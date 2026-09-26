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
    netRateSeries, netWindowRate, netEta, average,
    levelEta, fmtDuration, downsample, detectGaps, rampLevel, boostFillLevel, boostFloor,
    PARTS_PER_BOOST, MIN_RAW_STOCK, LOD_BUCKET_MS, RAW_INTERVAL_MS, bucketId, LOD_BY_RANGE,
    fmtHits, roomPosture, defenderSummary, zoneTarget, zoneLevel, isCriticalZone, storageClassInfo,
    RANGES, DEFAULT_RANGE,
    empireVerdict, threatItems, clearRooms, isOutgunned, hasNoSpawn,
    hasIncomingNuke, incomingNukes,
    netTowerDps, sortByPosture, hostileEpisodes, CRITICAL_RAMPART_HITS,
    remoteThreatClass, sortRemoteThreats, hasThreatDetail, remoteEpisodes, remoteDeployPhase,
    armyRoutesForHome, routeStatusText, excludeRoutedGuards, routeOrAbsence, routesOrAbsence,
    REMOTE_STALE_AGE_TICKS, MAX_REMOTE_THREATS,
    powerGateState, powerBanksOrAbsence, bankEta, bankContest, bankStale, bankPlans,
    powerFleetRows, haulerSummary, powerStockPoint, POWER_BANK_STALE_AGE_TICKS,
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
let historyGaps = [];    // detectGaps(history, ...) — collection outages within `history`
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
async function loadHistory() {
    if (DEMO) {
        history = await demoHistory();
        historyGaps = detectGaps(history, expectedIntervalMs());
        return history.length;
    }
    const added = historyRaw.length > 0
        ? await loadHistoryIncremental().catch(loadHistoryFull)
        : await loadHistoryFull();
    history = downsample(historyRaw, MAX_POINTS);
    historyGaps = detectGaps(history, expectedIntervalMs());
    return added;
}

// ---------- rendering ----------

function timeLabels() {
    const short = rangeHours <= 24;
    return history.map(r => short
        ? r.date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        : r.date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
}

// Default tooltip title (Chart.js's own default is the point's x-axis label)
// plus a note when the point right after it was flagged by detectGaps — the
// tooltip is where the exact outage duration lives, since the shaded band
// (gapBandPlugin) and the broken line (lineDataset's segment.borderColor)
// can't carry text of their own.
function tooltipTitle(items) {
    if (!items.length) return "";
    const title = items[0].label;
    const gap = historyGaps.find(g => g.afterIndex === items[0].dataIndex);
    return gap ? [title, `⚠ ${fmtDuration(gap.durationMs)} gap before this point — no data collected`] : title;
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
                callbacks: { title: tooltipTitle },
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
    const nonNull = data.filter(v => v != null).length;
    return {
        label, data,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        // with only a few actual (non-null) points a 0-radius line is
        // invisible — show dots until enough real data fills in
        pointRadius: nonNull < 5 ? 3 : 0,
        pointHoverRadius: 4,
        pointHoverBorderColor: cssVar("--surface-1"),
        pointHoverBorderWidth: 2,
        tension: 0.15,
        // Breaks the line across a detected collection outage (historyGaps)
        // without discarding either real point on either side of it — unlike
        // a null data point, which would also blank out that point's own
        // (legitimate) value. Without this the category x-axis (see
        // timeLabels) draws the two points evenly spaced like any other step,
        // and the outage becomes invisible — the exact "false continuity"
        // this exists to prevent.
        segment: {
            borderColor: ctx => historyGaps.some(g => g.afterIndex === ctx.p1DataIndex) ? "transparent" : undefined,
        },
    };
}

// Shades each detected outage's column on the category x-axis so a gap reads
// at a glance, not just as a broken line (lineDataset's segment.borderColor).
// The axis stays category-based (see timeLabels), so the band's width is
// always exactly one column regardless of the outage's real duration — the
// tooltip title (tooltipTitle) carries the actual duration text.
const gapBandPlugin = {
    id: "gapBands",
    beforeDatasetsDraw(chart) {
        if (!historyGaps.length) return;
        const { ctx, chartArea, scales: { x } } = chart;
        if (!chartArea) return;
        ctx.save();
        ctx.fillStyle = cssVar("--status-warning") + "26"; // ~15% alpha
        for (const gap of historyGaps) {
            const left = x.getPixelForValue(gap.afterIndex - 1);
            const right = x.getPixelForValue(gap.afterIndex);
            ctx.fillRect(Math.min(left, right), chartArea.top, Math.abs(right - left), chartArea.bottom - chartArea.top);
        }
        ctx.restore();
    },
};

// Shared by rateDatasets/netRateDatasets: the raw-rate line plus a flat
// dashed line at the window average, so the current rate reads against the
// range's trend. The avg is omitted (and with it the legend, per
// baseOptions) when `wr` is null.
function avgLineDataset(label, value) {
    const ds = lineDataset(label, history.map(() => value), "--series-2");
    Object.assign(ds, { borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, tension: 0 });
    return ds;
}

function rateLineDatasets(label, series, wr) {
    const datasets = [lineDataset(label, series, "--series-1")];
    if (wr) datasets.push(avgLineDataset(`avg ${compact(wr.rate)}/tick`, wr.rate));
    return datasets;
}

// Instantaneous per-tick rate for an {l,p,pt} field. Shared by the empire GCL
// chart and the per-room RCL chart. windowRate is null (so the avg line is
// omitted) when there's no positive gain in range.
function rateDatasets(label, sel) {
    return rateLineDatasets(label, rateSeries(sel, history), windowRate(sel, history));
}

// The netRateSeries/netWindowRate analogue of rateDatasets, for plain
// (non {l,p,pt}) numeric fields such as defender-zone rampart hits, where the
// avg line can legitimately sit at or below zero — that's the shrinking signal this
// chart exists to show, not a "no data" state to omit like rateDatasets does
// for windowRate's null case.
function netRateDatasets(label, sel) {
    return rateLineDatasets(label, netRateSeries(sel, history), netWindowRate(sel, history));
}

function renderLine(key, canvasId, datasets, { yMax = undefined, unit = "" } = {}) {
    charts[key]?.destroy();
    const opts = baseOptions(datasets.length);
    if (yMax !== undefined) opts.scales.y.max = yMax;
    // Assigned onto the existing callbacks, not replacing them — tooltipTitle
    // (baseOptions) has to survive this or a unit'd chart loses its gap note.
    if (unit) opts.plugins.tooltip.callbacks.label = c => ` ${c.dataset.label}: ${compact(c.parsed.y)}${unit}`;
    charts[key] = new Chart($(canvasId), {
        type: "line", data: { labels: timeLabels(), datasets }, options: opts, plugins: [gapBandPlugin],
    });
}

// ETA text shared by the empire GCL tile and the per-room stat strip.
function etaText(eta) {
    return eta
        ? `ETA ~${eta.etaMs != null ? fmtDuration(eta.etaMs) : `${compact(eta.etaTicks)} ticks`} · ${compact(eta.rate)}/tick`
        : "ETA — no gain in range";
}

// Growth-rate + ETA tile for a plain (non {l,p,pt}) numeric field tracked
// against an explicit target — the netWindowRate/netEta analogue of the RCL
// tile's Upgrade/ETA pair. A null `cur` (no rampart in the defender zone at
// all — a real, page-wide-recognized state, see ZONE_ABSENT below) reads the
// same way here as it does in the zone column, instead of showing a stale historical rate next to a contradictory
// "no gain in range". Once `cur` is known, three branches: already at/above
// target, a genuinely shrinking/flat trend (a dropping zone is real
// signal, not silence — must not read the same as "no data"), and a normal
// positive ETA.
function zoneGrowthTile(label, sel, cur, target, history) {
    if (cur == null) return { label, value: ZONE_ABSENT.word, delta: ZONE_ABSENT.why };
    const wr = netWindowRate(sel, history);
    const atTarget = target != null && cur >= target;
    const delta = atTarget ? "at target"
        : wr && wr.rate < 0 ? "shrinking — no ETA"
        : etaText(netEta(cur, target, wr));
    return { label, value: wr ? `${compact(wr.rate)}/tick` : "—", delta };
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
    // Above every posture, `spawnless` included: a scheduled, unavoidable hit
    // is the single most decision-relevant fact about a room when true.
    nuked:      { color: "--status-critical", headline: "NUKE INCOMING" },
    // Above every remaining posture: a colony that cannot rebuild lost creeps
    // is worse off than one merely losing the current fight.
    spawnless:  { color: "--status-critical", headline: "NO SPAWN" },
    outgunned:  { color: "--status-critical", headline: "OUTGUNNED" },
    exposed:    { color: "--status-critical", headline: "EXPOSED" },
    engaged:    { color: "--status-warning",  headline: "ENGAGED" },
    stronghold: { color: "--status-serious",  headline: "STRONGHOLD NEARBY" },
    unknown:    { color: "--text-muted",      headline: "UNKNOWN" },
    clear:      { color: "--status-good",     headline: "ALL CLEAR" },
};

const THREAT_KIND_LABEL = {
    nuked: "nuke incoming",
    spawnless: "no spawn",
    outgunned: "outgunned",
    exposed: "exposed",
    engaged: "engaged",
    stronghold: "armed stronghold",
    unknown: "unknown",
};

function verdictSubtitle(v) {
    const parts = [];
    if (v.counts.nuked) parts.push(`${pluralCount(v.counts.nuked, "room")} facing an incoming nuke`);
    if (v.counts.spawnless) parts.push(`${pluralCount(v.counts.spawnless, "room")} with no spawn`);
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

    if (item.spawnless) {
        card.append(boardRow("Spawns", "none — colony cannot rebuild lost creeps until a new spawn is built", "critical"));
    }
    // Nuke rows come before the `!thr` early return below — an incoming nuke
    // doesn't depend on threat detail, so it must still show on a degraded
    // snapshot that has dropped `thr` entirely.
    for (const [ticksToLand, launchRoom, x, y] of item.nukes ?? []) {
        card.append(boardRow("Nuke", nukeLandingText(ticksToLand, launchRoom, x, y), "critical"));
    }

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
    card.append(boardRow("Defender zone",
        thr.defRmp != null
            ? `${fmtHits(thr.defRmp)} of ${fmtHits(zoneTarget(item.rcl.l))} target at RCL ${item.rcl.l}`
            : ZONE_ABSENT.why,
        thr.defRmp == null ? "na" : isCriticalZone(thr.defRmp) ? "critical" : undefined));
    const def = defenderSummary(thr, item.roles);
    card.append(boardRow("Defenders",
        def.des ? `${def.cur} of ${def.des} fielded` : DEF_STATE_EXPLAIN[def.state] ?? def.state,
        def.des && def.cur < def.des ? shortfallClass(def.cur, def.des) : undefined));
    // Squads this room has out protecting its remotes: spawn capacity and
    // bodies committed elsewhere while the home itself is under threat.
    const routes = armyRoutesForHome(latest, item.room);
    if (routes.length) {
        card.append(boardRow("Squads out",
            routes.map(r => `→ ${r.target}: ${routeStatusText(r)}`).join(" · "),
            routes.some(r => r.dead > 0) ? "critical" : undefined));
    }
    return card;
}

// The home room's answer to a remote threat, from `ar`. A missing route is
// "none" only when the snapshot kept its first-step detail — the same rule
// the remote table's empty state follows.
function responseRow(entry) {
    if (!entry.home) return null;
    const resolved = routeOrAbsence(latest, entry.home, entry.room);
    if (resolved.route) {
        return boardRow("Response", routeStatusText(resolved.route), resolved.route.dead > 0 ? "critical" : undefined);
    }
    return boardRow("Response",
        resolved.absent === "none" ? "no squad planned" : "unknown — army detail dropped from this snapshot", "na");
}

function strongholdCard(item) {
    const { entry } = item;
    const card = document.createElement("article");
    card.className = "board-card";
    card.append(threatCardHead(item));
    card.append(boardRow("Core", `level ${entry.coreLvl}${entry.core != null ? ` · ${fmtHits(entry.core)} hits` : ""}`,
        "critical"));
    const deploy = remoteDeployPhase(entry.exp, latest.tick);
    if (deploy) {
        const ms = observedMsPerTick(history);
        const ticks = Math.max(0, deploy.ticks);
        const text = ms != null ? fmtDuration(ticks * ms) : `~${compact(ticks)} ticks`;
        card.append(boardRow(deploy.phase === "deploys" ? "Deploys in" : "Expires in", text,
            deploy.phase === "deploys" ? undefined : "critical"));
    }
    if (entry.home) card.append(boardRow("Threatens", `${entry.home}'s remote mining`));
    const response = responseRow(entry);
    if (response) card.append(response);
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
    // room really is its own finding and keeps its card. `spawnless`/nuked
    // rooms are kept even here — both are structural or scheduled facts off
    // fields that are never dropped by payload-size degradation, not a "same
    // sentence N times" case (a nuke's ETA/launch room differs room to room),
    // and they're exactly the kind of chaos that makes a big payload (and
    // degradation) likely.
    const items = v.degraded
        ? threatItems(latest).filter(i => i.scope === "remote" || i.spawnless || i.nukes.length)
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

// One line above every chart, naming any collection outage in the current
// range before a reader has to notice a shaded band or a broken line
// themselves (see gapBandPlugin/lineDataset) — the same "surface it in text,
// don't rely on the chart alone" pattern renderAttackLog already uses for
// degraded threat detail.
// Written into both the overview and room views' note element — a gap in
// `history` isn't specific to whichever view happens to be open, and the
// room view's charts get the same gapBandPlugin/lineDataset gap styling as
// the overview's without this, they'd have no persistent text explaining it.
function renderDataGapNote() {
    let text = "";
    if (historyGaps.length) {
        const totalMs = historyGaps.reduce((a, g) => a + g.durationMs, 0);
        const worst = historyGaps.reduce((a, g) => g.durationMs > a.durationMs ? g : a);
        const when = new Date(worst.startMs).toLocaleString([],
            { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
        text = `⚠ ${pluralCount(historyGaps.length, "data gap")} in this range `
            + `(${fmtDuration(totalMs)} total, no data collected) — largest ${fmtDuration(worst.durationMs)} starting ${when}`;
    }
    for (const id of ["data-gap-note", "room-data-gap-note"]) {
        const el = $(id);
        if (el) el.textContent = text;
    }
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
    const cpuSeries = history.map(r => r.cpu.u);
    const cpuAvg = average(cpuSeries);
    const cpuDatasets = [lineDataset("CPU used", cpuSeries, "--series-1")];
    if (cpuAvg != null) cpuDatasets.push(avgLineDataset(`avg ${compact(cpuAvg)}`, cpuAvg));
    renderLine("cpu", "c-cpu", cpuDatasets, { yMax: latest.cpu.l });
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
    renderPowerStockChart();
}

// Power held empire-wide, from the per-room `pw`. Unlike thr/roles this field
// is in no DEGRADATION_STEPS step, so its coverage going forward is complete
// (the `gpl` case) — the only gap is the stretch before the collector started
// persisting it, and powerStockPoint returns null there so the line starts at
// a blank left edge rather than a fabricated zero. The card hides itself
// entirely while the whole range predates the field.
function renderPowerStockChart() {
    const stock = history.map(r => powerStockPoint(r)?.stock ?? null);
    $("card-power-stock").hidden = stock.every(v => v == null);
    if ($("card-power-stock").hidden) return;
    renderLine("powerStock", "c-power-stock",
        [lineDataset("Power held", stock, "--series-1")]);
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
    const rcl8 = withThr.filter(([, r]) => r.rcl?.l === 8);

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
    // thr.dps is 0 in a clear room (the bot only prices towers against live
    // hostiles), so the sum only means something across rooms with hostiles.
    const contested = withThr.filter(([, r]) => r.thr.h > 0);
    const dpsSum = contested.reduce((a, [, r]) => a + r.thr.dps, 0);
    const noArmedTower = withThr.filter(([, r]) => r.thr.twrArmed === 0 && r.thr.twrTotal > 0).length;

    // Same predicate the threat board ranks on (calc.js), so this tile can't
    // count a room the board above it never names.
    const outgunned = withThr
        .map(entry => [entry, netTowerDps(entry[1].thr)])
        .filter(([[, r]]) => isOutgunned(r.thr))
        .sort((a, b) => a[1] - b[1]);
    const worstOutgunned = outgunned[0]?.[0];
    const worstOutgunnedNet = outgunned[0]?.[1];

    const smAvails = rcl8.map(([, r]) => r.thr.smAvail);
    const minSmAvail = smAvails.length ? Math.min(...smAvails) : null;
    const activeSm = withThr.filter(([, r]) => r.thr.sm !== undefined).length;
    const zeroSm = withThr.filter(([, r]) => r.thr.smAvail === 0).length;
    const longestCd = withThr.reduce((a, [, r]) => Math.max(a, r.thr.smCd ?? 0), 0);
    const ms = observedMsPerTick(history);

    const defRmpEntries = rcl8.filter(([, r]) => r.thr.defRmp != null);
    const weakestDefRmp = defRmpEntries.length ? defRmpEntries.reduce((a, b) => a[1].thr.defRmp < b[1].thr.defRmp ? a : b) : null;
    const criticalZoneCount = rcl8.filter(([, r]) => isCriticalZone(r.thr.defRmp)).length;

    const tiles = [
        {
            label: "Hostiles", value: fmtInt.format(totalH), delta: `in ${hostileRoomCount} room${hostileRoomCount === 1 ? "" : "s"}`,
            sub: [owners.size ? [...owners].join(", ") : null, anyBoosted ? "⚡ boosted parts" : null, unknownCount ? `${unknownCount} rooms unknown` : null]
                .filter(Boolean).join(" · ") || undefined,
        },
        {
            label: "Towers", value: `${armedSum}/${totalSum}`, delta: noArmedTower ? `${noArmedTower} room${noArmedTower === 1 ? "" : "s"} with no armed tower` : "all armed",
            sub: contested.length ? `${fmtInt.format(dpsSum)} dps vs hostiles` : undefined,
        },
        {
            label: "Outgunned", value: outgunned.length, delta: outgunned.length ? "heal beats tower dps" : "—",
            sub: worstOutgunned ? `${worstOutgunned[0]} ${fmtInt.format(worstOutgunnedNet)}` : "—",
        },
        {
            label: "Safe-mode charges (min, RCL8)", value: minSmAvail ?? "—", delta: `${activeSm} active · ${zeroSm} room${zeroSm === 1 ? "" : "s"} at 0`,
            sub: longestCd ? `longest cooldown ~${ms != null ? fmtDuration(longestCd * ms) : `${compact(longestCd)} ticks`}` : undefined,
        },
        {
            label: "Weakest defender zone (RCL8)", value: weakestDefRmp ? fmtHits(weakestDefRmp[1].thr.defRmp) : "—", delta: weakestDefRmp ? weakestDefRmp[0] : "—",
            sub: `${criticalZoneCount} zone${criticalZoneCount === 1 ? "" : "s"} under ${fmtHits(CRITICAL_RAMPART_HITS)}`,
        },
    ];
    renderTileRow("defense-tiles", tiles);
}

function defenseColumns() {
    return [
        { key: "room", label: "Room", primary: true, cell: ([n]) => roomLinkCell(n) },
        { key: "posture", label: "Posture", cell: ([, r]) => postureBadge(r.thr) },
        { key: "hostiles", label: "Hostiles", cell: ([, r]) => hostilesCell(r.thr) },
        { key: "dmgIn", label: "RA/A/H", hint: "hostile ranged / attack (melee) / heal damage per tick, boosts folded in",
          cell: ([, r]) => raahCell(r.thr) },
        { key: "towers", label: "Towers", hint: "towers with energy / built", cell: ([, r]) => towersCell(r.thr) },
        { key: "netDps", label: "Net dps",
          hint: "tower dps on the hostile the towers hit weakest (at its actual range) minus hostile heal/tick — negative means towers alone cannot break the heal",
          cell: ([, r]) => netDpsCell(r.thr) },
        { key: "safeMode", label: "Safe mode", cell: ([, r]) => safeModeCell(r.thr) },
        { key: "zone", label: "Zone",
          hint: "weakest rampart inside the configured defender zone — the one you actually fight behind",
          cell: ([, r]) => zoneCell(r.thr?.defRmp, r.rcl.l) },
        { key: "sc", label: "Class",
          hint: "storage class — a vault holds the empire's war chest, an outpost keeps only what its own defense consumes; above RCL 6 a room graduates to vault at 5.0M zone hits and reverts below 3.0M, unless pinned or overridden in config",
          cell: ([, r]) => storageClassCell(r) },
        { key: "defenders", label: "Defenders",
          hint: "home defense fleet from the live spawn manifest, plus this room's standing remote guards; on-demand squads are in Squads out",
          cell: ([, r]) => defCell(r.thr, r.roles) },
        { key: "squads", label: "Squads out",
          hint: "on-demand army squads this room has fielded for other rooms, from the bot's army records: forming at home, staging, in transit, or deployed in the target room. Engaged squads never respawn, so “lost” is permanent",
          cell: ([n]) => squadsOutCell(n) },
    ];
}

const ARMY_NONE_TITLE = "no army route from this room in the bot's army records";
const ARMY_DEGRADED_TITLE = "army detail dropped from this snapshot (payload degradation)";

// Per-squad breakdown for a tooltip; the cell text itself carries the phase.
function routeDetailTitle(r) {
    return r.squads.map(s => {
        const counts = [`${s.alive} alive`];
        if (s.spawning) counts.push(`${s.spawning} spawning`);
        if (s.queued) counts.push(`${s.queued} queued`);
        if (s.dead) counts.push(`${s.dead} dead`);
        return `squad ${s.id} ${s.status}: ${counts.join(", ")} — ${s.atHome} home / ${s.atTarget} target / ${s.inTransit} en route`;
    }).join("\n");
}

function squadsOutCell(room) {
    const resolved = routesOrAbsence(latest, room);
    if (!resolved.routes) {
        return resolved.absent === "none" ? naCell("none", ARMY_NONE_TITLE) : naCell("unknown", ARMY_DEGRADED_TITLE);
    }
    const td = textCell(resolved.routes.map(r => `${r.target}: ${routeStatusText(r)}`).join("; "),
        resolved.routes.some(r => r.dead > 0) ? "critical" : undefined);
    td.title = resolved.routes.map(r => `→ ${r.target}\n${routeDetailTitle(r)}`).join("\n");
    return td;
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

function attackLogRaahCell(ep) {
    return textCell(`${fmtInt.format(ep.peakRanged)}/${fmtInt.format(ep.peakMelee)}/${fmtInt.format(ep.peakHeal)}`);
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
        { key: "peakDmg", label: "Peak RA/A/H", cell: attackLogRaahCell },
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

function remoteRaahCell(entry) {
    if (entry.h === 0) return naCell(entry.mem ? "no vision" : "none", noHostilesTitle(entry));
    const td = document.createElement("td");
    td.textContent = `${fmtInt.format(entry.ranged ?? 0)}/${fmtInt.format(entry.melee ?? 0)}/${fmtInt.format(entry.heal ?? 0)}`;
    td.title = `ranged ${fmtInt.format(entry.ranged ?? 0)}/t · attack ${fmtInt.format(entry.melee ?? 0)}/t`
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

// Ticks convert to wall clock the same way the safe-mode cooldown cell does
// (thr.smCd * ms fed to fmtDuration, with a raw-ticks fallback when no
// ms-per-tick ratio is available yet). A stale sighting can put `ticks`
// slightly negative — clamped rather than shown as a negative duration.
function remoteDeployCell(entry, msPerTick) {
    if (entry.coreLvl === undefined) return naCell("no core", "no invader core seen in this room");
    const info = remoteDeployPhase(entry.exp, latest.tick);
    if (!info) return naCell("unknown", "core lifecycle timer not tracked for this sighting");
    const ticks = Math.max(0, info.ticks);
    const ms = msPerTick != null ? ticks * msPerTick : null;
    const text = ms != null ? fmtDuration(ms) : `~${compact(ticks)} ticks`;
    const label = info.phase === "deploys" ? `deploys in ${text}` : `expires in ${text}`;
    const td = textCell(label, info.phase === "deploys" ? undefined : "critical");
    td.title = info.phase === "deploys"
        ? "invader core is still vulnerable — killing it now prevents the stronghold"
        : "armed stronghold's own collapse timer";
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

// Joined from `ar` by (home, room). A corridor sighting has no home, so no
// room could answer it — an absence with a meaning, worded as such.
function remoteResponseCell(entry) {
    if (!entry.home) return naCell("n/a", "corridor sighting — no home room answers it");
    const resolved = routeOrAbsence(latest, entry.home, entry.room);
    if (!resolved.route) {
        return resolved.absent === "none"
            ? naCell("none", "no squad planned for this room in the bot's army records")
            : naCell("unknown", ARMY_DEGRADED_TITLE);
    }
    const td = textCell(routeStatusText(resolved.route), resolved.route.dead > 0 ? "critical" : undefined);
    td.title = routeDetailTitle(resolved.route);
    return td;
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
        { key: "response", label: "Response",
          hint: "squads the home room has fielded for this room, from the bot's army records: forming = still spawning at home, deployed = alive members in the room. Engaged squads never respawn, so “lost” is permanent",
          cell: remoteResponseCell },
        { key: "hostiles", label: "Hostiles", cell: remoteHostilesCell },
        { key: "dmgIn", label: "RA/A/H", hint: "hostile ranged / attack (melee) / heal damage per tick, boosts folded in",
          cell: remoteRaahCell },
        { key: "core", label: "Core",
          hint: "invader core hits and level — L0 is a harmless reserving core, L1-5 an armed stronghold",
          cell: remoteCoreCell },
        { key: "deploy", label: "Deploys/Expires",
          hint: "counts down to activation while the core is still vulnerable, or to its own collapse once armed",
          cell: e => remoteDeployCell(e, msPerTick) },
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

function remoteLogRaahCell(ep) {
    const td = document.createElement("td");
    td.textContent = `${fmtInt.format(ep.peakRanged)}/${fmtInt.format(ep.peakMelee)}/${fmtInt.format(ep.peakHeal)}`;
    return td;
}

function remoteLogAggressorsCell(ep) {
    const owners = ep.owners.filter(o => o !== "Source Keeper");
    if (owners.length) return textCell(owners.join(", "));
    if (ep.peakCoreLvl !== undefined) {
        const cell = textCell(`core L${ep.peakCoreLvl}`, ep.peakCoreLvl > 0 ? "critical" : undefined);
        cell.title = ep.peakCoreLvl > 0
            ? "armed stronghold, no hostile creeps recorded"
            : "reserving core only, no hostile creeps — harmless";
        return cell;
    }
    return naCell("unnamed", "no owner was recorded for these hostiles — usually Invader NPCs");
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
        { key: "peakDmg", label: "Peak RA/A/H", cell: remoteLogRaahCell },
        { key: "owners", label: "Aggressors", cell: remoteLogAggressorsCell },
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

// ---------- power harvesting ----------
// The dashboard's version of the bot's debugPowerBanks() console command:
// autoHarvest gate, every live bank with the planner's cached decision per
// home and the haulers already on it, then one row per squad plus the
// loot-leg haulers whose bank record is already gone. calc.js owns the readings; this owns the
// wording and the absence branches.

const POWER_ABSENCE = {
    // Four distinct empty states, and collapsing any two of them would lie.
    off: {
        text: "power harvesting is switched off",
        why: "the bot's autoHarvest gate is off — no bank is evaluated at all, so an empty list here says nothing about what is out there",
    },
    none: {
        text: "no live power banks",
        why: "this snapshot kept its detail and the bot's highway intel held no live bank",
    },
    unknown: {
        text: "no power detail in this snapshot (payload degradation)",
        why: "power-bank detail is dropped in the same degradation step as threat/army detail — this is not “no banks”",
    },
    uncollected: {
        text: "not collected in this snapshot",
        why: "stored before the collector began persisting the power fields — it cannot be backfilled",
    },
};

const GATE_TILE = {
    on: { value: "on", delta: "autoHarvest enabled" },
    off: { value: "off", delta: "autoHarvest disabled — no bank is evaluated" },
    uncollected: { value: "unknown", delta: "this snapshot predates the power fields" },
};

// Empire-wide power rollup. The gate tile comes first because it is the one
// thing that makes every other number on this row meaningless when off.
//
// A snapshot that lost its power detail to degradation must never produce a
// calm zero here — "0 banks, no haulers out" is precisely the reading that
// would be wrong, and for the same reason renderRemoteTiles shows "unknown"
// rather than 0. Only `pw` (never degraded) keeps its number in that state.
function renderPowerTiles() {
    const { banks = [], gate, absent } = powerBanksOrAbsence(latest);
    const blind = absent === "unknown" || absent === "uncollected";
    const haulers = [...banks.map(b => b.hl), ...(latest.ph ?? []).map(h => h.hl)]
        .map(haulerSummary).filter(Boolean);
    const haulerCount = haulers.reduce((a, h) => a + h.count, 0);
    const carrying = haulers.reduce((a, h) => a + h.carrying, 0);
    const committed = banks.filter(b => bankPlans(b).some(p => p.kind === "committed")).length;
    const stockPoint = powerStockPoint(latest);
    const processing = stockPoint?.processing ?? 0;
    renderTileRow("power-tiles", [
        { label: "Harvesting", ...GATE_TILE[gate] },
        {
            label: "Live banks",
            value: blind ? "unknown" : String(banks.length),
            delta: blind ? POWER_ABSENCE[absent].text
                : banks.length ? `${committed} committed`
                : POWER_ABSENCE[absent ?? "none"].text,
            sub: banks.length ? `${fmtInt.format(banks.reduce((a, b) => a + b.p, 0))} power on the map` : undefined,
        },
        {
            label: "Haulers out",
            value: blind ? "unknown" : String(haulerCount),
            delta: blind ? POWER_ABSENCE[absent].text
                : haulerCount ? `carrying ${fmtInt.format(carrying)}`
                : "none dispatched",
        },
        {
            label: "Power held",
            value: stockPoint ? compact(stockPoint.stock) : "unknown",
            delta: stockPoint ? `${pluralCount(processing, "room")} processing` : "this snapshot carries no power stock",
        },
    ]);
}

// A bank room is a highway room, never owned, so roomLinkCell would always
// take the screeps.com branch — spelled out here so the title can say why.
function bankRoomCell(bank) {
    const td = document.createElement("td");
    td.append(roomLink({ href: roomUrl(bank.rm), text: bank.rm, title: `${bank.rm} is a highway room — open it on screeps.com` }));
    return td;
}

function bankPowerCell(bank) {
    return textCell(fmtInt.format(bank.p));
}

// Hits plus who gets there first. `dps` is 0 for every bank we have not
// committed to, which is the normal state, so "nobody swinging" is a word
// rather than an em dash or an infinite ETA.
function bankHitsCell(bank) {
    const { killIn, decaysFirst, decayIn } = bankEta(bank);
    const td = document.createElement("td");
    td.textContent = fmtHits(bank.hits);
    if (killIn == null) {
        td.title = `${fmtInt.format(bank.hits)} hits · nothing of ours is attacking it`;
        return td;
    }
    td.append(" ", makeBadge(cssVar(decaysFirst ? "--status-warning" : "--status-good"), `${compact(killIn)}t`));
    td.title = `${fmtInt.format(bank.hits)} hits at ${fmtInt.format(bank.dps)} dps · `
        + (decaysFirst ? `decays in ${fmtInt.format(decayIn)}t first` : `dead ~${fmtInt.format(killIn)}t before it decays`);
    return td;
}

function bankDecayCell(bank) {
    const td = textCell(`${compact(bank.dec)}t`);
    td.title = `${fmtInt.format(bank.dec)} ticks until the bank decays on its own`;
    return td;
}

// Free adjacent tiles cap how many attackers can swing at once, which caps our
// dps — the single number that decides whether a bank is worth a squad.
function bankTilesCell(bank) {
    const td = textCell(String(bank.ft), bank.ft <= 1 ? "short" : undefined);
    td.title = `${bank.ft} free tile${bank.ft === 1 ? "" : "s"} around the bank — caps how many attackers can hit it at once`;
    return td;
}

function bankContestCell(bank) {
    const contest = bankContest(bank);
    if (!contest) return naCell("clear", "no contestant sightings on this bank");
    const td = document.createElement("td");
    td.append(makeBadge(cssVar("--status-warning"), pluralCount(contest.count, "rival")));
    td.title = `${contest.count} contestant sighting${contest.count === 1 ? "" : "s"} · `
        + `${fmtInt.format(contest.dps)} dps · ${fmtInt.format(contest.heal)} heal`;
    return td;
}

function bankDpsCell(bank) {
    if (!bank.dps) return naCell("none", "no attacker of ours is standing in the bank room");
    return textCell(fmtInt.format(bank.dps));
}

const PLAN_COLOR = { committed: "--status-good", skip: "--text-muted", retry: "--status-warning" };

// One chip per committed home. Skip and retry verdicts fold into a single
// muted chip: a chip per home in range is what pushed this table past the
// viewport, and "who is going" is the one verdict a reader scans for. Card
// mode still lists every verdict through chipsCell's text. An empty list is
// "not decided yet" (the verdict cache is heap state and empties on a global
// reset), which is a different thing from "no home in range" — neither of
// which may read as a decision the planner actually made.
function bankPlanCell(bank) {
    const plans = bankPlans(bank);
    if (!plans.length) return naCell("undecided", "the planner holds no cached verdict for this bank — its cache is heap state and empties on a global reset");
    const committed = plans.filter(p => p.kind === "committed");
    const others = plans.filter(p => p.kind !== "committed");
    const chips = committed.map(p => {
        const badge = makeBadge(cssVar(PLAN_COLOR.committed), `${p.home} ${p.mode ?? "go"}`);
        badge.title = `${p.home}: ${p.text}`;
        return badge;
    });
    if (others.length) {
        // Beside a committed chip "+N other" is enough; alone it would read
        // as "other than what?", so it names what it holds instead.
        const counts = ["skip", "retry"]
            .map(kind => [kind, others.filter(p => p.kind === kind).length])
            .filter(([, n]) => n)
            .map(([kind, n]) => `${n} ${kind}`);
        // planText passes unknown kinds through, so the label must still add up.
        const unknown = others.filter(p => p.kind !== "skip" && p.kind !== "retry").length;
        if (unknown) counts.push(`${unknown} other`);
        // A lone verdict names its reason — "why is nobody going" is the question it answers.
        const lone = !committed.length && others.length === 1 ? others[0] : null;
        const loneWhy = lone ? lone.abandon ?? lone.reason : null;
        const badge = makeBadge(cssVar(PLAN_COLOR.skip),
            committed.length ? `+${others.length} other` : [...counts, ...(loneWhy ? [loneWhy] : [])].join(" · "));
        badge.title = others.map(p => `${p.home}: ${p.text}`).join(" · ");
        chips.push(badge);
    }
    const td = chipsCell(chips, plans.map(p => `${p.home} ${p.text}`).join(" · "));
    // Stacked, not side by side: two committed homes plus the fold chip in a
    // row were the widest thing left in this table.
    td.classList.add("chips-stack");
    return td;
}

// One squad's own state, not its route's: a harvest route carries both the
// wave and its fight squad, so routeStatusText would describe the pair. A
// squad's dead count is a permanent loss — engaged squads never respawn — so
// it is named "lost" and never folded into a shortfall.
// The status itself goes in its own column, so this is everything after it.
function squadDetailText(squad) {
    const { dead, atTarget, inTransit, atHome, boosted } = squad;
    const where = atTarget ? `${atTarget} at the bank`
        : inTransit ? `${inTransit} en route`
        : atHome ? `${atHome} at home`
        : "nobody alive";
    return [where, dead ? `${dead} lost` : null, boosted ? "boosted" : null]
        .filter(Boolean).join(" · ");
}

// [count, carried power, min ttl]. A min ttl of 0 means every hauler is still
// spawning — printing "0t" there would say the opposite of what it means.
function haulerCell(hl) {
    const h = haulerSummary(hl);
    if (!h) return naCell("none", "no hauler is assigned to this bank yet");
    const td = document.createElement("td");
    td.textContent = h.spawning ? `${h.count} spawning` : `${h.count} · ${compact(h.carrying)}`;
    td.title = haulerDetailText(h);
    return td;
}

function haulerDetailText(h) {
    return `${pluralCount(h.count, "hauler")} · carrying ${fmtInt.format(h.carrying)} power · `
        + (h.spawning ? "all still spawning" : `shortest life left ${fmtInt.format(h.minTtl)}t`);
}

// `age` is intel staleness, not the snapshot's: StatsManager never reads the
// bank room, so hits/power only refresh while something of ours has vision
// there, and a row can outlive the real structure until `dec` runs out.
function bankAgeCell(bank) {
    if (bankStale(bank)) {
        return naCell(`${compact(bank.age)}t`, `last seen ${fmtInt.format(bank.age)} ticks ago — this is a memory of a room gone dark, not a live reading`);
    }
    const td = textCell(`${compact(bank.age)}t`);
    td.title = `hits and power were last refreshed ${fmtInt.format(bank.age)} ticks ago`;
    return td;
}

const POWER_COLUMNS = [
    { key: "room", label: "Bank room", primary: true, cell: bankRoomCell },
    { key: "power", label: "Power", hint: "power the bank drops when it dies", cell: bankPowerCell },
    { key: "hits", label: "Hits",
      hint: "the bank's remaining hits, and how long our own attackers need to break it — blank when nothing of ours is swinging, which is every bank we have not committed to",
      cell: bankHitsCell },
    { key: "decay", label: "Decays in", hint: "ticks until the bank decays on its own, whether or not anyone is hitting it", cell: bankDecayCell },
    { key: "tiles", label: "Free tiles",
      hint: "walkable tiles around the bank — this caps how many attackers can swing at once, and so caps the dps any plan can reach",
      cell: bankTilesCell },
    { key: "contest", label: "Contest",
      hint: "other players sighted racing or fighting us for this bank, with their summed damage and heal",
      cell: bankContestCell },
    { key: "dps", label: "Our dps", tier: 3, hint: "summed attack damage per tick of our creeps standing in the bank room", cell: bankDpsCell },
    { key: "plan", label: "Committed",
      hint: "homes the planner has committed to this bank, with the mode (loot, fight, race); skip and retry verdicts from other homes fold into one muted chip. It is the planner's cache, not a fresh evaluation, and is empty after a global reset. The squads themselves are in the table below",
      cell: bankPlanCell },
    { key: "haulers", label: "Haulers", cell: b => haulerCell(b.hl),
      hint: "haulers assigned to this bank, and the power they are already carrying; “spawning” means none has left home yet" },
    { key: "age", label: "Last seen", tier: 3,
      hint: "how stale the hits and power readings are — the bot only refreshes them while something of ours has vision in the bank room",
      cell: bankAgeCell },
];

function renderPowerTable() {
    const { banks, absent } = powerBanksOrAbsence(latest);
    renderTable("power-table", POWER_COLUMNS,
        [...(banks ?? [])].sort((a, b) => a.rm.localeCompare(b.rm)),
        absent ? POWER_ABSENCE[absent] : undefined);
}

function fleetRoomCell(row) {
    const td = document.createElement("td");
    td.append(roomLink({ href: roomUrl(row.rm), text: row.rm, title: `${row.rm} is a highway room — open it on screeps.com` }));
    if (!row.live) {
        const badge = makeBadge(cssVar("--text-muted"), "gone");
        badge.title = "our kill deleted the bank's intel record; these haulers are still loading or on the way home";
        td.append(" ", badge);
    }
    return td;
}

function fleetUnitCell(row) {
    if (row.kind === "haulers") return textCell("haulers");
    const td = textCell(row.fight ? "fight" : `w${row.wave ?? "?"}`);
    td.title = row.fight ? `squad #${row.id} · fight squad` : `squad #${row.id} · harvest wave ${row.wave ?? "?"}`;
    return td;
}

// `sq` carries only the wave number and the fight flag; status comes from the
// join back to `ar`. A miss there is normal, so it says so rather than
// inventing a phase.
function fleetStatusCell(row) {
    if (row.kind === "haulers") {
        const h = haulerSummary(row.hl);
        if (!h) return naCell("none", "no hauler count in this snapshot");
        return textCell(`${h.count} ${h.spawning ? "spawning" : "hauling"}`);
    }
    if (!row.squad) return naCell("no army record", "no army record for this squad in this snapshot — the two are built from different sources within one tick");
    return textCell(row.status);
}

function fleetDetailCell(row) {
    if (row.kind === "haulers") {
        const h = haulerSummary(row.hl);
        return h ? textCell(haulerDetailText(h)) : naCell("none");
    }
    return row.squad ? textCell(squadDetailText(row.squad)) : naCell("unknown", "no army record to read positions or losses from");
}

const POWER_FLEET_COLUMNS = [
    { key: "room", label: "Bank room", primary: true, cell: fleetRoomCell },
    { key: "home", label: "Home",
      hint: "the home room that fielded the squad; hauler counts are published per bank, not per home",
      cell: r => r.kind === "squad" ? textCell(r.home) : naCell("per bank", "hauler counts are published per bank, not per home") },
    { key: "unit", label: "Unit",
      hint: "w<n> is a harvest wave, fight is its fight squad; haulers are the loot leg of a bank that is already gone",
      cell: fleetUnitCell },
    { key: "status", label: "Status",
      hint: "the squad's own status from the bot's army records (not its route's); for haulers, how many are out and whether they have left home yet",
      cell: fleetStatusCell },
    { key: "detail", label: "Detail", tier: 3,
      hint: "where the squad's members are, and how many are lost for good (engaged squads never respawn); for haulers, the power they carry and the shortest life left",
      cell: fleetDetailCell },
];

// One row per unit of ours, so four squads on one bank become four short rows
// here rather than one ever-wider cell in the bank table. It also carries the
// haulers of banks that are already gone: our own kill deletes the intel
// record exactly while they are loading, so without `ph` the loot leg home
// would vanish from the payload mid-trip.
function renderPowerFleetTable() {
    const gate = powerGateState(latest);
    const rows = powerFleetRows(latest);
    renderTable("power-fleet-table", POWER_FLEET_COLUMNS, rows,
        rows.length ? undefined
            : gate === "uncollected" ? POWER_ABSENCE.uncollected
            : hasThreatDetail(latest)
                ? { text: "no squads out", why: "no harvest wave or fight squad is assigned to a live bank, and no hauler is carrying loot from a bank that is gone" }
                : POWER_ABSENCE.unknown);
}

// Stat strip for the selected room's controller: level, progress, upgrade
// throughput and ETA to the next level — the per-room analogue of the GCL
// tile in renderTiles(). At max level (!pt) there's no next level, and
// rcl.p is gone too, so progress/rate/ETA would only be "max"/"—" filler:
// the strip collapses to the single RCL tile.
function renderRoomTiles(room) {
    const rclOf = r => r.rooms[room]?.rcl ?? null;
    const cur = latest.rooms[room]?.rcl;
    if (!cur?.pt) {
        renderTileRow("room-tiles", [{ label: "RCL", value: cur?.l ?? "—", delta: "max level" }]);
        return;
    }
    const rangeLabel = $("range-group").querySelector('[aria-pressed="true"]')?.textContent ?? "range";
    const wr = windowRate(rclOf, history);
    const eta = levelEta(rclOf, cur, history);
    const tiles = [
        { label: "RCL", value: cur.l, delta: `${compact(cur.p)} / ${compact(cur.pt)}` },
        { label: `To level ${cur.l + 1}`, value: `${pct(cur.p, cur.pt).toFixed(1)}%`, delta: `${compact(cur.pt - cur.p)} left` },
        { label: "Upgrade", value: wr ? `${compact(wr.rate)}/tick` : "—", delta: `over ${rangeLabel}` },
        { label: "ETA", value: eta ? (eta.etaMs != null ? `~${fmtDuration(eta.etaMs)}` : `~${compact(eta.etaTicks)} ticks`) : "—",
          delta: eta ? `${compact(eta.rate)}/tick` : "no gain in range" },
    ];
    renderTileRow("room-tiles", tiles);
}

// Shared by the threat-board card and the per-room nukes section — ticksToLand
// counts down by exactly 1 per tick (unlike the nuker's fill stocks), so no
// rate estimation is needed, just the same observed ms/tick → fmtDuration
// conversion the nuker cooldown ETA already uses below.
function nukeEta(ticksToLand) {
    const ms = observedMsPerTick(history);
    return ms != null ? `~${fmtDuration(ticksToLand * ms)}` : `~${compact(ticksToLand)} ticks`;
}
function nukeLandingText(ticksToLand, launchRoom, x, y) {
    return `lands in ${nukeEta(ticksToLand)} at (${x}, ${y}) · launched from ${launchRoom}`;
}

// Incoming nukes for the selected room — tiles only, hidden entirely when
// there are none. No chart: ticksToLand counts down deterministically, so
// there's no trend to plot the way the nuker's fill stocks have one.
function renderNukes(room) {
    const nukes = incomingNukes(latest.rooms[room] ?? {});
    $("nukes-section").hidden = nukes.length === 0;
    if (nukes.length === 0) return;
    renderTileRow("nukes-tiles", nukes.map(([ticksToLand, launchRoom, x, y], i) => ({
        label: nukes.length > 1 ? `Nuke ${i + 1}` : "Nuke",
        value: nukeEta(ticksToLand),
        delta: `from ${launchRoom} · (${x}, ${y})`,
        sub: `lands at tick ${fmtInt.format(latest.tick + ticksToLand)}`,
    })));
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

    const gDataset = lineDataset("Ghodium", of(r => r.nuk ? pct(r.nuk[0], NUKER_GHODIUM_CAPACITY) : null), "--series-1");
    const eDataset = lineDataset("Energy", of(r => r.nuk ? pct(r.nuk[1], NUKER_ENERGY_CAPACITY) : null), "--series-2");
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

    const zoneCovered = history.filter(row => row.rooms[room]?.thr).length;
    const zoneSub = zoneCovered < history.length ? `${zoneCovered}/${history.length} snapshots had zone detail` : "";
    const scInfo = storageClassInfo(r);
    renderTileRow("defense-room-tiles", [
        { label: "Posture", value: posture.label,
          delta: thr.h === 0 ? "no hostiles" : [`${fmtInt.format(thr.h)} hostiles`, ...(thr.owners ?? []), ...posture.reasons].join(" · "),
          sub: thr.h ? `melee ${fmtInt.format(thr.melee ?? 0)} · ranged ${fmtInt.format(thr.ranged ?? 0)} · heal ${fmtInt.format(thr.heal ?? 0)} per tick` : "" },
        { label: "Towers", value: `${thr.twrArmed}/${thr.twrTotal}`, delta: thr.h ? `${fmtInt.format(thr.dps)} dps on weakest-hit hostile` : "no hostiles",
          sub: thr.h ? (netDps < 0 ? `heal exceeds tower dps by ${fmtInt.format(-netDps)}` : `towers out-damage heal by ${fmtInt.format(netDps)}`) : "" },
        { label: "Safe mode", value: smValue, delta: smActive ? "active" : "available", sub: smSub },
        { label: "Defender zone",
          value: `${fmtHits(thr.defRmp)}/${fmtHits(zoneTarget(r.rcl.l))}`,
          delta: `at RCL ${r.rcl.l}` },
        { ...zoneGrowthTile("Zone growth", r2 => r2.rooms[room]?.thr?.defRmp ?? null,
            thr.defRmp, zoneTarget(r.rcl.l), history), sub: zoneSub },
        { label: "Storage class", value: scInfo?.word ?? "unknown", delta: scInfo?.why ?? SC_ABSENT_WHY },
    ]);

    // Defense fleet card: def[] home-defender slots, standing army_member
    // guards (a separate role, found via `roles`, not `thr.def` — see
    // MANIFEST_GUARD_ROLE in calc.js) and this room's on-demand squads (from
    // `ar`) merged into one current-vs-desired chart. For a squad "desired" is
    // its full roster, so an engaged squad's losses show as a gap that never
    // closes — which is the truth, it never respawns. An empty roster is
    // usually healthy (see defenderSummary), so its explanation moves into the
    // Posture tile's sub rather than being lost along with the hidden card.
    const defSummary = defenderSummary(thr, r.roles);
    const routes = armyRoutesForHome(latest, room);
    const rows = [
        ...defSummary.slots.map(s => ({ label: s.role + (s.room ? ` → ${s.room}` : ""), cur: s.cur, des: s.des })),
        // A forming on-demand squad still shows up here too (its manifest row
        // is tagged the same as a standing guard) — excluded so it isn't also
        // counted below via `ar`, see excludeRoutedGuards in calc.js.
        ...excludeRoutedGuards(defSummary.guards, routes).map(g => ({ label: `guard: ${g.r}${g.rm ? ` → ${g.rm}` : ""}`, cur: g.c, des: g.d })),
        ...routes.flatMap(route => route.squads.map(s => ({
            label: `squad ${s.id} → ${route.target} · ${s.status}${s.dead ? ` · ${s.dead} lost` : ""}`,
            cur: s.alive, des: s.total,
        }))),
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

// Defender-zone rampart hits-per-tick growth — the
// netRateSeries/netWindowRate analogue of the RCL-rate chart, for a plain
// non-monotonic numeric field. Separate from renderRoomDefense so that
// function stays about the *current* ratios while this one is about *trend*;
// does its own thr check since it owns different DOM (a chart card, not
// the tile row) than renderRoomDefense's own !thr early return.
function renderZoneRate(room) {
    const thr = latest.rooms[room]?.thr;
    $("zone-rate-card").hidden = !thr;
    if (!thr) {
        charts.zoneRate?.destroy();
        delete charts.zoneRate;
        return;
    }
    renderLine("zoneRate", "c-zone-rate",
        netRateDatasets("Zone hits/tick", r => r.rooms[room]?.thr?.defRmp ?? null));
}

function renderRoomCharts() {
    const room = selectedRoom;
    $("room-title").replaceChildren(`Room ${room} `, screepsRoomLink(room));
    const of = fn => history.map(r => (r.rooms[room] ? fn(r.rooms[room]) : null));
    renderRoomTiles(room);
    const curRcl = latest.rooms[room]?.rcl;
    const rclMaxed = !curRcl?.pt;
    $("rcl-card").hidden = rclMaxed;
    if (rclMaxed) {
        charts.rcl?.destroy();
        delete charts.rcl;
    } else {
        renderLine("rcl", "c-rcl",
            [lineDataset("RCL progress", of(r => pct(r.rcl.p, r.rcl.pt)), "--series-1")],
            { yMax: 100, unit: "%" });
    }
    // At max level the RCL/tick series has nothing to difference (rcl.p is
    // undefined), so only UPW — which still feeds GCL — is worth plotting.
    // No UPW either means an empty chart, so the card goes like rcl-card's.
    const upw = of(r => r.upw ?? null);
    const rclRateShown = !rclMaxed || upw.some(v => v != null);
    $("rcl-rate-card").hidden = !rclRateShown;
    $("rcl-rate-title").textContent = rclMaxed ? "Controller upgrade · UPW" : "RCL gain · points per tick";
    if (!rclRateShown) {
        charts.rclRate?.destroy();
        delete charts.rclRate;
    } else {
        const rclDatasets = rclMaxed ? [] : rateDatasets("RCL/tick", r => r.rooms[room]?.rcl ?? null);
        rclDatasets.push(lineDataset("UPW", upw, "--series-3"));
        renderLine("rclRate", "c-rcl-rate", rclDatasets);
    }
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
    renderLine("repairQueue", "c-repair-queue", [
        lineDataset("This room", of(r => r.rq ? r.rq[0] : null), "--series-1"),
        lineDataset("Remotes", of(r => r.rq ? r.rq[1] : null), "--series-2"),
    ]);
    renderRolesChart(room);
    renderBoostGrid(room);
    renderNukes(room);
    renderNuker(room, of);
    renderRoomDefense(room);
    renderZoneRate(room);
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

// Soonest-first array from incomingNukes; empty means none. Unlike nukerCell's
// naCell (a room simply has no nuker, forever), an empty title here is a
// genuinely reassuring "no incoming nukes", not an absence with a meaning to
// explain.
function nukesCell(nukes) {
    if (!nukes.length) return naCell("none", "no incoming nukes");
    const td = document.createElement("td");
    const [soonest] = nukes;
    td.append(makeBadge(cssVar("--status-critical"), `${compact(soonest[0])}t`));
    td.title = nukes.map(([t, room, x, y]) => `${compact(t)}t from ${room} (${x}, ${y})`).join(" · ");
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

// One column rather than three — the split is what you want to see, but each
// part still fits one row, so a room's threat composition reads at a glance.
function raahCell(thr) {
    if (!thr) return naCell("unknown", DEGRADED_TITLE);
    if (thr.h === 0) return naCell("none", "no hostiles in this room");
    const td = document.createElement("td");
    td.textContent = `${fmtInt.format(thr.ranged ?? 0)}/${fmtInt.format(thr.melee ?? 0)}/${fmtInt.format(thr.heal ?? 0)}`;
    td.title = `ranged ${fmtInt.format(thr.ranged ?? 0)}/t · attack ${fmtInt.format(thr.melee ?? 0)}/t `
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
    if (thr.h) td.title = `${fmtInt.format(thr.dps)} dps on the weakest-hit hostile`;
    return td;
}

// The single most decision-relevant number on the page: negative means
// towers alone cannot out-damage what the hostiles are healing back.
function netDpsCell(thr) {
    if (!thr) return naCell("unknown", DEGRADED_TITLE);
    const td = document.createElement("td");
    if (thr.h === 0) return naCell("—", "no hostiles — the bot only prices towers against live hostiles");
    const net = netTowerDps(thr);
    td.textContent = `${net >= 0 ? "+" : ""}${fmtInt.format(net)}`;
    if (net < 0) td.className = "critical";
    td.title = `tower dps ${fmtInt.format(thr.dps)} on the weakest-hit hostile `
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

// `rcl` resolves the RCL-scaled repair target the hits are ramped against, so
// a healthy low-RCL rampart and a neglected high-RCL one never read the same
// color.
const ZONE_ABSENT = { word: "no zone", why: "no rampart inside the configured defender zone" };

function zoneCell(hits, rcl) {
    const td = document.createElement("td");
    if (hits == null) return naCell(ZONE_ABSENT.word, ZONE_ABSENT.why);
    const level = zoneLevel(hits, rcl);
    const critical = isCriticalZone(hits);
    td.append(makeBadge(cssVar(critical ? "--status-critical" : `--fill-${level}`), fmtHits(hits)));
    td.title = `${fmtHits(hits)} / target ${fmtHits(zoneTarget(rcl))} at RCL ${rcl}`;
    return td;
}

const SC_ABSENT_WHY = "no storage class in this snapshot (published before the bot shipped sc)";

function storageClassCell(r) {
    const info = storageClassInfo(r);
    if (!info) return naCell("unknown", SC_ABSENT_WHY);
    const td = textCell(info.word);
    td.title = info.why;
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
    // Incoming nukes are rare — unlike spawns/nuker, this column only appears
    // at all once some room actually has one, so a normal day doesn't carry a
    // column of "none" cells nobody needs to see.
    const anyNukes = Object.values(latest.rooms).some(hasIncomingNuke);
    // Same idea for controller progress: once every room is at max level
    // (!pt), Progress and ETA would be a whole column of "max" each.
    const anyLeveling = Object.values(latest.rooms).some(r => r.rcl?.pt);
    return [
        { key: "room", label: "Room", primary: true, cell: ([n]) => roomLinkCell(n) },
        { key: "rcl", label: "RCL", cell: ([, r]) => textCell(String(r.rcl.l)) },
        ...(anyLeveling ? [
            { key: "progress", label: "Progress",
              cell: ([, r]) => textCell(!r.rcl.pt ? "max" : `${pct(r.rcl.p, r.rcl.pt).toFixed(1)}%`) },
            { key: "eta", label: "ETA → next", cell: ([n, r]) => textCell(etaFor(n, r.rcl)) },
        ] : []),
        { key: "spawns", label: "Spawns",
          hint: "STRUCTURE_SPAWN count — 0 means the room's spawn was destroyed and cannot rebuild lost creeps",
          cell: ([, r]) => textCell(r.sp ?? "—", hasNoSpawn(r) ? "critical" : undefined) },
        ...(anyNukes ? [{ key: "nukes", label: "Nukes",
            hint: "incoming nukes on this room, soonest first — see the room view for full detail",
            cell: ([, r]) => nukesCell(incomingNukes(r)) }] : []),
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
    { id: "power",      render: () => { renderPowerTiles(); renderPowerTable(); renderPowerFleetTable(); } },
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
    renderDataGapNote();
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
