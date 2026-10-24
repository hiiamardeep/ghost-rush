from __future__ import annotations

import asyncio
import copy
import itertools
import unittest
from typing import Any

from ghost_rush.game import (
    ANCHORS,
    DISCONNECT_GRACE_MS,
    FINISH_X,
    GameEngine,
    Player,
    Room,
    TICK_HZ,
    TICK_SECONDS,
    TOTAL_LAPS,
    meteoroid_at,
    shield_at,
    spirit_orb_at,
)


class Clock:
    def __init__(self, value: float = 100_000) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


class FakeSocketIO:
    def __init__(self) -> None:
        self.rooms: dict[str, set[str]] = {}
        self.events: list[dict[str, Any]] = []

    async def emit(self, event: str, data: Any = None, **kwargs: Any) -> None:
        room = kwargs.get("room")
        target = kwargs.get("to")
        if target is not None:
            recipients = {target}
        elif room is not None:
            recipients = set(self.rooms.get(room, set()))
        else:
            recipients = set()
        self.events.append(
            {
                "event": event,
                "data": copy.deepcopy(data),
                "room": room,
                "to": target,
                "recipients": recipients,
            }
        )

    async def enter_room(self, sid: str, room: str, namespace: str | None = None) -> None:
        del namespace
        self.rooms.setdefault(room, set()).add(sid)

    async def leave_room(self, sid: str, room: str, namespace: str | None = None) -> None:
        del namespace
        self.rooms.get(room, set()).discard(sid)

    def events_for(self, name: str, sid: str | None = None) -> list[dict[str, Any]]:
        events = [event for event in self.events if event["event"] == name]
        if sid is not None:
            events = [event for event in events if sid in event["recipients"]]
        return events


class GameEngineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.clock = Clock()
        self.sio = FakeSocketIO()
        self.code_counter = itertools.count(1)
        self.engine = GameEngine(
            self.sio,
            now_ms=self.clock,
            code_factory=lambda: f"{next(self.code_counter):06d}",
        )

    async def create_room(self, sid: str = "host-socket", guest_id: str = "host", **kwargs: Any) -> Room:
        data = {"guestId": guest_id, "name": "  Haunted Racer  "}
        data.update(kwargs)
        await self.engine.create_room(sid, data)
        return self.engine.rooms[next(iter(self.engine.rooms))]

    async def test_room_create_join_payloads_and_colors(self) -> None:
        room = await self.create_room()
        self.assertEqual(room.code, "000001")
        updates = self.sio.events_for("room:update", "host-socket")
        self.assertEqual(updates[-1]["data"], {
            "code": "000001",
            "hostId": "host",
            "status": "waiting",
            "solo": False,
            "players": [{"id": "host", "name": "Haunted Race", "color": "#54e1ff", "connected": True}],
        })

        await self.engine.join_room("guest-socket", {"code": room.code.lower(), "guestId": "guest", "name": "Ghost"})
        self.assertEqual(list(room.players), ["host", "guest"])
        self.assertEqual(room.players["guest"].color, "#ffc857")
        payload = self.sio.events_for("game:state", "guest-socket")[-1]["data"]
        self.assertEqual(payload["totalLaps"], TOTAL_LAPS)
        self.assertEqual(payload["players"][1]["id"], "guest")
        self.assertEqual(payload["players"][1]["anchorX"], None)
        self.assertEqual(set(payload), {"status", "winner", "startedAt", "totalLaps", "players"})
        self.assertEqual(set(payload["players"][1]), {
            "id", "name", "color", "x", "y", "vx", "vy", "attached", "anchorX", "anchorY",
            "finished", "eliminated", "rank", "score", "collectedOrbs", "shieldCharge", "collectedShields",
            "finishTime", "lap", "connected",
        })

    async def test_invalid_code_guest_identity_and_full_room_errors(self) -> None:
        room = await self.create_room()
        await self.engine.join_room("missing-socket", {"code": "NOPE00", "guestId": "missing"})
        await self.engine.join_room("invalid-id-socket", {"code": room.code, "guestId": "x" * 101})
        for index in range(2, 5):
            await self.engine.join_room(f"socket-{index}", {"code": room.code, "guestId": f"guest-{index}"})
        await self.engine.join_room("full-socket", {"code": room.code, "guestId": "fifth"})
        self.assertEqual(len(room.players), 4)
        errors = [event["data"] for event in self.sio.events_for("room:error")]
        self.assertEqual(errors, [
            "Room not found. Check the code.",
            "Invalid guest identity.",
            "Room is full (maximum 4 racers).",
        ])

    async def test_host_permissions_race_start_reset_and_host_transfer(self) -> None:
        room = await self.create_room()
        await self.engine.join_room("guest-socket", {"code": room.code, "guestId": "guest"})
        await self.engine.race_start("guest-socket", {"guestId": "guest"})
        self.assertEqual(room.status, "waiting")
        self.assertEqual(self.sio.events_for("room:error")[-1]["data"], "Only the room host can start the match.")

        await self.engine.race_start("host-socket", {"guestId": "host"})
        self.assertEqual(room.status, "racing")
        self.assertEqual(room.started_at, self.clock.value)
        room.players["host"].score = 991
        await self.engine.race_reset("guest-socket", {"guestId": "guest"})
        self.assertEqual(room.status, "racing")
        await self.engine.race_reset("host-socket", {"guestId": "host"})
        self.assertEqual(room.status, "waiting")
        self.assertEqual(room.players["host"].score, 0)

        await self.engine.room_leave("host-socket", {"guestId": "host"})
        self.assertNotIn("host", room.players)
        self.assertEqual(room.host_id, "guest")

    async def test_solo_creation_starts_race_and_hold_updates_authoritative_physics(self) -> None:
        room = await self.create_room(solo=True)
        player = room.players["host"]
        self.assertEqual(room.status, "racing")
        self.assertEqual(room.started_at, self.clock.value)
        await self.engine.join_room("intruder-socket", {"code": room.code, "guestId": "intruder"})
        self.assertEqual(self.sio.events_for("room:error", "intruder-socket")[-1]["data"], "This is a solo race.")
        await self.engine.player_hold("host-socket", {"guestId": "host", "held": True})
        await self.engine.tick(now_ms=self.clock.value)
        self.assertTrue(player.attached)
        self.assertNotEqual((player.x, player.y), (120, 330))
        state = self.sio.events_for("game:state", "host-socket")[-1]["data"]
        self.assertEqual(state["players"][0]["attached"], True)
        self.assertAlmostEqual(state["players"][0]["x"], player.x)

    async def test_multiplayer_movement_state_is_broadcast_to_every_room_member(self) -> None:
        room = await self.create_room()
        await self.engine.join_room("guest-socket", {"code": room.code, "guestId": "guest"})
        await self.engine.race_start("host-socket", {"guestId": "host"})
        await self.engine.player_hold("host-socket", {"guestId": "host", "held": True})
        await self.engine.tick(now_ms=self.clock.value)
        guest_events = self.sio.events_for("game:state", "guest-socket")
        self.assertTrue(guest_events)
        state = guest_events[-1]["data"]
        self.assertEqual([player["id"] for player in state["players"]], ["host", "guest"])
        self.assertTrue(state["players"][0]["attached"])
        self.assertNotEqual((state["players"][0]["x"], state["players"][0]["y"]), (120, 330))

    async def test_orbs_and_shields_score_once_and_shield_absorbs_hazard(self) -> None:
        room = await self.create_room(solo=True)
        player = room.players["host"]
        orb = spirit_orb_at(0, 0)
        player.x, player.y = orb["x"], orb["y"]
        player.invulnerable_until = self.clock.value + 10_000
        await self.engine.tick(dt=0, now_ms=self.clock.value)
        self.assertEqual(player.collected_orbs, [0])
        self.assertEqual(player.score, 100)
        await self.engine.tick(dt=0, now_ms=self.clock.value)
        self.assertEqual(player.score, 100)

        relic = shield_at(0, 0)
        player.x, player.y = relic["x"], relic["y"]
        await self.engine.tick(dt=0, now_ms=self.clock.value)
        self.assertIn(0, player.collected_shields)
        self.assertTrue(player.shield_charge)
        self.assertEqual(player.score, 250)

        meteor = meteoroid_at(0, 0, player.lap)
        player.x, player.y = meteor["x"], meteor["y"]
        player.collected_shields = list(range(8))
        player.shield_charge = True
        player.invulnerable_until = 0
        await self.engine.tick(dt=0, now_ms=self.clock.value)
        self.assertFalse(player.shield_charge)
        # Shield must push the player clear of the hazard body, not leave them
        # sitting on the same coordinates where the rock still overlaps.
        self.assertNotEqual((player.x, player.y), (meteor["x"], meteor["y"]))
        self.assertGreaterEqual(player.vx, 260)
        self.assertLessEqual(player.vy, -180)
        self.assertGreater(player.invulnerable_until, self.clock.value + 900)

    async def test_unshielded_hazard_respawns_at_checkpoint(self) -> None:
        room = await self.create_room(solo=True)
        player = room.players["host"]
        player.checkpoint = 2
        meteor = meteoroid_at(0, 0, player.lap)
        player.x, player.y = meteor["x"], meteor["y"]
        player.invulnerable_until = 0
        await self.engine.tick(dt=0, now_ms=self.clock.value)
        checkpoint_anchor = ANCHORS[6]
        self.assertEqual(player.x, checkpoint_anchor["x"] - 70)
        self.assertEqual(player.y, checkpoint_anchor["y"] + 150)
        self.assertEqual((player.vx, player.vy), (260, 0))
        self.assertFalse(player.attached)

    async def test_checkpoint_lap_reset_and_finish_score_rank_and_winner(self) -> None:
        room = await self.create_room(solo=True)
        player = room.players["host"]
        player.x = FINISH_X - 1
        player.y = 330
        player.vx = 100
        player.vy = 0
        player.checkpoint = 3
        player.invulnerable_until = self.clock.value + 10_000
        await self.engine.tick(dt=0.02, now_ms=self.clock.value)
        self.assertEqual(player.lap, 1)
        self.assertEqual((player.x, player.y), (120, 330))
        self.assertEqual(player.checkpoint, 0)

        player.x = FINISH_X - 1
        player.vx = 100
        player.lap = TOTAL_LAPS - 1
        player.checkpoint = 7
        player.invulnerable_until = self.clock.value + 10_000
        await self.engine.tick(dt=0.02, now_ms=self.clock.value + 1000)
        self.assertEqual(room.status, "finished")
        self.assertTrue(player.finished)
        self.assertEqual((player.lap, player.rank, room.winner), (3, 1, "host"))
        self.assertAlmostEqual(player.finish_time or 0, 1.0)
        self.assertEqual(player.score, 1000 + (5000 - 18) + 700 + 1200)
        self.assertEqual(self.sio.events_for("race:finished", "host-socket")[-1]["data"]["winner"], "host")

    async def test_multiplayer_finish_order_and_room_completion(self) -> None:
        room = await self.create_room()
        await self.engine.join_room("guest-socket", {"code": room.code, "guestId": "guest"})
        await self.engine.race_start("host-socket", {"guestId": "host"})
        for player in room.players.values():
            player.x = FINISH_X - 1
            player.vx = 100
            player.lap = 2
            player.invulnerable_until = self.clock.value + 10_000
        await self.engine.tick(dt=0.02, now_ms=self.clock.value)
        self.assertEqual(room.status, "finished")
        self.assertEqual((room.players["host"].rank, room.players["guest"].rank), (1, 2))
        self.assertEqual(room.winner, "host")

    async def test_chat_payload_sanitizing_rate_limit_and_history(self) -> None:
        room = await self.create_room()
        await self.engine.join_room("guest-socket", {"code": room.code, "guestId": "guest", "name": "Guest"})
        await self.engine.chat_send("host-socket", {"guestId": "host", "text": "  hello\n   haunted   world  "})
        message = self.sio.events_for("chat:message", "guest-socket")[-1]["data"]
        self.assertEqual(set(message), {"id", "playerId", "name", "color", "text", "at"})
        self.assertEqual(message["text"], "hello haunted world")
        self.assertEqual(message["playerId"], "host")
        self.assertEqual(len(message["text"]), 19)

        self.clock.value += 400
        await self.engine.chat_send("host-socket", {"guestId": "host", "text": "rate limited"})
        self.assertEqual(len(self.sio.events_for("chat:message")), 1)
        self.clock.value += 400
        await self.engine.chat_send("host-socket", {"guestId": "host", "text": "x" * 100})
        self.assertEqual(len(self.sio.events_for("chat:message")[-1]["data"]["text"]), 80)

        await self.engine.join_room("late-socket", {"code": room.code, "guestId": "late"})
        history = self.sio.events_for("chat:history", "late-socket")[-1]["data"]
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["text"], "hello haunted world")

        for index in range(39):
            self.clock.value += 800
            await self.engine.chat_send("host-socket", {"guestId": "host", "text": f"bulk-{index}"})
        self.assertEqual(len(room.messages), 40)
        await self.engine.join_room("history-socket", {"code": room.code, "guestId": "history"})
        retained_history = self.sio.events_for("chat:history", "history-socket")[-1]["data"]
        self.assertEqual(len(retained_history), 30)
        self.assertEqual(retained_history[0]["text"], "bulk-9")

    async def test_disconnect_reconnect_replaces_socket_and_preserves_race_state(self) -> None:
        room = await self.create_room()
        await self.engine.join_room("guest-old", {"code": room.code, "guestId": "guest", "name": "Guest"})
        await self.engine.race_start("host-socket", {"guestId": "host"})
        guest = room.players["guest"]
        guest.score = 321
        await self.engine.disconnect("guest-old")
        self.assertIsNone(guest.socket_id)
        self.assertEqual(guest.disconnected_at, self.clock.value)

        await self.engine.join_room("guest-new", {"code": room.code, "guestId": "guest", "name": "New Name"})
        self.assertEqual(room.status, "racing")  # Returning players may rejoin a race in progress.
        self.assertEqual(guest.socket_id, "guest-new")
        self.assertEqual((guest.name, guest.score, guest.disconnected_at), ("New Name", 321, None))
        await self.engine.disconnect("guest-old")  # A stale old socket cannot take the player offline.
        self.assertEqual(guest.socket_id, "guest-new")
        self.assertTrue(self.sio.events_for("room:update", "guest-new")[-1]["data"]["players"][1]["connected"])

    async def test_disconnected_player_is_cleaned_after_grace_period(self) -> None:
        room = await self.create_room()
        await self.engine.join_room("guest-socket", {"code": room.code, "guestId": "guest"})
        await self.engine.disconnect("guest-socket")
        self.clock.value += DISCONNECT_GRACE_MS
        await self.engine.tick(now_ms=self.clock.value)
        self.assertIn("guest", room.players)  # Strictly greater than the original 45 seconds.
        self.clock.value += 1
        await self.engine.tick(now_ms=self.clock.value)
        self.assertNotIn("guest", room.players)
        self.assertNotIn("guest", self.engine.guest_room)

    async def test_multiple_rooms_are_ticked_by_one_authoritative_loop(self) -> None:
        first = await self.create_room(sid="first-socket", guest_id="first", solo=True)
        await self.engine.create_room("second-socket", {"guestId": "second", "solo": True})
        second = self.engine.rooms["000002"]
        first.players["first"].vy = 0
        second.players["second"].vy = 0
        await self.engine.tick(now_ms=self.clock.value)
        self.assertGreater(first.players["first"].y, 330)
        self.assertGreater(second.players["second"].y, 330)
        self.assertTrue(self.sio.events_for("game:state", "first-socket"))
        self.assertTrue(self.sio.events_for("game:state", "second-socket"))

    async def test_concurrent_joins_never_exceed_capacity_or_duplicate_guest(self) -> None:
        room = await self.create_room()
        await asyncio.gather(*(
            self.engine.join_room(f"socket-{index}", {"code": room.code, "guestId": f"guest-{index}"})
            for index in range(20)
        ))
        self.assertEqual(len(room.players), 4)
        self.assertLessEqual(len(room.players), 4)
        self.assertEqual(sum(1 for event in self.sio.events_for("room:error") if "Room is full" in event["data"]), 17)

        await self.engine.create_room("owner-socket", {"guestId": "owner"})
        duplicate_code = self.engine.guest_room["owner"]
        await asyncio.gather(
            self.engine.join_room("duplicate-a", {"code": duplicate_code, "guestId": "duplicate"}),
            self.engine.join_room("duplicate-b", {"code": duplicate_code, "guestId": "duplicate"}),
        )
        duplicate_room = self.engine.rooms[duplicate_code]
        self.assertEqual(sum(player.id == "duplicate" for player in duplicate_room.players.values()), 1)
        self.assertIn(duplicate_room.players["duplicate"].socket_id, {"duplicate-a", "duplicate-b"})

    async def test_loop_runs_near_60_hz_and_rejects_duplicate_loop(self) -> None:
        class CountingEngine(GameEngine):
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                super().__init__(*args, **kwargs)
                self.tick_times: list[float] = []

            async def tick(self, *, dt: float = TICK_SECONDS, now_ms: float | None = None) -> None:
                self.tick_times.append(asyncio.get_running_loop().time())
                await super().tick(dt=dt, now_ms=now_ms)

        engine = CountingEngine(FakeSocketIO())
        stop = asyncio.Event()
        task = asyncio.create_task(engine.run(stop))
        await asyncio.sleep(0.09)
        self.assertTrue(engine._loop_running)
        with self.assertRaisesRegex(RuntimeError, "already running"):
            await engine.run(asyncio.Event())
        stop.set()
        await asyncio.wait_for(task, timeout=1)
        intervals = [b - a for a, b in zip(engine.tick_times, engine.tick_times[1:])]
        self.assertEqual(TICK_HZ, 60)
        self.assertGreaterEqual(len(intervals), 3)
        self.assertTrue(all(0.006 <= interval <= 0.05 for interval in intervals), intervals)
        self.assertAlmostEqual(sum(intervals) / len(intervals), TICK_SECONDS, delta=0.015)

    async def test_payload_snapshots_do_not_change_after_later_game_mutations(self) -> None:
        room = await self.create_room(solo=True)
        payload = self.engine.game_payload(room)
        room.players["host"].collected_orbs.append(3)
        self.assertEqual(payload["players"][0]["collectedOrbs"], [])


if __name__ == "__main__":
    unittest.main()
