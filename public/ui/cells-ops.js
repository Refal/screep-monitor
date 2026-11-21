// Cells shared by the power-bank and deposit op tables (calc.js `opRows`).
import { compact, fmtDuration, observedMsPerTick, roomHistoryUrl } from "../calc.js";
import { cssVar, fmtInt } from "../dom.js";
import { currentShard, history, latest } from "../state.js";
import { fmtRate } from "./cells-economy.js";
import { chipsCell } from "./cells-labs.js";
import { makeBadge, roomLink, roomLinkCell, roomNameLink } from "./links.js";
import { naCell, textCell } from "./table.js";

function tickLinkCell(row, tick, what) {
    const td = document.createElement("td");
    td.append(roomLink({
        href: roomHistoryUrl(currentShard, row.rm, tick),
        text: String(tick),
        title: `${what} tick ${fmtInt.format(tick)}: open ${row.rm} history at that tick`,
    }));
    return td;
}

function durationCell(row) {
    const td = document.createElement("td");
    if (row.duration == null) return naCell("—", "no current tick to measure an open op against");
    const ms = observedMsPerTick(history);
    const wall = ms != null ? fmtDuration(row.duration * ms) : null;
    td.append(`${wall ?? `${fmtInt.format(row.duration)} ticks`} `);
    const badge = makeBadge(cssVar(row.status === "active" ? "--status-good" : "--text-muted"), row.status);
    badge.title = `${fmtInt.format(row.duration)} ticks · ${row.status === "active" ? "the op is still open" : "the op has ended"}`;
    td.append(badge);
    return td;
}

// Snapshot age plus the op's ticks before the snapshot: the same sum remoteWhenCell (sections/remote.js) uses.
function endedAgoCell(row) {
    if (row.e == null) return naCell("running", "the op is still open");
    if (row.agoTicks == null) return naCell("—", "no snapshot tick to measure against");
    const ticks = `${fmtInt.format(row.agoTicks)} ticks before the latest snapshot`;
    const msPerTick = observedMsPerTick(history);
    const td = document.createElement("td");
    if (msPerTick == null) {
        td.textContent = `${fmtInt.format(row.agoTicks)} ticks ago`;
        td.title = `${ticks} · no tick rate in range to convert it`;
        return td;
    }
    const ms = Date.now() - latest.ts.toDate().getTime() + row.agoTicks * msPerTick;
    td.textContent = ms < 60000 ? "just now" : `${fmtDuration(ms)} ago`;
    td.title = ticks;
    return td;
}

function chipList(pairs, title) {
    const chips = pairs.map(([name, units]) => {
        const badge = makeBadge(cssVar("--text-muted"), `${name} ${compact(units)}`);
        badge.title = `${fmtInt.format(units)} ${name} ${title}`;
        return badge;
    });
    return chipsCell(chips);
}

function energyCell(row, withBoosts) {
    const td = textCell(compact(row.en));
    td.title = `${fmtInt.format(row.en)} energy out: spawn bodies${withBoosts ? " plus lab boost energy" : ""}`;
    if (withBoosts && row.compounds.length) {
        const chips = chipList(row.compounds, "consumed boosting this op's creeps");
        td.append(" ", ...[...chips.childNodes]);
    }
    return td;
}

function gotCell(row, noun, none) {
    return row.got.length ? chipList(row.got, `${noun} handed over at home`) : naCell("none yet", none);
}

function yieldCell(row, unit) {
    if (row.yieldPer1k == null) return naCell("—", "no energy booked for this op");
    const td = textCell(fmtRate.format(row.yieldPer1k));
    td.title = `${fmtInt.format(row.gotTotal)} ${unit} in ÷ ${fmtInt.format(row.en)} energy out × 1000`
        + (row.status === "active" ? " · op still open: spend is booked at spawn, income on delivery, so this rises as hauling goes on" : "");
    return td;
}

// `inLabel`/`unit` word the income column; power ops also carry boost chips on the energy cell.
export function opColumns({ inLabel, unit, noun, none, withBoosts }) {
    return [
        { key: "home", label: "Home", primary: true, sort: r => r.home, cell: r => roomLinkCell(r.home) },
        { key: "room", label: "Target",
          hint: "the op's target room, a highway room",
          sort: r => r.rm, cell: r => { const td = document.createElement("td"); td.append(roomNameLink(r.rm)); return td; } },
        { key: "start", label: "Start",
          hint: "tick of the op's first spawn; links to the target room's history at that tick",
          sort: r => r.s, cell: r => tickLinkCell(r, r.s, "start") },
        { key: "end", label: "End",
          hint: "tick the op closed (no creep left and no plan record); links to the target room's history at that tick",
          sort: r => r.e, cell: r => (r.e == null ? naCell("—", "the op is still open") : tickLinkCell(r, r.e, "end")) },
        { key: "ended", label: "Ended",
          hint: "how long ago the op closed: snapshot age plus its ticks before the snapshot, at the observed s/tick",
          sort: r => r.e, cell: endedAgoCell },
        { key: "duration", label: "Duration",
          hint: "start to end, or to the latest snapshot while the op is open",
          sort: r => r.duration, cell: durationCell },
        { key: "energy", label: "Energy out",
          hint: withBoosts ? "energy spent on spawn bodies plus lab boost energy; chips show boost compounds consumed" : "energy spent on spawn bodies",
          sort: r => r.en, cell: r => energyCell(r, withBoosts) },
        { key: "in", label: inLabel,
          hint: `${noun} the op's haulers handed over at home`,
          sort: r => r.gotTotal, cell: r => gotCell(r, noun, none) },
        { key: "yield", label: "Yield",
          hint: `${unit} in per 1000 energy out`,
          sort: r => r.yieldPer1k, cell: r => yieldCell(r, unit) },
    ];
}
