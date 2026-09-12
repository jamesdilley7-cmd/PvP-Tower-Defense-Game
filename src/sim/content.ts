// Every name, cost and stat in the prototype lives in this file. Rename or
// retune here and both the server and the browser client pick it up — the
// client is sent the card list at match start rather than hardcoding it.

import type { CardDef, TowerDef } from './types.js';

export const GAME_NAME = 'Tower Clash';
export const RESOURCE_NAME = 'Elixir';

export const TICK_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;

export const ELIXIR_MAX = 10;
export const ELIXIR_START = 5;
export const ELIXIR_SECONDS_PER = 2.8;
export const OVERTIME_ELIXIR_MULTIPLIER = 2;

export const COUNTDOWN_SECONDS = 3;
export const NORMAL_SECONDS = 120;
export const OVERTIME_SECONDS = 60;

export const HAND_SIZE = 4;
/** Units stand idle for this long after being placed, so blocks can't be instant. */
export const DEPLOY_DELAY = 1.0;
export const RETARGET_INTERVAL = 0.25;
export const EFFECT_DURATION = 0.4;

export const TOWERS: Record<'keep' | 'outpost', TowerDef> = {
  outpost: {
    role: 'outpost',
    hp: 1400,
    damage: 72,
    hitSpeed: 0.8,
    range: 7.5,
    sight: 7.5,
    radius: 0.9,
  },
  keep: {
    role: 'keep',
    hp: 2600,
    damage: 120,
    hitSpeed: 1.0,
    range: 7.0,
    sight: 7.0,
    radius: 1.2,
  },
};

export const CARDS: CardDef[] = [
  {
    id: 'footmen',
    name: 'Footmen',
    cost: 3,
    type: 'troop',
    count: 3,
    hp: 300,
    damage: 70,
    hitSpeed: 1.1,
    speed: 2.4,
    range: 0.9,
    sight: 5.5,
    radius: 0.5,
    layer: 'ground',
    hitsLayers: ['ground'],
    targetPreference: 'any',
    lifetime: null,
    description: 'Three melee grunts. Cheap pressure and a solid block.',
  },
  {
    id: 'archers',
    name: 'Archers',
    cost: 3,
    type: 'troop',
    count: 2,
    hp: 190,
    damage: 65,
    hitSpeed: 1.2,
    speed: 2.2,
    range: 5.5,
    sight: 6.5,
    radius: 0.4,
    layer: 'ground',
    hitsLayers: ['ground', 'air'],
    targetPreference: 'any',
    lifetime: null,
    description: 'Fragile ranged pair. Your only sustained answer to air.',
  },
  {
    id: 'brute',
    name: 'Brute',
    cost: 5,
    type: 'troop',
    count: 1,
    hp: 1800,
    damage: 190,
    hitSpeed: 1.5,
    speed: 1.4,
    range: 1.0,
    sight: 5.0,
    radius: 0.8,
    layer: 'ground',
    hitsLayers: ['ground'],
    targetPreference: 'buildings',
    lifetime: null,
    description: 'Slow, huge, ignores troops entirely. Walks at your towers.',
  },
  {
    id: 'bats',
    name: 'Bats',
    cost: 2,
    type: 'troop',
    count: 4,
    hp: 90,
    damage: 45,
    hitSpeed: 1.0,
    speed: 3.6,
    range: 0.8,
    sight: 5.5,
    radius: 0.35,
    layer: 'air',
    hitsLayers: ['ground', 'air'],
    targetPreference: 'any',
    lifetime: null,
    description: 'Four fast fliers. Shred anything that cannot shoot up.',
  },
  {
    id: 'cannon',
    name: 'Cannon',
    cost: 3,
    type: 'building',
    count: 1,
    hp: 560,
    damage: 90,
    hitSpeed: 0.9,
    speed: 0,
    range: 6.0,
    sight: 6.0,
    radius: 0.6,
    layer: 'ground',
    hitsLayers: ['ground'],
    targetPreference: 'any',
    lifetime: 30,
    description: 'Defensive emplacement. Pulls ground pushes away from towers.',
  },
  {
    id: 'fireball',
    name: 'Fireball',
    cost: 4,
    type: 'spell',
    damage: 340,
    radius: 2.5,
    hitsLayers: ['ground', 'air'],
    description: 'Instant area damage anywhere on the map. Clears swarms.',
  },
];

export const CARDS_BY_ID: Map<string, CardDef> = new Map(CARDS.map((c) => [c.id, c]));

export function getCard(id: string): CardDef | undefined {
  return CARDS_BY_ID.get(id);
}
