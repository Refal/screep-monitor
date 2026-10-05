# screep_monitor

Room-statistics dashboard for the screeps2 bot — fully card-free:
GitHub Actions (collector, every 5 min) → Firestore (Firebase Spark) → Firebase Hosting (dashboard).

The bot publishes a compact stats JSON to a pool of **RawMemory segments starting at 90** on
shard2 every 20 ticks (`StatsManager` in the screeps2 repo, ~82s at today's shard speed).
Segment 90 carries a manifest plus the newest snapshot; a time-bucketed ring of recent
snapshots lives in the next `buckets` segments (91-96 by default). Each bucket holds every
snapshot published during one fixed window of game ticks, the bot appends to the current
window's bucket and overwrites the oldest when the window rolls, so a slow poller still sees
every publish while the bot writes only two segments per publish — see "Bot side" under
Operations, and screeps2's `docs/stats-history-ring.md`. `scripts/collect.mjs` fetches the
manifest from the Screeps Web API, then every bucket segment it names, merges them back into
one payload (order is irrelevant; entries are sorted and deduped by tick), and stores anything
not yet in Firestore; `public/` is a static Chart.js dashboard reading Firestore directly under
read-only security rules.

The **Defense** and **Remote threats** sections are deliberately built from `meta/latest`
rather than a time series. `StatsManager`'s payload-size degradation drops `roles`/`thr` and
the snapshot-level `rt` together, in its first step (`DEGRADATION_STEPS`, applied when a head
snapshot alone exceeds one 95KB segment), so historical coverage of all three in stored
`snapshots` docs is size-dependent and not guaranteed — the head snapshot on `meta/latest` is
the one place they're always complete.
Both activity logs (`hostileEpisodes` / `remoteEpisodes` in `public/calc.js`) report their own
coverage (`N of M snapshots in range carried threat detail`) rather than ever implying an
uncovered stretch was quiet. Before adding a "hostiles over time" chart, check that coverage
number for the range you care about.

`rt` (hostiles cached in **non-owned** rooms — remotes, SK rooms, corridors) has one extra
trap the owned-room `thr` doesn't. `thr` says `h: 0` when a room is clear, so its absence
always means "degraded". But the bot omits `rt` entirely on an empty list, so a missing `rt`
means *either* "nothing cached" *or* "degraded away". `hasThreatDetail` in `public/calc.js`
resolves it without a bot change: the first degradation step deletes per-room `roles`/`thr`
and top-level `rt` in one pass over the whole snapshot, and `buildRoomStats` sets `thr`
unconditionally — so **if any room in a snapshot still has `thr`, that snapshot's missing
`rt` genuinely means "no remote hostiles cached"**. Without that predicate every quiet
snapshot would count as a coverage gap and the log's note would cry wolf.

Each `rt` entry may also carry `exp`, an invader core's lifecycle deadline, sign-encoded so one
field covers both phases: `exp > 0` is the absolute tick an armed stronghold's core collapses;
`exp < 0` is `-`(absolute tick) it finishes deploying, while it still counts down toward
zero — hence a not-yet-armed core reads negative until it activates. Absent `exp` means neither
is known (no core, or a sighting — e.g. a memory-carried dark room — with no lifecycle detail).
`remoteDeployPhase` in `public/calc.js` turns the sign into a `{ phase, ticks }` reading; the
remote table's "Deploys/Expires" column and the threat board's stronghold card both render it.

Three further notes, all downstream of one fact: each `rt` entry's `age` is the bot's own
cached lookback (300-tick `hostileCache` TTL), not the snapshot's, so a fresh snapshot can
carry a stale sighting. First, the latest-snapshot table de-emphasises rows past
`REMOTE_STALE_AGE_TICKS`. Second, `remoteEpisodes` back-dates **both** ends of an episode by
`age` — `fromTick` is `min(tick - age)` and `toTick` is `max(tick - age)`. Reading `toTick`
off the snapshot instead would drag every episode through the cache's ~300-tick tail after
the room went dark: a finished raid would read as current, and a genuine re-sighting could
open a second episode starting before the first one's reported end. The episode also carries
`staleTicks` (how far behind the last observing snapshot that final sighting was), because
converting it to wall clock needs the ms-per-tick ratio, which only exists in the dashboard (`observedMsPerTick(history)`)
— so `fromMs`/`toMs` stay the observing rows' own clocks and `remoteWhenCell` applies the
lag. Third, `remoteEpisodes` and the `remote-tiles` headline counts both exclude
Source-Keeper-only entries, since an SK remote permanently caches its standing guards: in the
log they would produce one endless episode in every range, and in the tiles they would pin
"Remote hostiles" at a non-zero count that never returns to 0 on a quiet empire. They still
appear in the table, classed `keepers`, and are counted on the tiles' sub line.

`ar` (army routes) is the third snapshot-level field on the same degradation step, and the
answer to "who is defending that remote?". It is read straight off the bot's `Memory.armies`
rather than the spawn manifest, because the manifest (`roles`) only carries an army route while
a *forming* squad still has a queued slot — the moment `ArmyManager` marks a squad engaged, the
row disappears, so a manifest-based view loses the army exactly while it marches and fights.
Each route is `home → target` with per-squad status, member slots by status
`[queued, spawning, alive, dead]` and alive members by location `[home, target, elsewhere]`.
`routeSummary`/`routePhase` in `public/calc.js` collapse that to one word (forming, staging,
in transit, deployed, wiped) and `routeStatusText` to one line, which the remote table's
Response column, the threat board's stronghold card and the Army section's Squads column
all share. Two rules carried through every renderer: an engaged squad never respawns, so its
dead count is worded "lost" and never folded into a "short by N"; and like `rt` the bot omits
`ar` when no army exists, so an absent field reads as "none" only when `hasThreatDetail`
holds and "unknown" otherwise. The standing remote guard slot (`army_member` in `roles`) is
unaffected and still reaches the Defenders cell via `defenderSummary`.

`dv` / `sv` (defense and siege planner verdicts) replaced the bot's planner console lines.
`dv` is one row per defended room — `covered`, `holding` or `undefendable`, the homes that
gave up (`uh`) and a retry countdown (`in`); `sv` is one row per home→target siege route —
the committed objective (`core`/`stronghold`/`cleanup`), `covered`, or why it holds
(`awaiting-deploy`, `above-bar` with the core level in `d`, `boost-missing` with the compound
in `d`). The collector persists both omit-on-empty like `ar`, but they are **not** on any
degradation step: they are heap caches, so an absent field means "nothing to decide" or "the
cache is refilling after a global reset", never "dropped to fit". Neither is written for
everything that looks threatened (`dv` only covers remotes a home plans), so the dashboard
never presents a missing verdict as one that is coming.

`pc` (player campaigns) is one row per multi-day attack on another player's room, not to be
confused with the `sv` stronghold sieges: target `tg`/owner `ow`, phase `ph` (`assess`,
`starve`, `probe`, `press`, `hold`, `breach`, `cleanup`, then terminal `done`/`abandoned`)
and ticks in it `pa`, plus optional hold reason, outcome, breach verdict, ring counts, safe
mode `[charges, ticks left]`, starve coverage `[in scope, covered, kills, lost]` and the best
attrition option. Ring hits `rh` and target energy `te` are step values that change only at a
vision (about every 1000 ticks), so the charts draw steps, on separate axes since ring hits run
in millions; a row without the campaign breaks the line rather than bridging it. Same contract as `dv`/`sv`: omit-on-empty, never degraded,
unknown codes render muted.

`rl` (remote energy ledger) is one row per home→remote route: `in` is energy the route's haulers
delivered home, `out` is what its creeps cost to spawn (reserver, builder and defender spend
included on purpose), and `w` is the number of ticks those two sums cover. **`w` is per row**:
a route booked for the first time recently covers less than the full ring, so every rate divides
by the row's own `w` (`remoteLedgerRows` in `public/calc.js`), and a row under
`LEDGER_MATURE_TICKS` (10,500, the least a full ring covers) reads "measuring" instead of being
judged, and stays out of the headline tiles. The collector persists `rl` omit-on-empty like `rt`/`ar`, and the bot drops it in the
same first degradation step, so an absent field is read through `hasThreatDetail`: "none booked"
when threat detail survived, "unknown" when it did not. A snapshot from before the bot published
`rl` also reads "none booked". Boost and mineral costs are not in the ledger.

One caveat with a shelf life: `snapshots` docs written **before** the collector started
persisting `rt` carry `thr` but no `rt`, so `hasThreatDetail` reads them as "no remote
hostiles cached" when the truth is "never collected". Like `gpl`, `rt` can't be backfilled,
so the remote activity log under-reports incursions in any range still reaching back past
that deploy, and ages out of the problem on its own after `RETENTION_DAYS`.

`ph` / `pba` / `pw` / `pwl` and the power-tagged squads in `ar` (power harvesting) are the
fourth family on that degradation step, and the answer to "are we taking power banks, and is
it paying?". The bot no longer publishes live-bank planner state (the old `pb`: hits, decay,
contest, cached verdicts) — its `debugPowerBanks()` console command shows that live — and the
dashboard does not read `pb` from older snapshots either. Four traps, all of them load-bearing:

- **`pba` is a scalar, not a list, and never degrades.** It is the bot's `autoHarvest` gate,
  and it is the only thing separating "harvesting is switched off" from "the gate is on and
  nothing is out" from "the detail was degraded away". `buildSnapshotDoc` therefore persists
  it with an `!== undefined` guard rather than the `?.length` test `rt`/`ar`/`ph` use —
  a truthiness test would drop exactly the `0` that means "off". `powerGateState` in
  `public/calc.js` owns the reading, and the Power tiles show "unknown", never a calm zero,
  on a degraded snapshot.
- **Power squads are `ar` squads with a tag.** A harvest army is `kind: 'offense'` aimed at
  the bank room, and each squad carries `pw` (its harvest wave) or `pf: 1` (the fight squad);
  `squadSummary` exposes them as `wave` / `fight`. Those routes belong to the Power section,
  not the Army table (`isPowerRoute`). Rows are per *squad*, not per route — one harvest
  route carries both the wave and its fight squad.
- **`ph` is every power hauler, grouped by bank room, and `lv: 1` marks a live bank.** Our
  own kill deletes the bank's intel record exactly while the haulers are loading, so a row
  without `lv` is the loot leg home and renders "gone". Snapshots from before `lv` existed
  listed only that case, so reading a missing `lv` as gone is right for them too. A squad row
  reads "gone" only when `ph` says so for its room; with no `ph` row at all the haulers have
  simply not been dispatched.
- **`hl`'s min ttl is `0` while every hauler is still spawning.** Rendered as the word
  "spawning": printing "0t" would say the opposite of what it means.

`pwl` (power ledger) is one row per home: `p` is power its haulers handed over at home, `e`
the energy power ops cost it (spawn bodies of power-bank squads and haulers, plus lab boost
energy), `c` the boost compound units consumed, and `w` the ticks covered. It is the same
bucket ring as `rl`, so `w` is per row and `LEDGER_MATURE_TICKS` applies: a young home reads
"measuring" rather than a ratio — spend is booked at spawn and at the lab, power only on
delivery, so an op in progress always shows its cost first. `powerLedgerRows` reads it, with
the same "none" vs "unknown" absence branch as `remoteLedgerRows`.

`dpl` (deposit ledger) is the same per-home ring for deposit harvesting: `e` is the energy
deposit harvester and hauler bodies cost at spawn, `d` the deposit units its haulers handed
over at home per type (omitted before the first delivery), and `w` the ticks covered. Deposit
creeps are never boosted, so there is no compound column. `depositLedgerRows` totals `d`
across types for the energy-per-unit ratio (per unit hauled, not per unit of value), with the
same maturity rule and "none" vs "unknown" absence branch as `pwl`.

`sc` / `scm` are per-room too and likewise need no collector change: `sc` is the room's
resolved storage class (`vault` holds the war chest, `outpost` keeps only what its own
defense consumes) and `scm` (`pin` / `config`) is present only when a manual override decided
it. Both are optional — snapshots published before the bot shipped them lack them, and the
Defense table's Class column and the room's Storage class tile read "unknown" there.

`pw` is per-room — `[storage power, terminal power, power-spawn power, processing 0|1]` — and
needs no collector change at all: `buildSnapshotDoc` copies `rooms` wholesale, so per-room
fields ride along (the bot's `docs/stats-history-ring.md` says otherwise; the code is the
authority). `processing` is 1 only when the room owns a power spawn *and* the bot's energy
gate holds, so a spawn-less vault holding stray power reads 0. Like `gpl` it is in no
degradation step, so its history is complete going forward; the only gap is the stretch
before the collector began persisting it, which cannot be backfilled. A snapshot where *no*
room carries `pw` is ambiguous on its own — an empire genuinely holding no power looks
identical to one stored before the field existed — and `powerStockPoint` resolves it with
`pba` the same way `hasThreatDetail` resolves a missing `rt`: the bot added both fields in
one payload, so `pba` present with no `pw` anywhere is a real zero, and neither present is
"not collected". `?demo=1` covers all three stretches in one window.

`gpl` (power level) is the opposite case: it's not in any `DEGRADATION_STEPS` step, so its
history coverage in `snapshots` is always complete going forward. The only gap is time-based,
not size-based — it only exists in payloads published after the collector started persisting
it, so the GPL cards fill in from a blank left edge over the following `RETENTION_DAYS` and
can't be backfilled.

The dashboard uses the **Firestore Lite** SDK (`firebase-firestore-lite.js`), not the full
SDK, on purpose: it only ever does one-shot reads, polled on the collector's ~5-minute write
cadence, and the full SDK's WebChannel `Listen` stream — used internally even for one-shot
`getDoc`/`getDocs` — proved flaky on some networks (backchannel GETs 404ing, retried with
backoff, data appearing only after a few reloads). Lite talks plain REST and avoids that
stream. Each poll after the first fetches only snapshots newer than what it already has
(`loadHistoryIncremental` in `public/data.js`), so the 5-minute cadence stays cheaper in reads
than the old 10-minute full-refetch poll. The page also refreshes immediately on regaining
focus/visibility (background tabs get their timers throttled) and skips re-rendering charts
when a poll finds no new tick. If a truly push-based dashboard is ever wanted, that's a
separate feature and would mean switching back to the full SDK with `onSnapshot`.

## Dashboard layout

The page is priority-ordered rather than a flat scroll, because the only part of it that is
ever urgent is "is anything on fire?".

- **Threat board** (top, always visible). Built from `empireVerdict` / `threatItems` /
  `clearRooms` in `public/calc.js`. Lists *only* the rooms that are not clear plus armed
  strongholds, worst first; clear rooms collapse to one line. **A snapshot whose threat
  detail was degraded away must never produce a calm verdict** — `empireVerdict` returns
  `degraded` for that, and the board headlines it instead of a posture. There is a unit test
  pinning this, and `?demo=degraded` reaches it in a browser. A room with an incoming nuke
  (`nukes`) surfaces here too, ranked above even `spawnless`, using the same "overrides the
  posture, shows even on a clear room" mechanism. Below the cards, a **watch** line
  (`watchItems`) names clear RCL8 rooms whose defender zone is under `CRITICAL_RAMPART_HITS`
  — the bot's posture only judges rooms with hostiles in them, so it never sees a decaying
  wall. It never feeds `empireVerdict`; a watch room is named there instead of in the clear line.
- **Rooms at a glance** (below the empire tiles, never collapsed): one line per owned room,
  split by class. Levelling rooms get an RCL progress bar, ETA and storage, sorted soonest first;
  max-level rooms get zone / nuker / labs / storage / spawn, anything coloured first.
- **Player campaigns** (`public/sections/campaigns.js`, `pc` in `public/calc.js`): tiles and a
  table per campaign (phase, verdict, ring, safe mode, starve coverage, best attrition, vision
  age) plus two step charts of the starve trend: target ring hits and stored energy, and
  denial kills against losses. Falling lines mean the starve works.
- **Sections** are native `<details data-section="…">` accordions. A collapsed one is
  `display: none`, and a Chart.js chart built inside a zero-sized container bakes a wrong
  `devicePixelRatio` it does not recover from, so `SECTIONS` in `public/sections/index.js` renders
  lazily: new data marks every section dirty, only the open ones render, the rest render on
  first open. Below 1100px only Defense ships `open` (tiles plus a table, no charts), so a
  phone builds no charts at all until the reader opens a section, against 16 for the whole
  page. From 1100px up every section opens by default except the two activity logs
  (`history: true` in `SECTIONS`). Order is live state first (Defense, Army, Power, Boosts, Labs,
  Rooms), then Empire charts and Remote threats, then the logs. On a phone the Defense table
  folds its clear rooms behind a "+ N clear rooms" toggle, so a quiet empire isn't ten
  identical cards.
- **The room view reorders by room class** (`orderRoomView` in `public/sections/room-view.js`, which moves
  the DOM nodes so tab order matches). A levelling room leads with RCL progress tiles and
  the economy charts; a max-level room leads with a short strip (RCL/UPW, labs, storage),
  then Defense and Nuker — which own the zone, safe-mode and nuker tiles, so nothing is
  shown twice — with the economy charts last. Incoming nukes lead
  both.
- **Army** is a latest-snapshot section answering "what is the army doing, and why":
  a tile row (undefendable / holding rooms, squad members alive, sieges, power squads) and one
  row per operation from `armyOperations` — every non-power `ar` route joined to its `dv`/`sv`
  verdict, plus verdict-only rows for decisions no squad carries ("undefendable, nobody
  sent", a siege on hold), most urgent first. Power-bank squads stay in the Power section.
  The threat board summarises the same data in place: a threatened home's card has an
  Operations row naming every operation it fields or gave up on — by verdict, or by the
  squad's phase when there is none (manual squads, an empty cache) — and a stronghold card
  gets a Siege row from `sv`.
- **Power harvesting** is a latest-snapshot section built from `ar`/`ph`/`pba`/`pwl` — gate
  and stock tiles, one row per power squad and per bank's haulers (`powerFleetRows`), and the
  per-home ledger of power in against energy and boosts out. The empire-wide power *stock*
  over time is a chart in the Empire section instead, since `pw` (unlike everything else
  here) has complete history. Bank rooms are highway rooms, so their names link out to
  screeps.com rather than to a per-room view.
- **Deposit harvesting** is a latest-snapshot section built from `dpl` alone — tiles for the
  empire-wide totals and one ledger row per home of deposits in, by type, against energy out.
  It is the only deposit data the bot publishes.
- **The per-room view is a hash route**, not a tail on the same page — `#/room/E23S45`, with
  the time range as `?range=`. `public/route.js` owns the grammar (and rejects a range with
  no `LOD_BY_RANGE` flag behind it, which would otherwise run an unflagged full-resolution
  query). Every control writes the hash and lets `onHashChange` drive state, so a bookmark,
  the Back button and a click all take one path. Only *owned* rooms have such a view: `rt` names
  the remote next door (an entry's `home` is the colony), and those rooms carry no per-room stats
  at all, so their names link out to screeps.com rather than to a route that resolves to nothing
  — see `roomNameLink`/`isOwnedRoom` in `public/ui/links.js`.
- **Tables have two modes**, from one `renderTable` + column spec per table (`public/ui/table.js`).
  Below 700px each row is a card with its own labels — nothing important can be scrolled out
  of view. Above it they are real tables with the room column `position: sticky`. The old
  layout let the room name scroll away on a phone, which left the numbers anonymous.
- **Nothing load-bearing is hover-only.** A tooltip is a fine second channel and useless as
  the only one; touch has no hover. Column definitions live in the spec's `hint` and render as
  a "What these columns mean" disclosure; an absence with a meaning gets a word, not an em
  dash (`naCell`, and `remoteHomeCell`'s "corridor" is the original of the pattern). Two
  source-text tests in `test/calc.test.js` stop this drifting back.

### Code layout (`public/`)

There is no build step and no bundler: `public/` is deployed as-is and the browser loads the
ES modules directly (`<script type="module" src="app.js">`). Every relative import therefore
needs its `.js` extension, and the module graph must stay acyclic — `test/modules.test.js`
checks both, and links every module under Node so a wrong export name fails in CI rather than
as a blank page. `index.html` lists every module as `<link rel="modulepreload">` (the import
chain is ~10 levels deep and the JS is served `no-cache`, so without it a cold load is ~10 serial
round trips); the same test fails if a module is added without a matching preload line.

```
app.js            entry only: theme override, shard label, then boot()
controller.js     refresh/poll loop, hashchange handling, control wiring, boot()
data.js           Firestore (or ?demo) loaders — the only module that talks to Firebase
state.js          shared state as live-binding exports; change it through the setters
nav.js           hash routing; imports no rendering, so any module can use it without a cycle
render.js         renderAll + the header status line
constants.js dom.js config.js
charts/           Chart.js dataset + option builders, bar charts
ui/               renderTable, tiles, links/badges, shared cell builders and formatters
sections/         one module per overview section, the threat board, and the room view;
                  sections/index.js holds the lazily rendered SECTIONS registry
calc.js route.js  pure logic (shared with the collector / unit-tested), stay at the root
demo.js           ?demo=1 generator — must stay at the root (firebase.json ignores it there)
```

Sections import from `ui/` and `charts/`, never from each other; a helper needed by two
sections belongs in `ui/`. Nothing but `app.js` may do work at import time.

## Local preview (no setup needed)

```sh
cd public && python3 -m http.server 8787
# open http://localhost:8787/?demo=1   (synthetic data; add &theme=light|dark to force a theme)
```

`?demo=1` works only against this local server: the generator lives in `public/demo.js`,
which `firebase.json`'s hosting `ignore` excludes from every deploy, and `data.js` reaches
it with a dynamic `import()` gated on `?demo=1` so production never requests it.

`?demo=degraded` additionally strips the newest row's `thr`/`roles`/`rt` (`degradeLatest` in
`demo.js`). `synthDemo` degrades only rows mid-window, so this is the only way to see the
branches that need `latest` itself to be degraded — the remote table's two empty states, and
the threat board's "no threat data" verdict.

Note that `python3 -m http.server` sends no cache headers, so a browser will happily serve a
stale module or `styles.css` while you edit (the dashboard is ~30 small files now, so a
single changed module is easy to miss). Production sets `no-cache` on html/js/css (see
`firebase.json`); locally, hard-reload or serve from a fresh port.

## Tests

The rate/ETA/downsampling/boost-threshold logic behind the dashboard lives in
`public/calc.js`, and the hash grammar in `public/route.js` — pure functions with no DOM or
Firebase dependency, so they're covered by plain `node:test` unit tests in `test/`:

```sh
npm test
```

`test/modules.test.js` guards the dashboard's module tree (see *Code layout*).

Runs in CI as the `test` job in `.github/workflows/deploy.yml` on every push/PR touching
`public/`, `scripts/`, `test/`, or `package.json`; the `deploy` job only runs after it passes.

## One-time setup

### 1. Firebase (Spark plan — no billing account)

```sh
npx firebase-tools login
```

Then in the [Firebase console](https://console.firebase.google.com):
1. **Add project** (or attach to an existing empty GCP project). Stay on the **Spark** plan.
2. **Build → Firestore Database → Create database** (production mode, region `nam5` or `us-central1`).
3. **Project settings → General → Your apps → Add app (Web)** — copy the config values into
   `web-config.local.json` in the repo root (gitignored; see below). Do **not** paste them
   into `public/firebase-config.js` — that file is committed and must stay the `REPLACE_ME`
   placeholder. It's regenerated by `scripts/gen-web-config.mjs`.
4. **Create a narrow collector service account** rather than using the auto-created
   `firebase-adminsdk-*` account — the collector (`collect.mjs`, `check-freshness.mjs`) only
   ever needs to read/write `snapshots` and `meta`, not the full Firebase Admin surface:
   ```sh
   # GCP Console → IAM & Admin → Service Accounts → Create "gh-collector",
   # grant roles/datastore.user only, then Keys → Add key → JSON.
   ```
   Save the JSON as `service-account.json` locally (mode `600`; keep it out of git —
   `.gitignore` already covers `service-account*.json`).

`web-config.local.json` shape:

```json
{
  "apiKey": "...",
  "authDomain": "screeps-52c72.firebaseapp.com",
  "projectId": "screeps-52c72"
}
```

Put the project id into `.firebaserc`. Projects created on or after 2026-10-15 no longer get a
default Hosting site automatically, so the first deploy would fail with `404 Site Not Found`.
Create the site once (on older projects this just reports that the site already exists):

```sh
npx firebase-tools hosting:sites:create <project-id> --project <project-id>
```

For a one-off local deploy:

```sh
npm run gen:config
npx firebase-tools deploy --only firestore:rules,hosting
```

Ongoing hosting deploys run in CI instead (see "GitHub" below) — pushes to `main` under
`public/**`, `firestore.rules`, or `firebase.json` trigger `.github/workflows/deploy.yml`,
which generates `public/firebase-config.js` from the `FIREBASE_WEB_CONFIG` secret and deploys
with a dedicated `gh-deploy` service account. One-time setup for that:

```sh
# GCP Console → IAM & Admin → Service Accounts → Create "gh-deploy", grant
# roles/firebasehosting.admin, roles/firebaserules.admin,
# roles/serviceusage.serviceUsageConsumer, roles/datastore.indexAdmin
# (the last one for firestore:indexes deploys), then Keys → Add key → JSON.
gh secret set FIREBASE_DEPLOY_SA < gh-deploy-key.json
gh secret set FIREBASE_WEB_CONFIG < web-config.local.json
rm gh-deploy-key.json   # don't leave the key on disk
```

**On the web `apiKey` — it is not, and cannot be, a secret.** It is served to every visitor at
`/firebase-config.js` on the deployed site, so hiding it from git buys nothing: whatever is in
`FIREBASE_WEB_CONFIG` is public the moment it's deployed. It is also not the thing standing
between the Spark free tier and quota exhaustion — Firestore REST **authorizes by
`firestore.rules`, not by API key**, and accepts requests with no `key` parameter at all
(verified: a garbage key, an empty key, and no key all return the same live data as a valid one).
Restricting the key to HTTP referrers is still worth doing for the other Google APIs the project
touches (e.g. Identity Toolkit, if Auth is ever added) — but treat it as routing hygiene, not
access control, and don't expect rotating it to close anything. The actual quota control is the
`request.query.limit` cap in `firestore.rules` — see `firestore.rules` and the security-audit
notes for the accepted residual risk on that cap.

### 2. Test the collector locally

```sh
SCREEPS_TOKEN=<token from screeps2/.screeps.yaml> \
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json \
node scripts/collect.mjs
```

Expected: `Stored N tick(s) [a..b] (M rooms), ring depth D.` — and the doc appears in the Firestore console.
A second immediate run prints `Tick <N> already stored` (dedup).

### 3. GitHub (public repo — private repos would burn ~4,300 Actions minutes/month on a 10-min cron)

```sh
gh auth login
gh repo create screep-monitor --public --source . --push
gh secret set SCREEPS_TOKEN            # paste the Screeps auth token
gh secret set FIREBASE_SERVICE_ACCOUNT < service-account.json   # the gh-collector key from step 4 above
gh workflow run collect                # first manual run
```

## Operations

- Dashboard: `https://<project-id>.web.app` (public read-only; game stats only).
- Retention: the collector deletes snapshots older than 21 days on the first run of each UTC
  day (`RETENTION_DAYS` in `public/calc.js`, shared with the dashboard so the longest
  selectable range — the 21d button — always matches the prune window; asserted in
  `test/calc.test.js`). Lowered from 60 days when the ring buffer raised
  full-resolution storage from ~200 to ~1,050 snapshots/day (~9 MB/day, ~190 MB steady state
  at 21 days — well under Spark's 1 GB; `rt` adds at most ~3.3 KB/doc at the 30-entry
  payload cap, ~+73 MB steady state worst case, and near zero on a quiet empire). A
  Firestore TTL policy was evaluated and rejected:
  TTL deletes have no free allowance (billing required, so not Spark-compatible), and TTL
  expires on the field's own value, so it would also need a dedicated `expireAt` field.
- Quotas (Spark free tier): ~1,050 snapshot writes/day + ~288 `meta/latest` updates ≈ 1,340
  of 20k; dashboard reads are sized to the chart's 500-point render cap — the 24h/7d/21d
  ranges query only `b5`/`b30`/`b120` bucket-leader docs (~288/336/252 per full fetch; 6h
  fetches every doc, ~260), and incremental polls skip the query entirely until the current
  bucket rolls over (see `LOD_BY_RANGE` in `public/calc.js`).
- Bot side: adjust cadence/segment/ring geometry in `screeps2/src/config/config.stats.ts`
  (`segment`, `historySegmentCount`, `bucketTicks`); check a segment with
  `node scripts/screepsLive.mjs segment <90..99>` in the screeps2 repo. The collector needs no
  matching config — it derives which bucket segments to fetch from the manifest's `buckets` field.
- Rollout order when changing the wire format again: usually deploy the collector first with
  support for both the old and new version, confirm it's live, then publish the new version
  from the bot — doing it in the other order leaves the collector unable to parse what the bot
  sends. The segment-pool migration and the later switch to time buckets (this file's
  "RawMemory segments" paragraph above) were deliberate exceptions: both sides did a clean cut
  with no dual-format support, accepting a few poll cycles of reduced ring depth during rollout
  instead, because losing a little history depth during a deploy is cheaper than carrying
  compatibility code for it indefinitely.
