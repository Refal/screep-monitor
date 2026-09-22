/**
 * Fetches the bot's stats snapshot from a pool of RawMemory segments on
 * screeps.com and stores it in Firestore. Runs in GitHub Actions (cron) and
 * locally.
 *
 * Payload shape: segment SEGMENT holds a manifest+head snapshot
 * (t, gcl, gpl, cpu, cr, rooms, bmax?, rt?, ar?, pb?, ph?, pba, buckets), where `buckets`
 * is how many history bucket segments the bot keeps, at
 * SEGMENT+1 .. SEGMENT+buckets. Each bucket is a JSON array of the snapshots
 * published during one fixed window of game ticks (oldest first); the bot
 * appends to the current window's bucket and overwrites the oldest bucket
 * when the window rolls, so bucket order carries no meaning and the head
 * also appears inside its own bucket — readers dedup by `t`. The ring exists
 * because the bot only publishes once per 20 ticks (~82s) while this
 * collector polls every 5 minutes; without history, most published
 * snapshots were never read before being overwritten. `fetchPayload()`
 * fetches the manifest, then every bucket segment it names (capped at
 * MAX_BUCKETS), and merges them into the flat `{ ...head, h }` shape the
 * rest of this file (and the tests) expect — no other function needs to
 * know segments exist. A bucket that fails to fetch, or whose JSON doesn't
 * decode to an array, is skipped (logged as a warning) rather than losing
 * the whole poll; a bucket never written yet reads as empty. Only the
 * manifest segment is required.
 *
 * Env:
 *   SCREEPS_TOKEN                  — screeps.com auth token (required)
 *   GOOGLE_APPLICATION_CREDENTIALS — path to a Firebase service-account JSON (required)
 *   SCREEPS_SHARD                  — default shard2
 *   SCREEPS_SEGMENT                — manifest/head segment, default 90 (history
 *                                    buckets are always SEGMENT+1..SEGMENT+buckets,
 *                                    not separately configured)
 *
 * Firestore layout:
 *   snapshots/<autoId>  { ts, tick, gcl, gpl?, cpu, cr, rooms, bmax?, rt?, ar?, pb?, ph?, pba?,
 *                         b5?, b30?, b120? }
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
// `bucketId`/LOD_BUCKET_MS are wall-clock downsampling buckets (b5/b30/b120,
// used below in assignLodFlags) — an unrelated concept from this file's own
// "bucket" segments (bucketSegmentIds et al.), which are the bot's fixed
// tick-window history-ring segments.
import { LOD_BUCKET_MS, bucketId, RETENTION_DAYS, SHARD as DEFAULT_SHARD } from "../public/calc.js";

/** Parses SCREEPS_SEGMENT into a segment id, throwing loudly on anything
 * that isn't a non-negative integer — including an empty string, which
 * `Number()` alone would silently turn into segment 0. */
export function parseSegment(raw) {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(n) || n < 0) {
        throw new Error(`SCREEPS_SEGMENT must be a non-negative integer, got ${JSON.stringify(raw)}`);
    }
    return n;
}

const SHARD = process.env.SCREEPS_SHARD ?? DEFAULT_SHARD;
const SEGMENT = parseSegment(process.env.SCREEPS_SEGMENT ?? "90");
const BUCKET_FETCH_DELAY_MS = 150; // spread sequential bucket fetches instead of bursting the Screeps API
const MAX_BUCKETS = 9; // segment ids stop at 99, so 91-99 is the most the default SEGMENT=90 can own
const PRUNE_BATCH = 450;
const PRUNE_MAX_BATCHES = 20; // caps a single run's delete cost if a backlog ever builds up

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Returns `undefined` for a segment with no data yet ("never written"),
 * rather than throwing — callers with different requiredness (the manifest
 * is required, a bucket may legitimately be unwritten) decide what that
 * means. Any API/auth failure still throws. */
async function fetchSegment(segmentId) {
    const token = process.env.SCREEPS_TOKEN;
    if (!token) throw new Error("SCREEPS_TOKEN is not set");
    const url = `https://screeps.com/api/user/memory-segment?segment=${segmentId}&shard=${SHARD}`;
    const res = await fetch(url, { headers: { "X-Token": token } });
    if (!res.ok) throw new Error(`Screeps API ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (!body.ok) throw new Error(`Screeps API rejected segment ${segmentId}: ${JSON.stringify(body)}`);
    return body.data ? JSON.parse(body.data) : undefined;
}

/** SEGMENT+1 .. SEGMENT+buckets, capped at MAX_BUCKETS; a manifest without
 * `buckets` (or an older wire format) names no history at all. */
export function bucketSegmentIds(head, base) {
    const count = Math.min(head.buckets ?? 0, MAX_BUCKETS);
    return Array.from({ length: count }, (_, i) => base + 1 + i);
}

/** Merges a manifest's head with its successfully-fetched history buckets
 * into the flat `{ ...head, h }` shape unseenEntries/buildSnapshotDoc expect
 * (see the file header for the bucket-order/dedup contract). A failed bucket
 * is simply absent from `bucketEntries` — see fetchPayload(). */
export function mergeBuckets(head, bucketEntries) {
    return { ...head, h: bucketEntries.flat() };
}

/** Fetches the manifest segment, then every bucket segment it names, and
 * merges them. Only the manifest fetch can fail the whole poll — a bucket
 * that fails to fetch, or whose JSON doesn't decode to an array, just logs a
 * warning and is skipped. Returns the merged payload plus how many buckets
 * failed, so callers can tell an empty ring apart from a fetch glitch. */
async function fetchPayload() {
    const head = await fetchSegment(SEGMENT);
    if (head === undefined) throw new Error(`Segment ${SEGMENT} is empty (bot not publishing yet?)`);
    const bucketEntries = [];
    let failedBuckets = 0;
    for (const [i, segmentId] of bucketSegmentIds(head, SEGMENT).entries()) {
        if (i > 0) await sleep(BUCKET_FETCH_DELAY_MS);
        try {
            const entries = await fetchSegment(segmentId) ?? [];
            if (!Array.isArray(entries)) {
                throw new Error(`expected an array, got ${typeof entries}`);
            }
            bucketEntries.push(entries);
        } catch (err) {
            console.warn(`::warning::bucket segment ${segmentId} failed, skipping it: ${err.message}`);
            failedBuckets++;
        }
    }
    return { payload: mergeBuckets(head, bucketEntries), failedBuckets };
}

/**
 * Flattens a payload into every entry it carries — the head snapshot plus
 * the `h` ring — filtered to strictly-newer-than-latestTick and returned
 * oldest-first (the order they should be inserted in, so `meta/latest` ends
 * up holding the true newest). Deduped by tick, head wins (see the file
 * header for why the head also appears in its own bucket).
 */
export function unseenEntries(payload, latestTick) {
    const { h, ...head } = payload; // buildSnapshotDoc whitelists what persists
    const all = Array.isArray(h) ? [head, ...h] : [head];

    const byTick = new Map();
    for (const entry of all) {
        if (latestTick != null && entry.t <= latestTick) continue;
        // first occurrence wins, so the head beats its bucket copy — Map.set()
        // alone would overwrite on a repeat key, so this guards explicitly.
        if (!byTick.has(entry.t)) byTick.set(entry.t, entry);
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
        // `?.length`, not truthiness: an empty array is truthy, and `rt: []` is the
        // one shape the dashboard cannot read — its "nothing cached" vs "degraded
        // away" branches both key off the field being ABSENT (hasThreatDetail in
        // public/calc.js), so an empty array renders a table with no rows and no
        // explanation. The bot omits `rt` on an empty list; this keeps that
        // invariant local instead of trusting the other repo for it.
        ...(entry.rt?.length ? { rt: entry.rt } : {}),
        // Same contract as `rt`: the bot omits `ar` when no army exists and
        // drops it under degradation, so it must never persist as `[]`.
        ...(entry.ar?.length ? { ar: entry.ar } : {}),
        // Power harvesting, same omit-on-empty contract as `rt`/`ar`: both ride
        // the bot's first degradation step, so absence has to keep meaning
        // "nothing live, or degraded away" rather than "an empty table".
        ...(entry.pb?.length ? { pb: entry.pb } : {}),
        ...(entry.ph?.length ? { ph: entry.ph } : {}),
        // NOT the `?.length`/truthiness pattern: `pba` is a scalar 0|1 (the bot's
        // autoHarvest gate) and `0` is the load-bearing value — dropping it
        // collapses "gate off" into "no banks", which is the one distinction this
        // field exists to keep. The undefined guard is still needed: firebase-admin
        // rejects `undefined` values, and ring entries published before the bot
        // started emitting `pba` carry none.
        ...(entry.pba !== undefined ? { pba: entry.pba } : {}),
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
    const [{ payload, failedBuckets }, latestSnap] = await Promise.all([fetchPayload(), latestRef.get()]);
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
    // Suppressed before the first successful run (`latest == null`) — there's no
    // baseline yet to call a bucket fetch problem unusual.
    if (latest != null) {
        if (failedBuckets > 0) {
            console.log(`::warning::segment ${SEGMENT} had ${failedBuckets} bucket fetch failure(s) this poll (ring depth ${ringDepth}) — likely a fetch glitch.`);
        } else if (ringDepth === 0 && (payload.buckets ?? 0) > 0) {
            // The bot always writes the head into its bucket, so a named-but-empty
            // ring (with no fetch failures to blame) means the bot isn't writing it.
            console.log(`::warning::segment ${SEGMENT} names ${payload.buckets} bucket(s) but none carried history — check the bot's bucket writes.`);
        }
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
