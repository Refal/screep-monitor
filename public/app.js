import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
    getFirestore, doc, getDoc, collection, query, where, orderBy, getDocs, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const MAX_POINTS = 500;

const $ = id => document.getElementById(id);
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const fmtCompact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat("en");
const compact = n => (n == null ? "—" : fmtCompact.format(n));
const pct = (p, pt) => (pt ? (100 * p / pt) : 0);

// Progress points gained between two consecutive {l,p,pt} readings, level-up
// aware — p resets to ~0 when l increments, so a naive p-delta would go
// sharply negative right at a level-up. Used for both GCL and per-room RCL.
function progressDelta(prev, cur) {
    if (!prev || !cur) return null; // room absent from one of the snapshots
    if (cur.l === prev.l) return cur.p - prev.p;
    if (cur.l === prev.l + 1) return (prev.pt - prev.p) + cur.p;
    return null; // multi-level jump — intermediate progressTotal unknown, can't attribute
}

// Points gained per tick between consecutive history rows, aligned with
// history/timeLabels (index 0 has no predecessor, so it's null). `sel` reads
// the {l,p,pt} reading off a history row (e.g. r => r.gcl, r => r.rooms[room]?.rcl).
function rateSeries(sel) {
    return history.map((r, i) => {
        if (i === 0) return null;
        const prev = history[i - 1];
        const dTick = r.tick - prev.tick;
        const d = dTick > 0 ? progressDelta(sel(prev), sel(r)) : null;
        return d == null ? null : d / dTick;
    });
}

// Average gain rate over the whole visible window — aggregated rather than
// extrapolated from the last point so a single noisy interval can't skew the
// estimate — plus the observed wall-clock ms per tick over that window.
function windowRate(sel) {
    if (history.length < 2) return null;
    let points = 0, ticks = 0;
    for (let i = 1; i < history.length; i++) {
        const prev = history[i - 1], cur = history[i];
        const dTick = cur.tick - prev.tick;
        if (dTick <= 0) continue;
        const d = progressDelta(sel(prev), sel(cur));
        if (d == null) continue;
        points += d;
        ticks += dTick;
    }
    if (ticks <= 0 || points <= 0) return null;
    const rate = points / ticks;
    const first = history[0], last = history[history.length - 1];
    const dTickWindow = last.tick - first.tick;
    const msPerTick = dTickWindow > 0 ? (last.date - first.date) / dTickWindow : null;
    return { rate, msPerTick };
}

// ETA to the next level for a current {l,p,pt} reading. `pt` is falsy at max
// level (controller.progressTotal is undefined and JSON.stringify drops it),
// which reads as "no next level" rather than the misleading 0%/instant ETA
// a naive division would produce.
function levelEta(sel, cur) {
    if (!cur?.pt) return null;
    const wr = windowRate(sel);
    if (!wr) return null;
    const etaTicks = (cur.pt - cur.p) / wr.rate;
    return { rate: wr.rate, etaTicks, etaMs: wr.msPerTick ? etaTicks * wr.msPerTick : null };
}

function fmtDuration(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
    const mins = ms / 60000;
    if (mins < 60) return `${Math.round(mins)}m`;
    const hours = mins / 60;
    if (hours < 24) return `${Math.floor(hours)}h ${Math.round(mins % 60)}m`;
    const days = hours / 24;
    if (days < 30) return `${Math.floor(days)}d ${Math.round(hours % 24)}h`;
    return `${Math.round(days)}d`;
}

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
const PARTS_PER_BOOST = 30; // LAB_BOOST_MINERAL

let db;
let rangeHours = 24;
let selectedRoom = null;
let latest = null;
let history = [];        // downsampled [{date, tick, gcl, cpu, cr, rooms}]
const charts = {};

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
    // including 30d where n hits the MAX_POINTS ceiling and the trend is weakest.
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
                // full ramp; empty for the last room to exercise the all-zero row.
                bst: frac === 0 ? {} : {
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

async function loadHistory() {
    if (DEMO) { history = synthDemo(); return; }
    const cutoff = Timestamp.fromMillis(Date.now() - rangeHours * 3600e3);
    const q = query(collection(db, "snapshots"), where("ts", ">=", cutoff), orderBy("ts", "asc"));
    const snap = await getDocs(q);
    const rows = snap.docs.map(d => { const v = d.data(); return { ...v, date: v.ts.toDate() }; });
    history = downsample(rows, MAX_POINTS);
}

function downsample(rows, max) {
    if (rows.length <= max) return rows;
    const step = rows.length / max;
    const out = [];
    for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]);
    out[out.length - 1] = rows[rows.length - 1];
    return out;
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
    const eta = levelEta(r => r.gcl, latest.gcl);
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
    renderLine("gclRate", "c-gcl-rate",
        [lineDataset("GCL/tick", rateSeries(r => r.gcl), "--series-1")]);
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
    const wr = windowRate(rclOf);
    const eta = levelEta(rclOf, cur);
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

function renderRoomCharts() {
    const room = selectedRoom;
    $("room-title").textContent = `Room ${room}`;
    const of = fn => history.map(r => (r.rooms[room] ? fn(r.rooms[room]) : null));
    renderRoomTiles(room);
    renderLine("rcl", "c-rcl",
        [lineDataset("RCL progress", of(r => pct(r.rcl.p, r.rcl.pt)), "--series-1")],
        { yMax: 100, unit: "%" });
    const rclOf = r => r.rooms[room]?.rcl ?? null;
    const rclRateDatasets = [lineDataset("RCL/tick", rateSeries(rclOf), "--series-1")];
    const rclWr = windowRate(rclOf);
    if (rclWr) {
        const avg = lineDataset(`avg ${compact(rclWr.rate)}/tick`, history.map(() => rclWr.rate), "--series-2");
        Object.assign(avg, { borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, tension: 0 });
        rclRateDatasets.push(avg);
    }
    renderLine("rclRate", "c-rcl-rate", rclRateDatasets);
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

// Fill ramp (red = short, green = stocked) — 5 buckets plus zero/no-max.
// A boost costs PARTS_PER_BOOST per part, so a compound stock under that can't
// boost anything: treat it as absent rather than flagging it red. Raw reagents
// (OH/X/G) aren't measured in boosts, so the floor doesn't apply to them.
function boostFillLevel(amount, max, raw) {
    if (!max) return null;                            // no configured max — rendered as an outline chip
    if (!amount) return 0;                             // in-range but empty
    if (!raw && amount < PARTS_PER_BOOST) return 0;    // dust — can't boost a single part
    const fill = amount / max;
    if (fill < 0.20) return 1;
    if (fill < 0.40) return 2;
    if (fill < 0.60) return 3;
    if (fill < 0.85) return 4;
    return 5;
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
            chip.title = `${label} · ${fmtInt.format(amount)} · under one boost (${PARTS_PER_BOOST})`;
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
    if (!amount || (!raw && amount < PARTS_PER_BOOST)) {
        td.textContent = "—";
        td.className = "na";
        if (amount) td.title = `${fmtInt.format(amount)} · under one boost (${PARTS_PER_BOOST})`;
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
        const eta = levelEta(row => row.rooms[name]?.rcl ?? null, r.rcl);
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
    const age = Math.round((Date.now() - latest.ts.toDate().getTime()) / 60000);
    setStatus(`tick ${fmtInt.format(latest.tick)} · updated ${age} min ago`);
}

// ---------- boot ----------

async function refresh() {
    setStatus("loading…");
    try {
        await Promise.all([loadLatest(), loadHistory()]);
        renderAll();
    } catch (err) {
        setStatus(String(err.message ?? err));
    }
}

function bindControls() {
    $("range-group").addEventListener("click", e => {
        const btn = e.target.closest("button[data-range]");
        if (!btn) return;
        for (const b of $("range-group").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
        rangeHours = Number(btn.dataset.range);
        refresh();
    });
    $("room-select").addEventListener("change", e => {
        selectedRoom = e.target.value;
        renderRoomCharts();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => latest && renderAll());
}

if (!DEMO && firebaseConfig.apiKey === "REPLACE_ME") {
    $("setup-notice").hidden = false;
    setStatus("not configured");
} else {
    if (!DEMO) db = getFirestore(initializeApp(firebaseConfig));
    $("app").hidden = false;
    bindControls();
    refresh();
    if (!DEMO) setInterval(refresh, 10 * 60e3);
}
