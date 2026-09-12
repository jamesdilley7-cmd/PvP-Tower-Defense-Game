import { TICK_DT } from '../sim/content.js';
import { Match } from '../sim/match.js';
import { Bot } from '../server/bot.js';

// Runs whole matches with no rendering or networking, so balance changes can be
// judged in seconds instead of by playing them out. `npm run headless -- 50`.

const MATCH_COUNT = Number(process.argv[2] ?? 20);
const MAX_TICKS = 6000;

interface Tally {
  wins: [number, number];
  draws: number;
  totalSeconds: number;
  overtimes: number;
  reasons: Map<string, number>;
}

const tally: Tally = {
  wins: [0, 0],
  draws: 0,
  totalSeconds: 0,
  overtimes: 0,
  reasons: new Map(),
};

for (let i = 0; i < MATCH_COUNT; i++) {
  const match = new Match(i + 1);
  const bots = [new Bot(0), new Bot(1)] as const;
  let ticks = 0;
  let sawOvertime = false;

  while (!match.result && ticks < MAX_TICKS) {
    match.tick();
    ticks++;
    const snapshot = match.snapshot();
    if (snapshot.phase === 'overtime') sawOvertime = true;
    for (const [index, bot] of bots.entries()) {
      const intent = bot.update(snapshot, TICK_DT);
      if (intent) match.playCard(index === 0 ? 0 : 1, intent.cardId, intent.x, intent.y);
    }
  }

  const result = match.result;
  if (!result) {
    console.error(`Match ${i + 1} failed to finish within ${MAX_TICKS} ticks`);
    process.exit(1);
  }
  if (result.winner === null) tally.draws++;
  else tally.wins[result.winner]++;
  tally.totalSeconds += ticks * TICK_DT;
  if (sawOvertime) tally.overtimes++;
  tally.reasons.set(result.reason, (tally.reasons.get(result.reason) ?? 0) + 1);
}

const avg = (tally.totalSeconds / MATCH_COUNT).toFixed(1);
console.log(`Ran ${MATCH_COUNT} bot-vs-bot matches`);
console.log(`  Team 0 wins : ${tally.wins[0]}`);
console.log(`  Team 1 wins : ${tally.wins[1]}`);
console.log(`  Draws       : ${tally.draws}`);
console.log(`  Avg length  : ${avg}s`);
console.log(`  Reached OT  : ${tally.overtimes}`);
console.log(`  Endings     : ${[...tally.reasons].map(([r, n]) => `${r}×${n}`).join(', ')}`);
