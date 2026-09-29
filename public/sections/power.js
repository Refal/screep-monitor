// Power harvesting section.
import {
    bankContest, bankEta, bankPlans, bankStale, compact, fmtHits, hasThreatDetail, haulerSummary,
    powerBanksOrAbsence, powerFleetRows, powerGateState, powerStockPoint, roomUrl,
} from "../calc.js";
import { cssVar, fmtInt } from "../dom.js";
import { latest, route } from "../state.js";
import { pluralCount } from "../ui/cells-defense.js";
import { chipsCell } from "../ui/cells-labs.js";
import { SAMPLED_NOTE, ticksText } from "../ui/format.js";
import { makeBadge, roomLink } from "../ui/links.js";
import { naCell, renderTable, textCell } from "../ui/table.js";
import { renderTileRow } from "../ui/tiles.js";

// The dashboard's version of the bot's debugPowerBanks() console command:
// autoHarvest gate, every live bank with the planner's cached decision per
// home and the haulers already on it, then one row per squad plus the
// loot-leg haulers whose bank record is already gone. calc.js owns the readings; this owns the
// wording and the absence branches.

const POWER_ABSENCE = {
    // Four distinct empty states, and collapsing any two of them would lie.
    off: {
        text: "power harvesting is switched off",
        why: "the bot's autoHarvest gate is off — no bank is evaluated at all, so an empty list here says nothing about what is out there",
    },
    none: {
        text: "no live power banks",
        why: "this snapshot kept its detail and the bot's highway intel held no live bank",
    },
    unknown: {
        text: "no power detail in this snapshot (payload degradation)",
        why: "power-bank detail is dropped in the same degradation step as threat/army detail — this is not “no banks”",
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
// calm zero here — "0 banks, no haulers out" is precisely the reading that
// would be wrong, and for the same reason renderRemoteTiles shows "unknown"
// rather than 0. Only `pw` (never degraded) keeps its number in that state.
export function renderPowerTiles() {
    const { banks = [], gate, absent } = powerBanksOrAbsence(latest);
    const blind = absent === "unknown" || absent === "uncollected";
    const haulers = [...banks.map(b => b.hl), ...(latest.ph ?? []).map(h => h.hl)]
        .map(haulerSummary).filter(Boolean);
    const haulerCount = haulers.reduce((a, h) => a + h.count, 0);
    const carrying = haulers.reduce((a, h) => a + h.carrying, 0);
    const committed = banks.filter(b => bankPlans(b).some(p => p.kind === "committed")).length;
    const stockPoint = powerStockPoint(latest);
    const processing = stockPoint?.processing ?? 0;
    renderTileRow("power-tiles", [
        { label: "Harvesting", ...GATE_TILE[gate] },
        {
            label: "Live banks",
            value: blind ? "unknown" : String(banks.length),
            delta: blind ? POWER_ABSENCE[absent].text
                : banks.length ? `${committed} committed`
                : POWER_ABSENCE[absent ?? "none"].text,
            sub: banks.length ? `${fmtInt.format(banks.reduce((a, b) => a + b.p, 0))} power on the map` : undefined,
        },
        {
            label: "Haulers out",
            value: blind ? "unknown" : String(haulerCount),
            delta: blind ? POWER_ABSENCE[absent].text
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

// A bank room is a highway room, never owned, so roomLinkCell would always
// take the screeps.com branch — spelled out here so the title can say why.
function bankRoomCell(bank) {
    const td = document.createElement("td");
    td.append(roomLink({ href: roomUrl(bank.rm), text: bank.rm, title: `${bank.rm} is a highway room — open it on screeps.com` }));
    return td;
}

function bankPowerCell(bank) {
    return textCell(fmtInt.format(bank.p));
}

// Hits plus who gets there first. `dps` is 0 for every bank we have not
// committed to, which is the normal state, so "nobody swinging" is a word
// rather than an em dash or an infinite ETA.
function bankHitsCell(bank) {
    const { killIn, decaysFirst, decayIn } = bankEta(bank);
    const td = document.createElement("td");
    td.textContent = fmtHits(bank.hits);
    if (killIn == null) {
        td.title = `${fmtInt.format(bank.hits)} hits · nothing of ours is attacking it`;
        return td;
    }
    td.append(" ", makeBadge(cssVar(decaysFirst ? "--status-warning" : "--status-good"), `${compact(killIn)}t`));
    td.title = `${fmtInt.format(bank.hits)} hits at ${fmtInt.format(bank.dps)} dps · `
        + (decaysFirst ? `decays in ${fmtInt.format(decayIn)}t first` : `dead ~${fmtInt.format(killIn)}t before it decays`);
    return td;
}

function bankDecayCell(bank) {
    const td = textCell(`${compact(bank.dec)}t`);
    td.title = `${fmtInt.format(bank.dec)} ticks until the bank decays on its own`;
    return td;
}

// Free adjacent tiles cap how many attackers can swing at once, which caps our
// dps — the single number that decides whether a bank is worth a squad.
function bankTilesCell(bank) {
    const td = textCell(String(bank.ft), bank.ft <= 1 ? "short" : undefined);
    td.title = `${bank.ft} free tile${bank.ft === 1 ? "" : "s"} around the bank — caps how many attackers can hit it at once`;
    return td;
}

function bankContestCell(bank) {
    const contest = bankContest(bank);
    if (!contest) return naCell("clear", "no contestant sightings on this bank");
    const td = document.createElement("td");
    td.append(makeBadge(cssVar("--status-warning"), pluralCount(contest.count, "rival")));
    td.title = `${contest.count} contestant sighting${contest.count === 1 ? "" : "s"} · `
        + `${fmtInt.format(contest.dps)} dps · ${fmtInt.format(contest.heal)} heal`;
    return td;
}

function bankDpsCell(bank) {
    if (!bank.dps) return naCell("none", "no attacker of ours is standing in the bank room");
    return textCell(fmtInt.format(bank.dps));
}

function planShapeText(p) {
    if (p.adopted) return "adopted an existing squad — no go plan cached";
    if (!p.plan) return "no go plan in this snapshot";
    const parts = [];
    if (p.pairs != null) parts.push(`${pluralCount(p.pairs, "pair")} per wave × ${pluralCount(p.waves ?? 1, "wave")}`);
    if (p.planBoosted) parts.push("boosted");
    return parts.join(" · ") || "loot run";
}

// Kill and hauler-dispatch ETAs of every cached go plan on this bank.
function bankPlanEtaCell(bank) {
    const plans = bankPlans(bank).filter(p => p.plan);
    if (!plans.length) return naCell("none", "no cached go plan for this bank");
    return textCell(plans.map(p => [
        p.home,
        p.killTickIn != null ? `kill ${ticksText(p.killTickIn)}` : null,
        p.haulIn != null ? `haulers ${ticksText(p.haulIn)}` : null,
    ].filter(Boolean).join(" · ")).join("; "));
}

const PLAN_COLOR = { committed: "--status-good", skip: "--text-muted", retry: "--status-warning" };

// One chip per committed home. Skip and retry verdicts fold into a single
// muted chip: a chip per home in range is what pushed this table past the
// viewport, and "who is going" is the one verdict a reader scans for. Card
// mode still lists every verdict through chipsCell's text. An empty list is
// "not decided yet" (the verdict cache is heap state and empties on a global
// reset), which is a different thing from "no home in range" — neither of
// which may read as a decision the planner actually made.
function bankPlanCell(bank) {
    const plans = bankPlans(bank);
    if (!plans.length) return naCell("undecided", "the planner holds no cached verdict for this bank — its cache is heap state and empties on a global reset");
    const committed = plans.filter(p => p.kind === "committed");
    const others = plans.filter(p => p.kind !== "committed");
    const chips = committed.map(p => {
        const shape = p.pairs != null ? ` · ${p.pairs}×${p.waves ?? 1}` : "";
        const badge = makeBadge(cssVar(PLAN_COLOR.committed), `${p.home} ${p.mode ?? "go"}${shape}${p.planBoosted ? " ⚡" : ""}`);
        badge.title = `${p.home}: ${p.text} · ${planShapeText(p)}`;
        return badge;
    });
    // The last pair recall/release — an event the bot saw, not a state.
    for (const p of plans.filter(x => x.posture)) {
        const badge = makeBadge(cssVar(p.posture.word === "pairs recalled" ? "--status-warning" : "--status-good"),
            `${p.home} ${p.posture.word}`);
        badge.title = `${p.posture.explain} — the last change seen, not necessarily the current state; ${SAMPLED_NOTE}`;
        chips.push(badge);
    }
    if (others.length) {
        // Beside a committed chip "+N other" is enough; alone it would read
        // as "other than what?", so it names what it holds instead.
        const counts = ["skip", "retry"]
            .map(kind => [kind, others.filter(p => p.kind === kind).length])
            .filter(([, n]) => n)
            .map(([kind, n]) => `${n} ${kind}`);
        // planText passes unknown kinds through, so the label must still add up.
        const unknown = others.filter(p => p.kind !== "skip" && p.kind !== "retry").length;
        if (unknown) counts.push(`${unknown} other`);
        // A lone verdict names its reason — "why is nobody going" is the question it answers.
        const lone = !committed.length && others.length === 1 ? others[0] : null;
        const loneWhy = lone ? lone.abandon ?? lone.reason : null;
        const badge = makeBadge(cssVar(PLAN_COLOR.skip),
            committed.length ? `+${others.length} other` : [...counts, ...(loneWhy ? [loneWhy] : [])].join(" · "));
        badge.title = others.map(p => `${p.home}: ${p.text}`).join(" · ");
        chips.push(badge);
    }
    const td = chipsCell(chips, plans.map(p => `${p.home} ${p.text}`).join(" · "));
    // Stacked, not side by side: two committed homes plus the fold chip in a
    // row were the widest thing left in this table.
    td.classList.add("chips-stack");
    return td;
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

// [count, carried power, min ttl]. A min ttl of 0 means every hauler is still
// spawning — printing "0t" there would say the opposite of what it means.
function haulerCell(hl) {
    const h = haulerSummary(hl);
    if (!h) return naCell("none", "no hauler is assigned to this bank yet");
    const td = document.createElement("td");
    td.textContent = h.spawning ? `${h.count} spawning` : `${h.count} · ${compact(h.carrying)}`;
    td.title = haulerDetailText(h);
    return td;
}

function haulerDetailText(h) {
    return `${pluralCount(h.count, "hauler")} · carrying ${fmtInt.format(h.carrying)} power · `
        + (h.spawning ? "all still spawning" : `shortest life left ${fmtInt.format(h.minTtl)}t`);
}

// `age` is intel staleness, not the snapshot's: StatsManager never reads the
// bank room, so hits/power only refresh while something of ours has vision
// there, and a row can outlive the real structure until `dec` runs out.
function bankAgeCell(bank) {
    if (bankStale(bank)) {
        return naCell(`${compact(bank.age)}t`, `last seen ${fmtInt.format(bank.age)} ticks ago — this is a memory of a room gone dark, not a live reading`);
    }
    const td = textCell(`${compact(bank.age)}t`);
    td.title = `hits and power were last refreshed ${fmtInt.format(bank.age)} ticks ago`;
    return td;
}

const POWER_COLUMNS = [
    { key: "room", label: "Bank room", primary: true, cell: bankRoomCell },
    { key: "power", label: "Power", hint: "power the bank drops when it dies", cell: bankPowerCell },
    { key: "hits", label: "Hits",
      hint: "the bank's remaining hits, and how long our own attackers need to break it — blank when nothing of ours is swinging, which is every bank we have not committed to",
      cell: bankHitsCell },
    { key: "decay", label: "Decays in", hint: "ticks until the bank decays on its own, whether or not anyone is hitting it", cell: bankDecayCell },
    { key: "tiles", label: "Free tiles",
      hint: "walkable tiles around the bank — this caps how many attackers can swing at once, and so caps the dps any plan can reach",
      cell: bankTilesCell },
    { key: "contest", label: "Contest",
      hint: "other players sighted racing or fighting us for this bank, with their summed damage and heal",
      cell: bankContestCell },
    { key: "dps", label: "Our dps", tier: 3, hint: "summed attack damage per tick of our creeps standing in the bank room", cell: bankDpsCell },
    { key: "plan", label: "Committed",
      hint: "homes the planner has committed to this bank, with the mode (loot, fight, race); skip and retry verdicts from other homes fold into one muted chip. It is the planner's cache, not a fresh evaluation, and is empty after a global reset. The squads themselves are in the table below",
      cell: bankPlanCell },
    { key: "planEta", label: "Plan ETA", tier: 3,
      hint: "from each committed home's go plan: when the bank should break and when haulers leave home; a loot run carries only the hauler dispatch",
      cell: bankPlanEtaCell },
    { key: "haulers", label: "Haulers", cell: b => haulerCell(b.hl),
      hint: "haulers assigned to this bank, and the power they are already carrying; “spawning” means none has left home yet" },
    { key: "age", label: "Last seen", tier: 3,
      hint: "how stale the hits and power readings are — the bot only refreshes them while something of ours has vision in the bank room",
      cell: bankAgeCell },
];

export function renderPowerTable() {
    const { banks, absent } = powerBanksOrAbsence(latest);
    renderTable("power-table", POWER_COLUMNS,
        [...(banks ?? [])].sort((a, b) => a.rm.localeCompare(b.rm)),
        absent ? POWER_ABSENCE[absent] : undefined);
}

function fleetRoomCell(row) {
    const td = document.createElement("td");
    td.append(roomLink({ href: roomUrl(row.rm), text: row.rm, title: `${row.rm} is a highway room — open it on screeps.com` }));
    if (!row.live) {
        const badge = makeBadge(cssVar("--text-muted"), "gone");
        badge.title = "our kill deleted the bank's intel record; these haulers are still loading or on the way home";
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

// `sq` carries only the wave number and the fight flag; status comes from the
// join back to `ar`. A miss there is normal, so it says so rather than
// inventing a phase.
function fleetStatusCell(row) {
    if (row.kind === "haulers") {
        const h = haulerSummary(row.hl);
        if (!h) return naCell("none", "no hauler count in this snapshot");
        return textCell(`${h.count} ${h.spawning ? "spawning" : "hauling"}`);
    }
    if (!row.squad) return naCell("no army record", "no army record for this squad in this snapshot — the two are built from different sources within one tick");
    return textCell(row.status);
}

function fleetDetailCell(row) {
    if (row.kind === "haulers") {
        const h = haulerSummary(row.hl);
        return h ? textCell(haulerDetailText(h)) : naCell("none");
    }
    return row.squad ? textCell(squadDetailText(row.squad)) : naCell("unknown", "no army record to read positions or losses from");
}

const POWER_FLEET_COLUMNS = [
    { key: "room", label: "Bank room", primary: true, cell: fleetRoomCell },
    { key: "home", label: "Home",
      hint: "the home room that fielded the squad; hauler counts are published per bank, not per home",
      cell: r => r.kind === "squad" ? textCell(r.home) : naCell("per bank", "hauler counts are published per bank, not per home") },
    { key: "unit", label: "Unit",
      hint: "w<n> is a harvest wave, fight is its fight squad; haulers are the loot leg of a bank that is already gone",
      cell: fleetUnitCell },
    { key: "status", label: "Status",
      hint: "the squad's own status from the bot's army records (not its route's); for haulers, how many are out and whether they have left home yet",
      cell: fleetStatusCell },
    { key: "detail", label: "Detail", tier: 3,
      hint: "where the squad's members are, and how many are lost for good (engaged squads never respawn); for haulers, the power they carry and the shortest life left",
      cell: fleetDetailCell },
];

// One row per unit of ours, so four squads on one bank become four short rows
// here rather than one ever-wider cell in the bank table. It also carries the
// haulers of banks that are already gone: our own kill deletes the intel
// record exactly while they are loading, so without `ph` the loot leg home
// would vanish from the payload mid-trip.
export function renderPowerFleetTable() {
    const gate = powerGateState(latest);
    const rows = powerFleetRows(latest);
    renderTable("power-fleet-table", POWER_FLEET_COLUMNS, rows,
        rows.length ? undefined
            : gate === "uncollected" ? POWER_ABSENCE.uncollected
            : hasThreatDetail(latest)
                ? { text: "no squads out", why: "no harvest wave or fight squad is assigned to a live bank, and no hauler is carrying loot from a bank that is gone" }
                : POWER_ABSENCE.unknown);
}
