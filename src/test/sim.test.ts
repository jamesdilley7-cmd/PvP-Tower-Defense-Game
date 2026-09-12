import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARENA, nearestBridge, ownHalf } from '../sim/arena.js';
import {
  COUNTDOWN_SECONDS,
  ELIXIR_SECONDS_PER,
  ELIXIR_START,
  HAND_SIZE,
  TICK_DT,
  getCard,
} from '../sim/content.js';
import { Match } from '../sim/match.js';
import type { CardDef, Team } from '../sim/types.js';

function advance(match: Match, seconds: number): void {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) match.tick();
}

/** Starts a match and runs out the countdown so cards can be played. */
function liveMatch(seed = 1): Match {
  const match = new Match(seed);
  advance(match, COUNTDOWN_SECONDS);
  return match;
}

/** Finds a seed whose opening hands satisfy a scenario's card requirements. */
function findSeed(predicate: (match: Match) => boolean): number {
  for (let seed = 1; seed < 500; seed++) {
    if (predicate(liveMatch(seed))) return seed;
  }
  throw new Error('No seed produced the required opening hands');
}

function handOf(match: Match, team: Team): string[] {
  return match.snapshot().players[team].hand;
}

function cost(cardId: string): number {
  const card = getCard(cardId);
  assert.ok(card, `card ${cardId} exists`);
  return card.cost;
}

describe('arena setup', () => {
  it('spawns six towers, three per team', () => {
    const match = new Match(1);
    const towers = match.snapshot().entities.filter((e) => e.kind === 'tower');
    assert.equal(towers.length, 6);
    assert.equal(towers.filter((t) => t.team === 0).length, 3);
    assert.equal(towers.filter((t) => t.team === 1).length, 3);
  });

  it('gives each player a full hand and a next card', () => {
    const snapshot = new Match(1).snapshot();
    for (const player of snapshot.players) {
      assert.equal(player.hand.length, HAND_SIZE);
      assert.notEqual(player.nextCard, '');
      assert.equal(new Set(player.hand).size, HAND_SIZE, 'hand has no duplicates');
    }
  });

  it('deals the same opening hand for the same seed', () => {
    assert.deepEqual(handOf(new Match(42), 0), handOf(new Match(42), 0));
    assert.notDeepEqual(handOf(new Match(1), 0), handOf(new Match(1), 1));
  });
});

describe('match clock', () => {
  it('holds in countdown before starting', () => {
    const match = new Match(1);
    assert.equal(match.snapshot().phase, 'countdown');
    advance(match, COUNTDOWN_SECONDS - 0.2);
    assert.equal(match.snapshot().phase, 'countdown');
    advance(match, 0.4);
    assert.equal(match.snapshot().phase, 'normal');
  });

  it('rejects plays before the match starts', () => {
    const match = new Match(1);
    const card = handOf(match, 0)[0];
    assert.ok(card);
    const result = match.playCard(0, card, 9, 5);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /not started/i);
  });
});

describe('elixir', () => {
  it('regenerates at the tuned rate', () => {
    const match = liveMatch();
    const before = match.snapshot().players[0].elixir;
    advance(match, ELIXIR_SECONDS_PER);
    const after = match.snapshot().players[0].elixir;
    assert.ok(
      Math.abs(after - before - 1) < 0.05,
      `expected roughly +1 elixir, got ${(after - before).toFixed(3)}`,
    );
  });

  it('deducts the cost and cycles the hand when a card is played', () => {
    const match = liveMatch();
    const hand = handOf(match, 0);
    const played = hand.find((id) => cost(id) <= ELIXIR_START);
    assert.ok(played, 'an affordable card is in the opening hand');

    const elixirBefore = match.snapshot().players[0].elixir;
    const nextCard = match.snapshot().players[0].nextCard;
    const result = match.playCard(0, played, 9, 5);
    assert.equal(result.ok, true);

    const after = match.snapshot().players[0];
    assert.ok(Math.abs(elixirBefore - cost(played) - after.elixir) < 0.001);
    assert.ok(!after.hand.includes(played), 'played card left the hand');
    assert.ok(after.hand.includes(nextCard), 'the queued card was drawn');
  });

  it('rejects a card the player cannot afford', () => {
    const seed = findSeed((m) => handOf(m, 0).includes('brute'));
    const match = liveMatch(seed);

    // Spending anything at all puts the most expensive card out of reach.
    const cheapest = handOf(match, 0)
      .filter((id) => id !== 'brute')
      .reduce((a, b) => (cost(a) <= cost(b) ? a : b));
    assert.equal(match.playCard(0, cheapest, 9, 5).ok, true);
    assert.ok(match.snapshot().players[0].elixir < cost('brute'));

    const result = match.playCard(0, 'brute', 9, 6);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /elixir/i);
  });
});

describe('placement rules', () => {
  it('refuses troop placement on the opponent half', () => {
    const seed = findSeed((m) =>
      handOf(m, 0).some((id) => getCard(id)?.type !== 'spell' && cost(id) <= ELIXIR_START),
    );
    const match = liveMatch(seed);
    const troop = handOf(match, 0).find(
      (id) => getCard(id)?.type !== 'spell' && cost(id) <= ELIXIR_START,
    );
    assert.ok(troop);
    const enemyHalf = ownHalf(1);
    const result = match.playCard(0, troop, 9, enemyHalf.minY + 2);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /own half/i);
  });

  it('allows spells anywhere on the map', () => {
    const seed = findSeed((m) => handOf(m, 0).includes('fireball'));
    const match = liveMatch(seed);
    const result = match.playCard(0, 'fireball', 9, ownHalf(1).minY + 4);
    assert.equal(result.ok, true);
  });

  it('refuses placement on top of a tower', () => {
    const seed = findSeed((m) =>
      handOf(m, 0).some((id) => getCard(id)?.type !== 'spell' && cost(id) <= ELIXIR_START),
    );
    const match = liveMatch(seed);
    const troop = handOf(match, 0).find(
      (id) => getCard(id)?.type !== 'spell' && cost(id) <= ELIXIR_START,
    );
    assert.ok(troop);
    const result = match.playCard(0, troop, 3.5, 7);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /tower/i);
  });
});

describe('combat', () => {
  it('a spell damages enemies and spares your own units', () => {
    const seed = findSeed((m) => handOf(m, 0).includes('fireball') && handOf(m, 1).includes('bats'));
    const match = liveMatch(seed);

    const batsX = 9;
    const batsY = ownHalf(1).minY + 2;
    assert.equal(match.playCard(1, 'bats', batsX, batsY).ok, true);
    advance(match, 0.2);

    const batsBefore = match.snapshot().entities.filter((e) => e.defId === 'bats');
    assert.ok(batsBefore.length > 0, 'bats are on the field');

    const target = batsBefore[0];
    assert.ok(target);
    assert.equal(match.playCard(0, 'fireball', target.x, target.y).ok, true);
    advance(match, 0.1);

    const batsAfter = match.snapshot().entities.filter((e) => e.defId === 'bats');
    assert.ok(
      batsAfter.length < batsBefore.length,
      'fireball removed bats caught in the blast radius',
    );
    const ownTowers = match.snapshot().entities.filter((e) => e.kind === 'tower' && e.team === 1);
    assert.ok(
      ownTowers.every((t) => t.hp === t.maxHp),
      'the caster did not damage anything of their own',
    );
  });

  it('keeps stay dormant until an outpost falls', () => {
    const match = liveMatch();
    const keep = match.battlefield.find((e) => e.towerRole === 'keep' && e.team === 0);
    assert.ok(keep);
    assert.equal(keep.dormant, true, 'keep starts dormant');

    const outpost = match.battlefield.find((e) => e.towerRole === 'outpost' && e.team === 0);
    assert.ok(outpost);
    outpost.hp = 0;
    match.tick();

    assert.equal(keep.dormant, false, 'losing an outpost rouses the keep');
  });
});

describe('pathing', () => {
  it('ground units cross the river only on a bridge', () => {
    const seed = findSeed((m) => handOf(m, 0).includes('footmen'));
    const match = liveMatch(seed);
    assert.equal(match.playCard(0, 'footmen', ARENA.bridgeXs[0] ?? 3.5, 12).ok, true);

    let sawRiverCrossing = false;
    for (let i = 0; i < 600; i++) {
      match.tick();
      for (const e of match.battlefield) {
        if (e.kind !== 'troop' || e.layer !== 'ground' || e.hp <= 0) continue;
        if (e.y <= ARENA.riverMinY || e.y >= ARENA.riverMaxY) continue;
        sawRiverCrossing = true;
        const bridge = nearestBridge(e.x);
        assert.ok(
          Math.abs(e.x - bridge.x) <= ARENA.bridgeHalfWidth + 0.01,
          `ground unit at x=${e.x.toFixed(2)} was in the river off-bridge`,
        );
      }
    }
    assert.ok(sawRiverCrossing, 'a unit actually reached the river during the run');
  });
});

describe('win conditions', () => {
  it('sustained unopposed pressure destroys a tower and ends in a result', () => {
    const match = liveMatch(7);
    // Team 0 attacks with whatever it can afford; team 1 never responds.
    for (let i = 0; i < 3600; i++) {
      if (i % 20 === 0) {
        const me = match.snapshot().players[0];
        const playable = me.hand
          .map((id) => getCard(id))
          .filter((c): c is CardDef => c !== undefined && c.type !== 'spell' && c.cost <= me.elixir);
        const card = playable[0];
        if (card) match.playCard(0, card.id, ARENA.bridgeXs[0] ?? 3.5, ownHalf(0).maxY - 1);
      }
      match.tick();
      if (match.result) break;
    }

    assert.ok(match.towersDestroyedBy(0) >= 1, 'attacker took at least one tower');
    assert.ok(match.result, 'the match reached a conclusion');
    assert.equal(match.result?.winner, 0);
  });
});
