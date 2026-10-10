// Threat board at the top of the overview.
import {
    armyOperations, cmpRoom, compact, defenderSummary, empireVerdict, fmtHits, isCriticalZone, quietRooms,
    REMOTE_STALE_AGE_TICKS, remoteDeployPhase, routeOrAbsence, routeStatusText, SIEGE_VERDICT,
    siegeDetailText, siegeVerdictFor, threatItems, verdictInfo, watchItems, worstTone, zoneTarget,
} from "../calc.js";
import { $, cssVar, fmtInt } from "../dom.js";
import { latest } from "../state.js";
import { DEF_STATE_EXPLAIN, pluralCount, shortfallClass, ZONE_ABSENT } from "../ui/cells-defense.js";
import { nukeLandingText, zoneState } from "../ui/cells-nuker.js";
import { ticksText, toneClass } from "../ui/format.js";
import { makeBadge, roomNameLink } from "../ui/links.js";

// The page's answer to "is anything on fire?", above everything else so a
// phone glance never has to scroll for it. Only non-clear rooms and armed
// strongholds get a card, worst first (see threatItems); the clear rooms
// collapse to one line. calc.js owns the judgment, this owns the wording.

const VERDICT_TONE = {
    // Above every posture, `spawnless` included: a scheduled, unavoidable hit
    // is the single most decision-relevant fact about a room when true.
    nuked:      { color: "--status-critical", headline: "NUKE INCOMING" },
    // Above every remaining posture: a colony that cannot rebuild lost creeps
    // is worse off than one merely losing the current fight.
    spawnless:  { color: "--status-critical", headline: "NO SPAWN" },
    outgunned:  { color: "--status-critical", headline: "OUTGUNNED" },
    exposed:    { color: "--status-critical", headline: "EXPOSED" },
    engaged:    { color: "--status-warning",  headline: "ENGAGED" },
    stronghold: { color: "--status-serious",  headline: "STRONGHOLD NEARBY" },
    unknown:    { color: "--text-muted",      headline: "UNKNOWN" },
    clear:      { color: "--status-good",     headline: "ALL CLEAR" },
};

const THREAT_KIND_LABEL = {
    nuked: "nuke incoming",
    spawnless: "no spawn",
    outgunned: "outgunned",
    exposed: "exposed",
    engaged: "engaged",
    stronghold: "armed stronghold",
    unknown: "unknown",
};

// `quiet` and `watched` are the counts of quietRooms and watchItems — the
// clear rooms split the same way the lines below the board split them, so
// the subtitle can't disagree with them.
function verdictSubtitle(v, { quiet, watched }) {
    const parts = [];
    if (v.counts.nuked) parts.push(`${pluralCount(v.counts.nuked, "room")} facing an incoming nuke`);
    if (v.counts.spawnless) parts.push(`${pluralCount(v.counts.spawnless, "room")} with no spawn`);
    if (v.counts.outgunned) parts.push(`${v.counts.outgunned} outgunned`);
    if (v.counts.exposed) parts.push(`${v.counts.exposed} exposed`);
    if (v.counts.engaged) parts.push(`${v.counts.engaged} engaged`);
    if (v.strongholds) parts.push(pluralCount(v.strongholds, "armed stronghold"));
    if (v.counts.unknown) parts.push(`${pluralCount(v.counts.unknown, "room")} unknown`);
    // Nothing else to say: the clear count carries its own noun.
    if (quiet || (!parts.length && !watched)) parts.push(parts.length ? `${quiet} clear` : `${pluralCount(quiet, "room")} clear`);
    if (watched) parts.push(`${watched} to watch`);
    return parts.join(" · ");
}

// One label/value line inside a threat card.
function boardRow(label, value, cls) {
    const row = document.createElement("div");
    row.className = "board-row";
    const k = document.createElement("span");
    k.className = "board-key";
    k.textContent = label;
    const val = document.createElement("span");
    if (cls) val.className = cls;
    val.append(value);
    row.append(k, val);
    return row;
}

function threatCardHead(item) {
    const head = document.createElement("div");
    head.className = "board-head";
    head.append(roomNameLink(item.room));
    const tone = item.kind === "engaged" ? "--status-warning"
        : item.kind === "unknown" ? "--text-muted"
        : item.kind === "stronghold" ? "--status-serious"
        : "--status-critical";
    head.append(makeBadge(cssVar(tone), THREAT_KIND_LABEL[item.kind]));
    return head;
}

function roomThreatCard(item) {
    const card = document.createElement("article");
    card.className = "board-card";
    card.append(threatCardHead(item));

    if (item.spawnless) {
        card.append(boardRow("Spawns", "none — colony cannot rebuild lost creeps until a new spawn is built", "critical"));
    }
    // Nuke rows come before the `!thr` early return below — an incoming nuke
    // doesn't depend on threat detail, so it must still show on a degraded
    // snapshot that has dropped `thr` entirely.
    for (const [ticksToLand, launchRoom, x, y] of item.nukes ?? []) {
        card.append(boardRow("Nuke", nukeLandingText(ticksToLand, launchRoom, x, y), "critical"));
    }

    const thr = item.thr;
    if (!thr) {
        // The distinction the whole payload doctrine exists to protect: this is
        // silence, not safety.
        card.append(boardRow("Why", "threat detail was dropped from this snapshot — not an all-clear", "na"));
        return card;
    }

    const who = [thr.owners?.join(", "), (thr.boosted ?? 0) > 0 ? "⚡ boosted parts" : null].filter(Boolean).join(" · ");
    card.append(boardRow("Hostiles", `${thr.h}${who ? ` · ${who}` : ""}`));
    card.append(boardRow("Damage",
        `${fmtInt.format((thr.melee ?? 0) + (thr.ranged ?? 0))}/t in · towers net ${fmtInt.format(item.net)}/t`,
        item.net < 0 ? "critical" : undefined));
    if (item.net < 0) {
        card.append(boardRow("Warning", "hostile healing beats your tower dps — towers alone cannot break this", "critical"));
    }
    if (item.posture.reasons.length) {
        card.append(boardRow("Exposed by", item.posture.reasons.join(" · "), "serious"));
    }
    card.append(boardRow("Safe mode",
        thr.sm !== undefined ? `active, ${compact(thr.sm)} ticks left`
            : thr.smAvail > 0 ? `${pluralCount(thr.smAvail, "charge")} ready`
            : "no charge available",
        thr.sm === undefined && thr.smAvail === 0 ? "critical" : undefined));
    card.append(boardRow("Defender zone",
        thr.defRmp != null
            ? `${fmtHits(thr.defRmp)} of ${fmtHits(zoneTarget(item.rcl.l))} target at RCL ${item.rcl.l}`
            : ZONE_ABSENT.why,
        thr.defRmp == null ? "na" : isCriticalZone(thr.defRmp) ? "critical" : undefined));
    const def = defenderSummary(thr, item.roles);
    card.append(boardRow("Defenders",
        def.des ? `${def.cur} of ${def.des} fielded` : DEF_STATE_EXPLAIN[def.state] ?? def.state,
        def.des && def.cur < def.des ? shortfallClass(def.cur, def.des) : undefined));
    // What this home has out while it is itself under threat: spawn capacity
    // and bodies committed elsewhere, each named by the planner's verdict or,
    // with none (manual squads, an empty cache), by where the squad stands.
    // The full rows are in the Army section.
    const ops = armyOperations(latest).filter(op =>
        (op.home === item.room && (op.route || op.verdict)) || op.gaveUp.includes(item.room));
    if (ops.length) {
        const tones = [
            ...ops.filter(op => op.verdict).map(op => op.verdict.tone),
            ...(ops.some(op => op.route?.dead > 0) ? ["critical"] : []),
        ];
        card.append(boardRow("Operations", ops.map(op => {
            if (op.home !== item.room) return `→ ${op.target}: gave up (${op.verdict.word})`;
            if (op.verdict) return `→ ${op.target}: ${op.verdict.word}`;
            return `→ ${op.target}: ${op.kind === "manual" ? "manual · " : ""}${op.route.phase}`;
        }).join(" · "), toneClass(worstTone(tones))));
    }
    return card;
}

// The home room's answer to a remote threat, from `ar`. A missing route is
// "none" only when the snapshot kept its first-step detail — the same rule
// the remote table's empty state follows.
function responseRow(entry) {
    if (!entry.home) return null;
    const resolved = routeOrAbsence(latest, entry.home, entry.room);
    if (resolved.route) {
        return boardRow("Response", routeStatusText(resolved.route), resolved.route.dead > 0 ? "critical" : undefined);
    }
    return boardRow("Response",
        resolved.absent === "none" ? "no squad planned" : "unknown — army detail dropped from this snapshot", "na");
}

function strongholdCard(item) {
    const { entry } = item;
    const card = document.createElement("article");
    card.className = "board-card";
    card.append(threatCardHead(item));
    card.append(boardRow("Core", `level ${entry.coreLvl}${entry.core != null ? ` · ${fmtHits(entry.core)} hits` : ""}`,
        "critical"));
    const deploy = remoteDeployPhase(entry.exp, latest.tick);
    if (deploy) {
        card.append(boardRow(deploy.phase === "deploys" ? "Deploys in" : "Expires in", ticksText(deploy.ticks),
            deploy.phase === "deploys" ? undefined : "critical"));
    }
    if (entry.home) card.append(boardRow("Threatens", `${entry.home}'s remote mining`));
    const response = responseRow(entry);
    if (response) card.append(response);
    const sv = entry.home ? siegeVerdictFor(latest, entry.home, entry.room) : null;
    if (sv) {
        const info = verdictInfo(SIEGE_VERDICT, sv.k);
        const detail = siegeDetailText(sv);
        card.append(boardRow("Siege", detail ? `${info.word} — ${detail}` : info.word, toneClass(info.tone)));
    }
    card.append(boardRow("Hostiles",
        entry.mem ? "unknown — no vision" : `${entry.h}${entry.owners?.length ? ` · ${entry.owners.join(", ")}` : ""}`,
        entry.mem ? "na" : undefined));
    // Promoted out of a tooltip: past the cache TTL, or carried from the bot's
    // persisted memory, this row is a belief rather than a reading.
    const stale = entry.mem || entry.age > REMOTE_STALE_AGE_TICKS;
    card.append(boardRow("Last seen",
        stale ? `believed present — no vision for ~${fmtInt.format(entry.age)} ticks` : `${fmtInt.format(entry.age)} ticks ago`,
        stale ? "na" : undefined));
    card.append(boardRow("Care", "never send an unescorted melee creep at an armed stronghold"));
    return card;
}

export function renderThreatBoard() {
    const v = empireVerdict(latest);
    // When the whole payload was degraded, every room is `unknown` for the same
    // single reason and the banner has already given it — one card per room
    // would just be the same sentence N times. Name the rooms on one line
    // instead. A PARTIALLY covered snapshot is different: there, an uncovered
    // room really is its own finding and keeps its card. `spawnless`/nuked
    // rooms are kept even here — both are structural or scheduled facts off
    // fields that are never dropped by payload-size degradation, not a "same
    // sentence N times" case (a nuke's ETA/launch room differs room to room),
    // and they're exactly the kind of chaos that makes a big payload (and
    // degradation) likely.
    const items = v.degraded
        ? threatItems(latest).filter(i => i.scope === "remote" || i.spawnless || i.nukes.length)
        : threatItems(latest);

    // A degraded payload leads with that, never with a colour that reads calm.
    const tone = v.degraded ? { color: "--status-warning", headline: "NO THREAT DATA" } : VERDICT_TONE[v.level];
    const head = $("verdict");
    head.style.setProperty("--verdict-color", cssVar(tone.color));
    const title = document.createElement("strong");
    title.className = "verdict-title";
    title.textContent = tone.headline;
    // Computed once and shared by the subtitle, the watch line and the clear
    // line. A degraded payload has no clear rooms, so both are empty there.
    const watch = v.degraded ? [] : watchItems(latest);
    const quiet = v.degraded ? [] : quietRooms(latest);
    const sub = document.createElement("span");
    sub.className = "verdict-sub";
    sub.textContent = v.degraded
        ? "this snapshot had its threat detail dropped (payload degradation) — the board below is not an all-clear"
        : verdictSubtitle(v, { quiet: quiet.length, watched: watch.length });
    head.replaceChildren(title, sub);
    renderWatchLine(watch);

    $("threat-list").replaceChildren(
        ...items.map(item => item.scope === "remote" ? strongholdCard(item) : roomThreatCard(item)));

    if (v.degraded) {
        $("clear-line").textContent =
            `${pluralCount(v.rooms, "room")} owned, none covered by this snapshot · `
            + Object.keys(latest.rooms).sort(cmpRoom).join(" ");
        return;
    }
    // A watch room is named on the watch line instead, so no room is listed twice.
    $("clear-line").textContent = quiet.length
        ? `${pluralCount(quiet.length, "room")} clear · ${quiet.join(" ")}`
        : "";
}

// One line, not cards: nothing here is an emergency, and a card would read
// as one. Each room links to its view, where the zone tile and chart are.
function renderWatchLine(watch) {
    const line = $("watch-line");
    line.hidden = watch.length === 0;
    if (!watch.length) { line.replaceChildren(); return; }
    const label = document.createElement("strong");
    label.textContent = "Watch";
    const parts = [label];
    for (const w of watch) {
        const zone = zoneState(w.room);
        const trend = zone.shrinking ? `, shrinking ${compact(zone.rate)}/tick` : "";
        parts.push(" · ", roomNameLink(w.room), ` defender zone ${fmtHits(w.hits)}${trend}`);
    }
    line.replaceChildren(...parts);
}
