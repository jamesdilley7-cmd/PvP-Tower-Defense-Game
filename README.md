# Tower Clash — Phase 0 Prototype

The playable proof of the battle loop described in [DESIGN.md](DESIGN.md) §11, Phase 0:
core loop, one map, six cards, local network only.

It is a **TypeScript match server plus a throwaway browser client**, not the Unity
app. That is deliberate: the point of Phase 0 is to find out whether the elixir
curve, tower layout and win conditions are any fun, and that question is far
cheaper to answer in a canvas you can reload in a second than inside a game
engine. The simulation is written with no transport or rendering dependencies, so
it ports to the Phase 1 stack (Colyseus match server, Unity client) without a
rewrite.

## Running it

```bash
npm install
npm start           # builds, then serves on http://localhost:3000
```

Open <http://localhost:3000> and choose:

- **Play vs Bot** — instant match against a simple AI, for solo testing.
- **Find Match** — waits for a second player. Open a second browser tab and pick
  the same option to pair them up.

## Other commands

```bash
npm test              # 15 simulation tests (node:test, no browser needed)
npm run headless -- 50  # play 50 bot-vs-bot matches and print a balance summary
npm run dev           # tsc --watch while you are editing
```

`npm run headless` is the balance tool. It runs full matches with no rendering,
so a tuning change can be judged across dozens of games in seconds:

```
Ran 30 bot-vs-bot matches
  Team 0 wins : 16
  Team 1 wins : 14
  Draws       : 0
  Avg length  : 145.5s
  Reached OT  : 14
  Endings     : towers×16, tower-hp×8, sudden-death×6
```

## Renaming and retuning

**Everything you will want to rename or rebalance is in
[`src/sim/content.ts`](src/sim/content.ts)** — card names, costs, stats, tower
numbers, match length, elixir rate, and the name of the resource itself:

```ts
export const GAME_NAME = 'Tower Clash';
export const RESOURCE_NAME = 'Elixir';   // rename here and the UI follows
```

The client is sent the card list at match start rather than hardcoding it, so a
rename needs no client changes at all.

## How it fits together

| Path | Role |
|---|---|
| `src/sim/` | The authoritative simulation. Pure, deterministic, no networking or rendering. |
| `src/sim/content.ts` | All names, costs and tuning constants. |
| `src/server/` | WebSocket server, room pairing, tick loop, and the bot. |
| `src/client/` | Canvas debug client. Renders server snapshots; owns no game rules. |
| `src/test/` | Unit tests plus the headless balance harness. |

The rule that matters: **clients send intent, the server decides outcomes.** A
client asks to "play card X at position Y"; the server validates elixir, hand
contents and placement against its own simulation before anything happens. The
bot goes through the same `playCard` path a human does — it gets no shortcuts.

## The six cards

| Card | Cost | What it is for |
|---|---:|---|
| Bats | 2 | Four fast fliers; punish a defence with no anti-air |
| Footmen | 3 | Three melee grunts; cheap pressure and blocking |
| Archers | 3 | Fragile ranged pair; the sustained answer to air |
| Cannon | 3 | Defensive building; pulls ground pushes off your towers |
| Fireball | 4 | Area spell, castable anywhere; clears swarms |
| Brute | 5 | Slow tank that ignores troops and walks at buildings |

They form a deliberate triangle: Brute beats towers, Bats beat an unsupported
Brute, Archers beat Bats, Fireball punishes clumped Archers and Footmen.

## Known simplifications

These are fine for Phase 0 and are on the list for Phase 1:

- **Damage is instant**, with no projectile travel time for ranged units.
- **Full state is sent every tick** (20Hz) as JSON, with no delta compression.
- **No client-side interpolation** — the client draws exactly what it last
  received, so movement is tick-rate smooth rather than frame smooth.
- **Spells only damage enemies**, where the reference game damages both sides.
- **No deployment-zone expansion** after destroying an opponent's outpost.
- No accounts, persistence, matchmaking by trophies, or leaderboard — all Phase 1
  and beyond per DESIGN.md.
