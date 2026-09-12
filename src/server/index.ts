import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import { ARENA } from '../sim/arena.js';
import { CARDS, RESOURCE_NAME, TICK_DT, TICK_RATE } from '../sim/content.js';
import { Match } from '../sim/match.js';
import type { ClientMessage, ServerMessage, Team } from '../sim/types.js';
import { Bot } from './bot.js';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// An explicit allowlist rather than joining user input onto a directory, so
// there is no path traversal surface here at all.
const STATIC_FILES: Record<string, { path: string; type: string }> = {
  '/': { path: 'src/client/index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { path: 'src/client/style.css', type: 'text/css; charset=utf-8' },
  '/client.js': { path: 'dist/client/client.js', type: 'text/javascript; charset=utf-8' },
};

interface Conn {
  ws: WebSocket;
  name: string;
  team: Team;
  room: Room | null;
}

class Room {
  private readonly match: Match;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly conns: Array<Conn | null>,
    private readonly bot: Bot | null,
    seed: number,
  ) {
    this.match = new Match(seed);
  }

  start(): void {
    for (const conn of this.conns) {
      if (!conn) continue;
      const opponent = this.conns.find((c) => c && c !== conn);
      send(conn.ws, {
        t: 'start',
        you: conn.team,
        opponentName: this.bot ? 'Sparring Bot' : (opponent?.name ?? 'Opponent'),
        arena: ARENA,
        cards: CARDS,
        resourceName: RESOURCE_NAME,
      });
    }
    this.timer = setInterval(() => this.step(), 1000 / TICK_RATE);
  }

  private step(): void {
    this.match.tick();
    const snapshot = this.match.snapshot();
    this.broadcast({ t: 'state', snapshot });

    if (this.bot) {
      const intent = this.bot.update(snapshot, TICK_DT);
      if (intent) this.match.playCard(1, intent.cardId, intent.x, intent.y);
    }

    if (this.match.result) {
      this.broadcast({ t: 'end', result: this.match.result });
      this.stop();
    }
  }

  play(team: Team, cardId: string, x: number, y: number): void {
    const result = this.match.playCard(team, cardId, x, y);
    if (!result.ok) {
      const conn = this.conns.find((c) => c?.team === team);
      if (conn) send(conn.ws, { t: 'rejected', reason: result.reason ?? 'Rejected' });
    }
  }

  handleDisconnect(leaver: Conn): void {
    for (const conn of this.conns) {
      if (!conn || conn === leaver) continue;
      send(conn.ws, {
        t: 'end',
        result: {
          winner: conn.team,
          reason: 'keep-destroyed',
          towersDestroyed: [0, 0],
        },
      });
    }
    this.stop();
  }

  private broadcast(message: ServerMessage): void {
    for (const conn of this.conns) {
      if (conn) send(conn.ws, message);
    }
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const conn of this.conns) {
      if (conn) conn.room = null;
    }
  }
}

let waiting: Conn | null = null;
let seedCounter = 1;

function startMatch(conn: Conn, mode: 'bot' | 'human'): void {
  if (mode === 'bot') {
    conn.team = 0;
    const room = new Room([conn, null], new Bot(1), seedCounter++);
    conn.room = room;
    room.start();
    return;
  }

  if (waiting && waiting !== conn && waiting.ws.readyState === waiting.ws.OPEN) {
    const host = waiting;
    waiting = null;
    host.team = 0;
    conn.team = 1;
    const room = new Room([host, conn], null, seedCounter++);
    host.room = room;
    conn.room = room;
    room.start();
    return;
  }

  waiting = conn;
  send(conn.ws, { t: 'waiting' });
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

/** Messages arrive from the network, so shape is checked before use. */
function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const msg = data as Record<string, unknown>;

  if (msg['t'] === 'queue') {
    const mode = msg['mode'] === 'bot' ? 'bot' : 'human';
    const name = typeof msg['name'] === 'string' ? msg['name'].slice(0, 24) : undefined;
    return { t: 'queue', mode, name };
  }
  if (msg['t'] === 'play') {
    const { cardId, x, y } = msg;
    if (typeof cardId !== 'string' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { t: 'play', cardId, x: x as number, y: y as number };
  }
  if (msg['t'] === 'leave') return { t: 'leave' };
  return null;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const file = STATIC_FILES[req.url ?? '/'];
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  try {
    const body = await readFile(resolve(ROOT, file.path));
    res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Failed to read asset. Run `npm run build` first.');
  }
}

const server = createServer((req, res) => {
  void handleHttp(req, res);
});
const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  const conn: Conn = { ws, name: 'Player', team: 0, room: null };

  ws.on('message', (raw: Buffer) => {
    const message = parseClientMessage(raw.toString());
    if (!message) return;

    if (message.t === 'queue') {
      if (conn.room) return;
      if (message.name) conn.name = message.name;
      startMatch(conn, message.mode);
    } else if (message.t === 'play') {
      conn.room?.play(conn.team, message.cardId, message.x, message.y);
    } else if (message.t === 'leave') {
      conn.room?.handleDisconnect(conn);
      if (waiting === conn) waiting = null;
    }
  });

  ws.on('close', () => {
    if (waiting === conn) waiting = null;
    conn.room?.handleDisconnect(conn);
  });
});

server.listen(PORT, () => {
  console.log(`Prototype running at http://localhost:${PORT}`);
  console.log('Open two tabs and pick "Find Match" to play human vs human.');
});
