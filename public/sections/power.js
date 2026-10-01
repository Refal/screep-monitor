// Power harvesting section.
import {
    compact, fmtDuration, hasThreatDetail, haulerSummary, LEDGER_MATURE_TICKS, observedMsPerTick,
    powerFleetRows, powerGateState, powerLedgerRows, powerStockPoint, roomUrl,
} from "../calc.js";
import { cssVar, fmtInt } from "../dom.js";
import { history, latest } from "../state.js";
import { pluralCount } from "../ui/cells-defense.js";
import { fmtRate } from "../ui/cells-economy.js";
import { chipsCell } from "../ui/cells-labs.js";
import { makeBadge, roomLink, roomLinkCell } from "../ui/links.js";
import { naCell, renderTable, textCell } from "../ui/table.js";
import { renderTileRow } from "../ui/tiles.js";

// autoHarvest gate and stock tiles, one row per power squad and hauler group
// out on the map, and the per-home ledger of power in against energy out.
// Live-bank planner state is not in the payload (debugPowerBanks() in the
// bot's console shows it). calc.js owns the readings; this owns the wording
// and the absence branches.

const POWER_ABSENCE = {
    // Distinct empty states, and collapsing any two of them would lie.
    off: {
        text: "power harvesting is switched off",
        why: "the bot's autoHarvest gate is off — no bank is evaluated at all, so an empty list here says nothing about what is out there",
    },
    none: {
        text: "no squads out",
        why: "no harvest wave or fight squad is in the army records, and no power hauler is out",
    },
    unknown: {
        text: "no power detail in this snapshot (payload degradation)",
        why: "power squads and haulers are dropped in the same degradation step as threat/army detail — this is not “nothing out”",
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
// calm zero here — "no haulers out" is precisely the reading that would be
// wrong, and for the same reason renderRemoteTiles shows "unknown" rather
// than 0. Only `pw` (never degraded) keeps its number in that state.
export function renderPowerTiles() {
    const gate = powerGateState(latest);
    const blind = gate === "uncollected" || (!latest.ph && !hasThreatDetail(latest));
    const blindText = gate === "uncollected" ? POWER_ABSENCE.uncollected.text : POWER_ABSENCE.unknown.text;
    const haulers = (latest.ph ?? []).map(h => haulerSummary(h.hl)).filter(Boolean);
    const haulerCount = haulers.reduce((a, h) => a + h.count, 0);
    const carrying = haulers.reduce((a, h) => a + h.carrying, 0);
    const stockPoint = powerStockPoint(latest);
    const processing = stockPoint?.processing ?? 0;
    renderTileRow("power-tiles", [
        { label: "Harvesting", ...GATE_TILE[gate] },
        {
            label: "Haulers out",
            value: blind ? "unknown" : String(haulerCount),
            delta: blind ? blindText
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

function haulerDetailText(h) {
    return `${pluralCount(h.count, "hauler")} · carrying ${fmtInt.format(h.carrying)} power · `
        + (h.spawning ? "all still spawning" : `shortest life left ${fmtInt.format(h.minTtl)}t`);
}

// A bank room is a highway room, never owned, so roomLinkCell would always
// take the screeps.com branch — spelled out here so the title can say why.
function fleetRoomCell(row) {
    const td = document.createElement("td");
    td.append(roomLink({ href: roomUrl(row.rm), text: row.rm, title: `${row.rm} is a highway room — open it on screeps.com` }));
    if (!row.live) {
        const badge = makeBadge(cssVar("--text-muted"), "gone");
        badge.title = row.kind === "haulers"
            ? "our kill deleted the bank's intel record; these haulers are still loading or on the way home"
            : "our kill deleted the bank's intel record; this squad is done with it and on the way home";
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

function fleetStatusCell(row) {
    if (row.kind === "haulers") {
        const h = haulerSummary(row.hl);
        if (!h) return naCell("none", "no hauler count in this snapshot");
        return textCell(`${h.count} ${h.spawning ? "spawning" : "hauling"}`);
    }
    return textCell(row.status);
}

function fleetDetailCell(row) {
    if (row.kind === "haulers") {
        const h = haulerSummary(row.hl);
        return h ? textCell(haulerDetailText(h)) : naCell("none");
    }
    return textCell(squadDetailText(row.squad));
}

const POWER_FLEET_COLUMNS = [
    { key: "room", label: "Bank room", primary: true, cell: fleetRoomCell },
    { key: "home", label: "Home",
      hint: "the home room that fielded the squad; hauler counts are published per bank, not per home",
      cell: r => r.kind === "squad" ? textCell(r.home) : naCell("per bank", "hauler counts are published per bank, not per home") },
    { key: "unit", label: "Unit",
      hint: "w<n> is a harvest wave, fight is its fight squad; haulers are every power hauler assigned to that bank",
      cell: fleetUnitCell },
    { key: "status", label: "Status",
      hint: "the squad's own status from the bot's army records (not its route's); for haulers, how many are out and whether they have left home yet",
      cell: fleetStatusCell },
    { key: "detail", label: "Detail", tier: 3,
      hint: "where the squad's members are, and how many are lost for good (engaged squads never respawn); for haulers, the power they carry and the shortest life left",
      cell: fleetDetailCell },
];

// One row per unit of ours, so four squads on one bank are four short rows.
// Army records and `ph` both outlive the bank's intel record — our own kill
// deletes it exactly while the haulers load — so a "gone" row is the walk home.
export function renderPowerFleetTable() {
    const gate = powerGateState(latest);
    const rows = powerFleetRows(latest);
    renderTable("power-fleet-table", POWER_FLEET_COLUMNS, rows,
        rows.length ? undefined
            : gate === "uncollected" ? POWER_ABSENCE.uncollected
            : gate === "off" ? POWER_ABSENCE.off
            : hasThreatDetail(latest) ? POWER_ABSENCE.none
            : POWER_ABSENCE.unknown);
}

// Measuring outranks the ratio: a young window has booked the spawn and lab
// spend but usually not the delivery yet, so any ratio there is noise.
function ledgerRatioCell(row) {
    if (row.energyPerPower == null) {
        return naCell("no power yet", `${fmtInt.format(row.e)} energy spent and no power delivered home within the window`);
    }
    const ratio = fmtRate.format(row.energyPerPower);
    if (!row.mature) {
        return naCell("measuring",
            `${ratio} energy per power so far, but only ${fmtInt.format(row.w)} of ${fmtInt.format(LEDGER_MATURE_TICKS)} ticks are covered`);
    }
    const td = textCell(ratio);
    td.title = `${fmtInt.format(row.e)} energy out ÷ ${fmtInt.format(row.p)} power in over ${fmtInt.format(row.w)} ticks`;
    return td;
}

function ledgerAmountCell(total, rate, unit, w) {
    const td = textCell(compact(total));
    td.title = `${fmtInt.format(total)} ${unit} over ${fmtInt.format(w)} ticks · ${fmtRate.format(rate)} /tick`;
    return td;
}

function ledgerBoostsCell(row) {
    if (!row.compounds.length) return naCell("none", "no boost compound consumed by power ops within the window");
    const chips = row.compounds.map(([compound, units]) => {
        const badge = makeBadge(cssVar("--text-muted"), `${compound} ${compact(units)}`);
        badge.title = `${fmtInt.format(units)} ${compound} consumed boosting power-op creeps`;
        return badge;
    });
    return chipsCell(chips, row.compounds.map(([c, u]) => `${c} ${fmtInt.format(u)}`).join(" · "));
}

function ledgerWindowCell(row, msPerTick) {
    const td = textCell(msPerTick != null ? fmtDuration(row.w * msPerTick) : `${fmtInt.format(row.w)} ticks`);
    td.title = `${fmtInt.format(row.w)} ticks`;
    return td;
}

function ledgerColumns(msPerTick) {
    return [
        { key: "home", label: "Home", primary: true, cell: r => roomLinkCell(r.home) },
        { key: "power", label: "Power in",
          hint: "power the home's power haulers handed over at home",
          cell: r => ledgerAmountCell(r.p, r.powerRate, "power", r.w) },
        { key: "energy", label: "Energy out",
          hint: "energy spent on power ops: spawn cost of power-bank squads and haulers, plus lab boost energy",
          cell: r => ledgerAmountCell(r.e, r.energyRate, "energy", r.w) },
        { key: "ratio", label: "Energy / power",
          hint: "energy out per unit of power in. “measuring” = the home has not been booked for a full window yet; spend is booked at spawn, power on delivery",
          cell: ledgerRatioCell },
        { key: "boosts", label: "Boosts",
          hint: "boost compound units consumed by power-op creeps within the window",
          cell: ledgerBoostsCell },
        { key: "window", label: "Window", tier: 3,
          hint: "how much game time the sums cover; a home booked recently covers less than the full ring",
          cell: r => ledgerWindowCell(r, msPerTick) },
    ];
}

export function renderPowerLedgerTable() {
    const { rows, absent } = powerLedgerRows(latest);
    const empty = absent === "unknown"
        ? { text: "unknown", why: "power ledger dropped from this snapshot (payload degradation)" }
        : { text: "no power op booked yet", why: "no power squad or hauler has spawned and no power has been delivered within the ledger window" };
    renderTable("power-ledger-table", ledgerColumns(observedMsPerTick(history)), rows, empty);
}
