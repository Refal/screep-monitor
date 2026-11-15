// Deposit harvesting section.
import { compact, opRows } from "../calc.js";
import { latest } from "../state.js";
import { pluralCount } from "../ui/cells-defense.js";
import { fmtRate } from "../ui/cells-economy.js";
import { opColumns } from "../ui/cells-ops.js";
import { renderTable } from "../ui/table.js";
import { renderTileRow } from "../ui/tiles.js";

// The bot's per-op deposit log (`ops`, kind "deposit"). calc.js owns the reading;
// this owns the wording. `ops` is never degraded, so an empty list means no op yet.

const DEPOSIT_OP_COLUMNS = opColumns({
    inLabel: "Deposits in", unit: "deposit units", noun: "deposit units (per type)", withBoosts: false,
    none: "no deposit delivered home yet",
});

export function renderDepositTiles() {
    const rows = opRows(latest, "deposit");
    const active = rows.filter(r => r.status === "active");
    const finished = rows.filter(r => r.status === "finished");
    const total = rows.reduce((a, r) => a + r.gotTotal, 0);
    const finishedIn = finished.reduce((a, r) => a + r.gotTotal, 0);
    const finishedOut = finished.reduce((a, r) => a + r.en, 0);
    renderTileRow("deposit-tiles", [
        {
            label: "Open ops",
            value: String(active.length),
            delta: active.length ? `from ${pluralCount(new Set(active.map(r => r.home)).size, "home")}` : "no deposit op open",
        },
        {
            label: "Deposits in",
            value: compact(total),
            delta: `across ${pluralCount(rows.length, "op")} listed`,
        },
        {
            label: "Energy / unit",
            value: finishedIn > 0 ? fmtRate.format(finishedOut / finishedIn) : "—",
            delta: finished.length ? `across ${pluralCount(finished.length, "finished op")}` : "no finished op yet",
        },
    ]);
}

export function renderDepositOpsTable() {
    renderTable("deposit-ops-table", DEPOSIT_OP_COLUMNS, opRows(latest, "deposit"),
        { text: "no deposit op logged yet", why: "no deposit harvester or hauler has spawned since the bot began logging ops" });
}
