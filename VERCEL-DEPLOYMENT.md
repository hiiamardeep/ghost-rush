# Vercel frontend and Python backend deployment

Deploy the Vite frontend as a Vercel project and the Python + FastAPI + Socket.IO backend as a persistent Render web service.

## Vercel frontend project

Import the GitHub repository as one Vercel project with these settings:

| Setting | Value |
| --- | --- |
| Root Directory | `client` |
| Framework Preset | Vite |
| Node.js Version | 24.x |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |

The SPA rewrite is in `client/vercel.json`.

Set these variables under **Settings → Environment Variables** for Production and any Preview environment you use:

| Name | Value |
| --- | --- |
| `VITE_SERVER_URL` | Python service origin, e.g. `https://ghost-rush-python.onrender.com` |

`VITE_SERVER_URL` is only the Python service origin: omit `/socket.io`, any path, and a trailing slash. Vite embeds the value during the frontend build, so redeploy the frontend after changing it. The client uses the standard `/socket.io` connection path.

## Render Python web service

The repository includes a Render Blueprint in `render.yaml`. In Render, create a Blueprint from your GitHub repository and configure the service:

| Setting | Value |
| --- | --- |
| Runtime | Python 3 |
| Region | Singapore (change before first deploy to match your players) |
| Plan | `0.5c-512mb` paid compute |
| Root Directory | `server-python` |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `python run.py` |
| Health Check Path | `/health` |
| Instances | One |
| Workers | One (`run.py` enforces this) |

Set the service environment variable `CLIENT_ORIGIN` to the exact Vercel frontend origin, for example `https://ghost-rush-client.vercel.app`. Do not include a path or trailing slash. Render supplies `PORT`; `run.py` reads it automatically. `server-python/.python-version` pins Python 3.14.8.

The Blueprint uses one paid instance so active rooms stay on one process. It will incur Render compute charges. For a no-cost trial, change the plan to `free`; free instances can spin down after 15 minutes without inbound HTTP or WebSocket messages, and any restart clears in-memory rooms. The default Singapore region is chosen for an India-based audience; choose the region nearest your players before creating the service.

The Python service serves Socket.IO at `/socket.io` over WebSocket and polling, and its `/health` route returns `{"ok":true,"game":"ghost-rush"}`. The backend uses python-socketio 5.x, which speaks Socket.IO protocol revision 5 and Engine.IO revision 4, compatible with the existing Socket.IO JavaScript 4 client. The frontend and game UI do not need changes for this backend.

## Deploy and connect them

1. Deploy the Render Blueprint or create the web service with the settings above.
2. Copy the Render service origin, such as `https://ghost-rush-python.onrender.com`.
3. Set Vercel `VITE_SERVER_URL` to that origin; redeploy the frontend.
4. Set Render `CLIENT_ORIGIN` to the Vercel production origin; redeploy the backend if you add or change this value.
5. Open the frontend, create a room, and join from a second browser profile. Confirm movement, chat, disconnect/reconnect, and `/health` in the service logs.

For Vercel Preview deployments, the Python service must allow that exact preview origin. Use a stable Vercel branch domain and set `CLIENT_ORIGIN` to it, or update the backend's environment and redeploy when testing a different preview URL. The frontend Preview build must point `VITE_SERVER_URL` to the Render service and use `/socket.io`.

## Local development and tests

```bash
cd server-python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m unittest discover -s tests -v
python run.py
```

In another terminal, run the frontend with `cd client && npm ci && npm run dev`, then open <http://localhost:5173>. The local Python backend defaults to port `3001`, matching the client's development fallback.

## State and runtime limits

The Python implementation has one authoritative event loop at 60 Hz and serializes room and tick mutations with one asyncio lock. Run a single service instance and one worker: room state, guest mappings, race progress, chat history, and loop ownership exist only in process memory. A service restart loses active rooms. Scaling to multiple instances would split players and rooms; Redis or another shared store and coordinated simulation ownership would be needed before scaling out.

## References

- [Render Python version configuration](https://render.com/docs/python-version)
- [Render Blueprint configuration](https://render.com/docs/blueprint-spec)
- [python-socketio version compatibility](https://pypi.org/project/python-socketio/)
- [python-socketio ASGI integration](https://python-socketio.readthedocs.io/en/stable/server.html)
