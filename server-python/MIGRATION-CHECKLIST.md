# Python backend migration checklist

This checklist was derived from the original Node server before migration, the event handlers in `client/src/App.tsx`, and the state consumed by `client/src/GameCanvas.tsx`. The Node implementation was removed after the Python migration passed its test suite. The Python suite passes all 19 tests, including a live Engine.IO 4 / Socket.IO 5 WebSocket handshake.

## Socket.IO contract

| Direction | Event | Contract / behavior | Verification |
| --- | --- | --- | --- |
| Client → server | `room:create` | `{ guestId, name, solo? }`; rejects empty or >100-character IDs | Passed |
| Client → server | `room:join` | `{ code, guestId, name }`; code is trimmed and uppercased | Passed |
| Client → server | `player:hold` | `{ guestId, held }`; only the current socket can control its active racer | Passed |
| Client → server | `race:start` | `{ guestId }`; host-only; resets players and starts the clock | Passed |
| Client → server | `race:reset` | `{ guestId }`; host-only; silently ignores unauthorized requests | Passed |
| Client → server | `chat:send` | `{ guestId, text }`; whitespace normalization, 80-character limit, 800 ms/player rate limit | Passed |
| Client → server | `room:leave` | `{ guestId }`; only the current socket may leave that guest's room | Passed |
| Server → client | `room:update` | `{ code, hostId, status, solo, players[] }` | Passed |
| Server → client | `game:state` | `{ status, winner, startedAt, totalLaps, players[] }` with the existing physics, score, lap, shield, and connection fields | Passed |
| Server → client | `race:finished` | Full `game:state` payload | Passed |
| Server → client | `room:error` | Existing human-readable string errors | Passed |
| Server → client | `chat:message` | `{ id, playerId, name, color, text, at }` | Passed |
| Server → client | `chat:history` | Up to 30 latest messages, only for non-solo rooms with messages | Passed |

The frontend does not use Socket.IO acknowledgements. Its listeners, error recovery, local-storage room code, and `VITE_SERVER_URL` setting remain unchanged. The Python server uses python-socketio 5.x (Socket.IO protocol 5 / Engine.IO 4), matching Socket.IO JavaScript 4.x.

## Gameplay and room rules

- [x] Four racers maximum; host is the first player; host transfers to the first remaining player after departure.
- [x] Names are trimmed, default to `Racer`, and are limited to 12 characters. Colors retain the original four-color order.
- [x] Solo rooms start racing immediately and reject other guests.
- [x] Only the host can start/reset; returning players can rejoin an existing room during a race.
- [x] Player movement, gravity, nearest-anchor selection, rope constraint, tangential swing force, drag, speed cap, and out-of-world respawn use the original constants.
- [x] Meteoroids, mines, spirit cores, and shield relics use the same deterministic positions, movement formulas, collision radii, and lap scaling as the renderer.
- [x] Shield pickups resolve before hazards, absorb one collision, apply the original knockback and 900 ms invulnerability window, and score 150 points.
- [x] Spirit cores are collected once per race for 100 points each; checkpoints, three-lap resets, finish time, rank, winner, and placement/time/checkpoint bonuses match the original rules.
- [x] Chat history retains 40 messages; join sends the latest 30; disconnect marks players offline for 45 seconds before cleanup.
- [x] One 60 Hz loop simulates all rooms; an asyncio lock serializes loop ticks and all state-changing event handlers.
- [x] Health endpoint, configured/local CORS origin checks, startup loop creation, and graceful loop shutdown are configured.

## Behavioral differences

- Reconnecting a guest now removes the superseded Socket.IO room membership and prevents the same guest ID from remaining in multiple rooms. The original allowed an old socket or stale room mapping to survive some cross-room reconnect cases. This is a reconnect consistency fix; event names and payload fields are unchanged.
- Room codes remain six uppercase alphanumeric characters, but Python uses a cryptographic uniform code generator instead of `Math.random()` base-36 sampling. Chat message IDs retain the same timestamp-plus-short-random-suffix shape.
- All rooms are still in memory. A process restart loses rooms; the service must run one instance and one worker until state sharing and loop coordination are designed.

## Verification record

Passed with Python 3.14.4: `python -m unittest discover -s tests -v` — 19 tests passed, including health, configured CORS origins, multiplayer state broadcasts, and live WebSocket integration. The Vite production build also passed with `npm run build`. No frontend source changes were required for this migration.
