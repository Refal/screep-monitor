/**
 * Fetches the bot's stats snapshot from RawMemory segment 90 on screeps.com
 * and stores it in Firestore. Runs in GitHub Actions (cron) and locally.
 *
 * Env:
 *   SCREEPS_TOKEN                  — screeps.com auth token (required)
 *   GOOGLE_APPLICATION_CREDENTIALS — path to a Firebase service-account JSON (required)
 *   SCREEPS_SHARD                  — default shard2
 *   SCREEPS_SEGMENT                — default 90
 *
 * Firestore layout:
 *   snapshots/<autoId>  { ts, tick, gcl, cpu, cr, rooms }
 *   meta/latest         same shape; also used to dedup by tick and to
 *                       trigger the once-a-day retention sweep
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const SHARD = process.env.SCREEPS_SHARD ?? "shard2";
const SEGMENT = process.env.SCREEPS_SEGMENT ?? "90";
const RETENTION_DAYS = 60;

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

async function pruneOldSnapshots(db) {
    const cutoff = Timestamp.fromMillis(Date.now() - RETENTION_DAYS * 864e5);
    const old = await db.collection("snapshots").where("ts", "<", cutoff).limit(400).get();
    if (old.empty) return 0;
    const batch = db.batch();
    old.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    return old.size;
}

async function main() {
    const stats = await fetchSegment();
    if (stats.v !== 1) throw new Error(`Unknown stats payload version: ${stats.v}`);

    initializeApp({ credential: applicationDefault() });
    const db = getFirestore();

    const latestRef = db.doc("meta/latest");
    const latest = (await latestRef.get()).data();

    if (latest?.tick === stats.t) {
        console.log(`Tick ${stats.t} already stored — bot idle or slow ticks, skipping.`);
        return;
    }

    const doc = {
        ts: Timestamp.now(),
        tick: stats.t,
        gcl: stats.gcl,
        cpu: stats.cpu,
        cr: stats.cr,
        rooms: stats.rooms,
    };
    await db.collection("snapshots").add(doc);
    await latestRef.set(doc);
    console.log(`Stored tick ${stats.t} (${Object.keys(stats.rooms).length} rooms).`);

    // retention sweep on the first run of each UTC day
    const prevDay = latest?.ts?.toDate().toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (prevDay && prevDay !== today) {
        const pruned = await pruneOldSnapshots(db);
        if (pruned) console.log(`Pruned ${pruned} snapshots older than ${RETENTION_DAYS} days.`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
