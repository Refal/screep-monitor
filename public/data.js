// Firestore access (or the ?demo synthetic series) and the history loaders.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
// Firestore Lite, not the full SDK: the dashboard only ever does one-shot
// reads, polled on the collector's ~5-minute write cadence (see
// scheduleNextPoll in controller.js), and the full SDK's WebChannel `Listen` stream —
// used even for one-shot getDoc/getDocs — has proven flaky on some networks
// (backchannel GETs 404, retried with backoff). Lite talks plain REST and
// skips that stream entirely.
import {
    collection, doc, getDoc, getDocs, getFirestore, limit, orderBy, query, Timestamp, where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-lite.js";
import { bucketId, detectGaps, downsample, LOD_BUCKET_MS, LOD_BY_RANGE, RAW_INTERVAL_MS } from "./calc.js";
import { DEMO, params } from "./config.js";
import { MAX_HISTORY_DOCS, MAX_POINTS } from "./constants.js";
import { firebaseConfig } from "./firebase-config.js";
import {
    history, historyRaw, rangeHours, setHistory, setHistoryGaps, setHistoryRaw, setLatest,
} from "./state.js";

let db;

// demo.js is excluded from deploy (see firebase.json hosting.ignore), so this
// must stay a dynamic import reached only when ?demo=1 is set — a static one
// would 404 in production. Memoized per range: onHashChange clears demoRows
// on a range switch, since the generated series depends on rangeHours.
let demoRows = null;

async function demoHistory() {
    if (!demoRows) {
        const { synthDemo, degradeLatest } = await import("./demo.js");
        demoRows = synthDemo(rangeHours, MAX_POINTS);
        // ?demo=degraded — see degradeLatest. The threat board's most dangerous
        // failure mode is reading calm on a payload that dropped its threat
        // detail, and this is the only way to see that branch in a browser.
        if (params.get("demo") === "degraded") demoRows = degradeLatest(demoRows);
    }
    return demoRows;
}

export async function loadLatest() {
    if (DEMO) { setLatest((await demoHistory()).at(-1)); return; }
    const snap = await getDoc(doc(db, "meta", "latest"));
    if (!snap.exists()) throw new Error("No data yet — has the collector run?");
    setLatest(snap.data());
}

const toRows = snap => snap.docs.map(d => { const v = d.data(); return { ...v, date: v.ts.toDate() }; });

// Builds the snapshots query for the current range: the caller's ts predicate
// plus the range's LOD flag (if any). Both history loaders go through here so
// a full fetch and a later incremental fetch can never disagree about
// resolution — a range switch clears historyRaw first (see bindControls), so
// incremental only ever appends rows fetched under the current range's flag.
function historyQuery(tsClause) {
    const flag = LOD_BY_RANGE[rangeHours];
    return query(collection(db, "snapshots"), tsClause,
        ...(flag ? [where(flag, "==", true)] : []),
        orderBy("ts", "asc"), limit(MAX_HISTORY_DOCS));
}

// Fetches the full `rangeHours` window into historyRaw. Used on first load,
// on a range switch, and as the fallback when an incremental fetch fails.
// Returns the row count, for loadHistory's render gate.
async function loadHistoryFull() {
    const cutoff = Timestamp.fromMillis(Date.now() - rangeHours * 3600e3);
    setHistoryRaw(toRows(await getDocs(historyQuery(where("ts", ">=", cutoff)))));
    return historyRaw.length;
}

// Fetches only snapshots newer than the last row already held, appends them,
// and drops rows that have aged out of the current window. Keeps a poll's
// read cost near-constant (1-2 docs) instead of rescanning the whole range.
async function loadHistoryIncremental() {
    // On a flagged range, each bucket holds exactly one flagged doc (the
    // collector's lod cursor persists across runs) and the collector never
    // stamps ts beyond its own now — so while we're still inside the same
    // bucket as the newest leader we hold, a new leader cannot exist yet.
    // Skip the query entirely instead of billing a read to learn nothing.
    // Clock skew at a bucket edge costs at most one extra poll of latency.
    const widthMs = LOD_BUCKET_MS[LOD_BY_RANGE[rangeHours]];
    if (widthMs && bucketId(Date.now(), widthMs)
            === bucketId(historyRaw.at(-1).date.getTime(), widthMs)) {
        return 0;
    }
    const rows = toRows(await getDocs(historyQuery(where("ts", ">", historyRaw.at(-1).ts))));
    const cutoff = Date.now() - rangeHours * 3600e3;
    setHistoryRaw([...historyRaw, ...rows].filter(r => r.date.getTime() >= cutoff));
    return rows.length;
}

// The normal spacing between stored rows for the current range — the active
// LOD tier's bucket width, or the bot's raw publish cadence (RAW_INTERVAL_MS,
// not the collector's much coarser poll interval) on an unflagged (short)
// range. detectGaps flags anything wider than a multiple of this as an
// outage rather than ordinary cadence.
function expectedIntervalMs() {
    const flag = LOD_BY_RANGE[rangeHours];
    return flag ? LOD_BUCKET_MS[flag] : RAW_INTERVAL_MS;
}

// Returns the number of new rows fetched (used by the render gate). Range
// switches reset historyRaw to [] (see bindControls), so an empty historyRaw
// doubles as "need a full fetch" without a separate range-tracking flag.
export async function loadHistory() {
    if (DEMO) {
        setHistory(await demoHistory());
        setHistoryGaps(detectGaps(history, expectedIntervalMs()));
        return history.length;
    }
    const added = historyRaw.length > 0
        ? await loadHistoryIncremental().catch(loadHistoryFull)
        : await loadHistoryFull();
    setHistory(downsample(historyRaw, MAX_POINTS));
    setHistoryGaps(detectGaps(history, expectedIntervalMs()));
    return added;
}

// Initialises Firebase and the Firestore handle the loaders read through.
// Not called under ?demo — there is no Firestore then.
export async function initFirestore() {
    const app = initializeApp(firebaseConfig);
    // App Check: enforced once traffic looks right (see README). Site key
    // is absent until that's set up, so this stays a no-op till then.
    // Imported dynamically so the ~28KB module is only fetched once a
    // site key is actually configured.
    if (firebaseConfig.appCheckSiteKey) {
        const { initializeAppCheck, ReCaptchaV3Provider } =
            await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js");
        if (location.hostname === "localhost") self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
        initializeAppCheck(app, {
            provider: new ReCaptchaV3Provider(firebaseConfig.appCheckSiteKey),
            isTokenAutoRefreshEnabled: true,
        });
    }
    db = getFirestore(app);
}

// Drops the memoized demo series (see demoHistory) — a range switch needs a fresh one.
export function resetDemoRows() { demoRows = null; }
