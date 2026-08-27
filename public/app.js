import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
// Firestore Lite, not the full SDK: the dashboard only ever does one-shot
// reads, polled on the collector's ~5-minute write cadence (see
// scheduleNextPoll below), and the full SDK's WebChannel `Listen` stream —
// used even for one-shot getDoc/getDocs — has proven flaky on some networks
// (backchannel GETs 404, retried with backoff). Lite talks plain REST and
// skips that stream entirely.
import {
    getFirestore, doc, getDoc, collection, query, where, orderBy, limit, getDocs, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-lite.js";
import {
    compact, pct, rateSeries, observedMsPerTick, windowRate, stockRate,
    levelEta, fmtDuration, downsample, rampLevel, boostFillLevel, boostFloor,
    PARTS_PER_BOOST, MIN_RAW_STOCK, LOD_BUCKET_MS, bucketId, LOD_BY_RANGE,
} from "./calc.js";
const MAX_POINTS = 500;
// firestore.rules caps snapshots list() queries at request.query.limit <= 9000
// (anonymous-scan quota defense — see README "On the web apiKey"). Both
// history queries below must carry it or Firestore denies them.
const MAX_HISTORY_DOCS = 9000;

const $ = id => document.getElementById(id);
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const fmtInt = new Intl.NumberFormat("en");

// Game facts (compound ladders per boost purpose), same order as the bot CLI.
// Stock amounts come from the payload (`bst`), maxes from `bmax` — only the
// symbols are safe to hardcode here.
const BOOST_LADDERS = [
    ["attack", ["UH", "UH2O", "XUH2O"]],
    ["ranged", ["KO", "KHO2", "XKHO2"]],
    ["heal", ["LO", "LHO2", "XLHO2"]],
    ["tough", ["GO", "GHO2", "XGHO2"]],
    ["harvest", ["UO", "UHO2", "XUHO2"]],
    ["build/repair", ["LH", "LH2O", "XLH2O"]],
    ["dismantle", ["ZH", "ZH2O", "XZH2O"]],
    ["upgrade", ["GH", "GH2O", "XGH2O"]],
    ["move", ["ZO", "ZHO2", "XZHO2"]],
    ["carry", ["KH", "KH2O", "XKH2O"]],
];
// Reaction inputs shown as raw stock, not boostable parts.
const RAW_INPUTS = [["hydroxide", "OH"], ["catalyst", "X"], ["ghodium", "G"]];
// All-rooms matrix drops harvest/carry to keep the column count tight — still
// shown in the per-room detail table below, which uses BOOST_LADDERS directly.
const MATRIX_LADDERS = BOOST_LADDERS.filter(([purpose]) => purpose !== "harvest" && purpose !== "carry");
// Nuker capacities/cooldown — game constants, not in the payload.
const NUKER_GHODIUM_CAPACITY = 5000;
const NUKER_ENERGY_CAPACITY = 300000;
const NUKER_COOLDOWN = 100000; // ticks after a launch

let db;
let rangeHours = 24;
let selectedRoom = null;
let latest = null;
let history = [];        // downsampled [{date, tick, gcl, cpu, cr, rooms}]
let historyRaw = [];     // every fetched row for the current range, un-downsampled
let inFlight = false;
let lastPollAt = 0;
let pollTimer = null;
const charts = {};

const POLL_MS = 5 * 60e3;
const STALE_PROBE_MS = 2.5 * 60e3;
const STALE_AFTER_MS = 15 * 60e3;

function setStatus(text) { $("status").textContent = text; }

// ---------- data ----------

// ?demo=1 renders synthetic data with no Firestore — for local layout checks.
// ?theme=light|dark forces a theme (same override the viewer's OS would set).
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const themeOverride = params.get("theme");
if (themeOverride) document.documentElement.dataset.theme = themeOverride;

// Real controller.progressTotal per level (1..7 → points to reach the next
// level); level 8 has none (max). Used only to make the demo RCL series walk
// through realistic level-ups.
const RCL_LEVEL_PT = { 1: 200, 2: 45000, 3: 135000, 4: 405000, 5: 1215000, 6: 2405000, 7: 4805000 };

// Adds `gain` points to a {level, progress} pair, rolling over into the next
// level(s) exactly like controller.progress does — so demo history can cross
// a level-up mid-window and exercise progressDelta's level-up branch.
function advanceRcl(level, progress, gain) {
    let l = level, p = progress + gain;
    while (RCL_LEVEL_PT[l] !== undefined && p >= RCL_LEVEL_PT[l]) {
        p -= RCL_LEVEL_PT[l];
        l += 1;
    }
    return { l, p, pt: RCL_LEVEL_PT[l] };
}

// Nuker state per room (k) at row i — covers the states real history will
// show: armed and ready; ghodium full with energy still trickling in;
// filling then launched partway through the window (the one case that
// exercises stockRate's cur < prev skip, since the fill drops to zero at the
// launch row); full and refilled but still on cooldown; no nuker at all; and
// a nuker that only starts publishing partway through the window (the real
// shape of history right after this field ships — exercises the null-gap
// skip in stockRate). Returns null/undefined for "room has no nuk this row",
// which the caller drops from the payload rather than storing.
function demoNuk(k, i, n, f) {
    switch (k) {
        case 0: // ready from the start
            return [NUKER_GHODIUM_CAPACITY, NUKER_ENERGY_CAPACITY, 0];
        case 1: { // ghodium full, energy trickling in (the slow, gated leg) — kept
                   // short of full even at the last row, so the rooms table
                   // shows a genuine "still filling" state, not a second "ready"
            const fill = 0.55 * f;
            return [NUKER_GHODIUM_CAPACITY, Math.round(NUKER_ENERGY_CAPACITY * fill), 0];
        }
        case 2: { // filling, then a launch empties it partway through the window
            const launchAt = Math.floor(n * 0.6);
            if (i < launchAt) {
                const fill = Math.min(1, (i / launchAt) * 1.1);
                return [Math.round(NUKER_GHODIUM_CAPACITY * fill), Math.round(NUKER_ENERGY_CAPACITY * fill), 0];
            }
            return [0, 0, Math.max(0, NUKER_COOLDOWN - (i - launchAt) * 120)]; // tick step matches rows.push below
        }
        case 3: // full and refilled, just counting down cooldown
            return [NUKER_GHODIUM_CAPACITY, NUKER_ENERGY_CAPACITY, Math.round(NUKER_COOLDOWN * (1 - f) * 0.4)];
        case 4: // no nuker in this room
            return null;
        case 5: { // nuker starts publishing partway through the window
            const appearAt = Math.floor(n * 0.3);
            if (i < appearAt) return null;
            const fill = Math.min(1, (i - appearAt) / (n - appearAt));
            return [Math.round(NUKER_GHODIUM_CAPACITY * fill), Math.round(NUKER_ENERGY_CAPACITY * fill * 0.5), 0];
        }
        default:
            return null;
    }
}

function synthDemo() {
    const roomNames = ["E15S57", "E18S59", "E21S41", "E21S55", "E23S44", "E27S41"];
    // Per-room fill band for the boosts matrix — spans empty/low/mid/high/full,
    // last room deliberately empty (mirrors a freshly-claimed room with no stock at all).
    const fillFrac = [0.08, 0.92, 0.45, 0.68, 0.28, 0];
    // Per-room RCL trajectory over the visible window: starting {level, progress},
    // total points gained by the last row, and an oscillation so the rate chart
    // has real shape (same reasoning as the gcl series below). E18S59 is seeded
    // just short of its level-6 threshold so it levels up partway through the
    // window; E21S55 starts already at level 8 (maxed, no next-level pt).
    // oscAmp is capped well under (totalGain / MAX_POINTS) * oscPeriod — the
    // point where the oscillation's slope would exceed the trend's and the
    // rate would dip negative — so RCL/tick stays positive at every range,
    // including 21d where n hits the MAX_POINTS ceiling and the trend is weakest.
    const rclSpecs = [
        { level: 5, progress: 300000, totalGain: 350000, oscAmp: 3500, oscPeriod: 9 },
        { level: 6, progress: 2100000, totalGain: 500000, oscAmp: 4000, oscPeriod: 7 },
        { level: 7, progress: 800000, totalGain: 300000, oscAmp: 2800, oscPeriod: 8 },
        { level: 8, progress: 5000000, totalGain: 200000, oscAmp: 1400, oscPeriod: 6 },
        { level: 4, progress: 150000, totalGain: 200000, oscAmp: 2300, oscPeriod: 10 },
        { level: 6, progress: 400000, totalGain: 250000, oscAmp: 3200, oscPeriod: 11 },
    ];
    const now = Date.now();
    const n = Math.min(MAX_POINTS, rangeHours * 6);
    const rows = [];
    for (let i = 0; i < n; i++) {
        const f = i / n;
        const date = new Date(now - (n - i) * (rangeHours / n) * 3600e3);
        const rooms = {};
        roomNames.forEach((name, k) => {
            const frac = fillFrac[k];
            const spec = rclSpecs[k];
            const nuk = demoNuk(k, i, n, f);
            const gained = spec.totalGain * f + spec.oscAmp * Math.sin(i / spec.oscPeriod + k);
            rooms[name] = {
                rcl: advanceRcl(spec.level, spec.progress, Math.max(0, gained)),
                e: 1200 + Math.round(600 * Math.sin(i / 5 + k)), ec: 1800,
                se: 200000 + f * 80000 + 20000 * Math.sin(i / 9 + k), te: k * 40000,
                q: (i + k) % 9,
                roles: [
                    { r: "hauler", c: 3, d: 3 }, { r: "upgrader", c: 2 + k % 2, d: 3 },
                    { r: "source_miner", c: 2, d: 2 }, { r: "builder", c: 1, d: 2 },
                    { r: "remote_miner", rm: "E16S57", c: 1, d: 2 },
                ],
                thr: k === 1 ? { h: 2, melee: 3, ranged: 1, boosted: 0 } : { h: 0 },
                lab: k === 0
                    ? { s: "reaction", o: "XGH2O",
                        i1: ["GH2O", Math.round(3000 * (1 - f))], i2: ["X", Math.round(2800 * (1 - f))],
                        ot: Math.round(2500 * f), cd: i % 10, lc: [2, 4, 0] }
                    : k === 1 ? { s: "boost", lc: [2, 4, 2] } : { s: "idle", lc: [0, 0, 0] },
                // spread across several purposes/tiers so the boosts matrix shows the
                // full ramp; compounds all-zero for the last room to exercise the
                // all-zero row, but with trace raw stock (below MIN_RAW_STOCK) to
                // exercise the "raw under 100" grey state.
                bst: frac === 0 ? { OH: 60, X: 12 } : {
                    UH: Math.round(3000 * frac), UH2O: Math.round(1000 * frac * 0.6),
                    KO: Math.round(3000 * Math.min(1, frac * 1.1)), KHO2: Math.round(1000 * frac * 0.5),
                    LO: Math.round(3000 * frac * 0.9), LHO2: Math.round(1000 * frac * 0.4),
                    GO: Math.round(3000 * frac * 0.7),
                    ZO: Math.round(3000 * frac), ZHO2: Math.round(1000 * frac * 0.3),
                    KH: Math.round(3000 * frac * 0.5),
                    LH: Math.round(3000 * frac * 0.6),
                    GH2O: Math.round(1000 * frac * frac),
                    OH: Math.round(11000 * frac),
                    X: Math.round(21000 * frac * 0.8),
                    G: Math.round(500 * frac), // present in bst but absent from bmax below — exercises "no max" chip
                },
                ...(nuk ? { nuk } : {}),
            };
        });
        rows.push({
            ts: { toDate: () => date }, date, tick: 76680000 + i * 120,
            // mild oscillation on top of the upward trend so the GCL/tick chart
            // has real shape in demo mode, and a steeper trend than the live
            // shard's so the ETA lands in a legible few-day range rather than
            // months. Phased on row index (not wall-clock time) so the cycle
            // count scales with n like every other synthetic series here,
            // instead of aliasing once 500 samples must cover 30 days.
            gcl: { l: 9, p: 6000000 + f * 6000000 + 60000 * Math.sin(i / 6), pt: 48032810 },
            cpu: { u: 20 + 8 * Math.sin(i / 7), l: 110, b: Math.min(10000, 6000 + i * 40) },
            cr: 323000000 + i * 9000,
            rooms,
            bmax: {
                UH: 3000, UH2O: 1000, XUH2O: 500,
                KO: 3000, KHO2: 1000,
                LO: 3000, LHO2: 1000,
                GO: 3000,
                ZO: 3000, ZHO2: 1000,
                KH: 3000, KH2O: 1000,
                LH: 3000,
                GH2O: 1000,
                OH: 11000, X: 21000,
                // G intentionally omitted — no configured max, shows the outline chip
            },
        });
    }
    return rows;
}

async function loadLatest() {
    if (DEMO) { latest = synthDemo().at(-1); return; }
    const snap = await getDoc(doc(db, "meta", "latest"));
    if (!snap.exists()) throw new Error("No data yet — has the collector run?");
    latest = snap.data();
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
    historyRaw = toRows(await getDocs(historyQuery(where("ts", ">=", cutoff))));
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
    historyRaw.push(...rows);
    const cutoff = Date.now() - rangeHours * 3600e3;
    while (historyRaw.length && historyRaw[0].date.getTime() < cutoff) historyRaw.shift();
    return rows.length;
}

// Returns the number of new rows fetched (used by the render gate). Range
// switches reset historyRaw to [] (see bindControls), so an empty historyRaw
// doubles as "need a full fetch" without a separate range-tracking flag.
async function loadHistory() {
    if (DEMO) { history = synthDemo(); return history.length; }
    const added = historyRaw.length > 0
        ? await loadHistoryIncremental().catch(loadHistoryFull)
        : await loadHistoryFull();
    history = downsample(historyRaw, MAX_POINTS);
    return added;
}

// ---------- rendering ----------

function timeLabels() {
    const short = rangeHours <= 24;
    return history.map(r => short
        ? r.date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        : r.date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
}

function baseOptions(series) {
    const ink = { primary: cssVar("--text-primary"), muted: cssVar("--text-muted") };
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
            legend: {
                display: series >= 2,
                labels: { color: ink.primary, boxWidth: 18, boxHeight: 2, usePointStyle: false },
            },
            tooltip: {
                backgroundColor: cssVar("--surface-1"),
                titleColor: ink.primary,
                bodyColor: cssVar("--text-secondary"),
                borderColor: cssVar("--border"),
                borderWidth: 1,
                usePointStyle: false,
            },
        },
        scales: {
            x: {
                ticks: { color: ink.muted, maxTicksLimit: 5, maxRotation: 0, autoSkip: true },
                grid: { display: false },
                border: { color: cssVar("--axis") },
            },
            y: {
                ticks: { color: ink.muted, callback: v => compact(v) },
                grid: { color: cssVar("--grid") },
                border: { display: false },
                beginAtZero: true,
            },
        },
    };
}

function lineDataset(label, data, colorVar) {
    const color = cssVar(colorVar);
    return {
        label, data,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        // with only a few snapshots a 0-radius line is invisible — show dots until history fills in
        pointRadius: history.length < 5 ? 3 : 0,
        pointHoverRadius: 4,
        pointHoverBorderColor: cssVar("--surface-1"),
        pointHoverBorderWidth: 2,
        tension: 0.15,
    };
}

// Instantaneous per-tick rate plus a flat dashed line at the window average,
// so the current rate reads against the range's trend. Shared by the empire
// GCL chart and the per-room RCL chart. The avg is omitted (and with it the
// legend, per baseOptions) when there's no positive gain in range.
function rateDatasets(label, sel) {
    const datasets = [lineDataset(label, rateSeries(sel, history), "--series-1")];
    const wr = windowRate(sel, history);
    if (wr) {
        const avg = lineDataset(`avg ${compact(wr.rate)}/tick`, history.map(() => wr.rate), "--series-2");
        Object.assign(avg, { borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, tension: 0 });
        datasets.push(avg);
    }
    return datasets;
}

function renderLine(key, canvasId, datasets, { yMax = undefined, unit = "" } = {}) {
    charts[key]?.destroy();
    const opts = baseOptions(datasets.length);
    if (yMax !== undefined) opts.scales.y.max = yMax;
    if (unit) opts.plugins.tooltip.callbacks = { label: c => ` ${c.dataset.label}: ${compact(c.parsed.y)}${unit}` };
    charts[key] = new Chart($(canvasId), { type: "line", data: { labels: timeLabels(), datasets }, options: opts });
}

// ETA text shared by the empire GCL tile and the per-room stat strip.
function etaText(eta) {
    return eta
        ? `ETA ~${eta.etaMs != null ? fmtDuration(eta.etaMs) : `${compact(eta.etaTicks)} ticks`} · ${compact(eta.rate)}/tick`
        : "ETA — no gain in range";
}

function renderTileRow(containerId, tiles) {
    $(containerId).replaceChildren(...tiles.map(t => {
        const el = document.createElement("div");
        el.className = "tile";
        const rows = [["label", t.label], ["value", t.value], ["delta", t.delta]];
        if (t.sub) rows.push(["sub", t.sub]);
        for (const [cls, text] of rows) {
            const d = document.createElement("div");
            d.className = cls;
            d.textContent = text;
            el.append(d);
        }
        return el;
    }));
}

function renderTiles() {
    const first = history[0];
    const creepCount = s => Object.values(s.rooms).reduce(
        (sum, r) => sum + (r.roles ?? []).reduce((a, x) => a + x.c, 0), 0);
    const gclPct = pct(latest.gcl.p, latest.gcl.pt);
    const eta = levelEta(r => r.gcl, latest.gcl, history);
    const tiles = [
        { label: "GCL", value: latest.gcl.l, delta: `${gclPct.toFixed(1)}% to ${latest.gcl.l + 1}`, sub: etaText(eta) },
        { label: "CPU bucket", value: fmtInt.format(latest.cpu.b), delta: `used ${latest.cpu.u.toFixed(1)} / ${latest.cpu.l}` },
        { label: "Credits", value: compact(latest.cr), delta: first ? `${latest.cr - first.cr >= 0 ? "+" : ""}${compact(latest.cr - first.cr)} over range` : "" },
        { label: "Rooms", value: Object.keys(latest.rooms).length, delta: "owned" },
        { label: "Creeps", value: creepCount(latest), delta: "alive (tracked roles)" },
    ];
    renderTileRow("tiles", tiles);
}

function renderEmpireCharts() {
    $("gcl-next").textContent = String(latest.gcl.l + 1);
    $("cpu-limit").textContent = String(latest.cpu.l);
    renderLine("gcl", "c-gcl",
        [lineDataset("GCL progress", history.map(r => pct(r.gcl.p, r.gcl.pt)), "--series-1")],
        { yMax: 100, unit: "%" });
    renderLine("gclRate", "c-gcl-rate", rateDatasets("GCL/tick", r => r.gcl));
    renderLine("cpu", "c-cpu",
        [lineDataset("CPU used", history.map(r => r.cpu.u), "--series-1")],
        { yMax: latest.cpu.l });
    renderLine("bucket", "c-bucket",
        [lineDataset("Bucket", history.map(r => r.cpu.b), "--series-1")],
        { yMax: 10000 });
    const uptime = history.map(r => {
        const labRooms = Object.values(r.rooms).filter(x => x.lab);
        return labRooms.length ? 100 * labRooms.filter(x => x.lab.s === "reaction").length / labRooms.length : null;
    });
    renderLine("uptime", "c-uptime",
        [lineDataset("Reacting", uptime, "--series-1")],
        { yMax: 100, unit: "%" });
}

// Stat strip for the selected room's controller: level, progress, upgrade
// throughput and ETA to the next level — the per-room analogue of the GCL
// tile in renderTiles().
function renderRoomTiles(room) {
    const rclOf = r => r.rooms[room]?.rcl ?? null;
    const cur = latest.rooms[room]?.rcl;
    const rangeLabel = $("range-group").querySelector('[aria-pressed="true"]')?.textContent ?? "range";
    const maxed = !cur?.pt;
    const wr = windowRate(rclOf, history);
    const eta = levelEta(rclOf, cur, history);
    const tiles = [
        {
            label: "RCL", value: cur?.l ?? "—",
            delta: maxed ? "max level" : `${compact(cur.p)} / ${compact(cur.pt)}`,
        },
        maxed
            ? { label: "Controller", value: "max", delta: `level ${cur?.l ?? "—"}` }
            : { label: `To level ${cur.l + 1}`, value: `${pct(cur.p, cur.pt).toFixed(1)}%`, delta: `${compact(cur.pt - cur.p)} left` },
        { label: "Upgrade", value: wr ? `${compact(wr.rate)}/tick` : "—", delta: `over ${rangeLabel}` },
        { label: "ETA", value: eta ? (eta.etaMs != null ? `~${fmtDuration(eta.etaMs)}` : `~${compact(eta.etaTicks)} ticks`) : "—",
          delta: eta ? `${compact(eta.rate)}/tick` : (maxed ? "at max level" : "no gain in range") },
    ];
    renderTileRow("room-tiles", tiles);
}

// Nuker status for the selected room — tiles + a two-series fill chart,
// hidden entirely when the room has no nuker. `nuk` is [ghodium, energy,
// cooldown]; absence is never a truncated payload (see nukerCell) so it's an
// unambiguous "no nuker" signal to hide the whole section on.
function renderNuker(room, of) {
    const nuk = latest.rooms[room]?.nuk;
    $("nuker-section").hidden = !nuk;
    if (!nuk) {
        // Otherwise a chart left bound to a now-hidden 0×0 canvas keeps its
        // ResizeObserver alive across the next room switch.
        charts.nuker?.destroy();
        delete charts.nuker;
        return;
    }
    const [g, e, cd] = nuk;
    const gFull = g >= NUKER_GHODIUM_CAPACITY, eFull = e >= NUKER_ENERGY_CAPACITY;
    const ready = cd === 0 && gFull && eFull;

    // Ticks until armed: whichever of cooldown and the two independent fill
    // legs (ghodium via reactions, energy via a gated hauler trickle, see
    // config.nuker.ts) finishes last. Stays null if a short leg has no
    // observed positive rate — an honest "no ETA" beats a fabricated one.
    let readyTicks = ready ? 0 : cd;
    let etaKnown = true;
    for (const [full, cap, amount, rate] of [
        [gFull, NUKER_GHODIUM_CAPACITY, g, stockRate(r => r.rooms[room]?.nuk?.[0] ?? null, history)],
        [eFull, NUKER_ENERGY_CAPACITY, e, stockRate(r => r.rooms[room]?.nuk?.[1] ?? null, history)],
    ]) {
        if (full) continue;
        if (!rate) { etaKnown = false; continue; }
        readyTicks = Math.max(readyTicks, (cap - amount) / rate);
    }
    // Collector gaps (dedup on unchanged tick, or the bot skipping publication
    // under minBucket) inflate the observed ms/tick and so over-estimate this
    // ETA — pre-existing for the RCL ETA too, but the ~100k-tick cooldown
    // multiplies it far more.
    const ms = observedMsPerTick(history);
    const etaLabel = ready ? "ready"
        : !etaKnown ? "—"
        : ms != null ? `~${fmtDuration(readyTicks * ms)}` : `~${compact(readyTicks)} ticks`;

    const cooldownLabel = cd > 0
        ? (ms != null ? `~${fmtDuration(cd * ms)}` : `~${compact(cd)} ticks`)
        : "off cooldown";
    renderTileRow("nuker-tiles", [
        { label: "Status", value: ready ? "ready" : cd > 0 ? "cooling" : "filling",
          delta: ready ? "armed" : "" },
        { label: "Ghodium", value: `${Math.round(Math.min(1, g / NUKER_GHODIUM_CAPACITY) * 100)}%`,
          delta: `${fmtInt.format(g)} / ${fmtInt.format(NUKER_GHODIUM_CAPACITY)}` },
        { label: "Energy", value: `${Math.round(Math.min(1, e / NUKER_ENERGY_CAPACITY) * 100)}%`,
          delta: `${fmtInt.format(e)} / ${fmtInt.format(NUKER_ENERGY_CAPACITY)}` },
        { label: "Cooldown", value: cooldownLabel,
          delta: cd > 0 ? `${fmtInt.format(cd)} / ${fmtInt.format(NUKER_COOLDOWN)}` : "" },
        { label: "ETA ready", value: etaLabel, delta: ready || etaKnown ? "" : "no gain in range" },
    ]);

    const gSeries = of(r => r.nuk ? pct(r.nuk[0], NUKER_GHODIUM_CAPACITY) : null);
    const eSeries = of(r => r.nuk ? pct(r.nuk[1], NUKER_ENERGY_CAPACITY) : null);
    const gDataset = lineDataset("Ghodium", gSeries, "--series-1");
    const eDataset = lineDataset("Energy", eSeries, "--series-2");
    // A nuker built (or first published) mid-window can have fewer than 5
    // non-null points even though history.length >= 5 — lineDataset's radius-0
    // default would then render nothing, since a lone point draws no segment.
    for (const [ds, series] of [[gDataset, gSeries], [eDataset, eSeries]]) {
        if (series.filter(v => v != null).length < 5) ds.pointRadius = 3;
    }
    renderLine("nuker", "c-nuker", [gDataset, eDataset], { yMax: 100, unit: "%" });
}

function renderRoomCharts() {
    const room = selectedRoom;
    $("room-title").textContent = `Room ${room}`;
    const of = fn => history.map(r => (r.rooms[room] ? fn(r.rooms[room]) : null));
    renderRoomTiles(room);
    renderLine("rcl", "c-rcl",
        [lineDataset("RCL progress", of(r => pct(r.rcl.p, r.rcl.pt)), "--series-1")],
        { yMax: 100, unit: "%" });
    renderLine("rclRate", "c-rcl-rate", rateDatasets("RCL/tick", r => r.rooms[room]?.rcl ?? null));
    renderLine("energy", "c-energy", [
        lineDataset("Storage", of(r => r.se), "--series-1"),
        lineDataset("Terminal", of(r => r.te), "--series-2"),
    ]);
    renderLine("spawn", "c-spawn",
        [lineDataset("Spawn energy", of(r => pct(r.e, r.ec)), "--series-1")],
        { yMax: 100, unit: "%" });
    const topCompounds = Object.entries(latest.rooms[room]?.bst ?? {})
        .sort(([, a], [, b]) => b - a).slice(0, 3).map(([sym]) => sym);
    renderLine("bst", "c-bst", topCompounds.map((sym, i) =>
        lineDataset(sym, of(r => r.bst?.[sym] ?? null), `--series-${i + 1}`)));
    renderRolesChart(room);
    renderBoostGrid(room);
    renderNuker(room, of);
}

function renderRolesChart(room) {
    charts.roles?.destroy();
    const roles = latest.rooms[room]?.roles ?? [];
    const labels = roles.map(x => x.rm ? `${x.r} → ${x.rm}` : x.r);
    const opts = baseOptions(2);
    // legend swatches mirror the mark: rects for bars, not line keys
    opts.plugins.legend.labels.boxWidth = 10;
    opts.plugins.legend.labels.boxHeight = 10;
    opts.indexAxis = "y";
    opts.interaction = { mode: "index", intersect: false, axis: "y" };
    opts.scales = {
        x: {
            ticks: { color: cssVar("--text-muted"), precision: 0 },
            grid: { color: cssVar("--grid") },
            border: { display: false },
            beginAtZero: true,
        },
        y: {
            ticks: { color: cssVar("--text-primary"), autoSkip: false, font: { size: 11 } },
            grid: { display: false },
            border: { color: cssVar("--axis") },
        },
    };
    charts.roles = new Chart($("c-roles"), {
        type: "bar",
        data: {
            labels,
            datasets: [
                { label: "Current", data: roles.map(x => x.c), backgroundColor: cssVar("--series-1"),
                  borderRadius: { topRight: 4, bottomRight: 4 }, maxBarThickness: 14 },
                { label: "Desired", data: roles.map(x => x.d), backgroundColor: cssVar("--series-2"),
                  borderRadius: { topRight: 4, bottomRight: 4 }, maxBarThickness: 14 },
            ],
        },
        options: opts,
    });
    const card = $("c-roles").closest(".plot");
    card.style.height = `${Math.max(200, roles.length * 34 + 60)}px`;
}

function makeBadge(color, text) {
    const badge = document.createElement("span");
    badge.className = "badge";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = color;
    const label = document.createElement("span");
    label.textContent = text;
    badge.append(swatch, label);
    return badge;
}

function threatBadge(thr) {
    let level, text;
    if (!thr || thr.h === 0) { level = "good"; text = "clear"; }
    else if (thr.boosted > 0) { level = "critical"; text = `${thr.h} hostiles ⚠ boosted`; }
    else if ((thr.melee ?? 0) + (thr.ranged ?? 0) > 0) { level = "serious"; text = `${thr.h} hostiles armed`; }
    else { level = "warning"; text = `${thr.h} hostiles`; }
    return makeBadge(cssVar(`--status-${level}`), text);
}

// Small fill square for the rooms-table nuker cell — same visual language as
// the boosts matrix chips, but against the nuker's own capacities rather
// than PARTS_PER_BOOST/bmax, so it doesn't reuse boostChip.
function nukerChip(label, amount, cap) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const fill = amount / cap;
    chip.style.background = amount === 0 ? cssVar("--grid") : cssVar(`--fill-${rampLevel(Math.min(1, fill))}`);
    chip.title = `${label} ${fmtInt.format(amount)} / ${fmtInt.format(cap)} (${Math.round(fill * 100)}%)`;
    return chip;
}

// `nuk` absent means the room has no nuker at all — unlike roles/thr, `nuk`
// is never dropped by StatsManager's payload-size degradation, so absence is
// never a truncated payload (contrast creepsCell, where a missing `roles` is
// ambiguous with degradation).
function nukerCell(nuk) {
    const td = document.createElement("td");
    td.className = "nuker-cell";
    if (!nuk) { td.textContent = "—"; td.classList.add("na"); return td; }
    const [g, e, cd] = nuk;
    const wrap = document.createElement("span");
    wrap.className = "nuker-fill";
    wrap.append(
        nukerChip("ghodium", g, NUKER_GHODIUM_CAPACITY),
        nukerChip("energy", e, NUKER_ENERGY_CAPACITY),
    );
    td.append(wrap);
    const ready = cd === 0 && g >= NUKER_GHODIUM_CAPACITY && e >= NUKER_ENERGY_CAPACITY;
    td.title = `${ready ? "ready · " : cd > 0 ? `cooldown ${fmtInt.format(cd)} · ` : ""}`
        + `ghodium ${fmtInt.format(g)} / ${fmtInt.format(NUKER_GHODIUM_CAPACITY)} · `
        + `energy ${fmtInt.format(e)} / ${fmtInt.format(NUKER_ENERGY_CAPACITY)}`;
    return td;
}

function labStatusBadge(s) {
    const colors = {
        reaction: cssVar("--status-good"),
        prepare: cssVar("--status-warning"),
        resource_check: cssVar("--status-warning"),
        finished: cssVar("--status-warning"),
        boost: cssVar("--series-1"),
        idle: cssVar("--text-muted"),
    };
    const labels = { resource_check: "resources", boost: "boosting" };
    return makeBadge(colors[s] ?? cssVar("--text-muted"), labels[s] ?? s);
}

function renderLabsTable() {
    const tbody = $("labs-table").querySelector("tbody");
    const rows = Object.entries(latest.rooms).sort(([a], [b]) => a.localeCompare(b));
    tbody.replaceChildren(...rows.map(([name, r]) => {
        const tr = document.createElement("tr");
        const lab = r.lab;
        const nameTd = document.createElement("td");
        nameTd.textContent = name;
        const statusTd = document.createElement("td");
        statusTd.append(lab ? labStatusBadge(lab.s) : document.createTextNode("—"));
        tr.append(nameTd, statusTd);
        const cells = lab ? [
            lab.o ? `${lab.i1?.[0] ?? "?"} + ${lab.i2?.[0] ?? "?"} → ${lab.o}` : "—",
            lab.i1 ? `${lab.i1[0]} ${fmtInt.format(lab.i1[1])}` : "—",
            lab.i2 ? `${lab.i2[0]} ${fmtInt.format(lab.i2[1])}` : "—",
            lab.ot != null ? fmtInt.format(lab.ot) : "—",
            lab.cd != null ? String(lab.cd) : "—",
            lab.lc.join("/"),
        ] : ["—", "—", "—", "—", "—", "—"];
        for (const text of cells) {
            const td = document.createElement("td");
            td.textContent = text;
            tr.append(td);
        }
        return tr;
    }));
}

function boostChip(label, amount, max, raw) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const level = boostFillLevel(amount, max, raw);
    const value = raw ? (amount ?? 0) : Math.floor((amount ?? 0) / PARTS_PER_BOOST);
    if (level === null) {
        chip.classList.add("nomax");
        chip.title = `${label} · ${compact(value)} parts · no max configured`;
    } else {
        chip.style.background = level === 0 ? cssVar("--grid") : cssVar(`--fill-${level}`);
        if (level === 0 && amount) {
            chip.title = `${label} · ${fmtInt.format(amount)} · ${boostFloor(raw).reason}`;
        } else if (level === 0) {
            chip.title = `${label} · none`;
        } else {
            const fillPct = max ? Math.round(Math.min(1, amount / max) * 100) : 0;
            chip.title = `${label} · ${fmtInt.format(value)} parts · ${fillPct}% of max`;
        }
    }
    return chip;
}

function boostCell(amount, max, raw) {
    const td = document.createElement("td");
    const floor = boostFloor(raw);
    if (!amount || amount < floor.amount) {
        td.textContent = "—";
        td.className = "na";
        if (amount) td.title = `${fmtInt.format(amount)} · ${floor.reason}`;
        return td;
    }
    const value = raw ? amount : Math.floor(amount / PARTS_PER_BOOST);
    if (!max) {
        td.textContent = compact(value);
        return td;
    }
    const level = boostFillLevel(amount, max, raw);
    const fill = Math.min(1, amount / max);
    td.append(makeBadge(cssVar(`--fill-${level}`), `${compact(value)} · ${Math.round(fill * 100)}%`));
    return td;
}

function renderBoostGrid(room) {
    $("room-boosts-title").textContent = `Boosts · ${room} · parts boostable, fill vs configured max`;
    const bst = latest.rooms[room]?.bst ?? {};
    const bmax = latest.bmax ?? {};
    const tbody = $("boost-grid").querySelector("tbody");
    const ladderRows = BOOST_LADDERS.map(([purpose, tiers]) => {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.textContent = purpose;
        tr.append(td);
        for (const sym of tiers) tr.append(boostCell(bst[sym] ?? 0, bmax[sym], false));
        return tr;
    });
    const rawRows = RAW_INPUTS.map(([name, sym]) => {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.textContent = `${name} (${sym}) · raw`;
        tr.append(td, boostCell(bst[sym] ?? 0, bmax[sym], true));
        for (let i = 0; i < 2; i++) {
            const empty = document.createElement("td");
            empty.textContent = "";
            tr.append(empty);
        }
        return tr;
    });
    tbody.replaceChildren(...ladderRows, ...rawRows);
}

function renderBoostMatrix() {
    const tbody = $("boost-matrix").querySelector("tbody");
    const bmax = latest.bmax ?? {};
    const rows = Object.entries(latest.rooms).sort(([a], [b]) => a.localeCompare(b));
    tbody.replaceChildren(...rows.map(([name, r]) => {
        const bst = r.bst ?? {};
        const tr = document.createElement("tr");
        const nameTd = document.createElement("td");
        nameTd.textContent = name;
        tr.append(nameTd);
        for (const [purpose, tiers] of MATRIX_LADDERS) {
            const td = document.createElement("td");
            const wrap = document.createElement("div");
            wrap.className = "chips";
            tiers.forEach((sym, i) => {
                wrap.append(boostChip(`${name} · ${purpose} T${i + 1} · ${sym}`, bst[sym] ?? 0, bmax[sym], false));
            });
            td.append(wrap);
            tr.append(td);
        }
        RAW_INPUTS.forEach(([label, sym], i) => {
            const td = document.createElement("td");
            if (i === 0) td.classList.add("raw-group");
            const wrap = document.createElement("div");
            wrap.className = "chips";
            wrap.append(boostChip(`${name} · ${label}`, bst[sym] ?? 0, bmax[sym], true));
            td.append(wrap);
            tr.append(td);
        });
        return tr;
    }));
}

function creepsCell(roles) {
    const td = document.createElement("td");
    if (!roles) {                      // payload degraded — roles/thr are dropped first, see StatsManager
        td.textContent = "—";
        td.className = "na";
        return td;
    }
    const cur = roles.reduce((a, x) => a + x.c, 0);
    const des = roles.reduce((a, x) => a + x.d, 0);
    td.textContent = `${cur} / ${des}`;
    if (cur < des) {
        td.className = cur < des * 0.5 ? "critical" : "short";
        td.title = "short: " + roles.filter(x => x.c < x.d)
            .map(x => `${x.rm ? `${x.r} → ${x.rm}` : x.r} ${x.c}/${x.d}`).join(", ");
    }
    return td;
}

// ETA cell text shared by the rooms table — mirrors the room stat strip's
// ETA tile, but compact enough for a table cell.
function etaCellText(eta, maxed) {
    if (maxed) return "max";
    if (!eta) return "—";
    return eta.etaMs != null ? `~${fmtDuration(eta.etaMs)}` : `~${compact(eta.etaTicks)} ticks`;
}

function renderRoomsTable() {
    const tbody = $("rooms-table").querySelector("tbody");
    const rows = Object.entries(latest.rooms).sort(([a], [b]) => a.localeCompare(b));
    tbody.replaceChildren(...rows.map(([name, r]) => {
        const tr = document.createElement("tr");
        const maxed = !r.rcl.pt;
        const eta = levelEta(row => row.rooms[name]?.rcl ?? null, r.rcl, history);
        const cells = [
            name,
            String(r.rcl.l),
            maxed ? "max" : `${pct(r.rcl.p, r.rcl.pt).toFixed(1)}%`,
            etaCellText(eta, maxed),
            `${r.e} / ${r.ec}`,
            compact(r.se),
            compact(r.te),
        ];
        for (const text of cells) {
            const td = document.createElement("td");
            td.textContent = text;
            tr.append(td);
        }
        tr.append(creepsCell(r.roles));
        const queueTd = document.createElement("td");
        queueTd.textContent = String(r.q);
        tr.append(queueTd);
        const threatTd = document.createElement("td");
        threatTd.append(threatBadge(r.thr));
        tr.append(threatTd);
        tr.append(nukerCell(r.nuk));
        return tr;
    }));
}

function renderRoomSelect() {
    const names = Object.keys(latest.rooms).sort();
    if (!selectedRoom || !names.includes(selectedRoom)) selectedRoom = names[0];
    const sel = $("room-select");
    sel.replaceChildren(...names.map(n => {
        const o = document.createElement("option");
        o.value = o.textContent = n;
        o.selected = n === selectedRoom;
        return o;
    }));
}

function renderAll() {
    renderTiles();
    renderRoomSelect();
    renderEmpireCharts();
    renderRoomCharts();
    renderBoostMatrix();
    renderLabsTable();
    renderRoomsTable();
    renderStatus();
}

// Ms since latest's snapshot was taken, shared by renderStatus (the "(N min
// ago)" readout) and scheduleNextPoll (aiming the next poll at latest's age).
function dataAgeMs() {
    return latest ? Date.now() - latest.ts.toDate().getTime() : 0;
}

// Redraws only the header status line — tick, timestamp, and age. Cheap
// enough to run on its own 30s tick so "(N min ago)" counts up live between
// polls instead of only updating when a full refresh happens to land.
function renderStatus() {
    if (!latest) return;
    const when = latest.ts.toDate();
    const ageMs = dataAgeMs();
    const age = Math.round(ageMs / 60000);
    const sameDay = when.toDateString() === new Date().toDateString();
    const stamp = sameDay
        ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        : when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const stale = ageMs > STALE_AFTER_MS;
    setStatus(`tick ${fmtInt.format(latest.tick)} · updated ${stamp} (${age} min ago)${stale ? " · stale" : ""}`);
    $("status").classList.toggle("stale", stale);
}

// ---------- boot ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
                const [, added] = await Promise.all([loadLatest(), loadHistory()]);
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

function bindControls() {
    $("range-group").addEventListener("click", e => {
        const btn = e.target.closest("button[data-range]");
        if (!btn) return;
        for (const b of $("range-group").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
        rangeHours = Number(btn.dataset.range);
        historyRaw = [];
        refresh({ force: true });
    });
    $("refresh")?.addEventListener("click", () => refresh({ force: true }));
    $("room-select").addEventListener("change", e => {
        selectedRoom = e.target.value;
        renderRoomCharts();
    });
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

if (!DEMO && firebaseConfig.apiKey === "REPLACE_ME") {
    $("setup-notice").hidden = false;
    setStatus("not configured");
} else {
    if (!DEMO) {
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
    $("app").hidden = false;
    bindControls();
    refresh();
}
