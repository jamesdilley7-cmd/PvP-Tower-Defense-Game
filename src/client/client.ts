import type {
  ArenaSpec,
  CardDef,
  EntitySnapshot,
  MatchResult,
  MatchSnapshot,
  PlayerSnapshot,
  ServerMessage,
  Team,
} from '../sim/types.js';

// A throwaway debug client: it renders exactly what the server sends, with no
// prediction or interpolation. Its job is to make the battle loop playable so
// the rules can be judged before any of this is rebuilt in Unity.

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const lobby = el('lobby');
const battle = el('battle');
const resultOverlay = el('result');
const canvas = el<HTMLCanvasElement>('arena');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas 2D unavailable');

const nameInput = el<HTMLInputElement>('name');
const lobbyStatus = el('lobby-status');
const handEl = el('hand');
const hintEl = el('hint');
const timerEl = el('timer');
const phaseEl = el('phase');
const elixirFill = el('elixir-fill');
const elixirValue = el('elixir-value');
const crownsYou = el('crowns-you');
const crownsThem = el('crowns-them');
const opponentNameEl = el('opponent-name');

let socket: WebSocket | null = null;
let myTeam: Team = 0;
let arena: ArenaSpec | null = null;
let cards = new Map<string, CardDef>();
let resourceName = 'Elixir';
let snapshot: MatchSnapshot | null = null;
let selectedCard: string | null = null;
let lastAttempted: string | null = null;
let renderedHand = '';
let tile = 20;
let originX = 0;
let originY = 0;

const TEAM_COLOURS: Record<'mine' | 'theirs', string> = {
  mine: '#4a9de0',
  theirs: '#e0604a',
};

// --- networking ---------------------------------------------------------

function connect(mode: 'bot' | 'human'): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}`);
  lobbyStatus.textContent = 'Connecting…';

  socket.addEventListener('open', () => {
    lobbyStatus.textContent = mode === 'bot' ? 'Starting match…' : 'Looking for an opponent…';
    send({ t: 'queue', mode, name: nameInput.value || 'Player' });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    handleMessage(message);
  });

  socket.addEventListener('close', () => {
    lobbyStatus.textContent = 'Disconnected.';
  });
}

function send(message: { t: 'queue'; mode: 'bot' | 'human'; name: string } | { t: 'play'; cardId: string; x: number; y: number }): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function handleMessage(message: ServerMessage): void {
  switch (message.t) {
    case 'waiting':
      lobbyStatus.textContent = 'Waiting for another player… open a second tab to pair up.';
      break;
    case 'start':
      myTeam = message.you;
      arena = message.arena;
      cards = new Map(message.cards.map((c) => [c.id, c]));
      resourceName = message.resourceName;
      opponentNameEl.textContent = message.opponentName;
      hintEl.textContent = `Pick a card, then tap your half of the arena.`;
      lobby.hidden = true;
      battle.hidden = false;
      resultOverlay.hidden = true;
      renderedHand = '';
      resize();
      break;
    case 'state':
      snapshot = message.snapshot;
      break;
    case 'rejected':
      hintEl.textContent = message.reason;
      hintEl.classList.add('error');
      if (lastAttempted) selectedCard = lastAttempted;
      break;
    case 'end':
      showResult(message.result);
      break;
  }
}

// --- input --------------------------------------------------------------

el<HTMLButtonElement>('play-bot').addEventListener('click', () => connect('bot'));
el<HTMLButtonElement>('play-human').addEventListener('click', () => connect('human'));
el<HTMLButtonElement>('again').addEventListener('click', () => location.reload());

canvas.addEventListener('pointerdown', (event) => {
  if (!arena || !selectedCard) {
    hintEl.textContent = 'Pick a card first.';
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const point = toArena(event.clientX - rect.left, event.clientY - rect.top);
  lastAttempted = selectedCard;
  send({ t: 'play', cardId: selectedCard, x: point.x, y: point.y });
  selectedCard = null;
  // Assume it lands; a 'rejected' message overwrites this with the reason.
  hintEl.classList.remove('error');
  hintEl.textContent = 'Pick a card, then tap your half of the arena.';
});

// --- coordinate mapping -------------------------------------------------

/** The viewer's own side is always drawn at the bottom, so team 1 sees a flipped board. */
function toScreen(x: number, y: number): { sx: number; sy: number } {
  if (!arena) return { sx: 0, sy: 0 };
  const ax = myTeam === 1 ? arena.width - x : x;
  const ay = myTeam === 1 ? arena.height - y : y;
  return { sx: originX + ax * tile, sy: originY + (arena.height - ay) * tile };
}

function toArena(sx: number, sy: number): { x: number; y: number } {
  if (!arena) return { x: 0, y: 0 };
  const ax = (sx - originX) / tile;
  const ay = arena.height - (sy - originY) / tile;
  return {
    x: myTeam === 1 ? arena.width - ax : ax,
    y: myTeam === 1 ? arena.height - ay : ay,
  };
}

function resize(): void {
  if (!arena) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);

  tile = Math.min(width / arena.width, height / arena.height);
  originX = (width - arena.width * tile) / 2;
  originY = (height - arena.height * tile) / 2;
}

window.addEventListener('resize', resize);

// --- rendering ----------------------------------------------------------

function drawArena(): void {
  if (!ctx || !arena) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  // Grass, split so each half reads as owned territory.
  const topHalf = toScreen(0, arena.height);
  const mid = toScreen(0, arena.riverMaxY);
  const bottom = toScreen(0, 0);
  ctx.fillStyle = '#1d2a22';
  ctx.fillRect(originX, topHalf.sy, arena.width * tile, mid.sy - topHalf.sy);
  ctx.fillStyle = '#22301f';
  ctx.fillRect(originX, mid.sy, arena.width * tile, bottom.sy - mid.sy);

  // River and bridges.
  const riverTop = toScreen(0, arena.riverMaxY);
  const riverBottom = toScreen(0, arena.riverMinY);
  ctx.fillStyle = '#1b3d52';
  ctx.fillRect(originX, riverTop.sy, arena.width * tile, riverBottom.sy - riverTop.sy);
  ctx.fillStyle = '#5a4630';
  for (const bx of arena.bridgeXs) {
    const left = toScreen(bx - arena.bridgeHalfWidth, arena.riverMaxY);
    const right = toScreen(bx + arena.bridgeHalfWidth, arena.riverMaxY);
    const x = Math.min(left.sx, right.sx);
    ctx.fillRect(x, riverTop.sy, Math.abs(right.sx - left.sx), riverBottom.sy - riverTop.sy);
  }

  if (selectedCard) drawDeployZone();
}

function drawDeployZone(): void {
  if (!ctx || !arena || !selectedCard) return;
  const card = cards.get(selectedCard);
  if (!card) return;

  ctx.fillStyle = 'rgba(216, 162, 58, 0.10)';
  if (card.type === 'spell') {
    ctx.fillRect(originX, originY, arena.width * tile, arena.height * tile);
    return;
  }
  const minY = myTeam === 0 ? 0.5 : arena.riverMaxY + 0.5;
  const maxY = myTeam === 0 ? arena.riverMinY - 0.5 : arena.height - 0.5;
  const a = toScreen(0.5, minY);
  const b = toScreen(arena.width - 0.5, maxY);
  ctx.fillRect(
    Math.min(a.sx, b.sx),
    Math.min(a.sy, b.sy),
    Math.abs(b.sx - a.sx),
    Math.abs(b.sy - a.sy),
  );
}

function drawEntity(e: EntitySnapshot): void {
  if (!ctx) return;
  const { sx, sy } = toScreen(e.x, e.y);
  const r = e.radius * tile;
  const colour = e.team === myTeam ? TEAM_COLOURS.mine : TEAM_COLOURS.theirs;

  ctx.globalAlpha = e.deploying ? 0.45 : 1;

  if (e.kind === 'tower') {
    ctx.fillStyle = colour;
    ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
    ctx.strokeStyle = '#0d1117';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx - r, sy - r, r * 2, r * 2);
  } else if (e.kind === 'building') {
    ctx.fillStyle = colour;
    ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
  } else {
    if (e.layer === 'air') {
      // A shadow under fliers so altitude reads at a glance.
      ctx.globalAlpha = (e.deploying ? 0.45 : 1) * 0.3;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(sx, sy + r * 0.9, r * 0.8, r * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = e.deploying ? 0.45 : 1;
    }
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    if (e.layer === 'air') {
      ctx.strokeStyle = '#e8edf2';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Health bar.
  if (e.hp < e.maxHp) {
    const barWidth = Math.max(r * 2, 14);
    const barY = sy - r - 7;
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(sx - barWidth / 2, barY, barWidth, 4);
    ctx.fillStyle = colour;
    ctx.fillRect(sx - barWidth / 2, barY, barWidth * (e.hp / e.maxHp), 4);
  }
  ctx.globalAlpha = 1;
}

function drawEffects(current: MatchSnapshot): void {
  if (!ctx) return;
  for (const effect of current.effects) {
    const { sx, sy } = toScreen(effect.x, effect.y);
    ctx.globalAlpha = 1 - effect.progress;
    ctx.strokeStyle = '#f0a03a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sx, sy, effect.radius * tile * (0.6 + effect.progress * 0.4), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function updateHud(current: MatchSnapshot): void {
  const me = current.players[myTeam];
  const them = current.players[myTeam === 0 ? 1 : 0];

  const seconds = Math.ceil(current.timeRemaining);
  timerEl.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  phaseEl.textContent =
    current.phase === 'countdown' ? 'Get ready' : current.phase === 'overtime' ? 'Overtime' : '';

  crownsYou.textContent = String(me.towersDestroyed);
  crownsThem.textContent = String(them.towersDestroyed);

  elixirFill.style.width = `${(me.elixir / 10) * 100}%`;
  elixirValue.textContent = `${Math.floor(me.elixir)} ${resourceName}`;

  updateHand(me);
}

function updateHand(me: PlayerSnapshot): void {
  const key = me.hand.join(',');
  if (key !== renderedHand) {
    renderedHand = key;
    handEl.replaceChildren();
    for (const cardId of me.hand) {
      const card = cards.get(cardId);
      if (!card) continue;
      const button = document.createElement('button');
      button.className = 'card';
      button.dataset['cardId'] = cardId;
      button.title = card.description;

      const name = document.createElement('span');
      name.textContent = card.name;
      const cost = document.createElement('span');
      cost.className = 'cost';
      cost.textContent = String(card.cost);

      button.append(name, cost);
      button.addEventListener('click', () => {
        selectedCard = selectedCard === cardId ? null : cardId;
        hintEl.classList.remove('error');
        hintEl.textContent = selectedCard
          ? `Tap the arena to deploy ${card.name}.`
          : 'Pick a card, then tap your half of the arena.';
      });
      handEl.append(button);
    }
    if (selectedCard && !me.hand.includes(selectedCard)) selectedCard = null;
  }

  for (const node of Array.from(handEl.children)) {
    const button = node as HTMLButtonElement;
    const cardId = button.dataset['cardId'];
    const card = cardId ? cards.get(cardId) : undefined;
    if (!card) continue;
    button.disabled = me.elixir < card.cost;
    button.classList.toggle('selected', selectedCard === cardId);
  }
}

function showResult(result: MatchResult): void {
  const title =
    result.winner === null ? 'Draw' : result.winner === myTeam ? 'Victory' : 'Defeat';
  el('result-title').textContent = title;
  const reasons: Record<MatchResult['reason'], string> = {
    'keep-destroyed': 'The Keep fell.',
    'sudden-death': 'First tower down in overtime.',
    towers: 'Won on towers destroyed.',
    'tower-hp': 'Won on remaining tower health.',
    draw: 'Both sides finished dead level.',
  };
  el('result-detail').textContent = reasons[result.reason];
  resultOverlay.hidden = false;
}

function frame(): void {
  if (arena && snapshot) {
    if (canvas.width === 0) resize();
    drawArena();
    for (const entity of snapshot.entities) drawEntity(entity);
    drawEffects(snapshot);
    updateHud(snapshot);
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
