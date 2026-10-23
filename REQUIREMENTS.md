# Requirements

Ghost Rush is a Node.js and TypeScript project. Its npm manifests and lockfiles are the source of truth for package versions; a Python `requirements.txt` does not apply.

## Development toolchain

- Node.js 20 or newer with npm.
- A modern browser with JavaScript modules, Canvas 2D, WebSockets, and `localStorage` support.
- Ports `5173` (Vite client) and `3001` (game server) available for the default local setup.
- Network access for installing npm packages. The stylesheet also loads Outfit and JetBrains Mono from Google Fonts, with local system font fallbacks.

## Packages

The client dependencies are declared in `client/package.json` and `client/package-lock.json`:

- React 18 and React DOM
- Phaser 3
- Socket.IO Client 4
- Vite 6 and TypeScript 5 for development and builds

The server dependencies are declared in `server/package.json` and `server/package-lock.json`:

- Express 4 and Socket.IO 4
- CORS middleware
- TypeScript 5 and `tsx` for development

Install dependencies with `npm ci` from the corresponding `client/` and `server/` directories.

## Environment configuration

| Variable | Component | Default |
| --- | --- | --- |
| `PORT` | Server | `3001` |
| `CLIENT_ORIGIN` | Server | `http://localhost:5173` |
| `VITE_SERVER_URL` | Client, at build time | Current browser hostname on port `3001` |

For a public deployment, configure `CLIENT_ORIGIN` as the exact client origin accepted by the server and set `VITE_SERVER_URL` to the public Socket.IO server URL before building the client. Keep local environment files out of source control.

## Build outputs

- `cd client && npm run build` creates the static site in `client/dist`.
- `cd server && npm run build` compiles the server into `server/dist`.
- `cd server && npm start` starts the compiled server.

Host the client and server so browsers can reach both origins and the server accepts Socket.IO WebSocket connections. HTTPS is recommended for public use and is needed for PWA installation in browsers outside localhost.
