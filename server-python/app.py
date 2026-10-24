"""FastAPI and Socket.IO ASGI entry point for Ghost Rush."""

from __future__ import annotations

import asyncio
import ipaddress
import os
from contextlib import asynccontextmanager
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from ghost_rush.game import GameEngine


def _configured_origin() -> str:
    raw_origin = os.getenv("CLIENT_ORIGIN", "http://localhost:5173").strip()
    configured = raw_origin.rstrip("/")
    try:
        parsed = urlsplit(configured)
        hostname = parsed.hostname
        parsed.port  # Validate that any port is numeric and in range.
    except ValueError as error:
        raise RuntimeError("CLIENT_ORIGIN must be a valid HTTP(S) origin") from error

    if (
        parsed.scheme not in {"http", "https"}
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("CLIENT_ORIGIN must be an HTTP(S) origin without a path")
    return configured


def is_allowed_origin(origin: str | None, _environ: Any = None) -> bool:
    """Allow the configured production client and the original local-dev origins."""
    client_origin = _configured_origin()
    if not origin or origin == client_origin:
        return True
    try:
        parsed = urlsplit(origin)
        if parsed.scheme != "http" or parsed.port != 5173 or parsed.path or parsed.query or parsed.fragment:
            return False
        hostname = (parsed.hostname or "").lower()
        if hostname in {"localhost", "127.0.0.1"}:
            return True
        address = ipaddress.ip_address(hostname)
        if not isinstance(address, ipaddress.IPv4Address):
            return False
        return any(
            address in ipaddress.ip_network(network)
            for network in ("10.0.0.0/8", "192.168.0.0/16", "172.16.0.0/12")
        )
    except (ValueError, TypeError):
        return False


class LifespanSocketIOApp:
    """Keep Socket.IO routing while forwarding ASGI lifespan to FastAPI."""

    def __init__(self, socketio_app: Callable[..., Awaitable[None]], lifespan_app: FastAPI) -> None:
        self.socketio_app = socketio_app
        self.lifespan_app = lifespan_app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] == "lifespan":
            await self.lifespan_app(scope, receive, send)
        else:
            await self.socketio_app(scope, receive, send)


def create_application() -> tuple[LifespanSocketIOApp, GameEngine, socketio.AsyncServer]:
    client_origin = _configured_origin()
    sio = socketio.AsyncServer(
        async_mode="asgi",
        cors_allowed_origins=is_allowed_origin,
        cors_credentials=False,
        ping_interval=25,
        ping_timeout=20,
    )
    engine = GameEngine(sio)

    @asynccontextmanager
    async def lifespan(_fastapi_app: FastAPI):
        stop_event = asyncio.Event()
        loop_task = asyncio.create_task(engine.run(stop_event), name="ghost-rush-60hz-game-loop")
        try:
            yield
        finally:
            stop_event.set()
            try:
                try:
                    await asyncio.wait_for(loop_task, timeout=2.0)
                except TimeoutError:
                    loop_task.cancel()
                    try:
                        await loop_task
                    except asyncio.CancelledError:
                        pass
            finally:
                await sio.shutdown()

    fastapi_app = FastAPI(
        title="Ghost Rush multiplayer server",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=[client_origin],
        allow_origin_regex=(
            r"^http://(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|"
            r"192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}):5173$"
        ),
        allow_methods=["GET", "OPTIONS"],
        allow_headers=["*"],
    )

    @fastapi_app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "game": "ghost-rush"}

    @fastapi_app.get("/")
    async def root() -> RedirectResponse:
        return RedirectResponse(client_origin, status_code=302)

    @sio.event
    async def connect(sid: str, environ: dict[str, Any], auth: Any = None) -> bool:
        del sid, environ, auth
        return True

    @sio.on("room:create")
    async def room_create(sid: str, data: Any = None) -> None:
        await engine.create_room(sid, data)

    @sio.on("room:join")
    async def room_join(sid: str, data: Any = None) -> None:
        await engine.join_room(sid, data)

    @sio.on("player:hold")
    async def player_hold(sid: str, data: Any = None) -> None:
        await engine.player_hold(sid, data)

    @sio.on("race:start")
    async def race_start(sid: str, data: Any = None) -> None:
        await engine.race_start(sid, data)

    @sio.on("race:reset")
    async def race_reset(sid: str, data: Any = None) -> None:
        await engine.race_reset(sid, data)

    @sio.on("chat:send")
    async def chat_send(sid: str, data: Any = None) -> None:
        await engine.chat_send(sid, data)

    @sio.on("room:leave")
    async def room_leave(sid: str, data: Any = None) -> None:
        await engine.room_leave(sid, data)

    @sio.event
    async def disconnect(sid: str, *_args: Any) -> None:
        await engine.disconnect(sid)

    socketio_app = socketio.ASGIApp(
        sio,
        other_asgi_app=fastapi_app,
        socketio_path="socket.io",
    )
    return LifespanSocketIOApp(socketio_app, fastapi_app), engine, sio


app, engine, sio = create_application()


__all__ = ["app", "create_application", "engine", "is_allowed_origin", "sio"]
