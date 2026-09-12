# Tower Clash — Product & Technical Design (v0.1, draft for sign-off)

A real-time 1v1 PvP tower-defense card game for mobile, in the spirit of Clash
Royale: short matches, a deckbuilding meta, and a competitive ladder. This
document lays out the game design and the technical architecture needed to
ship on iOS and Android, with open decisions flagged for sign-off.

A styled, reviewable version of this document (with a table of contents and
per-section review checkboxes) was published as a Claude Artifact for sign-off.

## 1. Vision & pillars

Two players, three towers each, ninety seconds of pressure. Players build an
8-card deck, spend a regenerating resource (**Elixir**) to deploy troops,
spells, and buildings, and try to knock down more of the opponent's towers
than they lose before the clock runs out.

Pillars:
- **Readable** — a spectator should understand who's winning within five seconds.
- **Deep** — deckbuilding and matchup knowledge matter as much as reflexes.
- **Fair** — ladder position reflects skill; the server, not the client, decides outcomes.
- **Live** — built for seasons: new cards, balance passes, and events after launch.

## 2. Core match loop

1v1, real-time, symmetric map. Normal match length **2:00**; if towers are
tied, up to **1:00** sudden-death overtime at double Elixir regeneration.

- **Elixir**: max 10, regenerates 1 every 2.8s (1.4s in overtime). Card costs run 1–9.
- **Hand & cycle**: deck of 8 cards, 4 in hand at a time; playing a card cycles in the next.
- **Towers** (illustrative stats, not final balance):

  | Tower | Role | HP | DPS |
  |---|---|---:|---:|
  | Outpost (×2) | Flanking, first line of defense | 1,400 | 90 |
  | Keep (×1) | Central; activates once an Outpost falls; destroying it ends the match instantly | 2,600 | 120 |

## 3. Cards & collection

Three card types combine into a deck of 8:
- **Troops** — ground/air, melee/ranged
- **Spells** — direct damage or utility
- **Buildings** — defensive, non-moving

Rarity governs upgrade cost and drop rate, not raw power ceiling, so a
well-built Common deck stays competitive.

| Rarity | Unlocks via | Max level | Upgrade cost curve |
|---|---|---:|---|
| Common | Arena 1+, shop, chests | 14 | Low |
| Rare | Arena 2+, chests | 12 | Medium |
| Epic | Arena 5+, chests | 9 | High |
| Legendary | Arena 8+, chests, rare shop offer | 7 | Very high |
| Champion | Season pass / top-ladder reward | 5 | Highest, slowest |

Duplicates plus soft currency (**Gold**) raise a card's level, scaling stats
modestly. Upgrades affect stats only, never unlock new abilities, so the
collection stays legible.

## 4. Progression & economy

- **Trophies** rise on a win, fall on a loss, and gate which **Arena** (~12–15,
  themed, each introducing new cards) a player sits in.
- **Seasons** run monthly: a soft trophy reset, a season leaderboard, and
  season-end rewards tied to peak rank.
- **Chests** drop from wins and open on a timer (or instantly for a Gem cost),
  yielding Gold, cards, and occasionally Gems.
- Two currencies: **Gold** (soft, earned — upgrades and shop) and **Gems**
  (hard, premium — skip timers, cosmetic and chest purchases).

## 5. Leaderboards

Four boards, all fed exclusively by server-validated match results — a client
never reports its own outcome directly into ranking.

- **Global** — top players worldwide by current-season trophies, re-ranked ~every 60s.
- **Regional** — same board, scoped to the player's matchmaking region.
- **Friends** — ranked against Game Center / Google Play Games friends, or an in-app friends list.
- **All-time best** — a player's highest-ever trophy count, surviving season resets.

Implementation: live ranking in Redis sorted sets (cheap top-N and
rank-of-player reads); a periodic job snapshots standings into PostgreSQL for
season archives and dispute investigation.

## 6. Networking architecture

The load-bearing decision: **the match server is the sole authority on what
happened in a battle.** Clients send intent, never outcomes.

1. Client sends a small signed message: "play card X at position Y, client-timestamp T."
2. The match server validates it (enough Elixir, legal placement zone, no
   cooldown violation) against its own running simulation.
3. The server advances the simulation at a fixed tick rate (~20–30Hz) and
   broadcasts compact binary state deltas to both clients.
4. Each client renders the authoritative state, using local
   prediction/interpolation purely for visual smoothness.

```
Client A ─┐                              ┌─ Matchmaking service (queues by trophy range)
          ├─▶ Match server (authoritative sim, ~20–30Hz) ─┼─ Redis (sessions, queues, leaderboard)
Client B ─┘         one instance per live match           └─ PostgreSQL (accounts, decks, match history)
                              │
                    Fleet orchestrator (Kubernetes / Agones)
```

- **MVP transport**: WebSocket with delta compression — simpler to build,
  debug, and get through mobile carrier NATs/firewalls than raw UDP; 3-minute
  matches with modest movement speeds are far more latency-tolerant than a
  shooter. Revisit UDP (ENet, or a managed service's transport) only if
  soft-launch telemetry shows latency-driven complaints.
- **Reconnection**: a session token lets a dropped client rejoin within a
  short grace window (~20s target) and resume receiving state; the match
  keeps simulating while disconnected, so leaving is never a way to dodge a loss.

## 7. Client & backend stack

| Layer | Choice | Why |
|---|---|---|
| Client engine | Unity (C#) | One codebase for iOS + Android, mature 2D tooling, easiest path to IAP/push/store SDKs |
| Match server | Go | Deterministic tick simulation, good concurrency for many simultaneous matches, fast to hire for |
| API services | Go or Node.js (TypeScript) | Matchmaking, accounts, shop, leaderboard — stateless, horizontally scaled |
| Primary database | PostgreSQL | Accounts, decks, card definitions, match history, purchases |
| Cache / real-time state | Redis | Matchmaking queues, session presence, leaderboard sorted sets |
| Orchestration | Kubernetes + Agones (or a managed multiplayer host) | Spin match-server instances up/down with concurrent-match demand, across regions |
| Auth | Sign in with Apple / Google Play Games + JWT | Required by both stores; server issues short-lived access + refresh tokens |

## 8. Fair play & anti-cheat

- Server-authoritative simulation (§6) removes the largest cheat surface by
  construction — a modified client can lie to itself, not to the ladder.
- Rate limiting and anomaly detection on account activity: implausible win
  streaks, superhuman reaction times, or replayed inputs get flagged for review.
- Play Integrity API (Android) and DeviceCheck/App Attest (iOS) reject
  requests from rooted, jailbroken, or tampered clients before they reach matchmaking.
- Every match is logged server-side well enough to replay for dispute investigation.

## 9. App screens

- **Home** — current deck preview, trophy count, chest slots, Battle button.
- **Deck builder** — full collection grid, filter by rarity/type/Elixir cost, drag into 8 slots.
- **Battle** — arena view, 4-card hand, Elixir bar, live tower HP for both sides.
- **Post-match** — trophy delta, chest/reward reveal, rematch or return-to-menu.
- **Leaderboards** — global / regional / friends tabs, season countdown.
- **Shop** — chests, rotating offers, Gems.

## 10. Store & platform requirements

**iOS**
- Sign in with Apple (mandatory once any other social login is offered)
- StoreKit for IAP; App Tracking Transparency prompt if ad attribution is used
- TestFlight for beta distribution
- Likely 9+/12+ age rating for mild cartoon combat

**Android**
- Google Play Games Sign-in; Play Billing for IAP
- Play Integrity API for tamper/emulator detection
- Internal → Closed → Open testing tracks for beta

**Both**: push notifications (match invites, chest-ready, friend requests) via
FCM + APNs behind one push service; localization starting with English,
expanding by target market.

## 11. Roadmap

Phases are sequential and each gates the next — the point is to prove the
server-authoritative battle loop before spending art/content budget at scale.

| Phase | Duration | Scope |
|---|---|---|
| 0 — Prototype | 2–3 wks | Core battle loop, one map, six cards, local network only |
| 1 — MVP | 6–8 wks | Accounts, matchmaking, 15–20 cards, real server-authoritative match server, one arena, basic leaderboard |
| 2 — Closed beta | 4–6 wks | ~40 cards, multiple arenas, chests/progression, global + friends leaderboards, anti-cheat baseline, TestFlight/Play Internal listings live |
| 3 — Soft launch | 4 wks | 1–2 test markets, telemetry/analytics wired up, watch retention/latency/match-quality before wider spend |
| 4 — Global launch | — | Marketing push, season 1 live-ops calendar, server capacity monitored against real concurrency |

## 12. Decisions needed from you

Everything above assumes a default so the design could move forward. These
are the calls that change it materially:

- **Monetization scope for MVP** — *assumed: none at MVP*; add Battle Pass and
  shop in v1.1 once retention data exists. Alternative: build the shop in
  from day one if funding requires an early revenue signal.
- **Client engine** — *assumed: Unity*. Alternative: Godot if the team already
  has Godot depth.
- **Match server hosting** — *assumed: self-managed Kubernetes + Agones*.
  Alternative: a managed multiplayer host (Unity Gaming Services Multiplay,
  PlayFab) trades cost for launch speed if there's no dedicated infra hire yet.
- **Clans/guilds** — *assumed: v2, not MVP*. Flag now if it's core to the pitch.
- **Art direction & IP** — no default assumed; needed before art production
  starts. Card/tower names and art must be original, not reskins of Clash
  Royale's, both legally and for the game's own identity.
- **Launch markets & localization** — no default assumed; drives which
  languages ship first (see §11, Phase 3).

## 13. Risks to plan around

- **Infra cost scales with concurrent matches**, not total players — budget
  the match-server fleet against peak concurrency, not registered users.
- **Balance is a permanent job, not a launch task.** A telemetry pipeline
  (win rates by card/deck) needs to exist before the card count grows past ~20.
- **Trademark exposure** if card names, tower names, or art lean too close to
  Clash Royale's specific assets — treat the art-direction decision (§12) as a
  gate before content production, not an afterthought.
