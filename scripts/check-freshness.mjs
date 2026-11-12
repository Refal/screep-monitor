/**
 * Staleness canary: fails (and lets GitHub email the run) if any shard's nested meta/latest.ts
 * is older than STALE_MINUTES. Catches quota exhaustion, a broken collector,
 * or a Screeps API outage — anything that would leave the dashboard showing
 * stale data without collect.mjs itself failing loudly.
 *
 * Env:
 *   GOOGLE_APPLICATION_CREDENTIALS — path to a Firebase service-account JSON (required)
 *   STALE_MINUTES                  — default 40
 *   SCREEPS_SHARDS                 — comma-separated shards to check, default shard2,shard3
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { shardPaths } from "../public/calc.js";
import { parseShards } from "./collect.mjs";

const staleMinutes = Number(process.env.STALE_MINUTES ?? "40");
const shards = parseShards(process.env);

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const stale = [];
for (const shard of shards) {
    const path = shardPaths(shard).latest;
    const snap = await db.doc(path).get();
    if (!snap.exists) {
        console.error(`::error::[${shard}] ${path} does not exist — no snapshot has ever been stored.`);
        stale.push(shard);
        continue;
    }
    const ts = snap.data().ts?.toDate();
    if (!ts) {
        console.error(`::error::[${shard}] ${path} has no ts field.`);
        stale.push(shard);
        continue;
    }
    const ageMinutes = (Date.now() - ts.getTime()) / 60000;
    console.log(`[${shard}] ${path} is ${ageMinutes.toFixed(1)} min old (threshold ${staleMinutes} min).`);
    if (ageMinutes > staleMinutes) {
        console.error(`::error::[${shard}] ${path} is stale (${ageMinutes.toFixed(1)} min > ${staleMinutes} min)`);
        stale.push(shard);
    }
}

if (stale.length > 0) {
    console.error(`Stale or missing shard(s): ${stale.join(", ")}`);
    process.exit(1);
}
