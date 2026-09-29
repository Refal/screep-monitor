// Remote economy section.
import { fmtDuration, LEDGER_MATURE_TICKS, observedMsPerTick } from "../calc.js";
import { fmtInt } from "../dom.js";
import { history } from "../state.js";
import { roomLinkCell } from "../ui/links.js";
import { naCell, renderTable, textCell } from "../ui/table.js";
import { renderTileRow } from "../ui/tiles.js";

const ECONOMY_DEGRADED_TITLE = "economy detail dropped from this snapshot (payload degradation)";

// Energy per tick, one decimal: a two-source remote tops out near 20/tick, so
// whole numbers would hide the difference between a thin and a healthy route.
const fmtRate = new Intl.NumberFormat("en", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

const fmtSignedRate = rate => `${rate > 0 ? "+" : ""}${fmtRate.format(rate)}`;

export function renderRemoteEconomyTiles(s) {
    if (s.absent === "unknown") {
        const dropped = { value: "—", delta: "unknown — economy detail dropped" };
        renderTileRow("remote-economy-tiles", [
            { label: "Net energy", ...dropped },
            { label: "Income", ...dropped },
            { label: "Spend", ...dropped },
            { label: "Losing remotes", ...dropped },
        ]);
        return;
    }
    // Nothing counted yet is a different state from a counted zero: the tiles
    // would otherwise read "+0.0" over routes that are all still measuring.
    if (s.routes > 0 && s.counted === 0) {
        const measuring = { value: "—", delta: `all ${s.routes} route${s.routes === 1 ? "" : "s"} still measuring` };
        renderTileRow("remote-economy-tiles", [
            { label: "Net energy", ...measuring },
            { label: "Income", ...measuring },
            { label: "Spend", ...measuring },
            { label: "Losing remotes", ...measuring },
        ]);
        return;
    }
    const counted = s.measuring
        ? `${s.counted} route${s.counted === 1 ? "" : "s"} · ${s.measuring} measuring, not counted`
        : `${s.counted} route${s.counted === 1 ? "" : "s"}`;
    renderTileRow("remote-economy-tiles", [
        {
            label: "Net energy", value: `${fmtSignedRate(s.netRate)} /tick`,
            delta: s.routes ? counted : "nothing booked yet",
            tone: s.netRate < 0 ? "short" : undefined,
        },
        { label: "Income", value: `${fmtRate.format(s.inRate)} /tick`, delta: "delivered home by remote haulers" },
        { label: "Spend", value: `${fmtRate.format(s.outRate)} /tick`, delta: "spawn cost of remote creeps" },
        {
            label: "Losing remotes", value: String(s.losing.length),
            delta: s.losing.length ? s.losing.map(r => r.remote).join(" ") : "none",
            tone: s.losing.length ? "short" : undefined,
        },
    ]);
}

function economyNetCell(row) {
    if (!row.mature) {
        return naCell("measuring",
            `${fmtSignedRate(row.netRate)} /tick so far, but only ${fmtInt.format(row.w)} of ${fmtInt.format(LEDGER_MATURE_TICKS)} ticks are covered`);
    }
    const td = textCell(fmtSignedRate(row.netRate), row.netRate < 0 ? "short" : undefined);
    td.title = `${fmtInt.format(row.in)} in − ${fmtInt.format(row.out)} out over ${fmtInt.format(row.w)} ticks`;
    return td;
}

function economyWindowCell(row, msPerTick) {
    const td = textCell(msPerTick != null ? fmtDuration(row.w * msPerTick) : `${fmtInt.format(row.w)} ticks`);
    td.title = `${fmtInt.format(row.w)} ticks`;
    return td;
}

function remoteEconomyColumns(msPerTick) {
    return [
        { key: "remote", label: "Remote", primary: true, cell: r => roomLinkCell(r.remote) },
        { key: "home", label: "Home", hint: "the colony whose creeps farm this remote and receive its energy", cell: r => roomLinkCell(r.home) },
        { key: "in", label: "In /t",
          hint: "energy per tick remote haulers delivered to the home's storage, or to spawns and extensions before it has storage",
          cell: r => textCell(fmtRate.format(r.inRate)) },
        { key: "out", label: "Out /t",
          hint: "energy per tick spent spawning this remote's miners, haulers, reservers, builders and defenders",
          cell: r => textCell(fmtRate.format(r.outRate)) },
        { key: "net", label: "Net /t",
          hint: "in minus out. “measuring” = the route has not been booked for a full window yet, so a negative number is not a verdict",
          cell: economyNetCell },
        { key: "window", label: "Window", tier: 3,
          hint: "how much game time the in and out sums cover; a route added recently covers less than the full ring",
          cell: r => economyWindowCell(r, msPerTick) },
    ];
}

export function renderRemoteEconomyTable({ rows, absent }) {
    const empty = absent === "unknown"
        ? { text: "unknown", why: ECONOMY_DEGRADED_TITLE }
        : { text: "no remote income booked yet", why: "no remote hauler has delivered and no remote creep has spawned within the ledger window" };
    renderTable("remote-economy-table", remoteEconomyColumns(observedMsPerTick(history)), rows, empty);
}
