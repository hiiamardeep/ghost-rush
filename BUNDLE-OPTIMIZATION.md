# Vite bundle-size warning

Updated `client/vite.config.ts` to split Phaser, React, Socket.IO, and remaining dependencies into separate chunks.

`chunkSizeWarningLimit: 1200` is a warning threshold, not a size reduction by itself. It is set because Phaser's engine chunk can legitimately be large. The split keeps the main application bundle smaller and improves cacheability. If the Phaser chunk grows beyond this threshold, consider lazy-loading the game screen or auditing Phaser imports and plugins.

Build from `client/`:

```bash
npm ci
npm run build
```
