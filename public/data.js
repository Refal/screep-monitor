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
// Auth gates every Firestore read: firestore.rules only lets an allowlisted,
// verified Google account list snapshots or read meta (the web apiKey is
// public and authorizes nothing — see README "Access control"). Firestore
// Lite picks up the signed-in user's ID token from this same app instance.
import {
    getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
    bucketId, detectGaps, downsample, LOD_BUCKET_MS, LOD_BY_RANGE, RAW_INTERVAL_MS, shardPaths,
} from "./calc.js";
import { DEMO, params } from "./config.js";
import { MAX_HISTORY_DOCS, MAX_POINTS } from "./constants.js";
import { firebaseConfig } from "./firebase-config.js";
import {
    currentShard, history, historyKey, historyRaw, rangeHours, setHistory, setHistoryGaps, setHistoryRaw, setLatest,
} from "./state.js";

let db;

let auth;

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
    const snap = await getDoc(doc(db, shardPaths(currentShard).latest));
    if (!snap.exists()) throw new Error("No data yet — has the collector run?");
    setLatest(snap.data());
}

const toRows = snap => snap.docs.map(d => { const v = d.data(); return { ...v, date: v.ts.toDate() }; });

// Builds the snapshots query for the current range: the caller's ts predicate
// plus the range's LOD flag (if any). Both history loaders go through here so
// a full fetch and a later incremental fetch can never disagree about
// resolution — each shard|range keeps its own cached rows (see historyCache), so
// incremental only ever appends rows fetched under the current range's flag.
function historyQuery(tsClause) {
    const flag = LOD_BY_RANGE[rangeHours];
    return query(collection(db, shardPaths(currentShard).snapshots), tsClause,
        ...(flag ? [where(flag, "==", true)] : []),
        orderBy("ts", "asc"), limit(MAX_HISTORY_DOCS));
}

const windowCutoffMs = () => Date.now() - rangeHours * 3600e3;

// Fetches the full `rangeHours` window. Used on first load, when no held row is
// still inside the window, and as the fallback when an incremental fetch fails.
async function loadHistoryFull() {
    const cutoff = Timestamp.fromMillis(windowCutoffMs());
    const rows = toRows(await getDocs(historyQuery(where("ts", ">=", cutoff))));
    return { rows, added: rows.length };
}

// Fetches only snapshots newer than the last held row, appends them, and drops
// rows that have aged out of the current window. Keeps a poll's read cost
// near-constant (1-2 docs) instead of rescanning the whole range.
async function loadHistoryIncremental(held) {
    // On a flagged range, each bucket holds exactly one flagged doc (the
    // collector's lod cursor persists across runs) and the collector never
    // stamps ts beyond its own now — so while we're still inside the same
    // bucket as the newest leader we hold, a new leader cannot exist yet.
    // Skip the query entirely instead of billing a read to learn nothing.
    // Clock skew at a bucket edge costs at most one extra poll of latency.
    const widthMs = LOD_BUCKET_MS[LOD_BY_RANGE[rangeHours]];
    if (widthMs && bucketId(Date.now(), widthMs)
            === bucketId(held.at(-1).date.getTime(), widthMs)) {
        return { rows: held, added: 0 };
    }
    const fresh = toRows(await getDocs(historyQuery(where("ts", ">", held.at(-1).ts))));
    const cutoff = windowCutoffMs();
    return { rows: [...held, ...fresh].filter(r => r.date.getTime() >= cutoff), added: fresh.length };
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

// Returns the number of new rows fetched (used by the render gate). Held rows are
// trimmed to the window first: the incremental query has no lower bound, so a cache
// entry from days ago would otherwise read every doc since, up to the limit.
export async function loadHistory() {
    if (DEMO) {
        setHistory(await demoHistory());
        setHistoryGaps(detectGaps(history, expectedIntervalMs()));
        return history.length;
    }
    const key = historyKey(currentShard, rangeHours);
    const cutoff = windowCutoffMs();
    const held = historyRaw.filter(r => r.date.getTime() >= cutoff);
    const { rows, added } = held.length > 0
        ? await loadHistoryIncremental(held).catch(loadHistoryFull)
        : await loadHistoryFull();
    // The view switched mid-fetch: these rows belong to the old shard|range, and
    // committing them would cache them under the new key. refresh() refetches.
    if (historyKey(currentShard, rangeHours) !== key) return 0;
    setHistoryRaw(rows);
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
    auth = getAuth(app);
    db = getFirestore(app);
}

// Resolves with the persisted user (or null) once Auth has restored its
// session from IndexedDB — before that, currentUser reads null even for a
// signed-in visitor.
export function waitForUser() {
    return new Promise(resolve => {
        const stop = onAuthStateChanged(auth, user => { stop(); resolve(user); });
    });
}

// Popup, not redirect: redirect sign-in breaks in browsers that partition
// third-party storage, since authDomain (firebaseapp.com) differs from the
// site's own web.app origin.
export async function signIn() {
    return (await signInWithPopup(auth, new GoogleAuthProvider())).user;
}

export const logout = () => signOut(auth);

// Drops the memoized demo series (see demoHistory) — a range switch needs a fresh one.
export function resetDemoRows() { demoRows = null; }
