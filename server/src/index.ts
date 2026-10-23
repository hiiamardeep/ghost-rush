import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server, Socket } from 'socket.io';

const PORT = Number(process.env.PORT || 3001);
const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;
const DISCONNECT_GRACE_MS = 45_000;
const MAX_PLAYERS = 4;
const WORLD_WIDTH = 11000;
const FINISH_X = 10800;
const TOTAL_LAPS = 3;
const START_X = 120;
const START_Y = 330;

const isAllowedOrigin = (origin?: string) => {
  if (!origin || origin === ORIGIN) return true;
  try {
    const url = new URL(origin);
    const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
    const address = url.hostname.split('.').map(Number);
    const isIpv4 = address.length === 4 && address.every(part => Number.isInteger(part) && part >= 0 && part <= 255);
    const [first, second] = address;
    const privateHost = isIpv4 && (
      first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31)
    );
    return url.protocol === 'http:' && url.port === '5173' && (localHost || privateHost);
  } catch {
    return false;
  }
};

const corsOrigin = (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
  callback(null, isAllowedOrigin(origin));
};

const app = express();
app.use(cors({ origin: corsOrigin }));
app.get('/', (req, res) => {
  const clientUrl = new URL(ORIGIN);
  if (
    ['localhost', '127.0.0.1'].includes(clientUrl.hostname) &&
    !['localhost', '127.0.0.1'].includes(req.hostname)
  ) {
    clientUrl.hostname = req.hostname;
  }
  res.redirect(clientUrl.origin);
});
app.get('/health', (_req, res) => res.json({ ok: true, game: 'ghost-rush' }));

const http = createServer(app);
const io = new Server(http, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000,
});

type Player = {
  id: string;
  socketId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  held: boolean;
  attached: boolean;
  anchorX: number | null;
  anchorY: number | null;
  ropeLength: number;
  finished: boolean;
  rank: number | null;
  checkpoint: number;
  lap: number;
  score: number;
  collectedOrbs: number[];
  shieldCharge: boolean;
  collectedShields: number[];
  invulnerableUntil: number;
  finishTime: number | null;
  disconnectedAt: number | null;
};

type ChatMessage = {
  id: string;
  playerId: string;
  name: string;
  color: string;
  text: string;
  at: number;
};

type Room = {
  code: string;
  hostId: string;
  status: 'waiting' | 'racing' | 'finished';
  players: Map<string, Player>;
  winner: string | null;
  startedAt: number;
  solo: boolean;
  messages: ChatMessage[];
};

const rooms = new Map<string, Room>();
const guestRoom = new Map<string, string>();
const colors = ['#54e1ff', '#ffc857', '#ff6f91', '#a78bfa'];

const anchors = Array.from({ length: 42 }, (_, i) => ({
  x: 320 + i * 250,
  y: 80 + ((Math.sin(i * 1.71) + 1) * 0.5) * 150,
}));

const METEOR_COUNT = 28;
const MINE_COUNT = 10;
const SHIELD_COUNT = 8;


const codegen = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const cleanName = (v: unknown) => String(v || 'Racer').trim().slice(0, 12) || 'Racer';

function getRoom(guestId: string) {
  const code = guestRoom.get(guestId);
  return code ? rooms.get(code) : undefined;
}

function makePlayer(id: string, socket: Socket, name: string, color: string): Player {
  return {
    id,
    socketId: socket.id,
    name: cleanName(name),
    color,
    x: 120,
    y: 330,
    vx: 0,
    vy: 0,
    held: false,
    attached: false,
    anchorX: null,
    anchorY: null,
    ropeLength: 0,
    finished: false,
    rank: null,
    checkpoint: 0,
    lap: 0,
    score: 0,
    collectedOrbs: [],
    shieldCharge: false,
    collectedShields: [],
    invulnerableUntil: 0,
    finishTime: null,
    disconnectedAt: null,
  };
}

function resetPlayer(p: Player) {
  p.x = 120;
  p.y = 330;
  p.vx = 0;
  p.vy = 0;
  p.held = false;
  p.attached = false;
  p.anchorX = null;
  p.anchorY = null;
  p.ropeLength = 0;
  p.finished = false;
  p.rank = null;
  p.checkpoint = 0;
  p.lap = 0;
  p.score = 0;
  p.collectedOrbs = [];
  p.shieldCharge = false;
  p.collectedShields = [];
  p.invulnerableUntil = 0;
  p.finishTime = null;
  p.disconnectedAt = null;
}

function roomPayload(r: Room) {
  return {
    code: r.code,
    hostId: r.hostId,
    status: r.status,
    solo: r.solo,
    players: [...r.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      connected: Boolean(p.socketId),
    })),
  };
}

function gamePayload(r: Room) {
  return {
    status: r.status,
    winner: r.winner,
    startedAt: r.startedAt,
    totalLaps: TOTAL_LAPS,
    players: [...r.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      attached: p.attached,
      anchorX: p.anchorX,
      anchorY: p.anchorY,
      finished: p.finished,
      rank: p.rank,
      score: p.score,
      collectedOrbs: p.collectedOrbs,
      shieldCharge: p.shieldCharge,
      collectedShields: p.collectedShields,
      finishTime: p.finishTime,
      lap: p.lap,
      connected: Boolean(p.socketId),
    })),
  };
}

function emitChatHistory(socket: Socket, r: Room) {
  if (r.solo || r.messages.length === 0) return;
  socket.emit('chat:history', r.messages.slice(-30));
}

function emitRoom(r: Room) {
  io.to(r.code).emit('room:update', roomPayload(r));
  io.to(r.code).emit('game:state', gamePayload(r));
}

function removePlayerFromRoom(id: string, socket?: Socket) {
  const room = getRoom(id);
  if (!room) return;
  const player = room.players.get(id);
  if (!player) {
    guestRoom.delete(id);
    return;
  }

  io.sockets.sockets.get(player.socketId)?.leave(room.code);
  socket?.leave(room.code);
  room.players.delete(id);
  if (guestRoom.get(id) === room.code) guestRoom.delete(id);

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === id) {
    room.hostId = room.players.keys().next().value as string;
  }

  if (room.status === 'racing' && [...room.players.values()].every(p => p.finished)) {
    room.status = 'finished';
    io.to(room.code).emit('race:finished', gamePayload(room));
  }
  emitRoom(room);
}

function playerFor(r: Room, id: string, socket: Socket) {
  const p = r.players.get(id);
  return p && p.socketId === socket.id ? p : undefined;
}

function resetRoom(r: Room) {
  r.status = 'waiting';
  r.winner = null;
  r.startedAt = 0;
  r.players.forEach(resetPlayer);
}

function finish(r: Room, p: Player) {
  if (p.finished) return;
  p.rank = [...r.players.values()].filter(q => q.finished && q.rank !== null).length + 1;
  p.finished = true;
  p.finishTime = Math.max(0, (Date.now() - r.startedAt) / 1000);
  p.held = false;
  p.attached = false;
  p.anchorX = null;
  p.anchorY = null;
  const timeBonus = Math.max(0, 5000 - Math.floor(p.finishTime * 18));
  const checkpointBonus = p.checkpoint * 100;
  const lapBonus = TOTAL_LAPS * 400;
  const placementBonus = Math.max(0, (r.players.size - p.rank) * 250);
  p.score += 1000 + timeBonus + checkpointBonus + lapBonus + placementBonus;
  if (!r.winner) r.winner = p.id;
  if ([...r.players.values()].every(q => q.finished)) {
    r.status = 'finished';
    io.to(r.code).emit('room:update', roomPayload(r));
    io.to(r.code).emit('race:finished', gamePayload(r));
  }
}

function respawn(p: Player) {
  const checkpointAnchorIndex = Math.max(0, (p.checkpoint - 1) * 6);
  const a = anchors[Math.min(checkpointAnchorIndex, anchors.length - 1)];
  p.x = Math.max(120, a.x - 70);
  p.y = a.y + 150;
  p.vx = 260;
  p.vy = 0;
  p.held = false;
  p.attached = false;
  p.anchorX = null;
  p.anchorY = null;
  p.ropeLength = 0;
}

function meteoroidAt(i: number, now: number, lap: number) {
  // Rocks fall from the sky; speed ramps up each lap
  const speedMul = 1 + lap * 0.45;
  const baseSpeed = (90 + (i % 7) * 18) * speedMul;
  const x0 = 200 + (i * 397) % (FINISH_X - 400);
  const drift = ((i * 53) % 120) - 60;
  const fallRange = 900;
  const phase = (i * 0.73) % 1;
  const y = -120 + ((now * baseSpeed + phase * fallRange) % fallRange);
  const x = x0 + drift * Math.sin(now * 0.7 + i);
  const r = 14 + (i % 5) * 3;
  return { x, y, r };
}

function spiritOrbAt(i: number, now: number, lap: number) {
  const x = 480 + i * 620;
  const y = 180 + ((i * 113) % 330) + Math.sin(now * 1.35 + i * 1.7) * 28;
  return { x, y, r: 17, value: 100 };
}

function mineAt(i: number, now: number, lap: number) {
  const x = 650 + i * 980 + Math.sin(now * (0.65 + i * 0.025) + i) * 105;
  const y = 210 + ((i * 79) % 250) + Math.sin(now * 1.1 + i * 1.7) * (35 + lap * 8);
  return { x, y, r: 19 + (i % 3) * 3 };
}

function shieldAt(i: number, now: number) {
  return { x: 850 + i * 1250, y: 145 + ((i * 97) % 300) + Math.sin(now * 0.9 + i * 1.8) * 24, r: 19 };
}

function simulate(r: Room, dt: number) {

  if (r.status !== 'racing') return;
  const now = Math.max(0, (Date.now() - r.startedAt) / 1000);

  for (const p of r.players.values()) {
    if (p.finished || !p.socketId) continue;

    if (p.held && !p.attached) {
      let best: { x: number; y: number; d: number } | null = null;
      for (const a of anchors) {
        const dx = a.x - p.x;
        const dy = a.y - p.y;
        const d = Math.hypot(dx, dy);
        if (dx > -40 && dy < -20 && d < 430) {
          const score = d - dx * 0.35;
          if (!best || score < best.d) best = { ...a, d: score };
        }
      }
      if (best) {
        p.attached = true;
        p.anchorX = best.x;
        p.anchorY = best.y;
        p.ropeLength = Math.max(50, Math.hypot(best.x - p.x, best.y - p.y));
      }
    }
    if (!p.held && p.attached) {
      p.attached = false;
      p.anchorX = null;
      p.anchorY = null;
    }

    p.vy += 1500 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    if (p.attached && p.anchorX !== null && p.anchorY !== null) {
      const dx = p.x - p.anchorX;
      const dy = p.y - p.anchorY;
      const d = Math.max(1, Math.hypot(dx, dy));
      const nx = dx / d;
      const ny = dy / d;
      if (d > p.ropeLength) {
        p.x = p.anchorX + nx * p.ropeLength;
        p.y = p.anchorY + ny * p.ropeLength;
      }
      const radial = p.vx * nx + p.vy * ny;
      p.vx -= radial * nx;
      p.vy -= radial * ny;
      const tangentX = -ny;
      const tangentY = nx;
      const direction = Math.sign(p.vx * tangentX + p.vy * tangentY) || 1;
      p.vx += tangentX * direction * 330 * dt;
      p.vy += tangentY * direction * 330 * dt;
    } else {
      p.vx *= Math.max(0, 1 - 0.12 * dt);
    }

    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 1250) {
      p.vx *= 1250 / speed;
      p.vy *= 1250 / speed;
    }

    if (p.y < -250 || p.y > 760) {
      respawn(p);
      continue;
    }

    // Collect shield relics before resolving hazards so a pickup on the same
    // tick as a collision can absorb that hit.
    for (let i = 0; i < SHIELD_COUNT; i++) {
      const relic = shieldAt(i, now);
      if (!p.collectedShields.includes(i) && Math.hypot(relic.x - p.x, relic.y - p.y) < relic.r + 18) {
        p.collectedShields = [...p.collectedShields, i];
        p.shieldCharge = true;
        p.score += 150;
      }
    }

    // Falling meteoroid rocks — faster each lap
    let metHit = false;
    for (let i = 0; i < METEOR_COUNT; i++) {
      const m = meteoroidAt(i, now, p.lap);
      if (Math.hypot(m.x - p.x, m.y - p.y) < m.r + 10) {
        metHit = true;
        break;
      }
    }
    // Energy mines are additional moving hazards. Their motion is deterministic
    // and shared with the client renderer, so collisions remain fair in multiplayer.
    let mineHit = false;
    for (let i = 0; i < MINE_COUNT; i++) {
      const mine = mineAt(i, now, p.lap);
      if (Math.hypot(mine.x - p.x, mine.y - p.y) < mine.r + 10) {
        mineHit = true;
        break;
      }
    }
    if ((metHit || mineHit) && p.invulnerableUntil <= Date.now()) {
      if (p.shieldCharge) {
        p.shieldCharge = false;
        // Leave enough time to clear the hazard after the shield's knockback.
        p.invulnerableUntil = Date.now() + 900;
        p.vx = Math.max(260, p.vx);
        p.vy = -180;
        p.held = false; p.attached = false; p.anchorX = null; p.anchorY = null; p.ropeLength = 0;
      } else { respawn(p); continue; }
    }

    // Spirit cores are collected once per player per race and award 100 points each.
    for (let i = 0; i < 17; i++) {
      const orb = spiritOrbAt(i, now, p.lap);
      const alreadyCollected = p.collectedOrbs?.includes(i);
      if (!alreadyCollected && Math.hypot(orb.x - p.x, orb.y - p.y) < orb.r + 18) {
        p.collectedOrbs = [...(p.collectedOrbs || []), i];
        p.score += orb.value;
      }
    }

    for (let i = 0; i < anchors.length; i += 6) {
      if (anchors[i].x < p.x) p.checkpoint = Math.max(p.checkpoint, i / 6 + 1);
    }

    // Lap line — complete lap or finish race
    if (p.x >= FINISH_X) {
      if (p.lap + 1 >= TOTAL_LAPS) {
        p.x = FINISH_X;
        p.lap = TOTAL_LAPS;
        finish(r, p);
      } else {
        p.lap += 1;
        p.x = START_X;
        p.y = START_Y;
        p.vx = Math.max(280, Math.abs(p.vx) * 0.55);
        p.vy = -80;
        p.held = false;
        p.attached = false;
        p.anchorX = null;
        p.anchorY = null;
        p.ropeLength = 0;
        p.checkpoint = 0;
      }
    }
  }

  if ([...r.players.values()].every(p => p.finished)) {
    r.status = 'finished';
  }
}

io.on('connection', socket => {
  socket.on('room:create', (data: { guestId?: string; name?: string; solo?: boolean }) => {
    const id = String(data?.guestId || '');
    if (!id || id.length > 100) return socket.emit('room:error', 'Invalid guest identity.');
    removePlayerFromRoom(id, socket);
    let code = codegen();
    while (rooms.has(code)) code = codegen();
    const solo = data?.solo === true;
    const room: Room = {
      code,
      hostId: id,
      status: solo ? 'racing' : 'waiting',
      players: new Map(),
      winner: null,
      startedAt: solo ? Date.now() : 0,
      solo,
      messages: [],
    };
    room.players.set(id, makePlayer(id, socket, String(data?.name || 'Racer'), colors[0]));
    rooms.set(code, room);
    guestRoom.set(id, code);
    socket.join(code);
    emitRoom(room);
  });

  socket.on('room:join', (data: { code?: string; guestId?: string; name?: string }) => {
    const code = String(data?.code || '').trim().toUpperCase();
    const id = String(data?.guestId || '');
    const room = rooms.get(code);
    if (!room) return socket.emit('room:error', 'Room not found. Check the code.');
    if (!id || id.length > 100) return socket.emit('room:error', 'Invalid guest identity.');

    const existing = room.players.get(id);
    if (existing) {
      existing.socketId = socket.id;
      existing.name = cleanName(data?.name || existing.name);
      existing.disconnectedAt = null;
      guestRoom.set(id, code);
      socket.join(code);
      emitRoom(room);
      emitChatHistory(socket, room);
      return;
    }

    if (room.solo) return socket.emit('room:error', 'This is a solo race.');
    if (room.status !== 'waiting') return socket.emit('room:error', 'This race has already started.');
    if (room.players.size >= MAX_PLAYERS) return socket.emit('room:error', 'Room is full (maximum 4 racers).');

    removePlayerFromRoom(id, socket);
    room.players.set(
      id,
      makePlayer(id, socket, String(data?.name || 'Racer'), colors[room.players.size % colors.length]),
    );
    guestRoom.set(id, code);
    socket.join(code);
    emitRoom(room);
    emitChatHistory(socket, room);
  });

  socket.on('player:hold', (data: { guestId?: string; held?: boolean }) => {
    const id = String(data?.guestId || '');
    const room = getRoom(id);
    if (!room || room.status !== 'racing') return;
    const p = playerFor(room, id, socket);
    if (p && !p.finished) p.held = Boolean(data.held);
  });


  socket.on('race:start', (data: { guestId?: string }) => {
    const id = String(data?.guestId || '');
    const room = getRoom(id);
    if (!room) return socket.emit('room:error', 'Room not found. Rejoin the match before starting.');
    if (!playerFor(room, id, socket)) return socket.emit('room:error', 'You are no longer connected to this room.');
    if (room.hostId !== id) return socket.emit('room:error', 'Only the room host can start the match.');
    resetRoom(room);
    room.status = 'racing';
    room.startedAt = Date.now();
    emitRoom(room);
  });

  socket.on('race:reset', (data: { guestId?: string }) => {
    const id = String(data?.guestId || '');
    const room = getRoom(id);
    if (!room || room.hostId !== id) return;
    if (!playerFor(room, id, socket)) return;
    resetRoom(room);
    emitRoom(room);
  });

  socket.on('chat:send', (data: { guestId?: string; text?: string }) => {
    const id = String(data?.guestId || '');
    const room = getRoom(id);
    if (!room || room.solo) return;
    const p = playerFor(room, id, socket);
    if (!p) return;

    const raw = String(data?.text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return;
    const textMsg = raw.slice(0, 80);
    // Simple rate limit: max 1 message per 800ms per player
    const mine = room.messages.filter(m => m.playerId === id);
    const last = mine[mine.length - 1];
    if (last && Date.now() - last.at < 800) return;

    const msg: ChatMessage = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      playerId: p.id,
      name: p.name,
      color: p.color,
      text: textMsg,
      at: Date.now(),
    };
    room.messages.push(msg);
    if (room.messages.length > 40) room.messages.splice(0, room.messages.length - 40);
    io.to(room.code).emit('chat:message', msg);
  });

  socket.on('room:leave', (data: { guestId?: string }) => {
    const id = String(data?.guestId || '');
    const room = getRoom(id);
    if (!room || !playerFor(room, id, socket)) return;
    removePlayerFromRoom(id, socket);
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      for (const p of room.players.values()) {
        if (p.socketId === socket.id) {
          p.held = false;
          p.attached = false;
          p.anchorX = null;
          p.anchorY = null;
          p.socketId = '';
          p.disconnectedAt = Date.now();

          io.to(room.code).emit('game:state', gamePayload(room));
          io.to(room.code).emit('room:update', roomPayload(room));
        }
      }
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const p of [...room.players.values()]) {
      if (!p.socketId && p.disconnectedAt && now - p.disconnectedAt > DISCONNECT_GRACE_MS) {
        removePlayerFromRoom(p.id);
      }
    }

    const wasRacing = room.status === 'racing';
    const wasFinished = room.status === 'finished';
    simulate(room, 1 / TICK_HZ);
    if (wasRacing) {
      io.to(room.code).emit('game:state', gamePayload(room));
      if (!wasFinished && room.status === 'finished') {
        io.to(room.code).emit('room:update', roomPayload(room));
        io.to(room.code).emit('race:finished', gamePayload(room));
      }
    }
  }
}, TICK_MS);

http.listen(PORT, () => console.log(`Ghost Rush server listening on http://localhost:${PORT}`));
