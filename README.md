# screep_monitor

Room-statistics dashboard for the screeps2 bot — fully card-free:
GitHub Actions (collector, every 5 min) → Firestore (Firebase Spark) → Firebase Hosting (dashboard).

The bot publishes a compact stats JSON to **RawMemory segment 90** on shard2 every 20 ticks
(`StatsManager` in the screeps2 repo, ~82s at today's shard speed) — well under the segment's
95 KB budget, so it also keeps a ring of recent snapshots in its own heap and publishes those
alongside the latest one. (The payload carries a wire version in `v`, but the collector no
longer reads it — the `v: 1` path was removed in `1846ecd` and nothing gates on the field
now; the rollout note at the bottom of this file is the only remaining guard.) Without the
ring, a 5-minute collector poll only ever saw the newest of several snapshots published
since the last poll — most were silently overwritten
before being read. `scripts/collect.mjs` fetches the segment from the Screeps Web API, walks
the ring for anything not yet stored, and stores it in Firestore; `public/` is a static
Chart.js dashboard reading Firestore directly under read-only security rules.

The **Defense** and **Remote threats** sections are deliberately built from `meta/latest`
rather than a time series. `StatsManager`'s payload-size degradation drops `roles`/`thr` and
the snapshot-level `rt` together, in its first step (`DEGRADATION_STEPS`, ~35% of the history
budget), so historical coverage of all three in stored `snapshots` docs is size-dependent and
not guaranteed — the head snapshot on `meta/latest` is the one place they're always complete.
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

Three further notes, all downstream of one fact: each `rt` entry's `age` is the bot's own
cached lookback (300-tick `hostileCache` TTL), not the snapshot's, so a fresh snapshot can
carry a stale sighting. First, the latest-snapshot table de-emphasises rows past
`REMOTE_STALE_AGE_TICKS`. Second, `remoteEpisodes` back-dates **both** ends of an episode by
`age` — `fromTick` is `min(tick - age)` and `toTick` is `max(tick - age)`. Reading `toTick`
off the snapshot instead would drag every episode through the cache's ~300-tick tail after
the room went dark: a finished raid would read as current, and a genuine re-sighting could
open a second episode starting before the first one's reported end. The episode also carries
`staleTicks` (how far behind the last observing snapshot that final sighting was), because
converting it to wall clock needs the ms-per-tick ratio, which only exists in `public/app.js`
— so `fromMs`/`toMs` stay the observing rows' own clocks and `remoteWhenCell` applies the
lag. Third, `remoteEpisodes` and the `remote-tiles` headline counts both exclude
Source-Keeper-only entries, since an SK remote permanently caches its standing guards: in the
log they would produce one endless episode in every range, and in the tiles they would pin
"Remote hostiles" at a non-zero count that never returns to 0 on a quiet empire. They still
appear in the table, classed `keepers`, and are counted on the tiles' sub line.

One caveat with a shelf life: `snapshots` docs written **before** the collector started
persisting `rt` carry `thr` but no `rt`, so `hasThreatDetail` reads them as "no remote
hostiles cached" when the truth is "never collected". Like `gpl`, `rt` can't be backfilled,
so the remote activity log under-reports incursions in any range still reaching back past
that deploy, and ages out of the problem on its own after `RETENTION_DAYS`.

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
(`loadHistoryIncremental` in `public/app.js`), so the 5-minute cadence stays cheaper in reads
than the old 10-minute full-refetch poll. The page also refreshes immediately on regaining
focus/visibility (background tabs get their timers throttled) and skips re-rendering charts
when a poll finds no new tick. If a truly push-based dashboard is ever wanted, that's a
separate feature and would mean switching back to the full SDK with `onSnapshot`.

## Local preview (no setup needed)

```sh
cd public && python3 -m http.server 8787
# open http://localhost:8787/?demo=1   (synthetic data; add &theme=light|dark to force a theme)
```

`?demo=1` works only against this local server: the generator lives in `public/demo.js`,
which `firebase.json`'s hosting `ignore` excludes from every deploy, and `app.js` reaches
it with a dynamic `import()` gated on `?demo=1` so production never requests it.

## Tests

The rate/ETA/downsampling/boost-threshold logic behind the dashboard lives in
`public/calc.js`, pure functions with no DOM or Firebase dependency, so they're covered by
plain `node:test` unit tests in `test/`:

```sh
npm test
```

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

Put the project id into `.firebaserc`. For a one-off local deploy:

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
- Bot side: adjust cadence/segment/ring budget in `screeps2/src/config/config.stats.ts`;
  check the segment with `node scripts/screepsLive.mjs segment 90` in the screeps2 repo.
- Rollout order when changing the wire format again: deploy the collector first with support
  for both the old and new version, confirm it's live, then publish the new version from the
  bot. Doing it in the other order leaves the collector unable to parse what the bot sends.
