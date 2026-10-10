// Remote-economy columns and formatters shared by the overview section and the room view.
import { compact, fmtDuration, LEDGER_MATURE_TICKS, observedMsPerTick, remoteLedgerRows } from "../calc.js";
import { $, fmtInt } from "../dom.js";
import { history, latest } from "../state.js";
import { roomLinkCell } from "./links.js";
import { naCell, renderTable, textCell } from "./table.js";

const ECONOMY_DEGRADED_TITLE = "economy detail dropped from this snapshot (payload degradation)";

// Energy per tick, one decimal: a two-source remote tops out near 20/tick, so
// whole numbers would hide the difference between a thin and a healthy route.
export const fmtRate = new Intl.NumberFormat("en", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export const fmtSignedRate = rate => `${rate > 0 ? "+" : ""}${fmtRate.format(rate)}`;

function economyNetCell(row) {
    if (!row.mature) {
        return naCell("measuring",
            `${fmtSignedRate(row.netRate)} /tick so far, but only ${fmtInt.format(row.w)} of ${fmtInt.format(LEDGER_MATURE_TICKS)} ticks are covered`);
    }
    const td = textCell(fmtSignedRate(row.netRate), row.netRate < 0 ? "short" : undefined);
    td.title = `${fmtInt.format(row.in)} in − ${fmtInt.format(row.out)} out over ${fmtInt.format(row.w)} ticks`;
    return td;
}

// A per-home ledger total, with the exact figure and its per-tick rate on hover.
export function ledgerAmountCell(total, rate, unit, w) {
    const td = textCell(compact(total));
    td.title = `${fmtInt.format(total)} ${unit} over ${fmtInt.format(w)} ticks · ${fmtRate.format(rate)} /tick`;
    return td;
}

// How much game time a ledger row covers, as wall time once the tick rate is known.
export function ledgerWindowCell(row, msPerTick) {
    const td = textCell(msPerTick != null ? fmtDuration(row.w * msPerTick) : `${fmtInt.format(row.w)} ticks`);
    td.title = `${fmtInt.format(row.w)} ticks`;
    return td;
}

const remoteColumn = { key: "remote", label: "Remote", primary: true, sort: r => r.remote, cell: r => roomLinkCell(r.remote) };

// Overview only: the room view lists one home's routes, so this column would
// repeat the same room on every row.
const homeColumn = { key: "home", label: "Home", hint: "the colony whose creeps farm this remote and receive its energy", sort: r => r.home, cell: r => roomLinkCell(r.home) };

function routeColumns(msPerTick) {
    return [
        { key: "in", label: "In /t",
          hint: "energy per tick remote haulers delivered to the home's storage, or to spawns and extensions before it has storage",
          sort: r => r.inRate, cell: r => textCell(fmtRate.format(r.inRate)) },
        { key: "out", label: "Out /t",
          hint: "energy per tick spent spawning this remote's miners, haulers, reservers, builders and defenders",
          sort: r => r.outRate, cell: r => textCell(fmtRate.format(r.outRate)) },
        { key: "net", label: "Net /t",
          hint: "in minus out. “measuring” = the route has not been booked for a full window yet, so a negative number is not a verdict",
          sort: r => (r.mature ? r.netRate : null), cell: economyNetCell },   // "measuring" is no verdict
        { key: "window", label: "Window", tier: 3,
          hint: "how much game time the in and out sums cover; a route added recently covers less than the full ring",
          sort: r => r.w, cell: r => ledgerWindowCell(r, msPerTick) },
    ];
}

export function renderRemoteEconomyTable({ rows, absent }) {
    const empty = absent === "unknown"
        ? { text: "unknown", why: ECONOMY_DEGRADED_TITLE }
        : { text: "no remote income booked yet", why: "no remote hauler has delivered and no remote creep has spawned within the ledger window" };
    renderTable("remote-economy-table",
        [remoteColumn, homeColumn, ...routeColumns(observedMsPerTick(history))], rows, empty);
}

// The selected room's own routes (it as the home), at the bottom of the room
// view. Hidden when the room has none, like the nukes block — including when
// the payload dropped the ledger, so a degraded snapshot doesn't put an
// "unknown" table on every room, most of which have no remotes.
export function renderRoomRemoteEconomy(room) {
    const { rows } = remoteLedgerRows(latest, room);
    $("room-remote-economy").hidden = rows.length === 0;
    if (rows.length === 0) return;
    renderTable("room-remote-economy-table",
        [remoteColumn, ...routeColumns(observedMsPerTick(history))], rows);
}
