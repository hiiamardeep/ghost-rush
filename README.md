# Ghost Rush

Ghost Rush is a browser based swinging race through a haunted skyline. Play a solo time trial or race friends in a private room. The client uses React, TypeScript, Vite, and Phaser. The multiplayer backend uses Python, FastAPI, and Socket.IO in `server-python/`.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the supported toolchain and configuration.

## Run locally

Install and start the Python server in one terminal:

```bash
cd server-python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

Install and start the client in another terminal:

```bash
cd client
npm ci
npm run dev
```

Open <http://localhost:5173>. The Python backend listens on port `3001` by default. Create a room and share its code to play with up to three other racers.

## Controls

- **Desktop:** Hold **Space** to grab the nearest anchor; release to swing forward.
- **Touch:** Press and hold the game canvas to grab an anchor; release to swing.

Collect Spirit Cores for points and Shield Relics to block a collision. Finish three laps as quickly as possible.

## Configuration

The defaults work for local development. To change them, set these environment variables:

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | Python server | `3001` locally; hosting platform value in production | HTTP and Socket.IO server port |
| `CLIENT_ORIGIN` | Python server | `http://localhost:5173` | Allowed client origin |
| `VITE_SERVER_URL` | Client build | Browser hostname on port `3001` | Socket.IO server origin |

For production, set `CLIENT_ORIGIN` to the exact public client origin and set `VITE_SERVER_URL` to the Python service origin before building the client. Socket.IO uses the standard `/socket.io` path. The server's `/` route redirects to the configured client origin, and `/health` returns a health status.

## Deploy the frontend and Python backend

Deploy the Vite frontend to Vercel and run the Python Socket.IO backend as a persistent web service. See [VERCEL-DEPLOYMENT.md](VERCEL-DEPLOYMENT.md) for Vercel and Render setup, environment variables, and runtime limits.

## Build and run for deployment

Build the client:

```bash
cd client
npm ci
npm run build
```

The client can be previewed locally with `npm run preview` from `client/`.

## Install as an app

Ghost Rush includes a web app manifest and icons. On supported browsers, use **Install app** or **Add to Home Screen**. PWA installation generally requires HTTPS outside localhost.

## Project structure

```text
ghost-rush/
├── client/                 # React, TypeScript, Vite, and Phaser game
│   ├── public/             # PWA manifest, icons, and service worker
│   └── src/                # Application, game canvas, and styles
├── server-python/          # FastAPI, python-socketio, and the migrated game engine
│   ├── app.py
│   ├── ghost_rush/game.py
│   └── tests/
├── render.yaml             # Persistent Python backend service configuration
├── .gitignore
└── REQUIREMENTS.md
```

## Current limitations

- Python rooms and race state are held in process memory and are lost when the service restarts. Run one instance and one worker until shared state is implemented.
- Players use browser stored guest IDs; there are no accounts.
- The game supports private rooms of up to four players, not public matchmaking.
- Persistent history, Redis, and multi-instance synchronization are not configured.
# ghost-rush
