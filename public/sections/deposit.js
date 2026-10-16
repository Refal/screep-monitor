// Deposit harvesting section.
import { compact, depositLedgerRows, observedMsPerTick } from "../calc.js";
import { cssVar, fmtInt } from "../dom.js";
import { history, latest } from "../state.js";
import { pluralCount } from "../ui/cells-defense.js";
import { fmtRate, ledgerAmountCell, ledgerWindowCell } from "../ui/cells-economy.js";
import { chipsCell } from "../ui/cells-labs.js";
import { makeBadge, roomLinkCell } from "../ui/links.js";
import { naCell, renderTable, textCell } from "../ui/table.js";
import { renderTileRow } from "../ui/tiles.js";

// The per-home deposit ledger (`dpl`), the bot's open deposit ops (`dpo`) and
// their empire-wide rollup. calc.js owns the reading; this owns the wording and
// the absence branches.

const DEPOSIT_DEGRADED = "deposit ledger dropped from this snapshot (payload degradation)";
const OPS_UNKNOWN = "this snapshot predates the bot publishing its open deposit ops (dpo)";

// A degraded snapshot must never read as a calm zero, for the same reason
// renderPowerTiles shows "unknown": "nothing hauled" is exactly the wrong
// reading there.
export function renderDepositTiles() {
    const { rows, absent, ops } = depositLedgerRows(latest);
    const blind = absent === "unknown";
    const total = rows.reduce((a, r) => a + r.total, 0);
    const rate = rows.reduce((a, r) => a + r.depositRate, 0);
    const energy = rows.reduce((a, r) => a + r.e, 0);
    const delivering = rows.filter(r => r.total > 0).length;
    renderTileRow("deposit-tiles", [
        {
            label: "Ops running",
            // `dpo` is never degraded, so it can answer even when the ledger cannot.
            value: ops == null ? "unknown" : String(ops.length),
            delta: ops == null ? OPS_UNKNOWN
                : ops.length ? `from ${pluralCount(new Set(ops.map(o => o.h)).size, "home")}`
                : "no deposit op open",
        },
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

// Ops are short, so the ratio shows from the first delivery rather than waiting
// out a full ledger window. While the op is still open its spend is
// front-loaded (booked at spawn, deposits on delivery), so the figure only
// falls from here: "running" says so. Once the bot has closed the op the
// window holds all of it and the number is final.
function ratioCell(row) {
    if (row.energyPerUnit == null) {
        return naCell("no deposits yet", `${fmtInt.format(row.e)} energy spent and no deposit delivered home within the window`);
    }
    const ratio = fmtRate.format(row.energyPerUnit);
    const sums = `${fmtInt.format(row.e)} energy out ÷ ${fmtInt.format(row.total)} deposit units in over ${fmtInt.format(row.w)} ticks`;
    const td = textCell(ratio);
    if (row.op === "active") {
        const marker = document.createElement("span");
        marker.className = "muted";
        marker.textContent = " running";
        td.append(marker);
        td.title = `${sums} · op still open: spend is booked at spawn and deposits on delivery, so this falls as hauling goes on`;
    } else if (row.op === "finished") {
        td.title = `${sums} · the op has ended, so this is its final figure`;
    } else {
        td.title = `${sums} · ${OPS_UNKNOWN}, so it may still be running`;
    }
    return td;
}

function opAge(op) {
    return Number.isFinite(latest?.tick) && Number.isFinite(op.s) ? ` · ${fmtInt.format(latest.tick - op.s)} ticks in` : "";
}

function opCell(row) {
    if (row.op === "unknown") return naCell("unknown", OPS_UNKNOWN);
    if (row.op === "finished") return naCell("finished", "the bot has no open deposit op for this home");
    const badge = makeBadge(cssVar("--status-good"), row.ops.length > 1 ? `active ×${row.ops.length}` : "active");
    badge.title = row.ops.map(o => `${o.t} in ${o.rm}, started at tick ${fmtInt.format(o.s)}${opAge(o)}`).join("\n");
    return chipsCell([badge], row.ops.map(o => `${o.t} in ${o.rm}`).join(" · "));
}

function ledgerColumns(msPerTick) {
    return [
        { key: "home", label: "Home", primary: true, sort: r => r.home, cell: r => roomLinkCell(r.home) },
        { key: "op", label: "Op",
          hint: "whether the bot still has a deposit op open for this home; the ledger window outlives the op",
          sort: r => ({ active: 0, finished: 1 })[r.op] ?? null, cell: opCell },
        { key: "deposits", label: "Deposits in",
          hint: "deposit units the home's deposit haulers handed over at home, per type",
          sort: r => r.total, cell: depositsCell },
        { key: "energy", label: "Energy out",
          hint: "energy spent spawning deposit harvesters and haulers",
          sort: r => r.e, cell: r => ledgerAmountCell(r.e, r.energyRate, "energy", r.w) },
        { key: "ratio", label: "Energy / unit",
          hint: "energy out per deposit unit in, summed across types, from the first delivery. “running” = the op is still open, so spend booked at spawn still outweighs deposits booked on delivery and the figure will fall",
          sort: r => r.energyPerUnit, cell: ratioCell },
        { key: "window", label: "Window", tier: 3,
          hint: "how much game time the sums cover; a home booked recently covers less than the full ring",
          sort: r => r.w, cell: r => ledgerWindowCell(r, msPerTick) },
    ];
}

export function renderDepositLedgerTable() {
    const { rows, absent } = depositLedgerRows(latest);
    const empty = absent === "unknown"
        ? { text: "unknown", why: DEPOSIT_DEGRADED }
        : { text: "no deposit op booked yet", why: "no deposit harvester or hauler has spawned and no deposit has been delivered within the ledger window" };
    renderTable("deposit-ledger-table", ledgerColumns(observedMsPerTick(history)), rows, empty);
}
