// Refresh/poll loop, hash-change handling, control wiring and boot.
import { RANGES, SHARDS } from "./calc.js";
import { DEMO } from "./config.js";
import { POLL_MS, STALE_PROBE_MS } from "./constants.js";
import {
    initFirestore, loadHistory, loadLatest, logout, resetDemoRows, signIn, waitForUser,
} from "./data.js";
import { $, setStatus, sleep } from "./dom.js";
import { firebaseConfig } from "./firebase-config.js";
import { applyRoute, go, readHash } from "./nav.js";
import { dataAgeMs, renderAll, renderStatus } from "./render.js";
import { ROOM } from "./route.js";
import { applySectionDefaults } from "./sections/index.js";
import {
    currentShard, latest, route, selectedRoom, setCurrentShard, setHistoryRaw, setLatest,
    setRangeHours, setRoute, setSelectedRoom,
} from "./state.js";

let inFlight = false;

let lastPollAt = 0;

let pollTimer = null;

// Bumped on every range/shard reset so refresh() can tell a fetch started
// before it — comparing values misses an A→B→A switch inside one fetch.
let viewGeneration = 0;

// True while the login screen is up: polling and refreshes stand down, since
// every read would be denied by firestore.rules until someone signs in.
let awaitingSignIn = false;

let signedInEmail = null;

function setLoginError(message) {
    $("login-error").textContent = message;
    $("login-error").hidden = !message;
}

function setUser(user) {
    signedInEmail = user?.email ?? null;
    $("sign-out").hidden = !user;
    $("sign-out").title = user ? `Signed in as ${user.email}` : "";
}

// Shows the login screen and resolves with the user once a Google sign-in
// succeeds. signIn() runs straight from the click so the browser treats the
// popup as user-initiated and doesn't block it.
function promptSignIn(message = "") {
    setStatus("signed out");
    $("login").hidden = false;
    setLoginError(message);
    return new Promise(resolve => {
        const btn = $("sign-in");
        const onClick = async () => {
            btn.disabled = true;
            try {
                const user = await signIn();
                btn.removeEventListener("click", onClick);
                $("login").hidden = true;
                setLoginError("");
                resolve(user);
            } catch (err) {
                // Closing the popup is a choice, not an error worth showing.
                const quiet = ["auth/popup-closed-by-user", "auth/cancelled-popup-request"];
                if (!quiet.includes(err?.code)) setLoginError(String(err?.message ?? err));
            } finally {
                btn.disabled = false;
            }
        };
        btn.addEventListener("click", onClick);
    });
}

// The signed-in account isn't on the firestore.rules allowlist (or its token
// was revoked): drop it and ask again, then pick up where the dashboard was.
async function regate() {
    awaitingSignIn = true;
    if (pollTimer) clearTimeout(pollTimer);
    $("app").hidden = true;
    const who = signedInEmail ?? "This account";
    let message = `${who} has no access to this dashboard. Sign in with an allowed Google account.`;
    // A failed sign-out must not strand the page behind a hidden #app: the
    // login screen still works, since a new popup sign-in replaces the session.
    try {
        await logout();
        setUser(null);
    } catch (err) {
        message += ` (Signing out failed: ${err?.message ?? err})`;
    }
    setUser(await promptSignIn(message));
    awaitingSignIn = false;
    $("app").hidden = false;
    refresh({ force: true });
}

// refresh() can't await regate() (it waits on a click), so failures land here
// rather than as an unhandled rejection: undo the gate and say what happened.
function startRegate() {
    regate().catch(err => {
        awaitingSignIn = false;
        $("login").hidden = true;
        $("app").hidden = false;
        setStatus(`sign-in failed: ${err?.message ?? err}`);
    });
}

function onHashChange() {
    const prev = route;
    let next = readHash();
    if (next.shard !== currentShard) {
        // readHash validates the room against `latest`, which still belongs to
        // the old shard — clear it so a pasted room link is judged on the new data.
        setLatest(null);
        setSelectedRoom(null);
        next = readHash();
    }
    setRoute(next);
    // Eagerly, before any fetch: refresh() is a no-op while a poll is already
    // in flight, and the pressed button and the visible view must still follow
    // the click. renderAll calls applyRoute again; it is idempotent.
    applyRoute();
    if (route.range !== prev.range || route.shard !== currentShard) {
        // Same reset the range buttons used to do inline: a new window needs a
        // full fetch at the new LOD, not an append to the old one.
        setRangeHours(route.range);
        setCurrentShard(route.shard);
        setHistoryRaw([]);
        resetDemoRows();
        viewGeneration++;
        refresh({ force: true });
        return;
    }
    setSelectedRoom(route.room ?? selectedRoom);
    if (latest) renderAll();
}

async function refresh({ force = false } = {}) {
    if (inFlight || awaitingSignIn) return;
    inFlight = true;
    $("refresh")?.toggleAttribute("disabled", true);
    const retryDelaysMs = [1000, 3000];
    try {
        for (let attempt = 0; ; attempt++) {
            setStatus(attempt === 0 ? "loading…" : `loading… (retry ${attempt})`);
            try {
                const prevTick = latest?.tick ?? null;
                const generationAtStart = viewGeneration;
                const [, added] = await Promise.all([loadLatest(), loadHistory()]);
                if (viewGeneration !== generationAtStart) {
                    // The range or shard changed mid-fetch (onHashChange's own refresh
                    // was a no-op while this one ran), so what came back is the old
                    // window: drop it and fetch the new one from scratch.
                    setHistoryRaw([]);
                    setLatest(null);
                    resetDemoRows();
                    force = true;
                    attempt = -1;
                    continue;
                }
                lastPollAt = Date.now();
                if (force || latest.tick !== prevTick || added > 0) {
                    renderAll();
                } else {
                    renderStatus();
                }
                return;
            } catch (err) {
                // Retrying can't fix a rules denial; it needs a different account.
                // regate() sets awaitingSignIn synchronously, so the finally below
                // won't schedule a poll behind the login screen.
                if (err?.code === "permission-denied") { startRegate(); return; }
                if (attempt >= retryDelaysMs.length) {
                    setStatus(String(err.message ?? err));
                    return;
                }
                await sleep(retryDelaysMs[attempt]);
            }
        }
    } finally {
        inFlight = false;
        $("refresh")?.toggleAttribute("disabled", false);
        if (!DEMO && !awaitingSignIn) scheduleNextPoll();
    }
}

// Self-scheduling poll aimed at the collector's ~5-minute write cadence: if
// the last poll found new data, aim the next one just after the next
// expected write (with jitter so multiple open tabs don't align); if it
// found nothing new, fall back to a fixed probe interval rather than one
// derived from latest.ts's age, so a stalled collector can't make the page
// poll faster and faster.
function scheduleNextPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    const ageMs = dataAgeMs();
    const jitterMs = Math.random() * 20e3;
    const delayMs = ageMs < POLL_MS
        ? Math.max(60e3, POLL_MS - ageMs) + jitterMs
        : STALE_PROBE_MS + jitterMs;
    pollTimer = setTimeout(refresh, delayMs);
}

// Label a window the way you'd say it: hours up to and including a day,
// then days — 6h, 24h, 7d, 21d.
function rangeLabel(hours) {
    return hours <= 24 ? `${hours}h` : `${hours / 24}d`;
}

function renderRangeButtons() {
    $("range-group").replaceChildren(...RANGES.map(hours => {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.range = String(hours);
        b.textContent = rangeLabel(hours);
        return b;
    }));
}

function bindControls() {
    $("range-group").addEventListener("click", e => {
        const btn = e.target.closest("button[data-range]");
        if (btn) go({ range: Number(btn.dataset.range) });
    });
    $("shard-group").addEventListener("click", e => {
        const btn = e.target.closest("button[data-shard]");
        if (btn && SHARDS.includes(btn.dataset.shard)) go({ shard: btn.dataset.shard });
    });
    $("refresh")?.addEventListener("click", () => refresh({ force: true }));
    // Reload rather than tear down in place: it resets every poll, timer and
    // cached row, and boot() then lands on the login screen.
    $("sign-out").addEventListener("click", () => logout().then(() => location.reload()));
    $("room-select").addEventListener("change", e => go({ view: ROOM, room: e.target.value }));
    window.addEventListener("hashchange", onHashChange);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => latest && renderAll());
    if (!DEMO) {
        // Skip the periodic tick while backgrounded — nothing to redraw for
        // no one to see — but renderStatus() itself always runs as part of
        // an actual refresh (see renderAll), regardless of visibility.
        setInterval(() => { if (!document.hidden) renderStatus(); }, 30e3);
        const wake = () => {
            if (!document.hidden && Date.now() - lastPollAt > 60e3) refresh();
        };
        document.addEventListener("visibilitychange", wake);
        window.addEventListener("focus", wake);
        window.addEventListener("online", wake);
    }
}

export async function boot() {
    if (!DEMO && firebaseConfig.apiKey === "REPLACE_ME") {
        $("setup-notice").hidden = false;
        setStatus("not configured");
    } else {
        if (!DEMO) {
            await initFirestore();
            // A persisted session skips the login screen. Whether that account
            // may actually read is only known from the first fetch (see regate).
            setUser(await waitForUser() ?? await promptSignIn());
        }
        $("app").hidden = false;
        setRoute(readHash());        // before the first fetch: rangeHours feeds the query
        setRangeHours(route.range);
        setCurrentShard(route.shard);
        renderRangeButtons();        // applyRoute sets aria-pressed, so build first
        applyRoute();
        applySectionDefaults();
        bindControls();
        refresh();
    }
}
