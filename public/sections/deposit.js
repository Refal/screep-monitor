// Deposit harvesting section.
import { compact, depositLedgerRows, LEDGER_MATURE_TICKS, observedMsPerTick } from "../calc.js";
import { cssVar, fmtInt } from "../dom.js";
import { history, latest } from "../state.js";
import { pluralCount } from "../ui/cells-defense.js";
import { fmtRate, ledgerAmountCell, ledgerWindowCell } from "../ui/cells-economy.js";
import { chipsCell } from "../ui/cells-labs.js";
import { makeBadge, roomLinkCell } from "../ui/links.js";
import { naCell, renderTable, textCell } from "../ui/table.js";
import { renderTileRow } from "../ui/tiles.js";

// The per-home deposit ledger (`dpl`) and its empire-wide rollup. It is the
// only deposit data the bot publishes, so this section is a ledger and nothing
// else. calc.js owns the reading; this owns the wording and the absence branch.

const DEPOSIT_DEGRADED = "deposit ledger dropped from this snapshot (payload degradation)";

// A degraded snapshot must never read as a calm zero, for the same reason
// renderPowerTiles shows "unknown": "nothing hauled" is exactly the wrong
// reading there.
export function renderDepositTiles() {
    const { rows, absent } = depositLedgerRows(latest);
    const blind = absent === "unknown";
    const total = rows.reduce((a, r) => a + r.total, 0);
    const rate = rows.reduce((a, r) => a + r.depositRate, 0);
    const energy = rows.reduce((a, r) => a + r.e, 0);
    const delivering = rows.filter(r => r.total > 0).length;
    renderTileRow("deposit-tiles", [
        {
            label: "Homes harvesting",
            value: blind ? "unknown" : String(rows.length),
            delta: blind ? DEPOSIT_DEGRADED
                : rows.length ? `${pluralCount(delivering, "home")} delivering`
                : "no deposit op booked",
        },
        {
            label: "Deposits in",
            value: blind ? "unknown" : compact(total),
            delta: blind ? DEPOSIT_DEGRADED : `${fmtRate.format(rate)} /tick across homes`,
        },
        {
            label: "Energy out",
            value: blind ? "unknown" : compact(energy),
            delta: blind ? DEPOSIT_DEGRADED : "deposit harvester and hauler spawn cost",
        },
    ]);
}

function depositsCell(row) {
    if (!row.deposits.length) return naCell("none yet", "no deposit delivered home within the window");
    const chips = row.deposits.map(([type, units]) => {
        const badge = makeBadge(cssVar("--text-muted"), `${type} ${compact(units)}`);
        badge.title = `${fmtInt.format(units)} ${type} handed over at home over ${fmtInt.format(row.w)} ticks`;
        return badge;
    });
    return chipsCell(chips, row.deposits.map(([t, u]) => `${t} ${fmtInt.format(u)}`).join(" · "));
}

// Measuring outranks the ratio: spend is booked at spawn and deposits only on
// delivery, so a young window's ratio is noise.
function ratioCell(row) {
    if (row.energyPerUnit == null) {
        return naCell("no deposits yet", `${fmtInt.format(row.e)} energy spent and no deposit delivered home within the window`);
    }
    const ratio = fmtRate.format(row.energyPerUnit);
    if (!row.mature) {
        return naCell("measuring",
            `${ratio} energy per unit so far, but only ${fmtInt.format(row.w)} of ${fmtInt.format(LEDGER_MATURE_TICKS)} ticks are covered`);
    }
    const td = textCell(ratio);
    td.title = `${fmtInt.format(row.e)} energy out ÷ ${fmtInt.format(row.total)} deposit units in over ${fmtInt.format(row.w)} ticks`;
    return td;
}

function ledgerColumns(msPerTick) {
    return [
        { key: "home", label: "Home", primary: true, cell: r => roomLinkCell(r.home) },
        { key: "deposits", label: "Deposits in",
          hint: "deposit units the home's deposit haulers handed over at home, per type",
          cell: depositsCell },
        { key: "energy", label: "Energy out",
          hint: "energy spent spawning deposit harvesters and haulers",
          cell: r => ledgerAmountCell(r.e, r.energyRate, "energy", r.w) },
        { key: "ratio", label: "Energy / unit",
          hint: "energy out per deposit unit in, summed across types. “measuring” = the home has not been booked for a full window yet; spend is booked at spawn, deposits on delivery",
          cell: ratioCell },
        { key: "window", label: "Window", tier: 3,
          hint: "how much game time the sums cover; a home booked recently covers less than the full ring",
          cell: r => ledgerWindowCell(r, msPerTick) },
    ];
}

export function renderDepositLedgerTable() {
    const { rows, absent } = depositLedgerRows(latest);
    const empty = absent === "unknown"
        ? { text: "unknown", why: DEPOSIT_DEGRADED }
        : { text: "no deposit op booked yet", why: "no deposit harvester or hauler has spawned and no deposit has been delivered within the ledger window" };
    renderTable("deposit-ledger-table", ledgerColumns(observedMsPerTick(history)), rows, empty);
}
