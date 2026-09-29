// Refresh/poll loop, hash-change handling, control wiring and boot.
import { RANGES } from "./calc.js";
import { DEMO } from "./config.js";
import { POLL_MS, STALE_PROBE_MS } from "./constants.js";
import { initFirestore, loadHistory, loadLatest, resetDemoRows } from "./data.js";
import { $, setStatus, sleep } from "./dom.js";
import { firebaseConfig } from "./firebase-config.js";
import { applyRoute, go, readHash } from "./nav.js";
import { dataAgeMs, renderAll, renderStatus } from "./render.js";
import { ROOM } from "./route.js";
import { applySectionDefaults } from "./sections/index.js";
import {
    latest, rangeHours, route, selectedRoom, setHistoryRaw, setRangeHours, setRoute, setSelectedRoom,
} from "./state.js";

let inFlight = false;

let lastPollAt = 0;

let pollTimer = null;

function onHashChange() {
    const prev = route;
    setRoute(readHash());
    // Eagerly, before any fetch: refresh() is a no-op while a poll is already
    // in flight, and the pressed button and the visible view must still follow
    // the click. renderAll calls applyRoute again; it is idempotent.
    applyRoute();
    if (route.range !== prev.range) {
        // Same reset the range buttons used to do inline: a new window needs a
        // full fetch at the new LOD, not an append to the old one.
        setRangeHours(route.range);
        setHistoryRaw([]);
        resetDemoRows();
        refresh({ force: true });
        return;
    }
    setSelectedRoom(route.room ?? selectedRoom);
    if (latest) renderAll();
}

async function refresh({ force = false } = {}) {
    if (inFlight) return;
    inFlight = true;
    $("refresh")?.toggleAttribute("disabled", true);
    const retryDelaysMs = [1000, 3000];
    try {
        for (let attempt = 0; ; attempt++) {
            setStatus(attempt === 0 ? "loading…" : `loading… (retry ${attempt})`);
            try {
                const prevTick = latest?.tick ?? null;
                const rangeAtStart = rangeHours;
                const [, added] = await Promise.all([loadLatest(), loadHistory()]);
                if (rangeHours !== rangeAtStart) {
                    // The range changed mid-fetch (onHashChange's own refresh was a
                    // no-op while this one ran), so what came back is the old window:
                    // drop it and fetch the new one from scratch.
                    setHistoryRaw([]);
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
        if (!DEMO) scheduleNextPoll();
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
    $("refresh")?.addEventListener("click", () => refresh({ force: true }));
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
        if (!DEMO) await initFirestore();
        $("app").hidden = false;
        setRoute(readHash());        // before the first fetch: rangeHours feeds the query
        setRangeHours(route.range);
        renderRangeButtons();        // applyRoute sets aria-pressed, so build first
        applyRoute();
        applySectionDefaults();
        bindControls();
        refresh();
    }
}
