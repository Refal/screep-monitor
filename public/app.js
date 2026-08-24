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

function synthDemo() {
    const roomNames = ["E15S57", "E18S59", "E21S55"];
    const now = Date.now();
    const n = Math.min(MAX_POINTS, rangeHours * 6);
    const rows = [];
    for (let i = 0; i < n; i++) {
        const f = i / n;
        const date = new Date(now - (n - i) * (rangeHours / n) * 3600e3);
        const rooms = {};
        roomNames.forEach((name, k) => {
            rooms[name] = {
                rcl: { l: 5 + k, p: 200000 + f * 400000 + k * 50000, pt: 1215000 },
                e: 1200 + Math.round(600 * Math.sin(i / 5 + k)), ec: 1800,
                se: 200000 + f * 80000 + 20000 * Math.sin(i / 9 + k), te: k * 40000,
                q: (i + k) % 9,
                roles: [
                    { r: "hauler", c: 3, d: 3 }, { r: "upgrader", c: 2 + k % 2, d: 3 },
                    { r: "source_miner", c: 2, d: 2 }, { r: "builder", c: 1, d: 2 },
                    { r: "remote_miner", rm: "E16S57", c: 1, d: 2 },
                ],
                thr: k === 1 ? { h: 2, melee: 3, ranged: 1, boosted: 0 } : { h: 0 },
            };
        });
        rows.push({
            ts: { toDate: () => date }, date, tick: 76680000 + i * 120,
            gcl: { l: 9, p: 6000000 + f * 900000, pt: 48032810 },
            cpu: { u: 20 + 8 * Math.sin(i / 7), l: 110, b: Math.min(10000, 6000 + i * 40) },
            cr: 323000000 + i * 9000,
            rooms,
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
        ? r.date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : r.date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
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

function renderTiles() {
    const first = history[0];
    const creepCount = s => Object.values(s.rooms).reduce(
        (sum, r) => sum + (r.roles ?? []).reduce((a, x) => a + x.c, 0), 0);
    const gclPct = pct(latest.gcl.p, latest.gcl.pt);
    const tiles = [
        { label: "GCL", value: latest.gcl.l, delta: `${gclPct.toFixed(1)}% to ${latest.gcl.l + 1}` },
        { label: "CPU bucket", value: fmtInt.format(latest.cpu.b), delta: `used ${latest.cpu.u.toFixed(1)} / ${latest.cpu.l}` },
        { label: "Credits", value: compact(latest.cr), delta: first ? `${latest.cr - first.cr >= 0 ? "+" : ""}${compact(latest.cr - first.cr)} over range` : "" },
        { label: "Rooms", value: Object.keys(latest.rooms).length, delta: "owned" },
        { label: "Creeps", value: creepCount(latest), delta: "alive (tracked roles)" },
    ];
    $("tiles").replaceChildren(...tiles.map(t => {
        const el = document.createElement("div");
        el.className = "tile";
        for (const [cls, text] of [["label", t.label], ["value", t.value], ["delta", t.delta]]) {
            const d = document.createElement("div");
            d.className = cls;
            d.textContent = text;
            el.append(d);
        }
        return el;
    }));
}

function renderEmpireCharts() {
    $("gcl-next").textContent = String(latest.gcl.l + 1);
    $("cpu-limit").textContent = String(latest.cpu.l);
    renderLine("gcl", "c-gcl",
        [lineDataset("GCL progress", history.map(r => pct(r.gcl.p, r.gcl.pt)), "--series-1")],
        { yMax: 100, unit: "%" });
    renderLine("cpu", "c-cpu",
        [lineDataset("CPU used", history.map(r => r.cpu.u), "--series-1")],
        { yMax: latest.cpu.l });
    renderLine("bucket", "c-bucket",
        [lineDataset("Bucket", history.map(r => r.cpu.b), "--series-1")],
        { yMax: 10000 });
}

function renderRoomCharts() {
    const room = selectedRoom;
    $("room-title").textContent = `Room ${room}`;
    const of = fn => history.map(r => (r.rooms[room] ? fn(r.rooms[room]) : null));
    renderLine("rcl", "c-rcl",
        [lineDataset("RCL progress", of(r => pct(r.rcl.p, r.rcl.pt)), "--series-1")],
        { yMax: 100, unit: "%" });
    renderLine("energy", "c-energy", [
        lineDataset("Storage", of(r => r.se), "--series-1"),
        lineDataset("Terminal", of(r => r.te), "--series-2"),
    ]);
    renderLine("spawn", "c-spawn",
        [lineDataset("Spawn energy", of(r => pct(r.e, r.ec)), "--series-1")],
        { yMax: 100, unit: "%" });
    renderRolesChart(room);
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

function threatBadge(thr) {
    let level, text;
    if (!thr || thr.h === 0) { level = "good"; text = "clear"; }
    else if (thr.boosted > 0) { level = "critical"; text = `${thr.h} hostiles ⚠ boosted`; }
    else if ((thr.melee ?? 0) + (thr.ranged ?? 0) > 0) { level = "serious"; text = `${thr.h} hostiles armed`; }
    else { level = "warning"; text = `${thr.h} hostiles`; }
    const badge = document.createElement("span");
    badge.className = "badge";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = cssVar(`--status-${level}`);
    const label = document.createElement("span");
    label.textContent = text;
    badge.append(swatch, label);
    return badge;
}

function renderRoomsTable() {
    const tbody = $("rooms-table").querySelector("tbody");
    const rows = Object.entries(latest.rooms).sort(([a], [b]) => a.localeCompare(b));
    tbody.replaceChildren(...rows.map(([name, r]) => {
        const tr = document.createElement("tr");
        const cells = [
            name,
            String(r.rcl.l),
            `${pct(r.rcl.p, r.rcl.pt).toFixed(1)}%`,
            `${r.e} / ${r.ec}`,
            compact(r.se),
            compact(r.te),
            String(r.q),
        ];
        for (const text of cells) {
            const td = document.createElement("td");
            td.textContent = text;
            tr.append(td);
        }
        const td = document.createElement("td");
        td.append(threatBadge(r.thr));
        tr.append(td);
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
