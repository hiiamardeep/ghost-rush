import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { io, Socket } from 'socket.io-client';
import type { GameState } from './GameCanvas';

const GameCanvas = lazy(() => import('./GameCanvas'));

const serverUrl = new URL(import.meta.env.VITE_SERVER_URL || `${window.location.protocol}//${window.location.hostname}:3001`);
if (
  ['localhost', '127.0.0.1'].includes(serverUrl.hostname) &&
  !['localhost', '127.0.0.1'].includes(window.location.hostname)
) {
  serverUrl.hostname = window.location.hostname;
}
const SERVER_URL = serverUrl.origin;
type RoomInfo = { code: string; hostId?: string; players: { id: string; name: string; color: string; connected?: boolean }[]; status: string; solo: boolean };
type ChatMessage = { id: string; playerId: string; name: string; color: string; text: string; at: number };
const createGuestId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
};
const guest = () => {
  let id = localStorage.getItem('swing_guest_id');
  if (!id) { id = createGuestId(); localStorage.setItem('swing_guest_id', id); }
  return id;
};

export default function App() {
  const guestId = useMemo(guest, []);
  const [name, setName] = useState(localStorage.getItem('swing_name') || '');
  const [codeInput, setCodeInput] = useState('');
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const chatListRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<RoomInfo | null>(null);
  roomRef.current = room;
  const [isStandalone, setIsStandalone] = useState(false);
  const canvasShellRef = useRef<HTMLDivElement>(null);
  const orientationLockedRef = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const [raceTimerVersion, setRaceTimerVersion] = useState(0);
  const [bestTime, setBestTime] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem('swing_solo_best_time'));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });
  const [newBest, setNewBest] = useState(false);
  const [displayScore, setDisplayScore] = useState(0);
  const [celebrateBurst, setCelebrateBurst] = useState(0);
  const me = gameState?.players.find(p => p.id === guestId);
  const finishTime = me?.finishTime ?? elapsed;

  useEffect(() => {
    const s = io(SERVER_URL, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });
    setSocket(s);
    let rejoiningRoom = false;
    s.on('connect', () => {
      setConnected(true);
      setError('');
      const currentRoom = roomRef.current;
      const roomCode = currentRoom?.code || localStorage.getItem('swing_room_code');
      if (roomCode) {
        rejoiningRoom = true;
        s.emit('room:join', {
          code: roomCode,
          guestId,
          name: localStorage.getItem('swing_name') || 'Racer',
        });
      }
    });
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', () => {
      setConnected(false);
      setError('Unable to connect to the race server. Check your connection and try again.');
    });
    s.on('room:update', (r: RoomInfo) => {
      rejoiningRoom = false;
      roomRef.current = r;
      localStorage.setItem('swing_room_code', r.code);
      setRoom(r);
      setError('');
    });
    s.on('game:state', (state: GameState) => setGameState(state));
    s.on('race:finished', (state: GameState) => setGameState(state));
    s.on('room:error', (message: string) => {
      if (rejoiningRoom) {
        rejoiningRoom = false;
        roomRef.current = null;
        localStorage.removeItem('swing_room_code');
        setRoom(null);
        setGameState(null);
      }
      setError(message);
    });
    s.on('chat:message', (msg: ChatMessage) => {
      setChatMessages(prev => [...prev.slice(-39), msg]);
    });
    s.on('chat:history', (msgs: ChatMessage[]) => {
      setChatMessages(Array.isArray(msgs) ? msgs.slice(-40) : []);
    });
    return () => { s.disconnect(); };
  }, []);

  useEffect(() => {
    const updateFullscreen = () => {
      const fullscreen = (document.fullscreenElement || (document as any).webkitFullscreenElement) === canvasShellRef.current;
      setIsFullscreen(fullscreen);
      if (!fullscreen && orientationLockedRef.current) {
        orientationLockedRef.current = false;
        try {
          screen.orientation?.unlock();
        } catch {
          // Some browsers expose orientation locking without supporting unlock.
        }
      }
    };
    document.addEventListener('fullscreenchange', updateFullscreen);
    document.addEventListener('webkitfullscreenchange', updateFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', updateFullscreen);
      document.removeEventListener('webkitfullscreenchange', updateFullscreen);
    };
  }, []);

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as any).standalone === true;
    setIsStandalone(standalone);

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    const onInstalled = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    if (gameState?.status !== 'racing') return;
    const serverStart = gameState.startedAt;
    const start = serverStart && serverStart > 0 ? serverStart : Date.now();
    const tick = () => setElapsed(Math.max(0, (Date.now() - start) / 1000));
    tick();
    const timer = window.setInterval(tick, 50);
    return () => window.clearInterval(timer);
  }, [gameState?.status, gameState?.startedAt, raceTimerVersion]);

  useEffect(() => {
    if (!room?.solo || !me?.finished || me.finishTime === null) return;
    const previous = Number(localStorage.getItem('swing_solo_best_time'));
    const hasPrevious = Number.isFinite(previous) && previous > 0;
    const isBest = !hasPrevious || me.finishTime < previous;
    setNewBest(isBest);
    if (isBest) {
      localStorage.setItem('swing_solo_best_time', String(me.finishTime));
      setBestTime(me.finishTime);
    } else {
      setBestTime(previous);
    }
  }, [room?.solo, me?.finished, me?.finishTime]);

  // Celebrate + count-up score when you finish
  useEffect(() => {
    if (!me?.finished || me.score == null) return;
    setCelebrateBurst(b => b + 1);
    setDisplayScore(0);
    const target = me.score;
    const start = performance.now();
    const duration = 1400;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayScore(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplayScore(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [me?.finished, me?.score, me?.finishTime]);

  useEffect(() => {
    if (!room || room.solo) setChatMessages([]);
  }, [room?.code, room?.solo]);

  useEffect(() => {
    const el = chatListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages]);

  const sendChat = () => {
    const textMsg = chatInput.trim();
    if (!textMsg || !socket || room?.solo) return;
    socket.emit('chat:send', { guestId, text: textMsg });
    setChatInput('');
  };

  const createRoom = () => {
    localStorage.setItem('swing_name', name.trim() || 'Racer');
    socket?.emit('room:create', { guestId, name: name.trim() || 'Racer' });
  };
  const startSolo = () => {
    localStorage.setItem('swing_name', name.trim() || 'Racer');
    socket?.emit('room:create', { guestId, name: name.trim() || 'Racer', solo: true });
  };
  const joinRoom = () => {
    if (!codeInput.trim()) { setError('Enter a room code.'); return; }
    localStorage.setItem('swing_name', name.trim() || 'Racer');
    socket?.emit('room:join', { code: codeInput.trim().toUpperCase(), guestId, name: name.trim() || 'Racer' });
  };
  const leaveRoom = () => {
    socket?.emit('room:leave', { guestId });
    roomRef.current = null;
    localStorage.removeItem('swing_room_code');
    setRoom(null); setGameState(null); setElapsed(0); setChatMessages([]); setChatInput('');
  };
  const holdChange = (held: boolean) => socket?.emit('player:hold', { guestId, held });
  const startRace = () => socket?.emit('race:start', { guestId });
  const resetRace = () => {
    setElapsed(0);
    setRaceTimerVersion(version => version + 1);
    setNewBest(false);
    socket?.emit(room?.solo ? 'race:start' : 'race:reset', { guestId });
  };
  const toggleFullscreen = async () => {
    const canvasShell = canvasShellRef.current as HTMLDivElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    if (!canvasShell) return;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    const active = document.fullscreenElement || doc.webkitFullscreenElement;
    try {
      if (active === canvasShell) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
      } else {
        if (canvasShell.requestFullscreen) await canvasShell.requestFullscreen();
        else if (canvasShell.webkitRequestFullscreen) await canvasShell.webkitRequestFullscreen();
        else {
          setError('Fullscreen is not supported in this browser. On iPhone: Share → Add to Home Screen, then open the app.');
          return;
        }
        const orientation = screen.orientation as (ScreenOrientation & {
          lock?: (orientation: 'landscape') => Promise<void>;
        }) | undefined;
        if (typeof orientation?.lock === 'function') {
          try {
            await orientation.lock('landscape');
            orientationLockedRef.current = true;
            setError('');
          } catch {
            setError('');
          }
        } else {
          setError('');
        }
      }
    } catch {
      setError('Could not enter fullscreen. Try Install app, or use Add to Home Screen on iPhone.');
    }
  };

  const installApp = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => null);
    setInstallPrompt(null);
    if (choice?.outcome === 'accepted') setError('');
  };
  const copyCode = async () => {
    if (!room) return;
    try { await navigator.clipboard.writeText(room.code); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch { setError(`Share this room code: ${room.code}`); }
  };

  const totalLaps = gameState?.totalLaps ?? 3;
  const myLap = me?.lap ?? 0;
  const progress = me
    ? Math.max(0, Math.min(100, ((myLap + Math.min(1, me.x / 10800)) / totalLaps) * 100))
    : 0;
  const standings = gameState
    ? [...gameState.players]
      .map(player => ({
        ...player,
        progress: player.finished
          ? 100
          : Math.max(0, Math.min(100, ((player.lap ?? 0) + Math.min(1, player.x / 10800)) / totalLaps * 100)),
      }))
      .sort((a, b) => {
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        if (a.finished && b.finished) return (a.rank ?? Infinity) - (b.rank ?? Infinity);
        return b.progress - a.progress;
      })
    : [];
  const isRoomHost = room?.hostId === guestId || (!room?.hostId && room?.players[0]?.id === guestId);

  return <main className={`shell${gameState?.status === 'racing' ? ' is-racing' : ''}`}>
    <header className="topbar">
      <a className="logo" href="#" aria-label="Ghost Rush home">
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path className="logo-trail" d="M7 15h9M4 21h8M7 27h8"/>
          <path className="logo-ghost" d="M20 35V21a9 9 0 0 1 18 0v14l-4-3-4 4-4-4-4 4z"/>
          <circle className="logo-eye" cx="26" cy="21" r="1.4"/>
          <circle className="logo-eye" cx="32" cy="21" r="1.4"/>
        </svg>
      </a>
      <div className="brand"><strong>GHOST <b>RUSH</b></strong></div>
      <div className={`connection ${connected ? 'on' : ''}`}><i />{connected ? 'ONLINE' : 'CONNECTING'}</div>
      <a className="support-link" href="https://www.buymeacoffee.com/amarde.ep" target="_blank" rel="noopener noreferrer" aria-label="Buy me a coffee" title="Buy me a coffee">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 9h12v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9Z" />
          <path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17M8 5c1 1 1 2 0 3m4-4c1 1 1 2 0 3" />
        </svg>
      </a>
      {!isStandalone && installPrompt && (
        <button type="button" className="install-btn" onClick={installApp} title="Install Ghost Rush">
          INSTALL APP
        </button>
      )}
      {!isStandalone && !installPrompt && (
        <details className="install-help">
          <summary>INSTALL</summary>
          <div className="install-help-body">
            <p><strong>Android / Chrome:</strong> browser menu → <em>Install app</em> or <em>Add to Home screen</em>.</p>
            <p><strong>iPhone:</strong> Share → <em>Add to Home Screen</em>. Open from the icon for app-like fullscreen.</p>
          </div>
        </details>
      )}
    </header>

    {!room ? <section className="landing">
      <div className="landing-copy">
        <div className="tag">A SPECTRAL ARCADE</div>
        <h1>HAUNT THE<br/><span>SKYLINE.</span></h1>
        <p>Swing through a haunted skyline. Collect spirit points, clear three laps, and beat your best time.</p>
        <svg className="hero-art" viewBox="0 0 480 280" fill="none" aria-hidden="true">
          <defs>
            <linearGradient id="hero-ghost" x1="248" y1="93" x2="248" y2="223" gradientUnits="userSpaceOnUse">
              <stop stopColor="#fff"/><stop offset="1" stopColor="#BFC8FF"/>
            </linearGradient>
            <linearGradient id="hero-rope" x1="130" y1="36" x2="260" y2="170" gradientUnits="userSpaceOnUse">
              <stop stopColor="#70EEFF"/><stop offset="1" stopColor="#B38CFF"/>
            </linearGradient>
            <filter id="hero-glow" x="0" y="0" width="480" height="280" filterUnits="userSpaceOnUse">
              <feGaussianBlur stdDeviation="8"/>
            </filter>
          </defs>
          <path d="M0 242h480" stroke="#A58BFF" strokeOpacity=".32"/>
          <path d="M22 242v-52h31v52m11 0v-91h39v91m13 0v-63h28v63m236 0v-85h36v85m12 0v-52h38v52"
            fill="#7965C6" fillOpacity=".13" stroke="#A895FF" strokeOpacity=".35"/>
          <path d="M40 210h8m-8 12h8m45-38h8m-8 13h8m-8 13h8m312-19h8m-8 13h8m-8 13h8"
            stroke="#C7BDFF" strokeOpacity=".55" strokeLinecap="round"/>
          <path d="M134 43c8 62 35 91 83 104" stroke="url(#hero-rope)" strokeWidth="2"/>
          <circle cx="134" cy="42" r="8" stroke="#82F1FF" strokeWidth="2"/>
          <circle cx="134" cy="42" r="2.5" fill="#D9FCFF"/>
          <path d="M217 118c15-17 47-15 59 4 7 11 6 24 4 37l-5 37-10-8-9 12-10-9-10 8-9-10-10 6 2-47c0-11 0-22 8-30z"
            fill="#B78CFF" fillOpacity=".3" filter="url(#hero-glow)"/>
          <path d="M221 126c8-17 34-21 49-9 13 11 11 29 9 45l-5 30-10-8-9 10-10-8-10 7-10-9-9 6 1-36c0-11-1-21 4-28z"
            fill="url(#hero-ghost)" stroke="#fff" strokeWidth="2"/>
          <path d="M232 132c0-3 2-5 4-5s4 2 4 5-2 5-4 5-4-2-4-5zm19 0c0-3 2-5 4-5s4 2 4 5-2 5-4 5-4-2-4-5z"
            fill="#282344"/>
          <path d="M240 148q5 5 10 0" stroke="#6B5B9B" strokeWidth="2" strokeLinecap="round"/>
          <path d="m360 99 5 10 11 1-8 7 2 11-10-5-10 5 2-11-8-7 11-1z"
            fill="#FF80B8" fillOpacity=".85"/>
          <circle cx="363" cy="110" r="18" stroke="#FF9BCB" strokeOpacity=".32"/>
          <circle cx="165" cy="202" r="2" fill="#B7ABFF"/>
          <circle cx="195" cy="221" r="1.5" fill="#8CEBFF"/>
          <circle cx="319" cy="219" r="2" fill="#FFB1D8"/>
        </svg>
      </div>
      <div className="panel">
        <div className="panel-head"><span>CHOOSE YOUR RUN</span></div>
        <label htmlFor="nickname">RACE NAME</label>
        <input id="nickname" maxLength={12} value={name} onChange={e=>setName(e.target.value)}
          onKeyDown={e=>{ if(e.key==='Enter' && connected) startSolo(); }}
          placeholder="Ghost name" autoComplete="username"/>
        <button className="primary" onClick={createRoom} disabled={!connected}>CREATE ROOM</button>
        <button className="secondary solo-button" onClick={startSolo} disabled={!connected}>SOLO RUN</button>
        <div className="divider"><span/>OR JOIN A FRIEND<span/></div>
        <label htmlFor="roomcode">ROOM CODE</label>
        <div className="join-row">
          <input id="roomcode" maxLength={6} value={codeInput} onChange={e=>setCodeInput(e.target.value.toUpperCase())}
            onKeyDown={e=>{ if(e.key==='Enter') joinRoom(); }}
            placeholder="ABC123" autoComplete="off" spellCheck={false}/>
          <button onClick={joinRoom} disabled={!connected}>JOIN</button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </section> : <section className="race">
      <div className="race-head">
        <div><small>{room.solo ? 'TIME TRIAL' : 'MULTIPLAYER ROOM'}</small><h2>{room.solo ? 'GHOST RUN' : <>GHOST <span>{room.code}</span></>}</h2></div>
        <div className="race-actions">
          {!room.solo && <button className="secondary" onClick={copyCode}>{copied ? 'COPIED ✓' : 'SHARE ROOM ↗'}</button>}
          <button className="subtle" onClick={leaveRoom}>LEAVE</button>
        </div>
      </div>
      <div className={`hud-strip has-laps ${room.solo ? '' : 'has-room'}`}>
        <div><small>RACE TIME</small><strong>{me?.finished ? `${finishTime.toFixed(2)}s` : elapsed.toFixed(2)+'s'}</strong></div>
        <div><small>{room.solo ? 'MODE' : 'RACERS'}</small><strong>{room.solo ? 'SOLO' : <>{room.players.length}<em> / 4</em></>}</strong></div>
        <div><small>STATUS</small><strong className="accent">{gameState?.status === 'racing' ? 'RACING' : gameState?.status === 'finished' ? 'FINISHED' : 'LOBBY'}</strong></div>
        <div><small>LAP</small><strong className="accent">{me?.finished ? totalLaps : Math.min(myLap + 1, totalLaps)}<em> / {totalLaps}</em></strong></div>
        {!room.solo && <div className="room-share"><small>GROUP CODE</small><strong>{room.code}</strong></div>}
      </div>
      <div ref={canvasShellRef} className={`game-stage${gameState?.status === 'racing' ? ' is-racing' : ''}`}>
        <div className="game-fullscreen">
          <Suspense fallback={<div className="game-loading" role="status"><span className="loading-orb" />LOADING THE HAUNTED CIRCUIT…</div>}>
            <GameCanvas state={gameState} myId={guestId} onHoldChange={holdChange}/>
          </Suspense>
          {room?.status === 'racing' && me && (
            <div className="ability-hud points-hud" aria-label="Race points and shield status">
              <div className="spirit-score-card">
                <span className="spirit-score-icon" aria-hidden="true">✦</span>
                <div className="spirit-score-copy">
                  <small>SPIRIT POINTS</small>
                  <strong>{(me.score ?? 0).toLocaleString()}</strong>
                  <span>+100 pts per spirit core · {(me.collectedOrbs ?? []).length} collected</span>
                </div>
              </div>
              <div className={`shield-status${me.shieldCharge ? ' active' : ''}`} title="Shield relic blocks one collision">
                <span aria-hidden="true">⬡</span><div><strong>{me.shieldCharge ? 'SHIELD READY' : 'SHIELD RELIC'}</strong><small>{me.shieldCharge ? 'Next hit absorbed' : 'Collect green relics'}</small></div>
              </div>
            </div>
          )}
          <div className="fullscreen-actions">
            <button className="icon-action" onClick={toggleFullscreen} aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
              {isFullscreen
                ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4m16 0h-5V4M4 15h5v5m6 0v-5h5"/></svg>
                : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5m6 0h5v5M20 15v5h-5m-6 0H4v-5"/></svg>}
            </button>
            <button className="icon-action" onClick={leaveRoom} aria-label="Leave race" title="Leave race">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5m5 5H3m9-9h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div className={`progress lap-progress ${me?.finished ? 'is-finished' : ''}`} aria-label={`Race progress: lap ${Math.min(myLap + 1, totalLaps)} of ${totalLaps}, ${Math.round(progress)} percent complete`}>
        <div className="lap-progress-heading"><span>HAUNTED CIRCUIT</span><strong>{me?.finished ? 'FINISH CLEARED' : `LAP ${Math.min(myLap + 1, totalLaps)} / ${totalLaps}`}</strong></div>
        <div className="lap-progress-track" role="img" aria-label={`${Math.round(progress)} percent complete`}>
          <i style={{width: `${progress}%`}} />
          <span className={myLap >= 0 ? 'passed' : ''}>01</span>
          <span className={myLap >= 1 ? 'passed' : ''}>02</span>
          <span className={myLap >= 2 || me?.finished ? 'passed' : ''}>03</span>
        </div>
        <div className="lap-progress-foot"><span>START GATE</span><b>{Math.round(progress)}% COMPLETE</b><span>FINISH GATE ✦</span></div>
      </div>
      {gameState?.status === 'racing' && <div className="control-tip"><p><kbd>SPACE</kbd> or hold to swing <span>·</span> release to launch <span>·</span> collect spirits for points</p></div>}
      {!room.solo && <div className="match-lobby">
        <div className="match-roster" aria-label="Players in this room">
          {room.players.map(player => <span className={`match-player${player.connected === false ? ' offline' : ''}`} key={player.id}>
            <i style={{ background: player.color }}/>
            {player.name}{player.id === guestId ? ' (YOU)' : ''}
            {player.connected === false ? <em>OFFLINE</em> : null}
            {player.id === room.hostId && <b>HOST</b>}
          </span>)}
        </div>
        {gameState?.status === 'waiting' && (isRoomHost
          ? <button className="primary match-start" onClick={startRace}>START MATCH</button>
          : <span className="match-waiting">WAITING FOR HOST TO START</span>)}
      </div>}
      {!room.solo && (
        <div className="room-chat" aria-label="Room chat">
          <div className="room-chat-head"><span>CHAT</span><em>{chatMessages.length}</em></div>
          <div className="room-chat-list" ref={chatListRef}>
            {chatMessages.length === 0 && <p className="room-chat-empty">Say hi to the room…</p>}
            {chatMessages.map(m => (
              <div className={`room-chat-line${m.playerId === guestId ? ' mine' : ''}`} key={m.id}>
                <b style={{ color: m.color }}>{m.name}</b>
                <span className="room-chat-text">{m.text}</span>
              </div>
            ))}
          </div>
          <form className="room-chat-form" onSubmit={e => { e.preventDefault(); sendChat(); }}>
            <input
              maxLength={80}
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              placeholder="Message…"
              autoComplete="off"
              aria-label="Chat message"
            />
            <button type="submit" disabled={!chatInput.trim() || !connected} aria-label="Send">↵</button>
          </form>
        </div>
      )}
      {!room.solo && standings.length > 0 && (
        <section className="race-standings" aria-label="Live player statistics">
          <div className="race-standings-head">
            <div><span>LIVE RACE DATA</span><h3>PLAYER STANDINGS</h3></div>
            <small>{standings.filter(player => player.finished).length} / {standings.length} FINISHED</small>
          </div>
          <div className="race-standings-columns" aria-hidden="true">
            <span>RANK / RACER</span><span>LAP</span><span>PROGRESS</span><span>STATUS</span><span>SCORE</span>
          </div>
          <div className="race-standings-list">
            {standings.map((player, index) => (
              <div
                className={`race-standing${player.id === guestId ? ' you' : ''}${player.finished ? ' finished' : ''}`}
                key={player.id}
                aria-label={`${player.name}${player.id === guestId ? ', you' : ''}, position ${player.rank ?? index + 1}, ${player.finished ? 'finished' : `lap ${Math.min((player.lap ?? 0) + 1, totalLaps)}, ${Math.round(player.progress)} percent complete`}`}
              >
                <div className="standing-racer">
                  <strong className={index === 0 ? 'leader' : ''}>{player.finished ? `#${player.rank ?? index + 1}` : `#${index + 1}`}</strong>
                  <i style={{ background: player.color }} />
                  <span>{player.name}{player.id === guestId ? <em>YOU</em> : null}</span>
                </div>
                <span className="standing-lap">{player.finished ? totalLaps : Math.min((player.lap ?? 0) + 1, totalLaps)}<small> / {totalLaps}</small></span>
                <div className="standing-progress">
                  <div><i style={{ width: `${player.progress}%`, background: player.color }} /></div>
                  <small>{Math.round(player.progress)}%</small>
                </div>
                <span className={`standing-status${player.finished ? ' done' : ''}`}>
                  {player.finished ? `${player.finishTime?.toFixed(2) ?? '—'}s` : player.connected === false ? 'OFFLINE' : 'RACING'}
                </span>
                <strong className="standing-score">{player.finished ? `${(player.score ?? 0).toLocaleString()} pts` : '—'}</strong>
              </div>
            ))}
          </div>
        </section>
      )}
      {me?.finished && (
        <section
          className={`results-showcase celebrate ${newBest ? 'new-best' : ''} ${!room.solo && me.rank === 1 ? 'is-winner' : ''}`}
          aria-live="polite"
          key={celebrateBurst}
        >
          <div className="results-confetti" aria-hidden="true">
            {Array.from({ length: 18 }, (_, i) => <i key={i} style={{ ['--i' as any]: i } as CSSProperties} />)}
          </div>
          <div className="results-heading">
            <span className="results-kicker">
              {newBest ? '✦ PERSONAL BEST ✦' : !room.solo && me.rank === 1 ? '👑 YOU TOOK THE CROWN' : 'ALL LAPS COMPLETE'}
            </span>
            <h2>
              {room.solo
                ? (newBest ? 'NEW RECORD!' : 'RUN COMPLETE')
                : me.rank === 1
                  ? 'VICTORY!'
                  : me.rank === 2
                    ? 'SECOND PLACE'
                    : me.rank === 3
                      ? 'THIRD PLACE'
                      : 'RACE COMPLETE'}
            </h2>
            <p>
              {newBest
                ? 'Your fastest haunt yet — keep swinging.'
                : !room.solo && me.rank === 1
                  ? `${me.name} owns this skyline.`
                  : `Nice run, ${me.name}.`}
            </p>
          </div>
          <div className="results-score">
            <span>FINAL SPIRIT POINTS</span>
            <strong className="score-pop">{displayScore.toLocaleString()}</strong>
            <small>SPIRIT POINTS</small>
            <div className="score-chips">
              <span>🏁 Laps</span>
              <span>✦ {(me.collectedOrbs ?? []).length} cores</span>
              <span>📍 Checks</span>
              {!room.solo && <span>🏆 Place</span>}
            </div>
          </div>
          <div className="results-stats">
            {!room.solo && (
              <div className="stat-rank">
                <span>PLACEMENT</span>
                <strong className={me.rank === 1 ? 'gold' : me.rank === 2 ? 'silver' : me.rank === 3 ? 'bronze' : ''}>
                  {me.rank ? `#${me.rank}` : '—'}
                </strong>
              </div>
            )}
            <div>
              <span>FINISH TIME</span>
              <strong>{finishTime.toFixed(2)}<small>s</small></strong>
            </div>
            {room.solo && (
              <div>
                <span>PERSONAL BEST</span>
                <strong>{bestTime === null ? '—' : <>{bestTime.toFixed(2)}<small>s</small></>}</strong>
              </div>
            )}
          </div>
          {!room.solo && gameState && (
            <div className="results-podium" aria-label="Race standings">
              {[...gameState.players]
                .filter(p => p.finished && p.rank != null)
                .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
                .map(p => (
                  <div
                    key={p.id}
                    className={`podium-row ${p.id === guestId ? 'you' : ''} ${p.rank === 1 ? 'first' : ''}`}
                  >
                    <em className={p.rank === 1 ? 'gold' : p.rank === 2 ? 'silver' : p.rank === 3 ? 'bronze' : ''}>
                      #{p.rank}
                    </em>
                    <i style={{ background: p.color }} />
                    <span>{p.name}{p.id === guestId ? ' (you)' : ''}</span>
                    <b>{(p.score ?? 0).toLocaleString()} pts</b>
                    <small>{p.finishTime != null ? `${p.finishTime.toFixed(2)}s` : '—'}</small>
                  </div>
                ))}
            </div>
          )}
          <div className="results-actions">
            <button
              type="button"
              className="primary results-again"
              onClick={resetRace}
              disabled={!room.solo && !isRoomHost}
            >
              {room.solo ? 'RACE AGAIN' : isRoomHost ? 'REMATCH' : 'WAITING FOR HOST'}
            </button>
          </div>
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </section>}
  </main>;
}
