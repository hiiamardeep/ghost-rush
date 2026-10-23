# Ghost Rush

Ghost Rush is a browser based swinging race through a haunted skyline. Play a solo time trial or race friends in a private room. The client uses React, TypeScript, Vite, and Phaser; the multiplayer server uses Node.js, Express, and Socket.IO.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the supported toolchain and configuration.

## Run locally

Install and start the server in one terminal:

```bash
cd server
npm ci
npm run dev
```

Install and start the client in another terminal:

```bash
cd client
npm ci
npm run dev
```

Open <http://localhost:5173>. The server listens on port `3001` by default. Create a room and share its code to play with up to three other racers.

## Controls

- **Desktop:** Hold **Space** to grab the nearest anchor; release to swing forward.
- **Touch:** Press and hold the game canvas to grab an anchor; release to swing.

Collect Spirit Cores for points and Shield Relics to block a collision. Finish three laps as quickly as possible.

## Configuration

The defaults work for local development. To change them, set these environment variables:

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | Server | `3001` | HTTP and Socket.IO server port |
| `CLIENT_ORIGIN` | Server | `http://localhost:5173` | Allowed client origin and redirect target |
| `VITE_SERVER_URL` | Client build | Browser hostname on port `3001` | Socket.IO server URL |

For production, set `CLIENT_ORIGIN` to the exact public client origin and set `VITE_SERVER_URL` before building the client. The client is a static site in `client/dist`; host it separately from the server and enable WebSocket connections. The server's `/` route redirects to the configured client origin, and `/health` returns a health status.

## Build and run for deployment

Build the client:

```bash
cd client
npm ci
npm run build
```

Build and start the server:

```bash
cd server
npm ci
npm run build
npm start
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
├── server/                 # Express and Socket.IO race server
│   └── src/index.ts
├── .gitignore
└── REQUIREMENTS.md
```

## Current limitations

- Rooms and race state are held in server memory and are lost when it restarts.
- Players use browser stored guest IDs; there are no accounts.
- The game supports private rooms of up to four players, not public matchmaking.
- Run the client and server as a single instance; persistent history and multi-instance synchronization are not configured.
