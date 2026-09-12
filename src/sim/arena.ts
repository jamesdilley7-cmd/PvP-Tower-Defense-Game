import type { ArenaSpec, Team, TowerRole, Vec2 } from './types.js';

export const ARENA: ArenaSpec = {
  width: 18,
  height: 32,
  riverMinY: 15.5,
  riverMaxY: 16.5,
  bridgeXs: [3.5, 14.5],
  bridgeHalfWidth: 1.0,
};

export const RIVER_MID_Y = (ARENA.riverMinY + ARENA.riverMaxY) / 2;

/** Team 0 defends the low-y end, team 1 the high-y end. */
export interface TowerPlacement {
  role: TowerRole;
  team: Team;
  x: number;
  y: number;
}

export const TOWER_PLACEMENTS: TowerPlacement[] = [
  { role: 'keep', team: 0, x: 9, y: 3 },
  { role: 'outpost', team: 0, x: 3.5, y: 7 },
  { role: 'outpost', team: 0, x: 14.5, y: 7 },
  { role: 'keep', team: 1, x: 9, y: 29 },
  { role: 'outpost', team: 1, x: 3.5, y: 25 },
  { role: 'outpost', team: 1, x: 14.5, y: 25 },
];

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function inRiver(y: number): boolean {
  return y > ARENA.riverMinY && y < ARENA.riverMaxY;
}

/** True when a straight line from one y to the other would cross open water. */
export function crossesRiver(fromY: number, toY: number): boolean {
  return (
    (fromY <= ARENA.riverMinY && toY >= ARENA.riverMaxY) ||
    (fromY >= ARENA.riverMaxY && toY <= ARENA.riverMinY)
  );
}

export function nearestBridge(x: number): Vec2 {
  let best = ARENA.bridgeXs[0] ?? ARENA.width / 2;
  let bestDist = Infinity;
  for (const bx of ARENA.bridgeXs) {
    const d = Math.abs(bx - x);
    if (d < bestDist) {
      bestDist = d;
      best = bx;
    }
  }
  return { x: best, y: RIVER_MID_Y };
}

/**
 * Ground units cannot swim, so a goal on the far bank routes through a bridge
 * first. Fliers ignore this entirely.
 */
export function waypointToward(from: Vec2, goal: Vec2, canFly: boolean): Vec2 {
  if (canFly || !crossesRiver(from.y, goal.y)) return goal;
  return nearestBridge(from.x);
}

/** Keeps a ground unit on the planks while it is inside the river band. */
export function clampToBridge(x: number, y: number): number {
  if (!inRiver(y)) return x;
  const bridge = nearestBridge(x);
  const min = bridge.x - ARENA.bridgeHalfWidth;
  const max = bridge.x + ARENA.bridgeHalfWidth;
  return Math.min(max, Math.max(min, x));
}

export function ownHalf(team: Team): { minY: number; maxY: number } {
  return team === 0
    ? { minY: 0.5, maxY: ARENA.riverMinY - 0.5 }
    : { minY: ARENA.riverMaxY + 0.5, maxY: ARENA.height - 0.5 };
}

export interface PlacementCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Spells reach anywhere; units may only be placed on their owner's half, clear
 * of the towers themselves.
 */
export function validatePlacement(team: Team, x: number, y: number, isSpell: boolean): PlacementCheck {
  if (x < 0.5 || x > ARENA.width - 0.5 || y < 0.5 || y > ARENA.height - 0.5) {
    return { ok: false, reason: 'Outside the arena' };
  }
  if (isSpell) return { ok: true };

  const half = ownHalf(team);
  if (y < half.minY || y > half.maxY) {
    return { ok: false, reason: 'You can only deploy on your own half' };
  }
  for (const tower of TOWER_PLACEMENTS) {
    if (distance({ x, y }, tower) < 2.0) {
      return { ok: false, reason: 'Too close to a tower' };
    }
  }
  return { ok: true };
}
