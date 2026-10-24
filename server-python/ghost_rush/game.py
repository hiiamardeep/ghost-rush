"""Authoritative Ghost Rush room and simulation logic.

This module is independent of FastAPI and python-socketio so its game rules can
be exercised deterministically in unit tests. All public operations and ticks
share one asyncio lock, keeping room mutations serial within this process.
"""

from __future__ import annotations

import asyncio
import math
import random
import secrets
import string
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol


TICK_HZ = 60
TICK_SECONDS = 1 / TICK_HZ
DISCONNECT_GRACE_MS = 45_000
MAX_PLAYERS = 4
WORLD_WIDTH = 11_000
FINISH_X = 10_800
TOTAL_LAPS = 3
START_X = 120
START_Y = 330
METEOR_COUNT = 28
MINE_COUNT = 10
SHIELD_COUNT = 8
BOMB_COUNT = 5
PLAYER_COLLISION_RADIUS = 18
HAZARD_SEPARATION = 48
COLORS = ("#54e1ff", "#ffc857", "#ff6f91", "#a78bfa")

ANCHORS = tuple(
    {"x": 320 + i * 250, "y": 80 + ((math.sin(i * 1.71) + 1) * 0.5) * 150}
    for i in range(42)
)


class SocketGateway(Protocol):
    async def emit(self, event: str, data: Any = None, **kwargs: Any) -> Any: ...

    async def enter_room(self, sid: str, room: str, namespace: str | None = None) -> Any: ...

    async def leave_room(self, sid: str, room: str, namespace: str | None = None) -> Any: ...


@dataclass(slots=True)
class Player:
    id: str
    socket_id: str | None
    name: str
    color: str
    x: float = START_X
    y: float = START_Y
    vx: float = 0
    vy: float = 0
    held: bool = False
    attached: bool = False
    anchor_x: float | None = None
    anchor_y: float | None = None
    rope_length: float = 0
    finished: bool = False
    eliminated: bool = False
    rank: int | None = None
    checkpoint: int = 0
    lap: int = 0
    score: int = 0
    collected_orbs: list[int] = field(default_factory=list)
    shield_charge: bool = False
    collected_shields: list[int] = field(default_factory=list)
    invulnerable_until: float = 0
    finish_time: float | None = None
    disconnected_at: float | None = None

    def reset(self) -> None:
        self.x = START_X
        self.y = START_Y
        self.vx = 0
        self.vy = 0
        self.held = False
        self.attached = False
        self.anchor_x = None
        self.anchor_y = None
        self.rope_length = 0
        self.finished = False
        self.eliminated = False
        self.rank = None
        self.checkpoint = 0
        self.lap = 0
        self.score = 0
        self.collected_orbs.clear()
        self.shield_charge = False
        self.collected_shields.clear()
        self.invulnerable_until = 0
        self.finish_time = None
        self.disconnected_at = None


@dataclass(slots=True)
class ChatMessage:
    id: str
    player_id: str
    name: str
    color: str
    text: str
    at: float

    def payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "playerId": self.player_id,
            "name": self.name,
            "color": self.color,
            "text": self.text,
            "at": self.at,
        }


@dataclass(slots=True)
class Room:
    code: str
    host_id: str
    status: str = "waiting"
    players: dict[str, Player] = field(default_factory=dict)
    winner: str | None = None
    started_at: float = 0
    solo: bool = False
    messages: list[ChatMessage] = field(default_factory=list)


def _javascript_string(value: Any) -> str:
    """Approximate String(value) for payload fields accepted by the TS server."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, dict):
        return "[object Object]"
    if isinstance(value, list):
        return ",".join("" if item is None else _javascript_string(item) for item in value)
    return str(value)


def clean_name(value: Any) -> str:
    candidate = value if value else "Racer"
    return _javascript_string(candidate).strip()[:12] or "Racer"


def _data_object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _base36(value: int) -> str:
    alphabet = string.digits + string.ascii_lowercase
    if value <= 0:
        return "0"
    result = ""
    while value:
        value, remainder = divmod(value, 36)
        result = alphabet[remainder] + result
    return result


def meteoroid_at(index: int, now: float, lap: int) -> dict[str, float]:
    # Rocks fall from the sky; speed ramps up each lap.
    speed_mul = 1 + lap * 0.45
    base_speed = (90 + (index % 7) * 18) * speed_mul
    x0 = 200 + (index * 397) % (FINISH_X - 400)
    drift = ((index * 53) % 120) - 60
    fall_range = 900
    phase = (index * 0.73) % 1
    y = -120 + ((now * base_speed + phase * fall_range) % fall_range)
    x = x0 + drift * math.sin(now * 0.7 + index)
    radius = 14 + (index % 5) * 3
    return {"x": x, "y": y, "r": radius}


def spirit_orb_at(index: int, now: float, lap: int = 0) -> dict[str, float]:
    del lap  # Kept in the signature to mirror the original shared helper.
    x = 480 + index * 620
    y = 180 + ((index * 113) % 330) + math.sin(now * 1.35 + index * 1.7) * 28
    return {"x": x, "y": y, "r": 17, "value": 100}


def mine_at(index: int, now: float, lap: int) -> dict[str, float]:
    x = 650 + index * 980 + math.sin(now * (0.65 + index * 0.025) + index) * 105
    y = 210 + ((index * 79) % 250) + math.sin(now * 1.1 + index * 1.7) * (35 + lap * 8)
    return {"x": x, "y": y, "r": 19 + (index % 3) * 3}


def bomb_at(index: int, now: float) -> dict[str, float]:
    """Random-looking moving bomb hazards, deterministic across all racers."""
    seed = index + 1
    random_x = ((seed * 1103515245 + 12345) % 2_147_483_647) / 2_147_483_647
    random_y = ((seed * 1664525 + 1013904223) % 4_294_967_296) / 4_294_967_296
    random_motion = ((seed * 22695477 + 1) % 4_294_967_296) / 4_294_967_296
    phase = math.tau
    base_x = 850 + index * ((FINISH_X - 1700) / (BOMB_COUNT - 1)) + (random_x - 0.5) * 240
    base_y = 105 + random_y * 360
    return {
        "x": base_x + math.sin(now * (0.35 + random_motion * 0.3) + random_y * phase) * (70 + random_x * 80),
        "y": base_y + math.cos(now * (0.55 + random_x * 0.35) + random_motion * phase) * (28 + random_y * 42),
        "r": 21 + random_motion * 4,
    }


def shield_at(index: int, now: float) -> dict[str, float]:
    return {
        "x": 850 + index * 1250,
        "y": 145 + ((index * 97) % 300) + math.sin(now * 0.9 + index * 1.8) * 24,
        "r": 19,
    }


def swept_circle_overlap(
    player_start: tuple[float, float],
    player_end: tuple[float, float],
    circle_start: tuple[float, float],
    circle_end: tuple[float, float],
    radius: float,
) -> bool:
    """Check relative motion across a tick so fast objects cannot tunnel through."""
    start_x = player_start[0] - circle_start[0]
    start_y = player_start[1] - circle_start[1]
    end_x = player_end[0] - circle_end[0]
    end_y = player_end[1] - circle_end[1]
    dx = end_x - start_x
    dy = end_y - start_y
    length_squared = dx * dx + dy * dy
    if length_squared == 0:
        return math.hypot(start_x, start_y) <= radius
    t = max(0.0, min(1.0, -(start_x * dx + start_y * dy) / length_squared))
    closest_x = start_x + dx * t
    closest_y = start_y + dy * t
    return closest_x * closest_x + closest_y * closest_y <= radius * radius


class GameEngine:
    """Single-process authoritative room registry and 60 Hz simulation."""

    def __init__(
        self,
        sio: SocketGateway,
        *,
        now_ms: Callable[[], float] | None = None,
        code_factory: Callable[[], str] | None = None,
    ) -> None:
        self.sio = sio
        self.rooms: dict[str, Room] = {}
        self.guest_room: dict[str, str] = {}
        self.lock = asyncio.Lock()
        self._loop_running = False
        self._now_ms = now_ms or (lambda: int(time.time() * 1000))
        self._code_factory = code_factory or self._new_code

    @staticmethod
    def _new_code() -> str:
        return "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(6))

    def _room_for_guest(self, guest_id: str) -> Room | None:
        code = self.guest_room.get(guest_id)
        return self.rooms.get(code) if code else None

    @staticmethod
    def _player_for(room: Room, guest_id: str, sid: str) -> Player | None:
        player = room.players.get(guest_id)
        return player if player is not None and player.socket_id == sid else None

    def _make_player(self, guest_id: str, sid: str, name: Any, color: str) -> Player:
        return Player(id=guest_id, socket_id=sid, name=clean_name(name), color=color)

    @staticmethod
    def room_payload(room: Room) -> dict[str, Any]:
        return {
            "code": room.code,
            "hostId": room.host_id,
            "status": room.status,
            "solo": room.solo,
            "players": [
                {
                    "id": player.id,
                    "name": player.name,
                    "color": player.color,
                    "connected": bool(player.socket_id),
                }
                for player in room.players.values()
            ],
        }

    @staticmethod
    def game_payload(room: Room) -> dict[str, Any]:
        return {
            "status": room.status,
            "winner": room.winner,
            "startedAt": room.started_at,
            "totalLaps": TOTAL_LAPS,
            "players": [
                {
                    "id": player.id,
                    "name": player.name,
                    "color": player.color,
                    "x": player.x,
                    "y": player.y,
                    "vx": player.vx,
                    "vy": player.vy,
                    "attached": player.attached,
                    "anchorX": player.anchor_x,
                    "anchorY": player.anchor_y,
                    "finished": player.finished,
                    "eliminated": player.eliminated,
                    "rank": player.rank,
                    "score": player.score,
                    "collectedOrbs": list(player.collected_orbs),
                    "shieldCharge": player.shield_charge,
                    "collectedShields": list(player.collected_shields),
                    "finishTime": player.finish_time,
                    "lap": player.lap,
                    "connected": bool(player.socket_id),
                }
                for player in room.players.values()
            ],
        }

    async def _emit_room(self, room: Room) -> None:
        await self.sio.emit("room:update", self.room_payload(room), room=room.code)
        await self.sio.emit("game:state", self.game_payload(room), room=room.code)

    async def _emit_chat_history(self, sid: str, room: Room) -> None:
        if room.solo or not room.messages:
            return
        await self.sio.emit(
            "chat:history",
            [message.payload() for message in room.messages[-30:]],
            to=sid,
        )

    async def _error(self, sid: str, message: str) -> None:
        await self.sio.emit("room:error", message, to=sid)

    async def _remove_player(self, guest_id: str, current_sid: str | None = None) -> None:
        room = self._room_for_guest(guest_id)
        if room is None:
            self.guest_room.pop(guest_id, None)
            return
        player = room.players.get(guest_id)
        if player is None:
            if self.guest_room.get(guest_id) == room.code:
                self.guest_room.pop(guest_id, None)
            return

        if player.socket_id:
            await self.sio.leave_room(player.socket_id, room.code)
        if current_sid:
            await self.sio.leave_room(current_sid, room.code)
        room.players.pop(guest_id, None)
        if self.guest_room.get(guest_id) == room.code:
            self.guest_room.pop(guest_id, None)

        if not room.players:
            self.rooms.pop(room.code, None)
            return

        if room.host_id == guest_id:
            room.host_id = next(iter(room.players))

        if room.status == "racing" and all(p.finished or p.eliminated for p in room.players.values()):
            room.status = "finished"
            await self.sio.emit("race:finished", self.game_payload(room), room=room.code)
        await self._emit_room(room)

    def _reset_room(self, room: Room) -> None:
        room.status = "waiting"
        room.winner = None
        room.started_at = 0
        for player in room.players.values():
            player.reset()

    async def _finish(self, room: Room, player: Player, now_ms: float) -> None:
        if player.finished:
            return
        player.rank = sum(1 for other in room.players.values() if other.finished and other.rank is not None) + 1
        player.finished = True
        player.finish_time = max(0, (now_ms - room.started_at) / 1000)
        player.held = False
        player.attached = False
        player.anchor_x = None
        player.anchor_y = None
        time_bonus = max(0, 5000 - math.floor(player.finish_time * 18))
        checkpoint_bonus = player.checkpoint * 100
        lap_bonus = TOTAL_LAPS * 400
        placement_bonus = max(0, (len(room.players) - player.rank) * 250)
        player.score += 1000 + time_bonus + checkpoint_bonus + lap_bonus + placement_bonus
        if not room.winner:
            room.winner = player.id
        if all(other.finished or other.eliminated for other in room.players.values()):
            room.status = "finished"
            await self.sio.emit("room:update", self.room_payload(room), room=room.code)
            await self.sio.emit("race:finished", self.game_payload(room), room=room.code)

    @staticmethod
    def _clear_grapple(player: Player) -> None:
        player.held = False
        player.attached = False
        player.anchor_x = None
        player.anchor_y = None
        player.rope_length = 0

    @staticmethod
    def _respawn(player: Player, now_ms: float = 0) -> None:
        """Send the player back to the last checkpoint with brief i-frames."""
        checkpoint_anchor_index = max(0, (player.checkpoint - 1) * 6)
        anchor = ANCHORS[min(checkpoint_anchor_index, len(ANCHORS) - 1)]
        player.x = max(120, anchor["x"] - 70)
        player.y = anchor["y"] + 150
        player.vx = 260
        player.vy = 0
        GameEngine._clear_grapple(player)
        # Brief invulnerability so a respawn into a dense hazard cluster does not
        # immediately chain-kill the player.
        if now_ms:
            player.invulnerable_until = max(player.invulnerable_until, now_ms + 1000)

    @staticmethod
    def _absorb_hit(player: Player, now_ms: float, hazard_x: float, hazard_y: float) -> None:
        """Consume the shield charge, bounce away from the hazard, and grant i-frames.

        The player is nudged out of the overlapping body so the same obstacle does
        not re-trigger as soon as invulnerability ends.
        """
        player.shield_charge = False
        player.invulnerable_until = now_ms + 1200
        GameEngine._clear_grapple(player)

        dx = player.x - hazard_x
        dy = player.y - hazard_y
        dist = math.hypot(dx, dy)
        if dist < 1e-3:
            # Degenerate overlap (centers coincide) — push upward-forward.
            nx, ny = 0.6, -0.8
        else:
            nx, ny = dx / dist, dy / dist

        # Escape the hazard volume, then apply a recovery velocity.
        player.x += nx * HAZARD_SEPARATION
        player.y += ny * HAZARD_SEPARATION
        player.vx = max(280, abs(player.vx) * 0.55 + 120) * (1 if nx >= 0 else -0.35)
        # Prefer a forward boost after a shield block so the race keeps momentum.
        if player.vx < 260:
            player.vx = 260
        player.vy = min(player.vy, -220)

    async def create_room(self, sid: str, data: Any) -> None:
        payload = _data_object(data)
        guest_id = _javascript_string(payload.get("guestId") or "")
        async with self.lock:
            if not guest_id or len(guest_id) > 100:
                await self._error(sid, "Invalid guest identity.")
                return
            await self._remove_player(guest_id, sid)
            code = self._code_factory()
            while code in self.rooms:
                code = self._code_factory()
            solo = payload.get("solo") is True
            now_ms = self._now_ms()
            room = Room(
                code=code,
                host_id=guest_id,
                status="racing" if solo else "waiting",
                started_at=now_ms if solo else 0,
                solo=solo,
            )
            room.players[guest_id] = self._make_player(guest_id, sid, payload.get("name") or "Racer", COLORS[0])
            self.rooms[code] = room
            self.guest_room[guest_id] = code
            await self.sio.enter_room(sid, code)
            await self._emit_room(room)

    async def join_room(self, sid: str, data: Any) -> None:
        payload = _data_object(data)
        code = _javascript_string(payload.get("code") or "").strip().upper()
        guest_id = _javascript_string(payload.get("guestId") or "")
        async with self.lock:
            room = self.rooms.get(code)
            if room is None:
                await self._error(sid, "Room not found. Check the code.")
                return
            if not guest_id or len(guest_id) > 100:
                await self._error(sid, "Invalid guest identity.")
                return

            existing = room.players.get(guest_id)
            if existing is not None:
                # A reconnect replaces the old socket. Leaving the old socket's
                # Socket.IO room also prevents it from receiving later broadcasts.
                previous_room_code = self.guest_room.get(guest_id)
                if previous_room_code and previous_room_code != code:
                    await self._remove_player(guest_id, sid)
                    room = self.rooms.get(code)
                    if room is None:
                        await self._error(sid, "Room not found. Check the code.")
                        return
                    existing = room.players.get(guest_id)
                if existing is None:
                    existing = self._make_player(
                        guest_id,
                        sid,
                        payload.get("name") or "Racer",
                        COLORS[len(room.players) % len(COLORS)],
                    )
                    room.players[guest_id] = existing
                else:
                    if existing.socket_id and existing.socket_id != sid:
                        await self.sio.leave_room(existing.socket_id, code)
                    existing.socket_id = sid
                    existing.name = clean_name(payload.get("name") or existing.name)
                    existing.disconnected_at = None
                self.guest_room[guest_id] = code
                await self.sio.enter_room(sid, code)
                await self._emit_room(room)
                await self._emit_chat_history(sid, room)
                return

            if room.solo:
                await self._error(sid, "This is a solo race.")
                return
            if room.status != "waiting":
                await self._error(sid, "This race has already started.")
                return
            if len(room.players) >= MAX_PLAYERS:
                await self._error(sid, "Room is full (maximum 4 racers).")
                return

            # A guest can belong to only one room. This also invalidates their
            # old socket so its later disconnect cannot mark the new membership offline.
            await self._remove_player(guest_id, sid)
            room = self.rooms.get(code)
            if room is None:
                await self._error(sid, "Room not found. Check the code.")
                return
            if len(room.players) >= MAX_PLAYERS:
                await self._error(sid, "Room is full (maximum 4 racers).")
                return
            room.players[guest_id] = self._make_player(
                guest_id,
                sid,
                payload.get("name") or "Racer",
                COLORS[len(room.players) % len(COLORS)],
            )
            self.guest_room[guest_id] = code
            await self.sio.enter_room(sid, code)
            await self._emit_room(room)
            await self._emit_chat_history(sid, room)

    async def player_hold(self, sid: str, data: Any) -> None:
        payload = _data_object(data)
        guest_id = _javascript_string(payload.get("guestId") or "")
        async with self.lock:
            room = self._room_for_guest(guest_id)
            if room is None or room.status != "racing":
                return
            player = self._player_for(room, guest_id, sid)
            if player is not None and not player.finished and not player.eliminated:
                player.held = bool(payload.get("held"))

    async def race_start(self, sid: str, data: Any) -> None:
        payload = _data_object(data)
        guest_id = _javascript_string(payload.get("guestId") or "")
        async with self.lock:
            room = self._room_for_guest(guest_id)
            if room is None:
                await self._error(sid, "Room not found. Rejoin the match before starting.")
                return
            if self._player_for(room, guest_id, sid) is None:
                await self._error(sid, "You are no longer connected to this room.")
                return
            if room.host_id != guest_id:
                await self._error(sid, "Only the room host can start the match.")
                return
            self._reset_room(room)
            room.status = "racing"
            room.started_at = self._now_ms()
            await self._emit_room(room)

    async def race_reset(self, sid: str, data: Any) -> None:
        payload = _data_object(data)
        guest_id = _javascript_string(payload.get("guestId") or "")
        async with self.lock:
            room = self._room_for_guest(guest_id)
            if room is None or room.host_id != guest_id:
                return
            if self._player_for(room, guest_id, sid) is None:
                return
            self._reset_room(room)
            await self._emit_room(room)

    async def chat_send(self, sid: str, data: Any) -> None:
        payload = _data_object(data)
        guest_id = _javascript_string(payload.get("guestId") or "")
        async with self.lock:
            room = self._room_for_guest(guest_id)
            if room is None or room.solo:
                return
            player = self._player_for(room, guest_id, sid)
            if player is None:
                return

            raw = _javascript_string(payload.get("text") or "")
            normalized = " ".join(raw.split()).strip()
            if not normalized:
                return
            text = normalized[:80]
            mine = [message for message in room.messages if message.player_id == guest_id]
            now_ms = self._now_ms()
            if mine and now_ms - mine[-1].at < 800:
                return

            random_suffix = "".join(random.choice(string.digits + string.ascii_lowercase) for _ in range(5))
            message = ChatMessage(
                id=f"{_base36(int(now_ms))}-{random_suffix}",
                player_id=player.id,
                name=player.name,
                color=player.color,
                text=text,
                at=now_ms,
            )
            room.messages.append(message)
            if len(room.messages) > 40:
                del room.messages[: len(room.messages) - 40]
            await self.sio.emit("chat:message", message.payload(), room=room.code)

    async def room_leave(self, sid: str, data: Any) -> None:
        payload = _data_object(data)
        guest_id = _javascript_string(payload.get("guestId") or "")
        async with self.lock:
            room = self._room_for_guest(guest_id)
            if room is None or self._player_for(room, guest_id, sid) is None:
                return
            await self._remove_player(guest_id, sid)

    async def disconnect(self, sid: str) -> None:
        async with self.lock:
            now_ms = self._now_ms()
            for room in self.rooms.values():
                for player in room.players.values():
                    if player.socket_id == sid:
                        player.held = False
                        player.attached = False
                        player.anchor_x = None
                        player.anchor_y = None
                        player.socket_id = None
                        player.disconnected_at = now_ms
                        await self.sio.emit("game:state", self.game_payload(room), room=room.code)
                        await self.sio.emit("room:update", self.room_payload(room), room=room.code)

    async def _simulate(self, room: Room, dt: float, now_ms: float) -> None:
        if room.status != "racing":
            return
        now = max(0, (now_ms - room.started_at) / 1000)
        previous_now = max(0, now - dt)

        for player in room.players.values():
            if player.finished or player.eliminated or not player.socket_id:
                continue
            previous_position = (player.x, player.y)

            if player.held and not player.attached:
                best: dict[str, float] | None = None
                for anchor in ANCHORS:
                    dx = anchor["x"] - player.x
                    dy = anchor["y"] - player.y
                    distance = math.hypot(dx, dy)
                    if dx > -40 and dy < -20 and distance < 430:
                        score = distance - dx * 0.35
                        if best is None or score < best["d"]:
                            best = {"x": anchor["x"], "y": anchor["y"], "d": score}
                if best is not None:
                    player.attached = True
                    player.anchor_x = best["x"]
                    player.anchor_y = best["y"]
                    player.rope_length = max(
                        50,
                        math.hypot(best["x"] - player.x, best["y"] - player.y),
                    )
            if not player.held and player.attached:
                player.attached = False
                player.anchor_x = None
                player.anchor_y = None

            player.vy += 1500 * dt
            player.x += player.vx * dt
            player.y += player.vy * dt

            if player.attached and player.anchor_x is not None and player.anchor_y is not None:
                dx = player.x - player.anchor_x
                dy = player.y - player.anchor_y
                distance = max(1, math.hypot(dx, dy))
                nx = dx / distance
                ny = dy / distance
                if distance > player.rope_length:
                    player.x = player.anchor_x + nx * player.rope_length
                    player.y = player.anchor_y + ny * player.rope_length
                radial = player.vx * nx + player.vy * ny
                player.vx -= radial * nx
                player.vy -= radial * ny
                tangent_x = -ny
                tangent_y = nx
                tangent_velocity = player.vx * tangent_x + player.vy * tangent_y
                direction = (1 if tangent_velocity > 0 else -1 if tangent_velocity < 0 else 0) or 1
                player.vx += tangent_x * direction * 330 * dt
                player.vy += tangent_y * direction * 330 * dt
            else:
                player.vx *= max(0, 1 - 0.12 * dt)

            speed = math.hypot(player.vx, player.vy)
            if speed > 1250:
                player.vx *= 1250 / speed
                player.vy *= 1250 / speed

            # Resolve fatal bombs immediately after movement. This must happen
            # before any early-return path (such as a fall respawn), otherwise
            # a same-tick collision could be silently skipped.
            bomb_hit = False
            for index in range(BOMB_COUNT):
                previous_bomb = bomb_at(index, previous_now)
                bomb = bomb_at(index, now)
                if swept_circle_overlap(
                    previous_position,
                    (player.x, player.y),
                    (previous_bomb["x"], previous_bomb["y"]),
                    (bomb["x"], bomb["y"]),
                    bomb["r"] + PLAYER_COLLISION_RADIUS,
                ):
                    bomb_hit = True
                    break
            if bomb_hit:
                player.eliminated = True
                self._clear_grapple(player)
                player.vx = 0
                player.vy = 0
                continue

            # Out-of-bounds is a lethal fall — shield cannot save a drop into the void.
            if player.y < -250 or player.y > 760:
                self._respawn(player, now_ms)
                continue

            # Pickups resolve before hazards so a shield collected this tick
            # can absorb a collision occurring on the same tick.
            for index in range(SHIELD_COUNT):
                relic = shield_at(index, now)
                previous_relic = shield_at(index, previous_now)
                if (
                    index not in player.collected_shields
                    and swept_circle_overlap(
                        previous_position,
                        (player.x, player.y),
                        (previous_relic["x"], previous_relic["y"]),
                        (relic["x"], relic["y"]),
                        relic["r"] * 1.12 + PLAYER_COLLISION_RADIUS,
                    )
                ):
                    player.collected_shields.append(index)
                    player.shield_charge = True
                    player.score += 150

            if player.invulnerable_until <= now_ms:
                hit: tuple[float, float] | None = None
                for index in range(METEOR_COUNT):
                    meteor = meteoroid_at(index, now, player.lap)
                    previous_meteor = meteoroid_at(index, previous_now, player.lap)
                    if swept_circle_overlap(
                        previous_position,
                        (player.x, player.y),
                        (previous_meteor["x"], previous_meteor["y"]),
                        (meteor["x"], meteor["y"]),
                        meteor["r"] + PLAYER_COLLISION_RADIUS,
                    ):
                        hit = (meteor["x"], meteor["y"])
                        break
                if hit is None:
                    for index in range(MINE_COUNT):
                        mine = mine_at(index, now, player.lap)
                        previous_mine = mine_at(index, previous_now, player.lap)
                        if swept_circle_overlap(
                            previous_position,
                            (player.x, player.y),
                            (previous_mine["x"], previous_mine["y"]),
                            (mine["x"], mine["y"]),
                            mine["r"] * 1.12 + PLAYER_COLLISION_RADIUS,
                        ):
                            hit = (mine["x"], mine["y"])
                            break
                if hit is not None:
                    if player.shield_charge:
                        self._absorb_hit(player, now_ms, *hit)
                    else:
                        self._respawn(player, now_ms)
                        continue

            for index in range(17):
                orb = spirit_orb_at(index, now, player.lap)
                previous_orb = spirit_orb_at(index, previous_now, player.lap)
                if (
                    index not in player.collected_orbs
                    and swept_circle_overlap(
                        previous_position,
                        (player.x, player.y),
                        (previous_orb["x"], previous_orb["y"]),
                        (orb["x"], orb["y"]),
                        orb["r"] * 1.15 + PLAYER_COLLISION_RADIUS,
                    )
                ):
                    player.collected_orbs.append(index)
                    player.score += int(orb["value"])

            for index in range(0, len(ANCHORS), 6):
                if ANCHORS[index]["x"] < player.x:
                    player.checkpoint = max(player.checkpoint, index // 6 + 1)

            if player.x >= FINISH_X:
                if player.lap + 1 >= TOTAL_LAPS:
                    player.x = FINISH_X
                    player.lap = TOTAL_LAPS
                    await self._finish(room, player, now_ms)
                else:
                    player.lap += 1
                    player.x = START_X
                    player.y = START_Y
                    player.vx = max(280, abs(player.vx) * 0.55)
                    player.vy = 0
                    GameEngine._clear_grapple(player)
                    player.checkpoint = 0

        if all(player.finished or player.eliminated for player in room.players.values()):
            room.status = "finished"

    async def tick(self, *, dt: float = TICK_SECONDS, now_ms: float | None = None) -> None:
        async with self.lock:
            current_ms = self._now_ms() if now_ms is None else now_ms
            for room in list(self.rooms.values()):
                for player in list(room.players.values()):
                    if (
                        player.socket_id is None
                        and player.disconnected_at is not None
                        and current_ms - player.disconnected_at > DISCONNECT_GRACE_MS
                    ):
                        await self._remove_player(player.id)

                was_racing = room.status == "racing"
                was_finished = room.status == "finished"
                await self._simulate(room, dt, current_ms)
                if was_racing:
                    await self.sio.emit("game:state", self.game_payload(room), room=room.code)
                    if not was_finished and room.status == "finished":
                        await self.sio.emit("room:update", self.room_payload(room), room=room.code)
                        await self.sio.emit("race:finished", self.game_payload(room), room=room.code)

    async def run(self, stop_event: asyncio.Event) -> None:
        """Run a single fixed-step loop, avoiding duplicate per-room tasks."""
        if self._loop_running:
            raise RuntimeError("Ghost Rush game loop is already running")
        self._loop_running = True
        loop = asyncio.get_running_loop()
        deadline = loop.time()
        try:
            while not stop_event.is_set():
                await self.tick(dt=TICK_SECONDS)
                deadline += TICK_SECONDS
                now = loop.time()
                if deadline < now:
                    deadline = now
                delay = deadline - now
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=delay)
                except TimeoutError:
                    pass
        finally:
            self._loop_running = False


__all__ = [
    "ANCHORS",
    "COLORS",
    "DISCONNECT_GRACE_MS",
    "FINISH_X",
    "GameEngine",
    "MAX_PLAYERS",
    "Player",
    "Room",
    "TICK_HZ",
    "TICK_SECONDS",
    "TOTAL_LAPS",
    "clean_name",
    "bomb_at",
    "meteoroid_at",
    "mine_at",
    "shield_at",
    "spirit_orb_at",
]
