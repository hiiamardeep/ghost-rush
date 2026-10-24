from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import unittest
import urllib.request
from pathlib import Path
from typing import Any

import websockets


SERVER_DIR = Path(__file__).resolve().parents[1]


class SocketIOIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_asgi_health_socketio_protocol_and_room_payload(self) -> None:
        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0))
            port = port_socket.getsockname()[1]
        env = os.environ.copy()
        env["PORT"] = str(port)
        env["CLIENT_ORIGIN"] = "http://localhost:5173"
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "run.py",
            cwd=SERVER_DIR,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            health_payload: dict[str, Any] | None = None
            for _ in range(100):
                if process.returncode is not None:
                    self.fail(f"Uvicorn exited during startup with status {process.returncode}")
                try:
                    response = await asyncio.to_thread(
                        lambda: urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=0.5)
                    )
                    health_payload = json.loads(response.read())
                    response.close()
                    break
                except OSError:
                    await asyncio.sleep(0.05)
            self.assertEqual(health_payload, {"ok": True, "game": "ghost-rush"})

            websocket_url = f"ws://127.0.0.1:{port}/socket.io/?EIO=4&transport=websocket"
            async with websockets.connect(
                websocket_url,
                origin="http://localhost:5173",
                open_timeout=5,
            ) as websocket:
                opening = await asyncio.wait_for(websocket.recv(), timeout=3)
                self.assertTrue(str(opening).startswith("0{"), opening)
                await websocket.send("40")  # Socket.IO protocol 5 namespace connect packet.
                connected = await asyncio.wait_for(websocket.recv(), timeout=3)
                self.assertTrue(str(connected).startswith("40"), connected)
                await websocket.send('42["room:create",{"guestId":"integration-racer","name":"Protocol Check"}]')
                payload: dict[str, Any] | None = None
                while payload is None:
                    packet = str(await asyncio.wait_for(websocket.recv(), timeout=3))
                    if packet == "2":  # Engine.IO server ping.
                        await websocket.send("3")
                        continue
                    if not packet.startswith("42"):
                        continue
                    event = json.loads(packet[2:])
                    if event[0] == "room:update":
                        payload = event[1]
            self.assertEqual(payload["hostId"], "integration-racer")
            self.assertEqual(payload["status"], "waiting")
            self.assertEqual(payload["players"][0]["name"], "Protocol Che")
        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except TimeoutError:
                    process.kill()
                    await process.wait()


if __name__ == "__main__":
    unittest.main()
