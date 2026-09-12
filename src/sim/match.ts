import {
  ARENA,
  TOWER_PLACEMENTS,
  clampToBridge,
  distance,
  validatePlacement,
  waypointToward,
} from './arena.js';
import {
  CARDS,
  COUNTDOWN_SECONDS,
  DEPLOY_DELAY,
  EFFECT_DURATION,
  ELIXIR_MAX,
  ELIXIR_SECONDS_PER,
  ELIXIR_START,
  HAND_SIZE,
  NORMAL_SECONDS,
  OVERTIME_ELIXIR_MULTIPLIER,
  OVERTIME_SECONDS,
  RETARGET_INTERVAL,
  TICK_DT,
  TICK_RATE,
  TOWERS,
  getCard,
} from './content.js';
import type {
  Entity,
  MatchPhase,
  MatchResult,
  MatchSnapshot,
  PlayerSnapshot,
  Team,
  Vec2,
} from './types.js';

export interface PlayResult {
  ok: boolean;
  reason?: string;
}

interface PlayerState {
  elixir: number;
  hand: string[];
  queue: string[];
}

interface Effect {
  id: number;
  x: number;
  y: number;
  radius: number;
  age: number;
}

const TOWERS_PER_TEAM = 3;

// Phase timing counts ticks rather than summing a float delta, so a long match
// cannot drift off the tuned clock.
const COUNTDOWN_TICKS = Math.round(COUNTDOWN_SECONDS * TICK_RATE);
const NORMAL_TICKS = Math.round(NORMAL_SECONDS * TICK_RATE);
const OVERTIME_TICKS = Math.round(OVERTIME_SECONDS * TICK_RATE);

/** Small deterministic PRNG so a given seed always produces the same match. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * The authoritative battle simulation. It knows nothing about networking: the
 * server drives it with tick() and relays snapshot(), which is what keeps the
 * same code testable headlessly and portable to a different transport later.
 */
export class Match {
  phase: MatchPhase = 'countdown';
  result: MatchResult | null = null;

  private tickCount = 0;
  private phaseTicks = 0;
  private entities: Entity[] = [];
  private effects: Effect[] = [];
  private players: [PlayerState, PlayerState];
  private nextEntityId = 1;
  private nextEffectId = 1;
  private overtimeBaseline: [number, number] = [0, 0];
  private random: () => number;

  constructor(seed = 1) {
    this.random = mulberry32(seed);
    this.players = [this.newPlayer(), this.newPlayer()];
    this.spawnTowers();
  }

  private newPlayer(): PlayerState {
    const deck = CARDS.map((c) => c.id);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const a = deck[i];
      const b = deck[j];
      if (a === undefined || b === undefined) continue;
      deck[i] = b;
      deck[j] = a;
    }
    return {
      elixir: ELIXIR_START,
      hand: deck.slice(0, HAND_SIZE),
      queue: deck.slice(HAND_SIZE),
    };
  }

  private spawnTowers(): void {
    for (const place of TOWER_PLACEMENTS) {
      const def = TOWERS[place.role];
      this.entities.push({
        id: this.nextEntityId++,
        team: place.team,
        kind: 'tower',
        defId: place.role,
        x: place.x,
        y: place.y,
        hp: def.hp,
        maxHp: def.hp,
        radius: def.radius,
        layer: 'ground',
        speed: 0,
        range: def.range,
        sight: def.sight,
        damage: def.damage,
        hitSpeed: def.hitSpeed,
        hitsLayers: ['ground', 'air'],
        targetPreference: 'any',
        attackCooldown: 0,
        deployTimer: 0,
        lifetime: null,
        targetId: null,
        retargetTimer: 0,
        towerRole: place.role,
        dormant: place.role === 'keep',
      });
    }
  }

  // --- public API -------------------------------------------------------

  playCard(team: Team, cardId: string, x: number, y: number): PlayResult {
    if (this.phase === 'ended') return { ok: false, reason: 'Match is over' };
    if (this.phase === 'countdown') return { ok: false, reason: 'Match has not started' };

    const player = this.players[team];
    const handIndex = player.hand.indexOf(cardId);
    if (handIndex === -1) return { ok: false, reason: 'That card is not in your hand' };

    const card = getCard(cardId);
    if (!card) return { ok: false, reason: 'Unknown card' };
    if (player.elixir < card.cost) return { ok: false, reason: 'Not enough elixir' };

    const placement = validatePlacement(team, x, y, card.type === 'spell');
    if (!placement.ok) return { ok: false, reason: placement.reason ?? 'Invalid placement' };

    player.elixir -= card.cost;
    this.cycleHand(player, handIndex);

    if (card.type === 'spell') {
      this.castSpell(team, card.damage, card.radius, card.hitsLayers, x, y);
    } else {
      const offsets = formationOffsets(card.count);
      for (const offset of offsets) {
        this.spawnUnit(team, card.id, x + offset.x, y + offset.y);
      }
    }
    return { ok: true };
  }

  tick(): void {
    if (this.phase === 'ended') return;
    this.tickCount++;
    this.phaseTicks++;

    this.advancePhase();
    if (this.result) return;

    if (this.phase !== 'countdown') {
      this.regenElixir();
      this.updateEntities();
      this.resolveDeaths();
      this.separate();
      this.checkVictory();
    }
    this.updateEffects();
  }

  snapshot(): MatchSnapshot {
    return {
      tick: this.tickCount,
      phase: this.phase,
      timeRemaining: this.timeRemaining(),
      entities: this.entities
        .filter((e) => e.hp > 0)
        .map((e) => ({
          id: e.id,
          team: e.team,
          kind: e.kind,
          defId: e.defId,
          x: round2(e.x),
          y: round2(e.y),
          hp: Math.ceil(e.hp),
          maxHp: e.maxHp,
          layer: e.layer,
          radius: e.radius,
          deploying: e.deployTimer > 0,
        })),
      effects: this.effects.map((f) => ({
        id: f.id,
        kind: 'spell' as const,
        x: round2(f.x),
        y: round2(f.y),
        radius: f.radius,
        progress: clamp(f.age / EFFECT_DURATION, 0, 1),
      })),
      players: [this.playerSnapshot(0), this.playerSnapshot(1)],
    };
  }

  /** Read-only view of the battlefield, for tests and future spectator tooling. */
  get battlefield(): readonly Entity[] {
    return this.entities;
  }

  towersDestroyedBy(team: Team): number {
    const opponent: Team = team === 0 ? 1 : 0;
    const alive = this.entities.filter((e) => e.kind === 'tower' && e.team === opponent && e.hp > 0);
    return TOWERS_PER_TEAM - alive.length;
  }

  // --- phase & clock ----------------------------------------------------

  private timeRemaining(): number {
    const duration =
      this.phase === 'countdown'
        ? COUNTDOWN_TICKS
        : this.phase === 'overtime'
          ? OVERTIME_TICKS
          : NORMAL_TICKS;
    return Math.max(0, (duration - this.phaseTicks) * TICK_DT);
  }

  private advancePhase(): void {
    if (this.phase === 'countdown' && this.phaseTicks >= COUNTDOWN_TICKS) {
      this.phase = 'normal';
      this.phaseTicks = 0;
      return;
    }
    if (this.phase === 'normal' && this.phaseTicks >= NORMAL_TICKS) {
      const a = this.towersDestroyedBy(0);
      const b = this.towersDestroyedBy(1);
      if (a !== b) {
        this.end(a > b ? 0 : 1, 'towers');
      } else {
        this.phase = 'overtime';
        this.phaseTicks = 0;
        this.overtimeBaseline = [a, b];
      }
      return;
    }
    if (this.phase === 'overtime' && this.phaseTicks >= OVERTIME_TICKS) {
      this.endByTowerHealth();
    }
  }

  private end(winner: Team | null, reason: MatchResult['reason']): void {
    this.phase = 'ended';
    this.result = {
      winner,
      reason,
      towersDestroyed: [this.towersDestroyedBy(0), this.towersDestroyedBy(1)],
    };
  }

  private endByTowerHealth(): void {
    const hp0 = this.totalTowerHp(0);
    const hp1 = this.totalTowerHp(1);
    if (hp0 === hp1) this.end(null, 'draw');
    else this.end(hp0 > hp1 ? 0 : 1, 'tower-hp');
  }

  private totalTowerHp(team: Team): number {
    return this.entities
      .filter((e) => e.kind === 'tower' && e.team === team && e.hp > 0)
      .reduce((sum, e) => sum + e.hp, 0);
  }

  private checkVictory(): void {
    for (const e of this.entities) {
      if (e.towerRole === 'keep' && e.hp <= 0) {
        this.end(e.team === 0 ? 1 : 0, 'keep-destroyed');
        return;
      }
    }
    if (this.phase === 'overtime') {
      const a = this.towersDestroyedBy(0);
      const b = this.towersDestroyedBy(1);
      const [baseA, baseB] = this.overtimeBaseline;
      if (a > baseA && a > b) return this.end(0, 'sudden-death');
      if (b > baseB && b > a) return this.end(1, 'sudden-death');
    }
  }

  // --- per-tick systems -------------------------------------------------

  private regenElixir(): void {
    const perSecond =
      (this.phase === 'overtime' ? OVERTIME_ELIXIR_MULTIPLIER : 1) / ELIXIR_SECONDS_PER;
    for (const player of this.players) {
      player.elixir = Math.min(ELIXIR_MAX, player.elixir + perSecond * TICK_DT);
    }
  }

  private updateEntities(): void {
    for (const e of this.entities) {
      if (e.hp <= 0) continue;

      if (e.lifetime !== null) {
        e.lifetime -= TICK_DT;
        if (e.lifetime <= 0) {
          e.hp = 0;
          continue;
        }
      }

      if (e.deployTimer > 0) {
        e.deployTimer -= TICK_DT;
        continue;
      }
      if (e.dormant) continue;

      e.retargetTimer -= TICK_DT;
      const current = e.targetId === null ? undefined : this.byId(e.targetId);
      if (!current || current.hp <= 0 || e.retargetTimer <= 0) {
        e.targetId = this.acquireTarget(e);
        e.retargetTimer = RETARGET_INTERVAL;
      }

      const target = e.targetId === null ? undefined : this.byId(e.targetId);
      if (!target || target.hp <= 0) continue;

      const gap = distance(e, target) - e.radius - target.radius;
      if (gap <= e.range) {
        e.attackCooldown -= TICK_DT;
        if (e.attackCooldown <= 0) {
          this.dealDamage(target, e.damage);
          e.attackCooldown = e.hitSpeed;
        }
      } else {
        e.attackCooldown = Math.max(0, e.attackCooldown - TICK_DT);
        this.moveToward(e, target);
      }
    }
  }

  private acquireTarget(e: Entity): number | null {
    let best: Entity | null = null;
    let bestGap = Infinity;
    let fallbackTower: Entity | null = null;
    let fallbackGap = Infinity;

    for (const other of this.entities) {
      if (other.team === e.team || other.hp <= 0) continue;
      if (!e.hitsLayers.includes(other.layer)) continue;
      if (e.targetPreference === 'buildings' && other.kind === 'troop') continue;

      const gap = distance(e, other) - e.radius - other.radius;
      if (other.kind === 'tower' && gap < fallbackGap) {
        fallbackGap = gap;
        fallbackTower = other;
      }
      if (gap <= e.sight && gap < bestGap) {
        bestGap = gap;
        best = other;
      }
    }

    if (best) return best.id;
    // Static defenders hold position rather than marching at a distant tower.
    if (e.speed > 0 && fallbackTower) return fallbackTower.id;
    return null;
  }

  private moveToward(e: Entity, target: Entity): void {
    if (e.speed <= 0) return;
    const goal = waypointToward(e, target, e.layer === 'air');
    const dx = goal.x - e.x;
    const dy = goal.y - e.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return;

    const step = e.speed * TICK_DT;
    let nx = e.x + (dx / d) * step;
    const ny = e.y + (dy / d) * step;
    if (e.layer === 'ground') nx = clampToBridge(nx, ny);
    e.x = clamp(nx, e.radius, ARENA.width - e.radius);
    e.y = clamp(ny, e.radius, ARENA.height - e.radius);
  }

  /** Push overlapping units apart so pushes spread out instead of stacking. */
  private separate(): void {
    const alive = this.entities.filter((e) => e.hp > 0);
    for (const a of alive) {
      if (a.kind !== 'troop' || a.deployTimer > 0) continue;
      for (const b of alive) {
        if (a === b || a.layer !== b.layer) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const minD = a.radius + b.radius;
        if (d >= minD) continue;
        if (d < 1e-6) {
          // Deterministic nudge for perfectly stacked spawns.
          const angle = ((a.id % 8) / 8) * Math.PI * 2;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          d = 1;
        }
        // A troop meeting another troop splits the correction, since the other
        // one applies its own half on its pass. Static targets never budge.
        const share = b.kind === 'troop' ? 0.5 : 1;
        const overlap = (minD - d) * share;
        let nx = a.x - (dx / d) * overlap;
        const ny = a.y - (dy / d) * overlap;
        if (a.layer === 'ground') nx = clampToBridge(nx, ny);
        a.x = clamp(nx, a.radius, ARENA.width - a.radius);
        a.y = clamp(ny, a.radius, ARENA.height - a.radius);
      }
    }
  }

  private resolveDeaths(): void {
    const dead = this.entities.filter((e) => e.hp <= 0);
    if (dead.length === 0) return;
    for (const e of dead) {
      // Losing an outpost rouses that side's keep.
      if (e.towerRole === 'outpost') {
        for (const other of this.entities) {
          if (other.team === e.team && other.towerRole === 'keep') other.dormant = false;
        }
      }
    }
    // Keeps stay in the list so checkVictory can see the destroyed one.
    this.entities = this.entities.filter((e) => e.hp > 0 || e.towerRole === 'keep');
  }

  private updateEffects(): void {
    for (const f of this.effects) f.age += TICK_DT;
    this.effects = this.effects.filter((f) => f.age < EFFECT_DURATION);
  }

  // --- spawning & damage ------------------------------------------------

  private spawnUnit(team: Team, cardId: string, x: number, y: number): void {
    const card = getCard(cardId);
    if (!card || card.type === 'spell') return;
    this.entities.push({
      id: this.nextEntityId++,
      team,
      kind: card.type,
      defId: card.id,
      x: clamp(x, card.radius, ARENA.width - card.radius),
      y: clamp(y, card.radius, ARENA.height - card.radius),
      hp: card.hp,
      maxHp: card.hp,
      radius: card.radius,
      layer: card.layer,
      speed: card.speed,
      range: card.range,
      sight: card.sight,
      damage: card.damage,
      hitSpeed: card.hitSpeed,
      hitsLayers: card.hitsLayers,
      targetPreference: card.targetPreference,
      attackCooldown: 0,
      deployTimer: DEPLOY_DELAY,
      lifetime: card.lifetime,
      targetId: null,
      retargetTimer: 0,
      towerRole: null,
      dormant: false,
    });
  }

  private castSpell(
    team: Team,
    damage: number,
    radius: number,
    hitsLayers: readonly string[],
    x: number,
    y: number,
  ): void {
    for (const e of this.entities) {
      if (e.team === team || e.hp <= 0) continue;
      if (!hitsLayers.includes(e.layer)) continue;
      if (distance(e, { x, y }) <= radius + e.radius) {
        this.dealDamage(e, damage);
      }
    }
    this.effects.push({ id: this.nextEffectId++, x, y, radius, age: 0 });
  }

  private dealDamage(target: Entity, amount: number): void {
    if (target.hp <= 0) return;
    target.hp -= amount;
    // Hitting a keep directly wakes it even if both outposts still stand.
    if (target.towerRole === 'keep') target.dormant = false;
  }

  // --- helpers ----------------------------------------------------------

  private byId(id: number): Entity | undefined {
    return this.entities.find((e) => e.id === id);
  }

  private cycleHand(player: PlayerState, handIndex: number): void {
    const played = player.hand[handIndex];
    if (played === undefined) return;
    const drawn = player.queue.shift();
    if (drawn === undefined) return;
    player.hand[handIndex] = drawn;
    player.queue.push(played);
  }

  private playerSnapshot(team: Team): PlayerSnapshot {
    const player = this.players[team];
    return {
      elixir: round2(player.elixir),
      hand: [...player.hand],
      nextCard: player.queue[0] ?? '',
      towersDestroyed: this.towersDestroyedBy(team),
    };
  }
}

function formationOffsets(count: number): Vec2[] {
  if (count <= 1) return [{ x: 0, y: 0 }];
  const radius = count <= 2 ? 0.5 : 0.7;
  const offsets: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.PI / 4;
    offsets.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return offsets;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
