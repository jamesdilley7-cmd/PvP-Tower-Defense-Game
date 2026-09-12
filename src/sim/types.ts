export type Team = 0 | 1;
export type Layer = 'ground' | 'air';
export type EntityKind = 'troop' | 'building' | 'tower';
export type TowerRole = 'keep' | 'outpost';
export type TargetPreference = 'any' | 'buildings';
export type MatchPhase = 'countdown' | 'normal' | 'overtime' | 'ended';

export interface Vec2 {
  x: number;
  y: number;
}

interface CardBase {
  id: string;
  name: string;
  cost: number;
  description: string;
}

export interface UnitCardDef extends CardBase {
  type: 'troop' | 'building';
  count: number;
  hp: number;
  damage: number;
  /** Seconds between attacks. */
  hitSpeed: number;
  /** Tiles per second. Zero for buildings. */
  speed: number;
  /** Edge-to-edge attack reach, in tiles. */
  range: number;
  /** Aggro radius, in tiles. */
  sight: number;
  radius: number;
  layer: Layer;
  hitsLayers: Layer[];
  targetPreference: TargetPreference;
  /** Buildings decay after this many seconds. Null means permanent. */
  lifetime: number | null;
}

export interface SpellCardDef extends CardBase {
  type: 'spell';
  damage: number;
  radius: number;
  hitsLayers: Layer[];
}

export type CardDef = UnitCardDef | SpellCardDef;

export interface TowerDef {
  role: TowerRole;
  hp: number;
  damage: number;
  hitSpeed: number;
  range: number;
  sight: number;
  radius: number;
}

export interface Entity {
  id: number;
  team: Team;
  kind: EntityKind;
  defId: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  radius: number;
  layer: Layer;
  speed: number;
  range: number;
  sight: number;
  damage: number;
  hitSpeed: number;
  hitsLayers: Layer[];
  targetPreference: TargetPreference;
  attackCooldown: number;
  /** Counts down before the entity can act at all. */
  deployTimer: number;
  lifetime: number | null;
  targetId: number | null;
  retargetTimer: number;
  towerRole: TowerRole | null;
  /** Keeps stay dormant until an outpost falls or they are hit directly. */
  dormant: boolean;
}

export interface ArenaSpec {
  width: number;
  height: number;
  riverMinY: number;
  riverMaxY: number;
  bridgeXs: number[];
  bridgeHalfWidth: number;
}

export interface EntitySnapshot {
  id: number;
  team: Team;
  kind: EntityKind;
  defId: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  layer: Layer;
  radius: number;
  deploying: boolean;
}

export interface EffectSnapshot {
  id: number;
  kind: 'spell';
  x: number;
  y: number;
  radius: number;
  /** 0 to 1, for fade-out rendering. */
  progress: number;
}

export interface PlayerSnapshot {
  elixir: number;
  hand: string[];
  nextCard: string;
  towersDestroyed: number;
}

export interface MatchSnapshot {
  tick: number;
  phase: MatchPhase;
  /** Seconds left in the current phase. */
  timeRemaining: number;
  entities: EntitySnapshot[];
  effects: EffectSnapshot[];
  players: [PlayerSnapshot, PlayerSnapshot];
}

export type MatchEndReason = 'keep-destroyed' | 'sudden-death' | 'towers' | 'tower-hp' | 'draw';

export interface MatchResult {
  winner: Team | null;
  reason: MatchEndReason;
  towersDestroyed: [number, number];
}

export type ClientMessage =
  | { t: 'queue'; mode: 'bot' | 'human'; name?: string }
  | { t: 'play'; cardId: string; x: number; y: number }
  | { t: 'leave' };

export type ServerMessage =
  | { t: 'waiting' }
  | {
      t: 'start';
      you: Team;
      opponentName: string;
      arena: ArenaSpec;
      cards: CardDef[];
      resourceName: string;
    }
  | { t: 'state'; snapshot: MatchSnapshot }
  | { t: 'rejected'; reason: string }
  | { t: 'end'; result: MatchResult };
