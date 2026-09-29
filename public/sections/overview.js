// Overview tiles, rooms-at-a-glance, data-gap note and empire charts.
import {
    average, compact, fmtDuration, fmtHits, levelEta, pct, powerStockPoint, zoneTarget,
} from "../calc.js";
import { avgLineDataset, lineDataset, rateDatasets, renderLine } from "../charts/core.js";
import { $, fmtInt } from "../dom.js";
import { history, historyGaps, latest } from "../state.js";
import { DEGRADED_TITLE, pluralCount, ZONE_ABSENT } from "../ui/cells-defense.js";
import { labStatusWord, labTone } from "../ui/cells-labs.js";
import { nukerStatus, zoneState } from "../ui/cells-nuker.js";
import { etaCellText } from "../ui/format.js";
import { roomNameLink } from "../ui/links.js";
import { etaText, renderTileRow } from "../ui/tiles.js";

export function renderTiles() {
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

// Two groups because the two room classes are watched for different things.
// Levelling rooms sort by ETA (the next level-up first); max-level rooms put
// anything needing a look first, then by name. Values come from the same
// helpers as the room view's headline strip, so the two can't disagree.

function glanceStat(text, tone, title) {
    const el = document.createElement("span");
    el.className = "glance-stat" + (tone ? ` ${tone}` : "");
    el.textContent = text;
    if (title) el.title = title;
    return el;
}

function glanceRow(room, body) {
    const row = document.createElement("div");
    row.className = "glance-row";
    const name = document.createElement("span");
    name.className = "glance-name";
    name.append(roomNameLink(room));
    const rest = document.createElement("span");
    rest.className = "glance-body";
    rest.append(...body);
    row.append(name, rest);
    return row;
}

function glanceGroup(title, rows) {
    const card = document.createElement("section");
    card.className = "card glance-group";
    const h = document.createElement("h3");
    h.textContent = title;
    card.append(h, ...rows);
    return card;
}

function growingGlanceRow([room, r]) {
    const eta = levelEta(row => row.rooms[room]?.rcl ?? null, r.rcl, history);
    const p = pct(r.rcl.p, r.rcl.pt);
    const bar = document.createElement("span");
    bar.className = "glance-bar";
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${p.toFixed(1)}% to level ${r.rcl.l + 1}`);
    const fill = document.createElement("span");
    fill.style.width = `${Math.min(100, p)}%`;
    bar.append(fill);
    return {
        eta,
        el: glanceRow(room, [
            glanceStat(`RCL ${r.rcl.l}`),
            bar,
            glanceStat(`${p.toFixed(1)}%`),
            glanceStat(eta ? `→ ${r.rcl.l + 1} in ${etaCellText(eta, false)}` : "no gain in range", eta ? undefined : "na"),
            glanceStat(`storage ${compact(r.se ?? 0)}`),
        ]),
    };
}

function maxedGlanceRow([room, r]) {
    const thr = r.thr;
    const zone = zoneState(room);
    const nuk = nukerStatus(r.nuk);
    const lab = r.lab;
    const labWarn = labTone(lab?.s);
    const body = [
        !thr ? glanceStat("zone unknown", "na", DEGRADED_TITLE)
            : zone.hits == null ? glanceStat(`zone: ${ZONE_ABSENT.word}`, "na", ZONE_ABSENT.why)
            : glanceStat(`zone ${fmtHits(zone.hits)}${zone.shrinking ? " ↓" : ""}`, zone.tone,
                `${fmtHits(zone.hits)} / target ${fmtHits(zoneTarget(r.rcl.l))}${zone.rate != null ? ` · ${compact(zone.rate)}/tick` : ""}`),
        glanceStat(nuk ? `nuker ${nuk.word}` : "no nuker", nuk ? undefined : "na"),
        !lab ? glanceStat("no labs", "na")
            // Naming the compound says more than "reaction"; prepare keeps its
            // warning tone, and the hover still carries the state.
            : lab.o && (lab.s === "reaction" || lab.s === "prepare") ? glanceStat(`lab ${lab.o}`, labWarn, labStatusWord(lab.s))
            : glanceStat(`labs ${labStatusWord(lab.s)}`, labWarn),
        glanceStat(`storage ${compact(r.se ?? 0)}`),
        glanceStat(`spawn ${Math.round(pct(r.e, r.ec))}%`, undefined, `${fmtInt.format(r.e)} / ${fmtInt.format(r.ec)}`),
    ];
    // 0 = look at this first; only states the stats above already colour or
    // mute. A room with no threat data ranks above a healthy one, the same
    // "silence is not safety" call POSTURE_RANK makes in calc.js. A room with
    // no zone at all stays at 2, as watchItems treats it: its own state, not
    // a thin wall.
    const attention = zone.tone === "critical" ? 0 : !thr || zone.tone || labWarn ? 1 : 2;
    return { attention, el: glanceRow(room, body) };
}

export function renderRoomsGlance() {
    const entries = Object.entries(latest.rooms);
    const growing = entries.filter(([, r]) => r.rcl?.pt).map(e => ({ room: e[0], ...growingGlanceRow(e) }))
        .sort((a, b) => (a.eta?.etaTicks ?? Infinity) - (b.eta?.etaTicks ?? Infinity) || a.room.localeCompare(b.room));
    const maxed = entries.filter(([, r]) => !r.rcl?.pt).map(e => ({ room: e[0], ...maxedGlanceRow(e) }))
        .sort((a, b) => a.attention - b.attention || a.room.localeCompare(b.room));
    const groups = [];
    if (maxed.length) groups.push(glanceGroup(`Max level · ${pluralCount(maxed.length, "room")}`, maxed.map(x => x.el)));
    if (growing.length) groups.push(glanceGroup(`Levelling · ${pluralCount(growing.length, "room")}`, growing.map(x => x.el)));
    $("rooms-glance").replaceChildren(...groups);
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
export function renderDataGapNote() {
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

export function renderEmpireCharts() {
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
