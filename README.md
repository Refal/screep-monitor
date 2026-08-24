# screep_monitor

Room-statistics dashboard for the screeps2 bot — fully card-free:
GitHub Actions (collector, every 10 min) → Firestore (Firebase Spark) → Firebase Hosting (dashboard).

The bot publishes a compact stats JSON to **RawMemory segment 90** on shard2 every 20 ticks
(`StatsManager` in the screeps2 repo). `scripts/collect.mjs` fetches that segment from the
Screeps Web API and stores snapshots in Firestore; `public/` is a static Chart.js dashboard
reading Firestore directly under read-only security rules.

## Local preview (no setup needed)

```sh
cd public && python3 -m http.server 8787
# open http://localhost:8787/?demo=1   (synthetic data; add &theme=light|dark to force a theme)
```

## One-time setup

### 1. Firebase (Spark plan — no billing account)

```sh
npx firebase-tools login
```

Then in the [Firebase console](https://console.firebase.google.com):
1. **Add project** (or attach to an existing empty GCP project). Stay on the **Spark** plan.
2. **Build → Firestore Database → Create database** (production mode, region `nam5` or `us-central1`).
3. **Project settings → General → Your apps → Add app (Web)** — copy the config values into
   `public/firebase-config.js`.
4. **Project settings → Service accounts → Generate new private key** — save the JSON
   (keep it out of git; `.gitignore` already covers `service-account*.json`).

Put the project id into `.firebaserc`, then deploy rules + hosting:

```sh
npx firebase-tools deploy --only firestore:rules,hosting
```

### 2. Test the collector locally

```sh
SCREEPS_TOKEN=<token from screeps2/.screeps.yaml> \
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json \
node scripts/collect.mjs
```

Expected: `Stored tick <N> (<M> rooms).` — and the doc appears in the Firestore console.
A second immediate run prints `Tick <N> already stored` (dedup).

### 3. GitHub (public repo — private repos would burn ~4,300 Actions minutes/month on a 10-min cron)

```sh
gh auth login
gh repo create screep-monitor --public --source . --push
gh secret set SCREEPS_TOKEN            # paste the Screeps auth token
gh secret set FIREBASE_SERVICE_ACCOUNT < service-account.json
gh workflow run collect                # first manual run
```

## Operations

- Dashboard: `https://<project-id>.web.app` (public read-only; game stats only).
- Retention: the collector deletes snapshots older than 60 days on the first run of each UTC day.
- Quotas (Spark free tier): 144 writes/day of ~20k, reads well under 50k/day.
- Bot side: adjust cadence/segment in `screeps2/src/config/config.stats.ts`;
  check the segment with `node scripts/screepsLive.mjs segment 90` in the screeps2 repo.
