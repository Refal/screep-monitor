/**
 * Fetches the bot's stats snapshot from RawMemory segment 90 on screeps.com
 * and stores it in Firestore. Runs in GitHub Actions (cron) and locally.
 *
 * Payload shape: a head snapshot (t, gcl, gpl, cpu, cr, rooms, bmax?) plus `h`, a
 * newest-first ring of older snapshots the bot kept in memory, published
 * because segment 90 has room to spare (~9 KB used of a 95 KB budget) and
 * the bot only publishes once per 20 ticks (~82s) while this collector
 * polls every 5 minutes — without the ring, ~80% of published snapshots
 * were never read before being overwritten by the next publish.
 *
 * Env:
 *   SCREEPS_TOKEN                  — screeps.com auth token (required)
 *   GOOGLE_APPLICATION_CREDENTIALS — path to a Firebase service-account JSON (required)
 *   SCREEPS_SHARD                  — default shard2
 *   SCREEPS_SEGMENT                — default 90
 *
 * Firestore layout:
 *   snapshots/<autoId>  { ts, tick, gcl, gpl?, cpu, cr, rooms, bmax?, b5?, b30?, b120? }
 *   meta/latest         same shape, plus `lod` (bucket-tracking state); also
 *                       used to dedup by tick and to trigger the once-a-day
 *                       retention sweep
 *
 * `ts` for history entries is interpolated, not insertion time: see
 * interpolateTimestamps() for why (otherwise a whole outage's worth of
 * backfilled docs would collapse onto ~one timestamp).
 *
 * `b5`/`b30`/`b120` mark the first stored doc in each 5-/30-/120-minute
 * wall-clock bucket, so the dashboard can query a downsampled slice for the
 * 24h/7d/21d ranges instead of paging through everything — see public/calc.js
 * and firestore.indexes.json.
 */
import { pathToFileURL } from "node:url";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { LOD_BUCKET_MS, bucketId, RETENTION_DAYS, SHARD as DEFAULT_SHARD } from "../public/calc.js";

const SHARD = process.env.SCREEPS_SHARD ?? DEFAULT_SHARD;
const SEGMENT = process.env.SCREEPS_SEGMENT ?? "90";
const PRUNE_BATCH = 450;
const PRUNE_MAX_BATCHES = 20; // caps a single run's delete cost if a backlog ever builds up

async function fetchSegment() {
    const token = process.env.SCREEPS_TOKEN;
    if (!token) throw new Error("SCREEPS_TOKEN is not set");
    const url = `https://screeps.com/api/user/memory-segment?segment=${SEGMENT}&shard=${SHARD}`;
    const res = await fetch(url, { headers: { "X-Token": token } });
    if (!res.ok) throw new Error(`Screeps API ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (!body.ok || !body.data) throw new Error(`Segment ${SEGMENT} is empty (bot not publishing yet?)`);
    return JSON.parse(body.data);
}

/**
 * Flattens a payload into every entry it carries — the head snapshot plus
 * the newest-first `h` ring — filtered to strictly-newer-than-latestTick and
 * returned oldest-first (the order they should be inserted in, so
 * `meta/latest` ends up holding the true newest). Ticks are deduped
 * defensively; the bot should never publish the same tick twice, but a
 * stale ring entry is cheap to guard against.
 */
export function unseenEntries(payload, latestTick) {
    const { h, ...head } = payload; // buildSnapshotDoc whitelists what persists
    const all = Array.isArray(h) ? [head, ...h] : [head];

    const byTick = new Map();
    for (const entry of all) {
        if (latestTick != null && entry.t <= latestTick) continue;
        byTick.set(entry.t, entry); // first occurrence wins; entries are already newest-first
    }
    return [...byTick.values()].sort((a, b) => a.t - b.t);
}

/**
 * Assigns each entry a wall-clock ts by interpolating between two real
 * anchors: the previously stored (latestTick, latestMs) and the current
 * fetch (headTick=payload.t, headMs=now). Backfilled history entries did
 * not just arrive — they were published minutes ago — so stamping them with
 * insertion time would collapse a whole outage's worth of samples onto
 * ~one instant, corrupting both Firestore's ts-ordering and the dashboard's
 * observedMsPerTick (public/calc.js), which divides a ts delta by a tick
 * delta. Falls back to headMs for every entry only on the very first run,
 * when there is no prior anchor to interpolate from.
 */
export function interpolateTimestamps(entries, { headTick, headMs, latestTick, latestMs }) {
    const msPerTick =
        latestTick != null && latestMs != null && headTick > latestTick
            ? (headMs - latestMs) / (headTick - latestTick)
            : null;
    return entries.map(e => ({
        ...e,
        tsMs: msPerTick != null ? headMs - (headTick - e.t) * msPerTick : headMs,
    }));
}

/**
 * Walks entries oldest-first, flagging the first one to land in each new
 * wall-clock bucket of every LOD_BUCKET_MS tier (shared via public/calc.js —
 * the dashboard's LOD_BY_RANGE maps ranges onto the same flags). `prevLod`
 * carries the last
 * bucket ids already flagged from a previous run (stored on meta/latest.lod),
 * so bucket boundaries stay correct across polls instead of resetting each
 * run. Returns the flagged docs plus the lod state to persist for next time.
 */
export function assignLodFlags(entries, prevLod) {
    const lod = { ...prevLod };
    const docs = entries.map(e => {
        const flags = {};
        for (const [flag, widthMs] of Object.entries(LOD_BUCKET_MS)) {
            const id = bucketId(e.tsMs, widthMs);
            if (id !== lod[flag]) { flags[flag] = true; lod[flag] = id; }
        }
        return { ...e, ...flags };
    });
    return { docs, lod };
}

/** Maps one flagged entry (from assignLodFlags) to the Firestore doc shape. */
export function buildSnapshotDoc(entry) {
    const doc = {
        ts: Timestamp.fromMillis(entry.tsMs),
        tick: entry.t,
        gcl: entry.gcl,
        ...(entry.gpl ? { gpl: entry.gpl } : {}),
        cpu: entry.cpu,
        cr: entry.cr,
        rooms: entry.rooms,
        ...(entry.bmax ? { bmax: entry.bmax } : {}),
    };
    for (const flag of Object.keys(LOD_BUCKET_MS)) if (entry[flag]) doc[flag] = true;
    return doc;
}

// Manual sweep on purpose, not a Firestore TTL policy — TTL needs billing and
// a dedicated expireAt field (see README "Operations" for the full rationale);
// these deletes fit easily inside the 20k/day free quota.
async function pruneOldSnapshots(db) {
    const cutoff = Timestamp.fromMillis(Date.now() - RETENTION_DAYS * 864e5);
    let pruned = 0;
    for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
        // .select() with no fields returns doc names only — we only need refs
        const old = await db.collection("snapshots").where("ts", "<", cutoff).select().limit(PRUNE_BATCH).get();
        if (old.empty) break;
        const batch = db.batch();
        old.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        pruned += old.size;
        if (old.size < PRUNE_BATCH) break; // fewer than a full batch means the query is exhausted
    }
    return pruned;
}

async function main() {
    initializeApp({ credential: applicationDefault() });
    const db = getFirestore();
    const latestRef = db.doc("meta/latest");

    // independent round trips (screeps.com and Firestore) — fetch both at once
    const [payload, latestSnap] = await Promise.all([fetchSegment(), latestRef.get()]);
    const latest = latestSnap.data();
    const latestTick = latest?.tick ?? null;
    const latestMs = latest?.ts?.toMillis() ?? null;

    const entries = unseenEntries(payload, latestTick);
    if (entries.length === 0) {
        console.log(`Tick ${payload.t} already stored — bot idle or slow ticks, skipping.`);
        return;
    }

    const headMs = Date.now();
    const withTs = interpolateTimestamps(entries, { headTick: payload.t, headMs, latestTick, latestMs });
    const { docs, lod } = assignLodFlags(withTs, latest?.lod);

    const snapshots = db.collection("snapshots");
    const batch = db.batch();
    let newestDoc;
    for (const entry of docs) {
        newestDoc = buildSnapshotDoc(entry);
        batch.set(snapshots.doc(), newestDoc);
    }
    batch.set(latestRef, { ...newestDoc, lod });
    await batch.commit();

    const ringDepth = payload.h?.length ?? 0;
    console.log(
        `Stored ${docs.length} tick(s) [${docs[0].t}..${docs.at(-1).t}] (${Object.keys(payload.rooms).length} rooms), ring depth ${ringDepth}.`
    );
    if (ringDepth < 4 && latest != null) {
        // Below poll-covering depth (~4 entries at today's cadence) after the very
        // first run is the visible signature of a bot global reset whose bootstrap
        // rehydrate failed — see screeps2 StatsManager's two-phase bootstrap.
        console.log(`::warning::segment ${SEGMENT} ring depth is only ${ringDepth} — check for a failed bot restart bootstrap.`);
    }

    // retention sweep on the first run of each UTC day
    const prevDay = latest?.ts?.toDate().toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (prevDay && prevDay !== today) {
        const prunedCount = await pruneOldSnapshots(db);
        if (prunedCount) console.log(`Pruned ${prunedCount} snapshots older than ${RETENTION_DAYS} days.`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
