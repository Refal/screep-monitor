// Army section.
import { armyOperations, armySummary, hasThreatDetail, operationRank, routeStatusText } from "../calc.js";
import { cssVar } from "../dom.js";
import { latest, route } from "../state.js";
import { ARMY_DEGRADED_TITLE, routeDetailTitle, SAMPLED_NOTE, ticksText, TONE_COLOR } from "../ui/format.js";
import { makeBadge, roomLinkCell } from "../ui/links.js";
import { naCell, renderTable, textCell } from "../ui/table.js";
import { renderTileRow } from "../ui/tiles.js";

// `ar` rides the bot's first degradation step while `dv`/`sv` never degrade,
// so a verdict row can outlive its squads' detail — "none sent" there would
// be a guess.
const armyDetailDropped = () => !latest.ar && !hasThreatDetail(latest);

const VERDICT_ABSENT_WHY = "the planners only decide remotes a home plans and sieges it can run, and their cache is heap state that empties on a global reset";

function verdictBadgeCell(op) {
    if (!op.verdict) {
        return op.kind === "manual"
            ? naCell("manual", "launched by hand from the console — no planner verdict applies")
            : naCell("no cached verdict", VERDICT_ABSENT_WHY);
    }
    const td = document.createElement("td");
    td.append(makeBadge(cssVar(TONE_COLOR[op.verdict.tone] ?? TONE_COLOR.na),
        op.detail ? `${op.verdict.word} · ${op.detail}` : op.verdict.word));
    td.title = `${op.verdict.explain} — ${SAMPLED_NOTE}`;
    return td;
}

function opHomeCell(op) {
    const gaveUp = op.gaveUp.length ? `gave up: ${op.gaveUp.join(", ")}` : null;
    const why = "homes that already gave up on this threat; the list resets when the threat changes";
    if (!op.home) {
        if (gaveUp) return naCell(gaveUp, why);
        return armyDetailDropped() ? naCell("unknown", ARMY_DEGRADED_TITLE) : naCell("nobody", "no home has a squad aimed at this room");
    }
    const td = roomLinkCell(op.home);
    if (gaveUp) {
        const note = document.createElement("div");
        note.className = "cell-note";
        note.textContent = gaveUp;
        note.title = why;
        td.append(note);
    }
    return td;
}

function opSquadsCell(op) {
    const r = op.route;
    if (!r) {
        return armyDetailDropped() ? naCell("unknown", ARMY_DEGRADED_TITLE)
            : naCell("none sent", "no squad is aimed at this room in the bot's army records");
    }
    const td = textCell(routeStatusText(r), r.dead > 0 ? "critical" : undefined);
    td.title = routeDetailTitle(r);
    return td;
}

const NEXT_LABEL = { "awaiting-deploy": "deploys in", "boost-missing": "recheck in", undefendable: "retry in" };

function opNextCell(op) {
    if (op.retryIn == null) return naCell("—", "no countdown on this verdict");
    const label = NEXT_LABEL[op.code] ?? "next in";
    return textCell(op.retryIn > 0 ? `${label} ${ticksText(op.retryIn)}` : `${label.split(" ")[0]} due`);
}

function opWhereCell(op) {
    const r = op.route;
    if (!r) return naCell("—", "no squad to place");
    return textCell(`${r.atHome} home · ${r.atTarget} in room · ${r.inTransit} en route`);
}

const ARMY_COLUMNS = [
    { key: "target", label: "Target", primary: true, sort: op => op.target, cell: op => roomLinkCell(op.target) },
    { key: "home", label: "Home", hint: "the colony that fields the squad; for a defense nobody took, the homes that gave up",
      sort: op => op.home ?? op.gaveUp[0], cell: opHomeCell },
    { key: "kind", label: "Kind",
      hint: "defense — a squad protecting a room; siege — an attack on an invader core or stronghold; manual — launched by hand",
      sort: op => op.kind, cell: op => textCell(op.kind) },
    { key: "verdict", label: "Verdict",
      hint: `the planner's latest decision: covered / holding / undefendable for defense, the committed objective or the reason it is holding for a siege. It is the planner's cache, ${SAMPLED_NOTE}`,
      // Same urgency the default order uses, so ▲ is "most urgent first".
      sort: operationRank, cell: verdictBadgeCell },
    { key: "squads", label: "Squads",
      hint: "forming at home, staging, in transit, or deployed in the target room. Engaged squads never respawn, so “lost” is permanent",
      cell: opSquadsCell },
    { key: "next", label: "Next", hint: "when the planner looks again: an undefendable retry, a core activation, a boost recheck",
      sort: op => op.retryIn, cell: opNextCell },
    { key: "where", label: "Where", tier: 3, hint: "alive members at home / in the target room / on the way", cell: opWhereCell },
];

export function renderArmyTiles() {
    const s = armySummary(latest);
    const dropped = armyDetailDropped();
    const tiles = [
        {
            label: "Undefendable", value: String(s.undefendable.length),
            delta: s.undefendable.length ? s.undefendable.join(" ") : "none",
            tone: s.undefendable.length ? "critical" : undefined,
        },
        {
            label: "Holding the line", value: String(s.holding.length),
            delta: s.holding.length ? s.holding.join(" ") : "none",
            tone: s.holding.length ? "short" : undefined,
        },
        dropped
            ? { label: "Squad members alive", value: "—", delta: "unknown — army detail dropped" }
            : {
                label: "Squad members alive", value: `${s.alive} / ${s.total}`,
                delta: s.lost ? `${s.lost} lost` : "no losses", tone: s.lost ? "serious" : undefined,
            },
        { label: "Sieges", value: `${s.siegeCommitted} committed`, delta: `${s.siegeHolding} holding` },
        { label: "Power squads", value: dropped ? "—" : String(s.powerSquads), delta: dropped ? "unknown — army detail dropped" : "shown in Power" },
    ];
    renderTileRow("army-tiles", tiles);
}

export function renderArmyTable() {
    const ops = armyOperations(latest);
    let empty;
    if (armyDetailDropped()) empty = { text: "unknown", why: ARMY_DEGRADED_TITLE };
    else empty = { text: "no army operations", why: `no squads out and no cached verdicts — ${VERDICT_ABSENT_WHY}` };
    renderTable("army-table", ARMY_COLUMNS, ops, empty);
}
