import { ARENA, TOWER_PLACEMENTS, distance, ownHalf } from '../sim/arena.js';
import { getCard } from '../sim/content.js';
import type { CardDef, EntitySnapshot, MatchSnapshot, Team, Vec2 } from '../sim/types.js';

export interface PlayIntent {
  cardId: string;
  x: number;
  y: number;
}

/**
 * A sparring partner, not an opponent worth studying. It exists so the
 * prototype can be played and profiled by one person. Its intents go through
 * the same Match.playCard validation a human's do — it gets no shortcuts.
 */
export class Bot {
  private cooldown = 2;

  constructor(
    private readonly team: Team,
    private readonly random: () => number = Math.random,
  ) {}

  update(snapshot: MatchSnapshot, dt: number): PlayIntent | null {
    if (snapshot.phase === 'countdown' || snapshot.phase === 'ended') return null;
    this.cooldown -= dt;
    if (this.cooldown > 0) return null;

    const intent = this.decide(snapshot);
    this.cooldown = 1.2 + this.random() * 1.6;
    return intent;
  }

  private decide(snapshot: MatchSnapshot): PlayIntent | null {
    const me = snapshot.players[this.team];
    const half = ownHalf(this.team);
    const affordable = me.hand
      .map((id) => getCard(id))
      .filter((c): c is CardDef => c !== undefined && c.cost <= me.elixir);
    if (affordable.length === 0) return null;

    const threats = snapshot.entities.filter(
      (e) =>
        e.team !== this.team && e.kind === 'troop' && e.y >= half.minY - 1 && e.y <= half.maxY + 1,
    );

    if (threats.length > 0) {
      const defence = this.pickDefence(affordable, threats);
      if (defence) {
        if (defence.type === 'spell') {
          const centre = centroid(threats);
          return { cardId: defence.id, x: centre.x, y: centre.y };
        }
        const lead = this.leadThreat(threats);
        const y = this.team === 0 ? lead.y - 2.5 : lead.y + 2.5;
        return this.legalSpot(defence.id, lead.x, clamp(y, half.minY, half.maxY));
      }
    }

    // Nothing to answer: build a push rather than sitting on a full bar.
    if (me.elixir >= 7) {
      const units = affordable.filter((c) => c.type !== 'spell');
      const attacker = units.reduce<CardDef | null>(
        (best, c) => (best === null || c.cost > best.cost ? c : best),
        null,
      );
      if (attacker) {
        const lane = this.random() < 0.5 ? ARENA.bridgeXs[0] : ARENA.bridgeXs[1];
        const y = this.team === 0 ? half.maxY - 1 : half.minY + 1;
        return this.legalSpot(attacker.id, lane ?? ARENA.width / 2, y);
      }
    }
    return null;
  }

  private pickDefence(affordable: CardDef[], threats: EntitySnapshot[]): CardDef | null {
    const hasAir = threats.some((t) => t.layer === 'air');
    for (const card of affordable) {
      if (card.type === 'spell') {
        if (threats.length >= 3) return card;
        continue;
      }
      if (hasAir && !card.hitsLayers.includes('air')) continue;
      return card;
    }
    return null;
  }

  private leadThreat(threats: EntitySnapshot[]): EntitySnapshot {
    const keep = TOWER_PLACEMENTS.find((t) => t.team === this.team && t.role === 'keep');
    const origin: Vec2 = keep ?? { x: ARENA.width / 2, y: ARENA.height / 2 };
    return threats.reduce((closest, t) =>
      distance(t, origin) < distance(closest, origin) ? t : closest,
    );
  }

  /** Nudges a chosen point clear of towers so the placement check passes. */
  private legalSpot(cardId: string, x: number, y: number): PlayIntent {
    let px = clamp(x, 1, ARENA.width - 1);
    let py = y;
    for (const tower of TOWER_PLACEMENTS) {
      const d = distance({ x: px, y: py }, tower);
      if (d >= 2.2) continue;
      const dx = px - tower.x;
      const dy = py - tower.y;
      const len = Math.hypot(dx, dy) || 1;
      px = tower.x + (dx / len) * 2.2;
      py = tower.y + (dy / len) * 2.2;
    }
    const half = ownHalf(this.team);
    return {
      cardId,
      x: clamp(px, 1, ARENA.width - 1),
      y: clamp(py, half.minY, half.maxY),
    };
  }
}

function centroid(entities: EntitySnapshot[]): Vec2 {
  const sum = entities.reduce((acc, e) => ({ x: acc.x + e.x, y: acc.y + e.y }), { x: 0, y: 0 });
  return { x: sum.x / entities.length, y: sum.y / entities.length };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
