# Requirements

Ghost Rush has a React/Vite frontend and a Python multiplayer backend in `server-python/`.

## Development toolchain

- Python 3.14.8 for the backend (`server-python/.python-version`).
- Node.js 20 or newer with npm for the frontend build.
- A modern browser with JavaScript modules, Canvas 2D, WebSockets, and `localStorage` support.
- Ports `5173` (Vite client) and `3001` (Python game server) available for the default local setup.
- Network access for installing npm and Python packages. The stylesheet also loads Outfit and JetBrains Mono from Google Fonts, with local system font fallbacks.

## Packages

The client dependencies are declared in `client/package.json` and `client/package-lock.json`:

- React 18 and React DOM
- Phaser 3
- Socket.IO Client 4
- Vite 6 and TypeScript 5 for development and builds

The recommended backend dependencies are pinned in `server-python/requirements.txt`:

- FastAPI
- python-socketio 5.x, which implements Socket.IO protocol revision 5 and Engine.IO revision 4 for compatibility with the existing Socket.IO JavaScript 4 client
- Uvicorn with WebSocket support

Install frontend dependencies with `cd client && npm ci`. Install Python backend dependencies with `cd server-python && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`.

## Environment configuration

| Variable | Component | Default |
| --- | --- | --- |
| `PORT` | Server | `3001` |
| `CLIENT_ORIGIN` | Python server | `http://localhost:5173` |
| `VITE_SERVER_URL` | Client, at build time | Current browser hostname on port `3001` |

For production, configure `CLIENT_ORIGIN` as the exact Vercel frontend origin and set `VITE_SERVER_URL` to the Python backend origin before building the frontend. The Socket.IO path is `/socket.io`. Keep local environment files out of source control. See [VERCEL-DEPLOYMENT.md](VERCEL-DEPLOYMENT.md) for deployment details.

## Build outputs

- `cd client && npm run build` creates the static site in `client/dist`.
- `cd server-python && python -m unittest discover -s tests -v` runs backend tests.
- `cd server-python && python run.py` starts the Python backend on `PORT` (default `3001`).

Host the Vite client and Python backend on publicly reachable origins. Run one backend instance and one worker because room and race state is in memory. HTTPS is recommended for public use and is needed for PWA installation in browsers outside localhost.
