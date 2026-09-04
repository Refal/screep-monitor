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
    fmtHits, roomPosture, defenderSummary, barrierTarget, barrierLevel, isCriticalBarrier,
    RANGES, DEFAULT_RANGE,
    empireVerdict, threatItems, clearRooms, isOutgunned,
    netTowerDps, sortByPosture, hostileEpisodes, CRITICAL_RAMPART_HITS, TOWER_DPS_PER_ARMED,
    remoteThreatClass, sortRemoteThreats, hasThreatDetail, remoteEpisodes,
    REMOTE_STALE_AGE_TICKS, MAX_REMOTE_THREATS,
    MANIFEST_GUARD_ROLE, SHARD, roomUrl, roomHistoryUrl,
    NUKER_GHODIUM_CAPACITY, NUKER_ENERGY_CAPACITY, NUKER_COOLDOWN,
} from "./calc.js";
import { parseHash, buildHash, OVERVIEW, ROOM } from "./route.js";
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

let db;
let rangeHours = DEFAULT_RANGE;
// The view, mirrored from location.hash. Every control writes the hash and
// lets onHashChange drive the state, so a bookmark, the Back button and a
// click all take exactly the same path.
let route = { view: OVERVIEW, room: null, range: DEFAULT_RANGE };
let selectedRoom = null;
let latest = null;
let history = [];        // downsampled [{date, tick, gcl, gpl?, cpu, cr, rooms}]
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
// Keeps the header's shard label in sync with the shard the room/history
// links above point at — see SHARD in calc.js. The literal in index.html is
// only a no-JS fallback.
$("shard-label").textContent = SHARD;

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

async function loadLatest() {
    if (DEMO) { latest = (await demoHistory()).at(-1); return; }
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
    if (DEMO) { history = await demoHistory(); return history.length; }
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

// ---------- threat board ----------
// The page's answer to "is anything on fire?", above everything else so a
// phone glance never has to scroll for it. Only non-clear rooms and armed
// strongholds get a card, worst first (see threatItems); the clear rooms
// collapse to one line. calc.js owns the judgment, this owns the wording.

const VERDICT_TONE = {
    // Above every posture: if the towers cannot break the heal, the room is
    // losing regardless of what else is in order. Same red as `exposed`, since
    // both are "act now" and a second red would only dilute it.
    outgunned:  { color: "--status-critical", headline: "OUTGUNNED" },
    exposed:    { color: "--status-critical", headline: "EXPOSED" },
    engaged:    { color: "--status-warning",  headline: "ENGAGED" },
    stronghold: { color: "--status-serious",  headline: "STRONGHOLD NEARBY" },
    unknown:    { color: "--text-muted",      headline: "UNKNOWN" },
    clear:      { color: "--status-good",     headline: "ALL CLEAR" },
};

const THREAT_KIND_LABEL = {
    outgunned: "outgunned",
    exposed: "exposed",
    engaged: "engaged",
    stronghold: "armed stronghold",
    unknown: "unknown",
};

function verdictSubtitle(v) {
    const parts = [];
    if (v.counts.outgunned) parts.push(`${v.counts.outgunned} outgunned`);
    if (v.counts.exposed) parts.push(`${v.counts.exposed} exposed`);
    if (v.counts.engaged) parts.push(`${v.counts.engaged} engaged`);
    if (v.strongholds) parts.push(pluralCount(v.strongholds, "armed stronghold"));
    if (v.counts.unknown) parts.push(`${pluralCount(v.counts.unknown, "room")} unknown`);
    if (!parts.length) return `${pluralCount(v.counts.clear, "room")} clear`;
    if (v.counts.clear) parts.push(`${v.counts.clear} clear`);
    return parts.join(" · ");
}

// One label/value line inside a threat card.
function boardRow(label, value, cls) {
    const row = document.createElement("div");
    row.className = "board-row";
    const k = document.createElement("span");
    k.className = "board-key";
    k.textContent = label;
    const val = document.createElement("span");
    if (cls) val.className = cls;
    val.append(value);
    row.append(k, val);
    return row;
}

function threatCardHead(item) {
    const head = document.createElement("div");
    head.className = "board-head";
    head.append(roomNameLink(item.room));
    const tone = item.kind === "engaged" ? "--status-warning"
        : item.kind === "unknown" ? "--text-muted"
        : item.kind === "stronghold" ? "--status-serious"
        : "--status-critical";
    head.append(makeBadge(cssVar(tone), THREAT_KIND_LABEL[item.kind]));
    return head;
}

function roomThreatCard(item) {
    const card = document.createElement("article");
    card.className = "board-card";
    card.append(threatCardHead(item));

    const thr = item.thr;
    if (!thr) {
        // The distinction the whole payload doctrine exists to protect: this is
        // silence, not safety.
        card.append(boardRow("Why", "threat detail was dropped from this snapshot — not an all-clear", "na"));
        return card;
    }

    const who = [thr.owners?.join(", "), (thr.boosted ?? 0) > 0 ? "⚡ boosted parts" : null].filter(Boolean).join(" · ");
    card.append(boardRow("Hostiles", `${thr.h}${who ? ` · ${who}` : ""}`));
    card.append(boardRow("Damage",
        `${fmtInt.format((thr.melee ?? 0) + (thr.ranged ?? 0))}/t in · towers net ${fmtInt.format(item.net)}/t`,
        item.net < 0 ? "critical" : undefined));
    if (item.net < 0) {
        card.append(boardRow("Warning", "hostile healing beats your tower dps — towers alone cannot break this", "critical"));
    }
    if (item.posture.reasons.length) {
        card.append(boardRow("Exposed by", item.posture.reasons.join(" · "), "serious"));
    }
    card.append(boardRow("Safe mode",
        thr.sm !== undefined ? `active, ${compact(thr.sm)} ticks left`
            : thr.smAvail > 0 ? `${pluralCount(thr.smAvail, "charge")} ready`
            : "no charge available",
        thr.sm === undefined && thr.smAvail === 0 ? "critical" : undefined));
    card.append(boardRow("Zone rampart",
        thr.defRmp != null
            ? `${fmtHits(thr.defRmp)} of ${fmtHits(barrierTarget("zoneRampart", item.rcl.l))} target at RCL ${item.rcl.l}`
            : "no rampart inside the configured defender zone",
        thr.defRmp == null ? "na" : isCriticalBarrier(thr.defRmp, "zoneRampart") ? "critical" : undefined));
    const def = defenderSummary(thr, item.roles);
    card.append(boardRow("Defenders",
        def.des ? `${def.cur} of ${def.des} fielded` : DEF_STATE_EXPLAIN[def.state] ?? def.state,
        def.des && def.cur < def.des ? shortfallClass(def.cur, def.des) : undefined));
    return card;
}

function strongholdCard(item) {
    const { entry } = item;
    const card = document.createElement("article");
    card.className = "board-card";
    card.append(threatCardHead(item));
    card.append(boardRow("Core", `level ${entry.coreLvl}${entry.core != null ? ` · ${fmtHits(entry.core)} hits` : ""}`,
        "critical"));
    if (entry.home) card.append(boardRow("Threatens", `${entry.home}'s remote mining`));
    card.append(boardRow("Hostiles",
        entry.mem ? "unknown — no vision" : `${entry.h}${entry.owners?.length ? ` · ${entry.owners.join(", ")}` : ""}`,
        entry.mem ? "na" : undefined));
    // Promoted out of a tooltip: past the cache TTL, or carried from the bot's
    // persisted memory, this row is a belief rather than a reading.
    const stale = entry.mem || entry.age > REMOTE_STALE_AGE_TICKS;
    card.append(boardRow("Last seen",
        stale ? `believed present — no vision for ~${fmtInt.format(entry.age)} ticks` : `${fmtInt.format(entry.age)} ticks ago`,
        stale ? "na" : undefined));
    card.append(boardRow("Care", "never send an unescorted melee creep at an armed stronghold"));
    return card;
}

function renderThreatBoard() {
    const v = empireVerdict(latest);
    // When the whole payload was degraded, every room is `unknown` for the same
    // single reason and the banner has already given it — one card per room
    // would just be the same sentence N times. Name the rooms on one line
    // instead. A PARTIALLY covered snapshot is different: there, an uncovered
    // room really is its own finding and keeps its card.
    const items = v.degraded
        ? threatItems(latest).filter(i => i.scope === "remote")
        : threatItems(latest);

    // A degraded payload leads with that, never with a colour that reads calm.
    const tone = v.degraded ? { color: "--status-warning", headline: "NO THREAT DATA" } : VERDICT_TONE[v.level];
    const head = $("verdict");
    head.style.setProperty("--verdict-color", cssVar(tone.color));
    const title = document.createElement("strong");
    title.className = "verdict-title";
    title.textContent = tone.headline;
    const sub = document.createElement("span");
    sub.className = "verdict-sub";
    sub.textContent = v.degraded
        ? "this snapshot had its threat detail dropped (payload degradation) — the board below is not an all-clear"
        : verdictSubtitle(v);
    head.replaceChildren(title, sub);

    $("threat-list").replaceChildren(
        ...items.map(item => item.scope === "remote" ? strongholdCard(item) : roomThreatCard(item)));

    if (v.degraded) {
        $("clear-line").textContent =
            `${pluralCount(v.rooms, "room")} owned, none covered by this snapshot · `
            + Object.keys(latest.rooms).sort().join(" ");
        return;
    }
    const clear = clearRooms(latest);
    $("clear-line").textContent = clear.length
        ? `${pluralCount(clear.length, "room")} clear · ${clear.join(" ")}`
        : "";
}

function renderTiles() {
    const first = history[0];
    const creepCount = s => Object.values(s.rooms).reduce(
        (sum, r) => sum + (r.roles ?? []).reduce((a, x) => a + x.c, 0), 0);
    const gclPct = pct(latest.gcl.p, latest.gcl.pt);
    const eta = levelEta(r => r.gcl, latest.gcl, history);
    const tiles = [
        { label: "GCL", value: latest.gcl.l, delta: `${gclPct.toFixed(1)}% to ${latest.gcl.l + 1}`, sub: etaText(eta) },
    ];
    if (latest.gpl != null) {
        const gplPct = pct(latest.gpl.p, latest.gpl.pt);
        const gplEta = levelEta(r => r.gpl, latest.gpl, history);
        tiles.push({ label: "GPL", value: latest.gpl.l, delta: `${gplPct.toFixed(1)}% to ${latest.gpl.l + 1}`, sub: etaText(gplEta) });
    }
    tiles.push(
        { label: "CPU bucket", value: fmtInt.format(latest.cpu.b), delta: `used ${latest.cpu.u.toFixed(1)} / ${latest.cpu.l}` },
        { label: "Credits", value: compact(latest.cr), delta: first ? `${latest.cr - first.cr >= 0 ? "+" : ""}${compact(latest.cr - first.cr)} over range` : "" },
        { label: "Rooms", value: Object.keys(latest.rooms).length, delta: "owned" },
        { label: "Creeps", value: creepCount(latest), delta: "alive (tracked roles)" },
        // No Defense tile: the threat board directly above this row is the same
        // judgment, named per room and impossible to miss.
    );
    renderTileRow("tiles", tiles);
}

function renderEmpireCharts() {
    $("gcl-next").textContent = String(latest.gcl.l + 1);
    $("cpu-limit").textContent = String(latest.cpu.l);
    renderLine("gcl", "c-gcl",
        [lineDataset("GCL progress", history.map(r => pct(r.gcl.p, r.gcl.pt)), "--series-1")],
        { yMax: 100, unit: "%" });
    renderLine("gclRate", "c-gcl-rate", rateDatasets("GCL/tick", r => r.gcl));
    $("card-gpl").hidden = $("card-gpl-rate").hidden = latest.gpl == null;
    if (latest.gpl != null) {
        $("gpl-next").textContent = String(latest.gpl.l + 1);
        renderLine("gpl", "c-gpl",
            [lineDataset("GPL progress", history.map(r => r.gpl ? pct(r.gpl.p, r.gpl.pt) : null), "--series-1")],
            { yMax: 100, unit: "%" });
        renderLine("gplRate", "c-gpl-rate", rateDatasets("GPL/tick", r => r.gpl));
    }
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

// Empire-wide defense rollup tiles. Rooms with no `thr` this snapshot are
// excluded from every aggregate below rather than counted as zero — a
// degraded room contributes no information, and treating its absence as
// "safe" would hide exactly the rooms most likely to be mid-fight (the
// payload gets big, and thr/roles are dropped first, when there's a lot
// going on). Each tile has a fixed unit regardless of state.
function renderDefenseTiles() {
    const rooms = Object.entries(latest.rooms);
    const withThr = rooms.filter(([, r]) => r.thr);
    const unknownCount = rooms.length - withThr.length;

    const totalH = withThr.reduce((a, [, r]) => a + r.thr.h, 0);
    const hostileRoomCount = withThr.filter(([, r]) => r.thr.h > 0).length;
    const owners = new Set();
    let anyBoosted = false;
    for (const [, r] of withThr) {
        for (const o of r.thr.owners ?? []) owners.add(o);
        if ((r.thr.boosted ?? 0) > 0) anyBoosted = true;
    }

    const armedSum = withThr.reduce((a, [, r]) => a + r.thr.twrArmed, 0);
    const totalSum = withThr.reduce((a, [, r]) => a + r.thr.twrTotal, 0);
    const dpsSum = withThr.reduce((a, [, r]) => a + r.thr.dps, 0);
    const noArmedTower = withThr.filter(([, r]) => r.thr.twrArmed === 0 && r.thr.twrTotal > 0).length;

    // Same predicate the threat board ranks on (calc.js), so this tile can't
    // count a room the board above it never names.
    const outgunned = withThr
        .map(entry => [entry, netTowerDps(entry[1].thr)])
        .filter(([[, r]]) => isOutgunned(r.thr))
        .sort((a, b) => a[1] - b[1]);
    const worstOutgunned = outgunned[0]?.[0];
    const worstOutgunnedNet = outgunned[0]?.[1];

    const smAvails = withThr.map(([, r]) => r.thr.smAvail);
    const minSmAvail = smAvails.length ? Math.min(...smAvails) : null;
    const activeSm = withThr.filter(([, r]) => r.thr.sm !== undefined).length;
    const zeroSm = withThr.filter(([, r]) => r.thr.smAvail === 0).length;
    const longestCd = withThr.reduce((a, [, r]) => Math.max(a, r.thr.smCd ?? 0), 0);
    const ms = observedMsPerTick(history);

    const rmps = withThr.filter(([, r]) => r.thr.rmp != null);
    const weakestRmp = rmps.length ? rmps.reduce((a, b) => a[1].thr.rmp < b[1].thr.rmp ? a : b) : null;
    const defRmps = withThr.map(([, r]) => r.thr.defRmp).filter(v => v != null);
    const minDefRmp = defRmps.length ? Math.min(...defRmps) : null;
    const criticalRmpCount = withThr.filter(([, r]) => isCriticalBarrier(r.thr.rmp, "rampart")).length;

    const tiles = [
        {
            label: "Hostiles", value: fmtInt.format(totalH), delta: `in ${hostileRoomCount} room${hostileRoomCount === 1 ? "" : "s"}`,
            sub: [owners.size ? [...owners].join(", ") : null, anyBoosted ? "⚡ boosted parts" : null, unknownCount ? `${unknownCount} rooms unknown` : null]
                .filter(Boolean).join(" · ") || undefined,
        },
        {
            label: "Towers", value: `${armedSum}/${totalSum}`, delta: noArmedTower ? `${noArmedTower} room${noArmedTower === 1 ? "" : "s"} with no armed tower` : "all armed",
            sub: `worst-case ${fmtInt.format(dpsSum)} dps`,
        },
        {
            label: "Outgunned", value: outgunned.length, delta: outgunned.length ? "heal beats tower dps" : "—",
            sub: worstOutgunned ? `${worstOutgunned[0]} ${fmtInt.format(worstOutgunnedNet)}` : "—",
        },
        {
            label: "Safe-mode charges (min)", value: minSmAvail ?? "—", delta: `${activeSm} active · ${zeroSm} room${zeroSm === 1 ? "" : "s"} at 0`,
            sub: longestCd ? `longest cooldown ~${ms != null ? fmtDuration(longestCd * ms) : `${compact(longestCd)} ticks`}` : undefined,
        },
        {
            label: "Weakest rampart", value: weakestRmp ? fmtHits(weakestRmp[1].thr.rmp) : "—", delta: weakestRmp ? weakestRmp[0] : "—",
            sub: `zone ${fmtHits(minDefRmp)} · ${criticalRmpCount} under ${fmtHits(CRITICAL_RAMPART_HITS)}`,
        },
    ];
    renderTileRow("defense-tiles", tiles);
}

function defenseColumns() {
    return [
        { key: "room", label: "Room", primary: true, cell: ([n]) => roomLinkCell(n) },
        { key: "posture", label: "Posture", cell: ([, r]) => postureBadge(r.thr) },
        { key: "hostiles", label: "Hostiles", cell: ([, r]) => hostilesCell(r.thr) },
        { key: "dmgIn", label: "In dmg/t", hint: "hostile melee + ranged damage per tick, boosts folded in",
          cell: ([, r]) => dmgInCell(r.thr) },
        { key: "towers", label: "Towers", hint: "towers with energy / built", cell: ([, r]) => towersCell(r.thr) },
        { key: "netDps", label: "Net dps",
          hint: "worst-case tower dps minus hostile heal/tick — negative means towers alone cannot break the heal",
          cell: ([, r]) => netDpsCell(r.thr) },
        { key: "safeMode", label: "Safe mode", cell: ([, r]) => safeModeCell(r.thr) },
        { key: "rampart", label: "Rampart", hint: "weakest own rampart",
          cell: ([, r]) => barrierCell(r.thr?.rmp, "rampart", r.rcl.l) },
        { key: "zoneRampart", label: "Zone rampart",
          hint: "weakest rampart inside the configured defender zone — the one you actually fight behind",
          cell: ([, r]) => barrierCell(r.thr?.defRmp, "zoneRampart", r.rcl.l) },
        // Was smuggled into the Rampart cell's tooltip; it is a distinct
        // measurement against its own RCL ladder, so it gets its own column.
        { key: "wall", label: "Weakest wall", tier: 3,
          hint: "weakest own wall, ramped against the wall repair target for this RCL",
          cell: ([, r]) => barrierCell(r.thr?.wall, "wall", r.rcl.l) },
        { key: "defenders", label: "Defenders",
          hint: "home defense fleet from the live spawn manifest; on-demand squads are not included",
          cell: ([, r]) => defCell(r.thr, r.roles) },
    ];
}

function renderDefenseTable() {
    renderTable("defense-table", defenseColumns(), sortByPosture(Object.entries(latest.rooms)));
}

const ATTACK_LOG_MAX_ROWS = 20;

// Single full-width "nothing to show" row. Both activity logs distinguish
// several empty states from each other (degraded vs genuinely quiet), so the
// text and its explanation are the caller's, not this helper's.
function naRow(colSpan, text, title) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = colSpan;
    td.className = "na";
    td.textContent = text;
    if (title) td.title = title;
    tr.append(td);
    return tr;
}

// ---------- shared table renderer ----------
// Every table on this page has the same shape: a sorted row list and one cell
// builder per column. Declaring the columns instead of appending them lets one
// renderer serve all seven — and, more to the point, lets each cell carry the
// metadata the mobile card layout needs (`data-label` for the ::before label,
// `data-tier` for what folds away, `data-primary` for the room name) without
// any of the 26 cell builders having to know a card layout exists. The two
// modes live in styles.css; nothing below is aware of which one is active.
//
// A column spec entry:
//   key      stable id, also the key in the section's hints list
//   label    the <th> text AND the card's data-label
//   sym      optional muted symbol after the label (boost matrix headers)
//   hint     what the column means — was a <th title=…>, and step 7 surfaces
//            it as visible text; kept on the <th> as desktop redundancy only
//   cell     (row) => HTMLTableCellElement, i.e. the existing builders as-is
//   tier     1 (default) always shown; 3 = desktop table only, and in card
//            mode folded behind the row's own expand toggle
//   primary  exactly one column: sticky on desktop, card title on mobile
//   group    first column of a visual group (left border)
function applyColMeta(cell, col) {
    cell.dataset.label = col.sym ? `${col.label} ${col.sym}` : col.label;
    if (col.tier && col.tier !== 1) cell.dataset.tier = String(col.tier);
    if (col.primary) cell.dataset.primary = "";
    if (col.group) cell.classList.add("raw-group");
}

function buildHead(spec) {
    const tr = document.createElement("tr");
    for (const col of spec) {
        const th = document.createElement("th");
        th.textContent = col.label;
        if (col.sym) {
            const sym = document.createElement("span");
            sym.className = "th-sym";
            sym.textContent = col.sym;
            th.append(" ", sym);
        }
        // Desktop-only redundancy: the same string is rendered as visible text
        // by the section's hints disclosure, which is what touch actually gets.
        if (col.hint) th.title = col.hint;
        applyColMeta(th, col);
        tr.append(th);
    }
    return tr;
}

// The column definitions, as visible (tappable) text rather than <th title>
// alone. A tooltip is fine as a second channel; it is not fine as the only
// one, and on a phone it is no channel at all. Rendered into a <details> right
// after the table, from the same spec the headers come from.
function renderColumnHints(table, spec) {
    const hinted = spec.filter(c => c.hint);
    const wrap = table.parentElement;
    let host = wrap.nextElementSibling;
    if (!host?.classList.contains("col-hints")) {
        if (!hinted.length) return;             // nothing to explain, nothing to insert
        host = document.createElement("details");
        host.className = "col-hints";
        wrap.insertAdjacentElement("afterend", host);
    }
    host.hidden = !hinted.length;
    if (!hinted.length) return;
    const summary = document.createElement("summary");
    summary.textContent = "What these columns mean";
    const dl = document.createElement("dl");
    for (const col of hinted) {
        const dt = document.createElement("dt");
        dt.textContent = col.sym ? `${col.label} (${col.sym})` : col.label;
        const dd = document.createElement("dd");
        dd.textContent = col.hint;
        dl.append(dt, dd);
    }
    host.replaceChildren(summary, dl);
}

// `empty` is {text, why} — the callers distinguish several empty states from
// each other (degraded vs genuinely quiet), so the wording stays theirs.
function renderTable(tableId, spec, rows, empty) {
    const table = $(tableId);
    table.querySelector("thead").replaceChildren(buildHead(spec));
    renderColumnHints(table, spec);
    const tbody = table.querySelector("tbody");
    if (!rows.length) {
        const tr = naRow(spec.length, empty?.text ?? "nothing to show", empty?.why);
        tr.firstChild.dataset.primary = "";      // full card width in card mode
        tbody.replaceChildren(tr);
        return;
    }
    const expandable = spec.some(c => c.tier === 3);
    tbody.replaceChildren(...rows.map(row => {
        const tr = document.createElement("tr");
        for (const col of spec) {
            const td = col.cell(row);
            applyColMeta(td, col);
            tr.append(td);
        }
        // Card mode hides tier-3 cells; this is the only thing that reveals
        // them, so a stray click elsewhere in the row can't shift the layout.
        // Hidden by CSS at desktop widths, where tier-3 is always shown.
        if (expandable) {
            tr.dataset.expandable = "";
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "row-expand-toggle";
            toggle.textContent = "+ more";
            toggle.addEventListener("click", () => {
                const open = tr.toggleAttribute("data-expanded");
                toggle.textContent = open ? "– less" : "+ more";
            });
            tr.append(toggle);
        }
        return tr;
    }));
}

// An absence with a meaning is not a missing value, so it gets a word rather
// than an em dash — remoteHomeCell has always done this ("corridor"), and this
// generalises it. The `why` is the long form: still a tooltip on the desktop
// table, but the word alone has to carry the meaning on a phone, where there
// is no hover at all.
function naCell(word, why) {
    const td = document.createElement("td");
    td.className = "na";
    td.textContent = word;
    if (why) td.title = why;
    return td;
}

// Plain text cell — the default shape for anything carrying no badge, chip or
// link. Keeps the seven column specs below declarative.
function textCell(text, cls) {
    const td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
}

// The three all-rooms tables (labs, boosts, rooms) all list every owned room
// alphabetically; the defense table is the one that sorts by severity instead.
function byRoomName(rooms) {
    return Object.entries(rooms).sort(([a], [b]) => a.localeCompare(b));
}

// Shared by both activity logs: a replay link on the first tick the hostiles
// were seen, plus the closing tick as plain text.
function episodeTicksCell(ep, linkTitle) {
    const td = document.createElement("td");
    td.append(
        roomLink({ href: roomHistoryUrl(ep.room, ep.fromTick), text: String(ep.fromTick), title: linkTitle }),
        ` – ${ep.toTick}`,
    );
    return td;
}

function attackWhenCell(ep) {
    const td = document.createElement("td");
    const ago = Date.now() - ep.toMs.getTime();
    td.textContent = ago < 60000 ? "just now" : `${fmtDuration(ago)} ago`;
    td.title = `${ep.fromMs.toLocaleString()} – ${ep.toMs.toLocaleString()}`;
    return td;
}

function attackLogColumns() {
    return [
        { key: "room", label: "Room", primary: true, cell: ep => roomLinkCell(ep.room) },
        { key: "when", label: "When", cell: attackWhenCell },
        { key: "ticks", label: "Ticks", tier: 3,
          hint: "first through last tick hostiles were observed — the link replays from the first",
          cell: ep => episodeTicksCell(ep, "replay from the first tick hostiles were observed") },
        { key: "peakH", label: "Peak hostiles",
          cell: ep => textCell(`${ep.peakH}${ep.boosted ? " ⚡" : ""}`) },
        { key: "peakDmg", label: "Peak dmg/t", cell: ep => textCell(fmtInt.format(ep.peakDmg)) },
        { key: "owners", label: "Aggressors",
          cell: ep => ep.owners.length ? textCell(ep.owners.join(", "))
              : naCell("unnamed", "no owner was recorded for these hostiles — usually Invader NPCs") },
    ];
}

function renderAttackLog() {
    const { episodes, covered, total } = hostileEpisodes(history);
    renderTable("attack-log", attackLogColumns(),
        covered === 0 ? [] : episodes.slice(0, ATTACK_LOG_MAX_ROWS),
        covered === 0
            ? { text: "no threat detail in this range", why: DEGRADED_TITLE }
            : { text: "no hostiles observed in this range" });
    const note = covered < total
        ? `${covered} of ${total} snapshots in range carried threat detail — gaps are payload degradation, not quiet periods`
        : `${covered} of ${total} snapshots in range carried threat detail`;
    $("attack-log-note").textContent = note;
}

// ---------- remote threats (rt) ----------
// `rt` lists hostiles cached in NON-owned rooms, so none of the owned-room
// defense cells above apply: there are no towers, no ramparts and no safe
// mode to report. It rides the same first degradation step as `thr`, so the
// same doctrine holds — but with one extra wrinkle the owned-room cells don't
// have: the bot OMITS `rt` when the list is empty, so absence alone is
// ambiguous. hasThreatDetail() is what separates "nothing cached" from
// "degraded away"; see its comment in calc.js.

// Same visual ordering as REMOTE_CLASS_RANK, and honest about magnitude: a
// level-0 reserving core is real information but not an alarm, so it gets ink
// rather than a status colour.
const REMOTE_CLASS_COLOR = {
    stronghold: "--status-critical",
    hostiles: "--status-warning",
    core: "--text-secondary",
    keepers: "--text-muted",
};
const REMOTE_CLASS_TITLE = {
    stronghold: "armed stronghold — never send an unescorted melee creep at it",
    hostiles: "non-Keeper hostiles cached in this room",
    core: "level-0 reserving core — harmless, the bot keeps farming next to it",
    keepers: "Source Keeper guards only — routine for an SK room",
};
const REMOTE_DEGRADED_TITLE = "remote detail dropped from this snapshot";
const REMOTE_NONE_TITLE = "this snapshot kept its threat detail and listed no remote hostiles";

function renderRemoteTiles() {
    const rt = latest.rt;
    if (!rt) {
        const known = hasThreatDetail(latest);
        const value = known ? "0" : "unknown";
        const delta = known ? "none cached" : REMOTE_DEGRADED_TITLE;
        renderTileRow("remote-tiles", [
            { label: "Rooms flagged", value, delta },
            { label: "Strongholds", value, delta },
            { label: "Remote hostiles", value, delta },
        ]);
        return;
    }
    // Keeper-only entries are excluded from the headline counts for the same
    // reason remoteEpisodes() excludes them: an SK remote permanently caches
    // its standing guards, so counting them would pin these tiles at a
    // non-zero "threat" the Class column and the activity log both call
    // routine, and a quiet empire would never read 0. They stay in the table
    // and get their own count on the sub line.
    const flagged = rt.filter(e => remoteThreatClass(e) !== "keepers");
    const keeperRooms = rt.length - flagged.length;
    const strongholds = flagged.filter(e => remoteThreatClass(e) === "stronghold").length;
    const hostiles = flagged.reduce((sum, e) => sum + e.h, 0);
    const stale = flagged.filter(e => e.age > REMOTE_STALE_AGE_TICKS).length;
    const holding = flagged.filter(e => e.h > 0).length;
    renderTileRow("remote-tiles", [
        {
            label: "Rooms flagged",
            value: String(flagged.length),
            delta: stale ? `${stale} stale` : "all fresh",
            // the cap applies to the whole published list, keepers included
            sub: [
                rt.length === MAX_REMOTE_THREATS ? "at the payload cap" : null,
                keeperRooms ? `plus ${keeperRooms} SK room${keeperRooms === 1 ? "" : "s"}` : null,
            ].filter(Boolean).join(" · ") || undefined,
        },
        { label: "Strongholds", value: String(strongholds), delta: strongholds ? "armed cores" : "none armed" },
        {
            label: "Remote hostiles", value: fmtInt.format(hostiles),
            delta: `${holding} room${holding === 1 ? "" : "s"} holding creeps`,
        },
    ]);
}

function remoteClassCell(entry) {
    const td = document.createElement("td");
    const cls = remoteThreatClass(entry);
    td.append(makeBadge(cssVar(REMOTE_CLASS_COLOR[cls]), cls));
    td.title = REMOTE_CLASS_TITLE[cls];
    return td;
}

// A corridor sighting has no `home` by design (the hostile cache is keyed by
// room, and an incidental sighting belongs to no colony) — that's an absence
// with a meaning, not a missing value, so it gets a word rather than an em dash.
function remoteHomeCell(home) {
    if (home) return roomLinkCell(home);
    const td = document.createElement("td");
    td.textContent = "corridor";
    td.className = "na";
    td.title = "incidental sighting, not a configured remote";
    return td;
}

// A `mem: 1` row was carried from the bot's persisted Memory, not read from
// its hostile cache, so nobody has looked: h: 0 there means UNKNOWN, and the
// cells must not report it as an observation. See screeps2 docs/stats-history-ring.md.
const NO_VISION_TITLE = "no vision — hostiles unknown, this row is carried from the bot's persisted memory";

function noHostilesTitle(entry) {
    return entry.mem ? NO_VISION_TITLE : "no hostile creeps cached";
}

function remoteDmgCell(entry) {
    if (entry.h === 0) return naCell(entry.mem ? "no vision" : "none", noHostilesTitle(entry));
    const td = document.createElement("td");
    td.textContent = fmtInt.format((entry.melee ?? 0) + (entry.ranged ?? 0));
    td.title = `melee ${fmtInt.format(entry.melee ?? 0)}/t · ranged ${fmtInt.format(entry.ranged ?? 0)}/t`
        + ` · heal ${fmtInt.format(entry.heal ?? 0)}/t`;
    return td;
}

function remoteCoreCell(entry) {
    if (entry.coreLvl === undefined) return naCell("no core", "no invader core seen in this room");
    const td = document.createElement("td");
    td.textContent = `L${entry.coreLvl} · ${fmtHits(entry.core)}`;
    if (entry.coreLvl > 0) td.className = "critical";
    // Hits come from live vision; a dark room has a level but no hit count, and
    // `entry.core ?? 0` would report that unknown as a core sitting at zero.
    const hits = entry.core === undefined ? "hits unknown (no vision)" : `${fmtInt.format(entry.core)} hits`;
    td.title = entry.coreLvl > 0
        ? `armed stronghold, ${hits}`
        : `reserving core, ${hits} — harmless`;
    return td;
}

// `age` is the bot's own cached age for the sighting, independent of how old
// the snapshot itself is: a fresh snapshot can carry a 2,000-tick-old memory.
// Rendered in wall clock (which is what "is this happening now?" wants) with
// the raw tick count always in the title, since ticks are what the replay
// links speak.
function remoteAgeCell(entry, msPerTick) {
    const age = entry.age;
    const td = document.createElement("td");
    const ms = msPerTick != null ? age * msPerTick : null;
    td.textContent = ms == null ? `${fmtInt.format(age)} ticks`
        : ms < 60000 ? "just now"
        : `~${fmtDuration(ms)} ago`;
    const parts = [`age ${fmtInt.format(age)} ticks`];
    if (age > REMOTE_STALE_AGE_TICKS) {
        td.className = "na";
        // A mem row outliving the cache is by design, not neglect: the bot stands
        // mining down next to a stronghold, so nobody is there to refresh it.
        parts.push(entry.mem
            ? `carried from the bot's persisted memory, so it outlives the ${REMOTE_STALE_AGE_TICKS}-tick hostile cache — the stronghold is still believed to be there, but nobody has eyes on it`
            : `past the bot's ${REMOTE_STALE_AGE_TICKS}-tick hostile cache — a memory of a room that has gone dark, not a live reading`);
    }
    td.title = parts.join(" · ");
    return td;
}

function remoteHostilesCell(entry) {
    // h: 0 on a row carried from persisted memory means UNKNOWN, not empty —
    // nobody has eyes on the room. That has to read as a word, not as a zero.
    if (entry.h === 0) return naCell(entry.mem ? "no vision" : "none cached", noHostilesTitle(entry));
    const td = document.createElement("td");
    td.textContent = String(entry.h);
    if (entry.owners?.length) td.title = entry.owners.join(", ");
    return td;
}

function remoteHealCell(entry) {
    if (entry.h === 0) return naCell(entry.mem ? "no vision" : "none", noHostilesTitle(entry));
    return textCell(fmtInt.format(entry.heal ?? 0));
}

function remoteColumns(msPerTick) {
    return [
        { key: "room", label: "Room", primary: true, cell: e => roomLinkCell(e.room) },
        { key: "class", label: "Class",
          hint: "how actionable this is, using the bot's own ranking: armed stronghold, then any non-Keeper hostile, then a level-0 core, then Keepers only",
          cell: remoteClassCell },
        { key: "home", label: "Home",
          hint: "home room farming this remote; “corridor” means an incidental sighting that belongs to no home",
          cell: e => remoteHomeCell(e.home) },
        { key: "hostiles", label: "Hostiles", cell: remoteHostilesCell },
        { key: "dmgIn", label: "In dmg/t", hint: "hostile melee + ranged damage per tick, boosts folded in",
          cell: remoteDmgCell },
        { key: "heal", label: "Heal/t", hint: "hostile healing per tick, boosts folded in", cell: remoteHealCell },
        { key: "core", label: "Core",
          hint: "invader core hits and level — L0 is a harmless reserving core, L1-5 an armed stronghold",
          cell: remoteCoreCell },
        { key: "age", label: "Last seen",
          hint: "the bot's own cached age for this sighting, not the snapshot's age",
          cell: e => remoteAgeCell(e, msPerTick) },
    ];
}

function renderRemoteTable() {
    renderTable("remote-table", remoteColumns(observedMsPerTick(history)),
        latest.rt ? sortRemoteThreats(latest.rt) : [],
        hasThreatDetail(latest)
            ? { text: "no remote hostiles cached", why: REMOTE_NONE_TITLE }
            : { text: "no remote detail in this snapshot (payload degradation)", why: REMOTE_DEGRADED_TITLE });
}

// "When" is the last tick the hostiles were actually SEEN, not the last
// snapshot that carried the sighting — the bot's hostileCache keeps an entry
// for REMOTE_STALE_AGE_TICKS after a room goes dark, so reading toMs straight
// off the observing row would report a raid that ended ~300 ticks ago as
// happening now. remoteEpisodes() hands us that lag as `staleTicks`; converting
// it needs the ms-per-tick ratio, which only exists here, so with no ratio
// available we fall back to the observation clock and say so in the title.
function remoteWhenCell(ep, msPerTick) {
    const td = document.createElement("td");
    const lagMs = msPerTick != null ? ep.staleTicks * msPerTick : 0;
    const ago = Date.now() - ep.toMs.getTime() + lagMs;
    td.textContent = ago < 60000 ? "just now" : `${fmtDuration(ago)} ago`;
    const parts = [`${ep.fromMs.toLocaleString()} – ${ep.toMs.toLocaleString()} observed`];
    if (ep.staleTicks > 0) {
        parts.push(msPerTick != null
            ? `last seen ${fmtInt.format(ep.staleTicks)} ticks before that final snapshot`
            : `last seen ${fmtInt.format(ep.staleTicks)} ticks earlier — no tick rate in range to date it`);
    }
    if (ep.staleTicks > REMOTE_STALE_AGE_TICKS) td.className = "na";
    td.title = parts.join(" · ");
    return td;
}

function remotePeakCell(ep) {
    const td = document.createElement("td");
    td.textContent = String(ep.peakH);
    td.title = ep.owners.length ? ep.owners.join(", ") : "no hostile creeps — core only";
    return td;
}

function remoteLogDmgCell(ep) {
    const td = document.createElement("td");
    td.textContent = fmtInt.format(ep.peakDmg);
    td.title = `peak heal ${fmtInt.format(ep.peakHeal)}/t`;
    return td;
}

function remoteLogCoreCell(ep) {
    if (ep.peakCoreLvl === undefined) return naCell("no core", "no invader core was seen during this episode");
    const td = document.createElement("td");
    td.textContent = `L${ep.peakCoreLvl}`;
    if (ep.peakCoreLvl > 0) td.className = "critical";
    return td;
}

function remoteLogColumns(msPerTick) {
    return [
        { key: "room", label: "Room", primary: true, cell: ep => roomLinkCell(ep.room) },
        { key: "home", label: "Home", cell: ep => remoteHomeCell(ep.home) },
        { key: "when", label: "When", cell: ep => remoteWhenCell(ep, msPerTick) },
        { key: "ticks", label: "Ticks", tier: 3,
          hint: "first through last tick the hostiles were actually seen — both ends come from the sighting's own age, not from the snapshots that carried it",
          // toTick is likewise back-dated: the last tick SEEN, not the last
          // snapshot that listed the sighting.
          cell: ep => episodeTicksCell(ep, "replay from the first tick the hostiles were seen, back-dated by the sighting's own age") },
        { key: "peakH", label: "Peak hostiles", cell: remotePeakCell },
        { key: "peakDmg", label: "Peak dmg/t", cell: remoteLogDmgCell },
        { key: "core", label: "Core", cell: remoteLogCoreCell },
    ];
}

function renderRemoteLog() {
    const { episodes, covered, total } = remoteEpisodes(history);
    renderTable("remote-log", remoteLogColumns(observedMsPerTick(history)),
        covered === 0 ? [] : episodes.slice(0, ATTACK_LOG_MAX_ROWS),
        covered === 0
            ? { text: "no remote detail in this range", why: REMOTE_DEGRADED_TITLE }
            : { text: "no remote incursions observed in this range" });
    $("remote-log-note").textContent = covered < total
        ? `${covered} of ${total} snapshots in range carried remote detail — gaps are payload degradation, not quiet periods`
        : `${covered} of ${total} snapshots in range carried remote detail`;
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

// Per-room defense detail: five tiles + two cards (defense fleet roster,
// damage balance). Unlike renderNuker, the section itself is never hidden —
// thr is present on meta/latest for every owned room (nuk only exists for
// rooms with a nuker), so a section that vanishes on room switch would just
// be jarring; "unknown" is itself the information when thr really is
// absent. The two cards still hide+destroy individually on an empty roster
// / no hostiles, same ResizeObserver discipline as renderNuker.
function renderRoomDefense(room) {
    const r = latest.rooms[room];
    const thr = r?.thr;
    const owners = thr?.owners;
    $("defense-title").replaceChildren(`Defense · ${room}`,
        owners?.length ? ` · ${owners.join(", ")}` : "");

    if (!thr) {
        renderTileRow("defense-room-tiles", [
            { label: "Defense", value: "unknown", delta: DEGRADED_TITLE, sub: "payload degradation — see README" },
        ]);
        for (const key of ["defenders", "balance"]) { charts[key]?.destroy(); delete charts[key]; }
        $("defenders-card").hidden = true;
        $("balance-card").hidden = true;
        return;
    }

    const posture = roomPosture(thr);
    const netDps = netTowerDps(thr);
    const ms = observedMsPerTick(history);
    const smActive = thr.sm !== undefined;
    const smValue = smActive
        ? (ms != null ? `~${fmtDuration(thr.sm * ms)}` : `~${compact(thr.sm)} ticks`)
        : pluralCount(thr.smAvail, "charge");
    const smSub = smActive ? "" : (thr.smCd ? `cooldown ${ms != null ? fmtDuration(thr.smCd * ms) : `~${compact(thr.smCd)} ticks`}` : "");

    renderTileRow("defense-room-tiles", [
        { label: "Posture", value: posture.label, delta: posture.reasons.join(" · ") || (thr.h === 0 ? "no hostiles" : ""), sub: `${thr.h} hostiles` },
        { label: "Hostiles", value: fmtInt.format(thr.h), delta: (thr.owners ?? []).join(", ") || "—",
          sub: thr.h ? `melee ${fmtInt.format(thr.melee ?? 0)} · ranged ${fmtInt.format(thr.ranged ?? 0)} · heal ${fmtInt.format(thr.heal ?? 0)} per tick` : "" },
        { label: "Towers", value: `${thr.twrArmed}/${thr.twrTotal}`, delta: `worst-case ${fmtInt.format(thr.dps)} dps`,
          sub: thr.h ? (netDps < 0 ? `heal exceeds tower dps by ${fmtInt.format(-netDps)}` : `towers out-damage heal by ${fmtInt.format(netDps)}`) : "" },
        { label: "Safe mode", value: smValue, delta: smActive ? "active" : "available", sub: smSub },
        { label: "Barriers", value: fmtHits(thr.rmp), delta: `zone ${fmtHits(thr.defRmp)}`,
          sub: `wall ${fmtHits(thr.wall)} · targets ${fmtHits(barrierTarget("rampart", r.rcl.l))} / ${fmtHits(barrierTarget("zoneRampart", r.rcl.l))} at RCL ${r.rcl.l}` },
    ]);

    // Defense fleet card: def[] home-defender slots plus army_member guards
    // (a separate role, found via `roles`, not `thr.def` — see
    // MANIFEST_GUARD_ROLE in calc.js) merged into one current-vs-desired
    // chart. An empty roster is usually healthy (see defenderSummary), so
    // its explanation moves into the Posture tile's sub rather than being
    // lost along with the hidden card.
    const defSummary = defenderSummary(thr, r.roles);
    const rows = [
        ...defSummary.slots.map(s => ({ label: s.role + (s.room ? ` → ${s.room}` : ""), cur: s.cur, des: s.des })),
        ...defSummary.guards.map(g => ({ label: `guard: ${g.r}${g.rm ? ` → ${g.rm}` : ""}`, cur: g.c, des: g.d })),
    ];
    if (rows.length === 0) {
        charts.defenders?.destroy();
        delete charts.defenders;
        $("defenders-card").hidden = true;
    } else {
        $("defenders-card").hidden = false;
        renderBarRows("defenders", "c-defenders", rows.map(x => x.label), [
            { label: "Current", data: rows.map(x => x.cur), backgroundColor: cssVar("--series-1"),
              borderRadius: { topRight: 4, bottomRight: 4 }, maxBarThickness: 14 },
            { label: "Desired", data: rows.map(x => x.des), backgroundColor: cssVar("--series-2"),
              borderRadius: { topRight: 4, bottomRight: 4 }, maxBarThickness: 14 },
        ]);
    }

    // Damage balance card: nothing to compare against when there are no hostiles.
    if (thr.h === 0) {
        charts.balance?.destroy();
        delete charts.balance;
        $("balance-card").hidden = true;
    } else {
        $("balance-card").hidden = false;
        renderBarRows("balance", "c-balance", ["Incoming dmg/t", "Hostile heal/t", "Tower dps"], [{
            label: "per tick",
            data: [(thr.melee ?? 0) + (thr.ranged ?? 0), thr.heal ?? 0, thr.dps],
            backgroundColor: [cssVar("--status-critical"), cssVar("--status-warning"), cssVar("--series-3")],
            borderRadius: { topRight: 4, bottomRight: 4 }, maxBarThickness: 14,
        }], { rowHeight: 40 });
    }
}

function renderRoomCharts() {
    const room = selectedRoom;
    $("room-title").replaceChildren(`Room ${room} `, screepsRoomLink(room));
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
    renderRoomDefense(room);
}

// Shared horizontal-bar recipe for "current vs desired"-style charts — roles,
// the defense fleet, and the damage-balance bars all use this. The options
// object (axes swapped, per-row height) is identical across all three; only
// the labels/datasets differ.
function renderBarRows(key, canvasId, labels, datasets, { rowHeight = 34, minHeight = 200 } = {}) {
    charts[key]?.destroy();
    const opts = baseOptions(datasets.length);
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
    charts[key] = new Chart($(canvasId), { type: "bar", data: { labels, datasets }, options: opts });
    const card = $(canvasId).closest(".plot");
    card.style.height = `${Math.max(minHeight, labels.length * rowHeight + 60)}px`;
}

function renderRolesChart(room) {
    const roles = latest.rooms[room]?.roles ?? [];
    const labels = roles.map(x => x.rm ? `${x.r} → ${x.rm}` : x.r);
    renderBarRows("roles", "c-roles", labels, [
        { label: "Current", data: roles.map(x => x.c), backgroundColor: cssVar("--series-1"),
          borderRadius: { topRight: 4, bottomRight: 4 }, maxBarThickness: 14 },
        { label: "Desired", data: roles.map(x => x.d), backgroundColor: cssVar("--series-2"),
          borderRadius: { topRight: 4, bottomRight: 4 }, maxBarThickness: 14 },
    ]);
}

// Always a real <a href> rather than a click handler, so middle-click,
// copy-link and open-in-new-tab all work. External links (screeps.com room
// views and tick replays) get target=_blank, which also keeps this tab's poll
// loop (scheduleNextPoll) running underneath; internal ones are hash routes
// and must stay in this tab.
function roomLink({ href, text, title, external = true } = {}) {
    const a = document.createElement("a");
    a.className = "room-link";
    a.href = href;
    if (external) { a.target = "_blank"; a.rel = "noopener"; }
    a.textContent = text;
    if (title) a.title = title;
    return a;
}

// Only an owned room has a per-room view to navigate to. `rt` names remotes,
// SK rooms and corridor sightings — a disjoint set from `latest.rooms`, since
// the hostile cache is keyed by the room next door, not by the colony (an rt
// row's `home` is the colony). Those rooms carry no rcl/roles/thr/bst/nuk at
// all, so an internal route would resolve straight back to the overview and
// strand a dead `#/room/…` in the address bar. Send them to the game instead,
// which is where they pointed before the room view existed.
//
// Still a plain href either way, so nothing about it needs preventDefault.
const isOwnedRoom = room => !!latest?.rooms?.[room];

function roomNameLink(room) {
    return isOwnedRoom(room)
        ? roomLink({
            href: buildHash({ view: ROOM, room, range: route.range }, DEFAULT_RANGE),
            text: room,
            external: false,
        })
        : roomLink({
            href: roomUrl(room),
            text: room,
            title: `${room} is not an owned room — open it on screeps.com`,
        });
}

// The escape hatch to the game itself, offered explicitly in the room view
// header rather than by hijacking every room name.
function screepsRoomLink(room) {
    return roomLink({ href: roomUrl(room), text: "↗ Screeps", title: `open ${room} on screeps.com` });
}

function roomLinkCell(room) {
    const td = document.createElement("td");
    td.append(roomNameLink(room));
    return td;
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
    if (!nuk) return naCell("not built", "this room has no nuker");
    const td = document.createElement("td");
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

// ---------- defense cell builders ----------
// Every cell here treats a missing `thr` as "unknown" (na + an explanatory
// title), never as "clear" — see the note atop the defense section of
// calc.js for why that distinction matters.

const POSTURE_COLOR = { clear: "--status-good", engaged: "--status-warning", exposed: "--status-critical", unknown: "--text-muted" };
const DEGRADED_TITLE = "threat detail dropped from this snapshot";

const pluralCount = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Shared cur-vs-des severity threshold for the two "current/desired" cells on
// this page (creeps, def[]) — half of desired or worse is critical, any
// shortfall short of that is just short.
const shortfallClass = (cur, des) => (cur < des ? (cur < des * 0.5 ? "critical" : "short") : "");

function postureBadge(thr) {
    const td = document.createElement("td");
    const { level, reasons } = roomPosture(thr);
    td.append(makeBadge(cssVar(POSTURE_COLOR[level]), level));
    td.title = reasons.length ? reasons.join(" · ") : (level === "unknown" ? DEGRADED_TITLE : "");
    return td;
}

function hostilesCell(thr) {
    if (!thr) return naCell("unknown", DEGRADED_TITLE);
    const td = document.createElement("td");
    if (thr.h === 0) { td.textContent = "0"; td.className = "na"; return td; }
    td.textContent = String(thr.h);
    td.className = thr.boosted > 0 ? "critical" : "serious";
    const parts = [];
    if (thr.owners?.length) parts.push(thr.owners.join(", "));
    parts.push(`melee ${fmtInt.format(thr.melee ?? 0)}/t`, `ranged ${fmtInt.format(thr.ranged ?? 0)}/t`, `heal ${fmtInt.format(thr.heal ?? 0)}/t`);
    if (thr.boosted > 0) parts.push(`${thr.boosted} boosted parts`);
    td.title = parts.join(" · ");
    return td;
}

// One column for melee+ranged rather than two — the sum is what's compared
// against tower dps; splitting it adds width without adding a decision.
function dmgInCell(thr) {
    if (!thr) return naCell("unknown", DEGRADED_TITLE);
    if (thr.h === 0) return naCell("none", "no hostiles in this room");
    const td = document.createElement("td");
    const dmg = (thr.melee ?? 0) + (thr.ranged ?? 0);
    td.textContent = fmtInt.format(dmg);
    td.title = `melee ${fmtInt.format(thr.melee ?? 0)}/t · ranged ${fmtInt.format(thr.ranged ?? 0)}/t `
        + `· heal ${fmtInt.format(thr.heal ?? 0)}/t${thr.boosted ? ` · ${thr.boosted} boosted parts` : ""}`;
    return td;
}

function towersCell(thr) {
    if (!thr) return naCell("unknown", DEGRADED_TITLE);
    if (thr.twrTotal === 0) return naCell("no tower", "no tower built in this room (RCL < 3?)");
    const td = document.createElement("td");
    td.textContent = `${thr.twrArmed}/${thr.twrTotal}`;
    if (thr.twrArmed === 0) td.className = "critical";
    else if (thr.twrArmed < thr.twrTotal) td.className = "short";
    td.title = `worst-case ${fmtInt.format(thr.dps)} dps`;
    return td;
}

// The single most decision-relevant number on the page: negative means
// towers alone cannot out-damage what the hostiles are healing back.
function netDpsCell(thr) {
    if (!thr) return naCell("unknown", DEGRADED_TITLE);
    const td = document.createElement("td");
    if (thr.h === 0) { td.textContent = fmtInt.format(thr.dps); td.className = "na"; return td; }
    const net = netTowerDps(thr);
    td.textContent = `${net >= 0 ? "+" : ""}${fmtInt.format(net)}`;
    if (net < 0) td.className = "critical";
    td.title = `tower dps ${fmtInt.format(thr.dps)} (${thr.twrArmed} armed × ${TOWER_DPS_PER_ARMED}) `
        + `− hostile heal ${fmtInt.format(thr.heal ?? 0)}/t`;
    return td;
}

function safeModeCell(thr) {
    if (!thr) return naCell("unknown", DEGRADED_TITLE);
    const td = document.createElement("td");
    if (thr.sm !== undefined) {
        td.append(makeBadge(cssVar("--series-1"), `active ${compact(thr.sm)}t`));
    } else {
        td.textContent = pluralCount(thr.smAvail, "charge");
        if (thr.smAvail === 0) td.className = thr.h > 0 ? "critical" : "short";
    }
    if (thr.smCd) td.title = `cooldown ${fmtInt.format(thr.smCd)}`;
    return td;
}

// `kind` is one of calc.js's BARRIER_TARGETS keys ("rampart"/"zoneRampart"/
// "wall"); `rcl` resolves the RCL-scaled repair target the hits are ramped
// against, so a healthy low-RCL rampart and a neglected high-RCL one never
// read the same color.
const BARRIER_ABSENT = {
    rampart:     { word: "no rampart", why: "this room has no own rampart" },
    zoneRampart: { word: "no zone",    why: "no rampart inside the configured defender zone" },
    wall:        { word: "no wall",    why: "this room has no own wall" },
};

function barrierCell(hits, kind, rcl) {
    const td = document.createElement("td");
    if (hits == null) return naCell(BARRIER_ABSENT[kind].word, BARRIER_ABSENT[kind].why);
    const level = barrierLevel(hits, kind, rcl);
    const critical = isCriticalBarrier(hits, kind);
    td.append(makeBadge(cssVar(critical ? "--status-critical" : `--fill-${level}`), fmtHits(hits)));
    td.title = `${fmtHits(hits)} / target ${fmtHits(barrierTarget(kind, rcl))} at RCL ${rcl}`;
    return td;
}

// def[] slots and army_member guard rows use different field names
// (role/room/cur/des vs RoleStats' r/rm/c/d) — format each the same way here
// so both read consistently in tooltips.
const fmtSlot = (role, room, cur, des) => `${role}${room ? ` → ${room}` : ""} ${cur}/${des}`;
const slotLabel = s => fmtSlot(s.role, s.room, s.cur, s.des);
const guardLabel = g => fmtSlot(g.r, g.rm, g.c, g.d);

// The short form shown in the cell. Each is a statement about why no fleet is
// planned, which is the thing a reader needs; DEF_STATE_EXPLAIN below is the
// long form, and the column-hints list carries it where hover cannot.
const DEF_STATE_WORD = {
    unknown: "unknown",
    "none-needed": "not needed",
    "safe-mode": "safe mode",
    unarmed: "unarmed foe",
    "no-plan": "none",
};

const DEF_STATE_EXPLAIN = {
    unknown: DEGRADED_TITLE,
    "none-needed": "no threat — no defense fleet planned",
    "safe-mode": "safe mode active — no fleet planned while it holds",
    unarmed: "hostiles present but carry no attack parts — no fleet planned",
    "no-plan": "armed hostiles and no home defense plan — sizing failed or nothing fieldable",
};

function defCell(thr, roles) {
    const td = document.createElement("td");
    const s = defenderSummary(thr, roles);
    // Suppressed remote requirements (including army_member guards) vanish
    // from `roles` by design while combat hostiles are in the room — say so
    // rather than let an empty guard list read as attrition.
    const suppressedNote = s.suppressed
        ? `remote spawn requirements (incl. ${s.guards.length ? `${s.guards.length} ` : ""}army_member guards) `
            + `are suppressed while combat hostiles are in this room — absent, not lost`
        : (s.guards.length ? `guards: ${s.guards.map(guardLabel).join(", ")}` : "");

    if (s.state in DEF_STATE_EXPLAIN) {
        td.textContent = DEF_STATE_WORD[s.state];
        td.className = s.state === "no-plan" ? "critical" : "na";
        td.title = [DEF_STATE_EXPLAIN[s.state], suppressedNote].filter(Boolean).join(" · ");
        return td;
    }

    // staffed / short — shortfallClass, so the two current-vs-desired cells
    // on this page read alike.
    td.className = shortfallClass(s.cur, s.des);
    const wrap = document.createElement("span");
    wrap.className = "def-fill";
    wrap.append(document.createTextNode(`${s.cur}/${s.des}`));
    const chipsWrap = document.createElement("span");
    chipsWrap.className = "chips";
    for (const slot of s.slots) {
        const chip = document.createElement("span");
        chip.className = "chip";
        const frac = slot.des ? slot.cur / slot.des : 1;
        chip.style.background = slot.cur === 0 ? cssVar("--grid") : cssVar(`--fill-${rampLevel(Math.min(1, frac))}`);
        chip.title = slotLabel(slot);
        chipsWrap.append(chip);
    }
    wrap.append(chipsWrap);
    td.append(wrap);
    td.title = suppressedNote;
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

function labStatusCell(lab) {
    if (!lab) return naCell("no labs", "this room has no labs built");
    const td = document.createElement("td");
    td.append(labStatusBadge(lab.s));
    return td;
}

// Every lab field is absent in two different ways — the room has no labs at
// all, or it has labs and simply isn't running a reaction right now — and the
// reader needs to tell them apart.
function labCell(lab, value) {
    if (!lab) return naCell("no labs", "this room has no labs built");
    if (value == null) return naCell("idle", "labs are built but no reaction is running in this room");
    return textCell(value);
}

function labsColumns() {
    return [
        { key: "room", label: "Room", primary: true, cell: ([n]) => roomLinkCell(n) },
        { key: "status", label: "Status", cell: ([, r]) => labStatusCell(r.lab) },
        { key: "reaction", label: "Reaction",
          cell: ([, r]) => labCell(r.lab, r.lab?.o ? `${r.lab.i1?.[0] ?? "?"} + ${r.lab.i2?.[0] ?? "?"} → ${r.lab.o}` : null) },
        { key: "in1", label: "In 1", tier: 3, hint: "contents of the first input lab",
          cell: ([, r]) => labCell(r.lab, r.lab?.i1 ? `${r.lab.i1[0]} ${fmtInt.format(r.lab.i1[1])}` : null) },
        { key: "in2", label: "In 2", tier: 3, hint: "contents of the second input lab",
          cell: ([, r]) => labCell(r.lab, r.lab?.i2 ? `${r.lab.i2[0]} ${fmtInt.format(r.lab.i2[1])}` : null) },
        { key: "out", label: "Output", hint: "output compound held across the output labs",
          cell: ([, r]) => labCell(r.lab, r.lab?.ot != null ? fmtInt.format(r.lab.ot) : null) },
        { key: "cd", label: "Cooldown", tier: 3, hint: "longest remaining cooldown among the output labs",
          cell: ([, r]) => labCell(r.lab, r.lab?.cd != null ? String(r.lab.cd) : null) },
        { key: "lc", label: "Labs i/o/b", tier: 3, hint: "lab counts: input / output / boost",
          cell: ([, r]) => labCell(r.lab, r.lab ? r.lab.lc.join("/") : null) },
    ];
}

function renderLabsTable() {
    renderTable("labs-table", labsColumns(), byRoomName(latest.rooms));
}

// A chip is a colour and nothing else, so on its own it says only "roughly
// this full". The number lives in `title`, which touch never sees — chipText()
// below is what the card layout prints instead.
function boostChipText(amount, max, raw) {
    const value = raw ? (amount ?? 0) : Math.floor((amount ?? 0) / PARTS_PER_BOOST);
    if (!value) return "0";
    return max ? `${compact(value)}/${compact(raw ? max : Math.floor(max / PARTS_PER_BOOST))}` : compact(value);
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
    const floor = boostFloor(raw);
    // Below the floor is not "nothing in stock": it is stock too small to be
    // worth anything, which is a different thing to know.
    if (!amount) return naCell("none", raw ? "no stock of this compound" : "no stock of this boost");
    if (amount < floor.amount) return naCell("trace", `${fmtInt.format(amount)} · ${floor.reason}`);
    const td = document.createElement("td");
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

function chipsCell(chips, text) {
    const td = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "chips";
    wrap.append(...chips);
    td.append(wrap);
    if (text) {
        // Only rendered in card mode (see styles.css): at table density the
        // chips plus a tooltip are enough, and 12 columns of numbers would not
        // fit anyway.
        const values = document.createElement("span");
        values.className = "chip-values";
        values.textContent = text;
        td.append(values);
    }
    return td;
}

// Built from MATRIX_LADDERS rather than hand-listed, so the header labels can
// no longer drift from the symbols the cells actually read (they used to be
// duplicated in index.html).
function boostMatrixColumns(bmax) {
    const ladders = MATRIX_LADDERS.map(([purpose, tiers]) => ({
        key: `b-${purpose}`,
        label: purpose === "build/repair" ? "build" : purpose,
        sym: tiers[0],
        hint: `${purpose} boosts, T1 · T2 · T3 — ${tiers.join(" · ")}`,
        cell: ([name, r]) => chipsCell(
            tiers.map((sym, i) => boostChip(`${name} · ${purpose} T${i + 1} · ${sym}`, (r.bst ?? {})[sym] ?? 0, bmax[sym], false)),
            tiers.map(sym => boostChipText((r.bst ?? {})[sym] ?? 0, bmax[sym], false)).join(" · ")),
    }));
    const raw = RAW_INPUTS.map(([label, sym], i) => ({
        key: `raw-${sym}`,
        label: sym,
        group: i === 0,
        hint: `${label} — raw reaction input, shown as stock rather than boostable parts`,
        cell: ([name, r]) => chipsCell(
            [boostChip(`${name} · ${label}`, (r.bst ?? {})[sym] ?? 0, bmax[sym], true)],
            boostChipText((r.bst ?? {})[sym] ?? 0, bmax[sym], true)),
    }));
    return [
        { key: "room", label: "Room", primary: true, cell: ([n]) => roomLinkCell(n) },
        ...ladders,
        ...raw,
    ];
}

function renderBoostMatrix() {
    renderTable("boost-matrix", boostMatrixColumns(latest.bmax ?? {}), byRoomName(latest.rooms));
}

function creepsCell(roles) {
    const td = document.createElement("td");
    if (!roles) return naCell("unknown", DEGRADED_TITLE);   // roles/thr are dropped first, see StatsManager
    const cur = roles.reduce((a, x) => a + x.c, 0);
    const des = roles.reduce((a, x) => a + x.d, 0);
    td.textContent = `${cur} / ${des}`;
    if (cur < des) {
        td.className = shortfallClass(cur, des);
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

function roomsColumns() {
    // The ETA cell is the one that needs history, not just the snapshot — it
    // reads the room's own RCL series to get an observed points-per-tick.
    const etaFor = (name, rcl) => etaCellText(levelEta(row => row.rooms[name]?.rcl ?? null, rcl, history), !rcl.pt);
    return [
        { key: "room", label: "Room", primary: true, cell: ([n]) => roomLinkCell(n) },
        { key: "rcl", label: "RCL", cell: ([, r]) => textCell(String(r.rcl.l)) },
        { key: "progress", label: "Progress",
          cell: ([, r]) => textCell(!r.rcl.pt ? "max" : `${pct(r.rcl.p, r.rcl.pt).toFixed(1)}%`) },
        { key: "eta", label: "ETA → next", cell: ([n, r]) => textCell(etaFor(n, r.rcl)) },
        { key: "spawnEnergy", label: "Spawn energy", cell: ([, r]) => textCell(`${r.e} / ${r.ec}`) },
        { key: "storage", label: "Storage", cell: ([, r]) => textCell(compact(r.se)) },
        { key: "terminal", label: "Terminal", tier: 3, cell: ([, r]) => textCell(compact(r.te)) },
        { key: "creeps", label: "Creeps", cell: ([, r]) => creepsCell(r.roles) },
        { key: "queue", label: "Queue", hint: "spawn queue length", cell: ([, r]) => textCell(String(r.q)) },
        { key: "nuker", label: "Nuker", tier: 3,
          hint: "ghodium \u00b7 energy fill vs capacity; ready = both full and off cooldown",
          cell: ([, r]) => nukerCell(r.nuk) },
    ];
}

function renderRoomsTable() {
    renderTable("rooms-table", roomsColumns(), byRoomName(latest.rooms));
}

function renderRoomSelect() {
    const names = Object.keys(latest.rooms).sort();
    // The hash decides which room is shown when it names one (reconcileRoute
    // has already dropped a room that no longer exists). Otherwise the select
    // just needs a valid default for whenever the room view is next opened.
    if (route.room) selectedRoom = route.room;
    else if (!selectedRoom || !names.includes(selectedRoom)) selectedRoom = names[0];
    const sel = $("room-select");
    sel.replaceChildren(...names.map(n => {
        const o = document.createElement("option");
        o.value = o.textContent = n;
        o.selected = n === selectedRoom;
        return o;
    }));
}

// ---------- sections ----------
// Each overview section is a <details> (see index.html). A collapsed one is
// display:none, and a Chart.js chart built inside a zero-sized container bakes
// a wrong devicePixelRatio it does not recover from — renderBarRows also sizes
// its .plot against a box that measures nothing. So render lazily: new data
// marks every section dirty, only the open ones render now, and the rest
// render when they are opened. On a phone with one section open that is 2-3
// charts instead of 16.
const SECTIONS = [
    { id: "defense",    render: () => { renderDefenseTiles(); renderDefenseTable(); } },
    { id: "empire",     render: renderEmpireCharts },
    { id: "attacks",    render: renderAttackLog },
    { id: "remote",     render: () => { renderRemoteTiles(); renderRemoteTable(); } },
    { id: "remote-log", render: renderRemoteLog },
    { id: "rooms",      render: renderRoomsTable },
    { id: "boosts",     render: renderBoostMatrix },
    { id: "labs",       render: renderLabsTable },
];
const dirtySections = new Set();
const sectionEl = id => document.querySelector(`details[data-section="${id}"]`);

function resizeChartsIn(root) {
    if (!root) return;
    for (const canvas of root.querySelectorAll("canvas")) Chart.getChart(canvas)?.resize();
}

function renderSection(section) {
    dirtySections.delete(section.id);
    section.render();
    resizeChartsIn(sectionEl(section.id));
}

// `toggle` does not bubble, so this has to run in the capture phase.
document.addEventListener("toggle", e => {
    const el = e.target;
    if (!(el instanceof HTMLDetailsElement) || !el.open) return;
    const section = SECTIONS.find(s => s.id === el.dataset.section);
    // No data yet (the boot-time open policy fires before the first fetch) or
    // already current: there is nothing to build, but a chart that was last
    // drawn while hidden still needs to re-measure.
    if (section && latest && dirtySections.has(section.id)) renderSection(section);
    else resizeChartsIn(el);
}, true);

// A wide screen shows the whole document at once, so nothing is worth hiding
// there. Narrower than that, the one section index.html ships `open` (Defense,
// the per-room board the threat board points at) stands on its own — which is
// what keeps the default phone view short.
function applySectionDefaults() {
    if (!matchMedia("(min-width: 1100px)").matches) return;
    for (const s of SECTIONS) {
        const el = sectionEl(s.id);
        if (el) el.open = true;
    }
}

// Renders whichever view the route selects. Skipping the hidden one is not
// just an economy: Chart.js sizes a canvas from its container, so building the
// room view's charts while it is display:none produces six 0x0 charts and
// leaks the ResizeObserver that renderNuker and renderRoomDefense already
// guard against individually.
function renderAll() {
    reconcileRoute();
    applyRoute();
    renderThreatBoard();
    renderTiles();
    renderRoomSelect();
    for (const s of SECTIONS) dirtySections.add(s.id);
    if (route.view === OVERVIEW) {
        for (const s of SECTIONS) if (sectionEl(s.id)?.open) renderSection(s);
    } else {
        renderRoomCharts();
    }
    renderStatus();
}

// Everything that depends on the route but not on a re-fetch: which view is
// visible, and which range button reads as pressed. Called on every render, so
// a cold load of #/room/E18S59?range=168 paints the right button — which the
// old click-only handler never did.
function applyRoute() {
    $("view-overview").hidden = route.view !== OVERVIEW;
    $("view-room").hidden = route.view !== ROOM;
    // Carries the range across, so leaving a room at 7d doesn't silently snap
    // the overview back to DEFAULT_RANGE and refetch.
    $("back-to-overview").href = buildHash({ view: OVERVIEW, range: route.range }, DEFAULT_RANGE);
    for (const b of $("range-group").querySelectorAll("button")) {
        b.setAttribute("aria-pressed", String(Number(b.dataset.range) === route.range));
    }
}

// Until a snapshot loads there is no way to know whether the hash's room is
// real, so parseHash keeps it. Once one has, re-resolve: a bookmark can
// outlive a room, and the honest answer is the overview. replaceState, not
// push, so Back doesn't bounce between the two.
// NB window.history — `history` alone is this module's snapshot array.
function reconcileRoute() {
    const resolved = readHash();
    if (resolved.view === route.view && resolved.room === route.room) return;
    route = resolved;
    window.history.replaceState(null, "", buildHash(route, DEFAULT_RANGE));
}

function currentRooms() {
    return latest ? Object.keys(latest.rooms) : null;
}

function readHash() {
    return parseHash(location.hash, { ranges: RANGES, rooms: currentRooms(), defaultRange: DEFAULT_RANGE });
}

function go(patch) {
    const next = buildHash({ ...route, ...patch }, DEFAULT_RANGE);
    if (next === (location.hash || "#/")) return;
    location.hash = next;
}

function onHashChange() {
    const prev = route;
    route = readHash();
    // Eagerly, before any fetch: refresh() is a no-op while a poll is already
    // in flight, and the pressed button and the visible view must still follow
    // the click. renderAll calls applyRoute again; it is idempotent.
    applyRoute();
    if (route.range !== prev.range) {
        // Same reset the range buttons used to do inline: a new window needs a
        // full fetch at the new LOD, not an append to the old one.
        rangeHours = route.range;
        historyRaw = [];
        demoRows = null;
        refresh({ force: true });
        return;
    }
    selectedRoom = route.room ?? selectedRoom;
    if (latest) renderAll();
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
    route = readHash();          // before the first fetch: rangeHours feeds the query
    rangeHours = route.range;
    renderRangeButtons();        // applyRoute sets aria-pressed, so build first
    applyRoute();
    applySectionDefaults();
    bindControls();
    refresh();
}
