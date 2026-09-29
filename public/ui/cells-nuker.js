// Nuker/nuke cells and helpers.
import {
    compact, fmtDuration, isCriticalZone, netWindowRate, NUKER_ENERGY_CAPACITY, NUKER_GHODIUM_CAPACITY,
    observedMsPerTick, rampLevel,
} from "../calc.js";
import { cssVar, fmtInt } from "../dom.js";
import { history, latest } from "../state.js";
import { makeBadge } from "./links.js";
import { naCell } from "./table.js";

// The defender zone as the summary views colour it: `hits` from the latest
// snapshot, `rate` its net hits/tick over the range (null with no trend, or
// with no zone at all), and `tone` critical under the CRITICAL_RAMPART_HITS
// cliff, short while shrinking. Shared by the glance row and the watch line,
// so the two can't colour one wall differently.
export function zoneState(room) {
    const hits = latest.rooms[room]?.thr?.defRmp ?? null;
    const wr = hits != null ? netWindowRate(row => row.rooms[room]?.thr?.defRmp ?? null, history) : null;
    const rate = wr?.rate ?? null;
    const shrinking = rate != null && rate < 0;
    return { hits, rate, shrinking, tone: isCriticalZone(hits) ? "critical" : shrinking ? "short" : undefined };
}

// Status of a nuker triple [ghodium, energy, cooldown], or null when the room
// has none. Shared by the room's headline strip and its Nuker section.
export function nukerStatus(nuk) {
    if (!nuk) return null;
    const [g, e, cd] = nuk;
    const ready = cd === 0 && g >= NUKER_GHODIUM_CAPACITY && e >= NUKER_ENERGY_CAPACITY;
    return {
        ready,
        word: ready ? "ready" : cd > 0 ? "cooling" : "filling",
        gPct: Math.round(Math.min(1, g / NUKER_GHODIUM_CAPACITY) * 100),
        ePct: Math.round(Math.min(1, e / NUKER_ENERGY_CAPACITY) * 100),
    };
}

// Shared by the threat-board card and the per-room nukes section — ticksToLand
// counts down by exactly 1 per tick (unlike the nuker's fill stocks), so no
// rate estimation is needed, just the same observed ms/tick → fmtDuration
// conversion the nuker cooldown ETA already uses below.
export function nukeEta(ticksToLand) {
    const ms = observedMsPerTick(history);
    return ms != null ? `~${fmtDuration(ticksToLand * ms)}` : `~${compact(ticksToLand)} ticks`;
}

export function nukeLandingText(ticksToLand, launchRoom, x, y) {
    return `lands in ${nukeEta(ticksToLand)} at (${x}, ${y}) · launched from ${launchRoom}`;
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
export function nukerCell(nuk) {
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
export function nukesCell(nukes) {
    if (!nukes.length) return naCell("none", "no incoming nukes");
    const td = document.createElement("td");
    const [soonest] = nukes;
    td.append(makeBadge(cssVar("--status-critical"), `${compact(soonest[0])}t`));
    td.title = nukes.map(([t, room, x, y]) => `${compact(t)}t from ${room} (${x}, ${y})`).join(" · ");
    return td;
}
