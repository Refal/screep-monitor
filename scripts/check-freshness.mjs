/**
 * Staleness canary: fails (and lets GitHub email the run) if meta/latest.ts
 * is older than STALE_MINUTES. Catches quota exhaustion, a broken collector,
 * or a Screeps API outage — anything that would leave the dashboard showing
 * stale data without collect.mjs itself failing loudly.
 *
 * Env:
 *   GOOGLE_APPLICATION_CREDENTIALS — path to a Firebase service-account JSON (required)
 *   STALE_MINUTES                  — default 40
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const staleMinutes = Number(process.env.STALE_MINUTES ?? "40");

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const snap = await db.doc("meta/latest").get();
if (!snap.exists) {
    console.error("meta/latest does not exist — no snapshot has ever been stored.");
    process.exit(1);
}

const ts = snap.data().ts?.toDate();
if (!ts) {
    console.error("meta/latest has no ts field.");
    process.exit(1);
}

const ageMinutes = (Date.now() - ts.getTime()) / 60000;
console.log(`meta/latest is ${ageMinutes.toFixed(1)} min old (threshold ${staleMinutes} min).`);

if (ageMinutes > staleMinutes) {
    console.error(`::error::meta/latest is stale (${ageMinutes.toFixed(1)} min > ${staleMinutes} min)`);
    process.exit(1);
}
