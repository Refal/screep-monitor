// Remote threats section and remote-threat log.
import {
    compact, fmtDuration, fmtHits, hasThreatDetail, MAX_REMOTE_THREATS, observedMsPerTick,
    REMOTE_STALE_AGE_TICKS, remoteDeployPhase, remoteEpisodes, remoteThreatClass, routeOrAbsence,
    routeStatusText, sortRemoteThreats,
} from "../calc.js";
import { ATTACK_LOG_MAX_ROWS } from "../constants.js";
import { $, cssVar, fmtInt } from "../dom.js";
import { history, latest } from "../state.js";
import {
    ARMY_DEGRADED_TITLE, episodeTicksCell, REMOTE_DEGRADED_TITLE, routeDetailTitle,
} from "../ui/format.js";
import { makeBadge, roomLinkCell } from "../ui/links.js";
import { naCell, renderTable, textCell } from "../ui/table.js";
import { renderTileRow } from "../ui/tiles.js";

// `rt` lists hostiles cached in NON-owned rooms, so none of the owned-room
// defense cells (ui/cells-defense.js) apply: there are no towers, no ramparts and no safe
// mode to report. It rides the same first degradation step as `thr`, so the
// same doctrine holds — but with one extra wrinkle the owned-room cells don't
// have: the bot OMITS `rt` when the list is empty, so absence alone is
// ambiguous. hasThreatDetail() is what separates "nothing cached" from
// "degraded away"; see its comment in calc.js.

// Same visual ordering as REMOTE_CLASS_RANK, and honest about magnitude: a
// level-0 reserving core is real information but not an alarm, so it gets ink
// rather than a status colour.
const REMOTE_CLASS_COLOR = {
    stronghold: "--status-critical",
    hostiles: "--status-warning",
    core: "--text-secondary",
    keepers: "--text-muted",
};

const REMOTE_CLASS_TITLE = {
    stronghold: "armed stronghold — never send an unescorted melee creep at it",
    hostiles: "non-Keeper hostiles cached in this room",
    core: "level-0 reserving core — harmless, the bot keeps farming next to it",
    keepers: "Source Keeper guards only — routine for an SK room",
};

const REMOTE_NONE_TITLE = "this snapshot kept its threat detail and listed no remote hostiles";

export function renderRemoteTiles() {
    const rt = latest.rt;
    if (!rt) {
        const known = hasThreatDetail(latest);
        const value = known ? "0" : "unknown";
        const delta = known ? "none cached" : REMOTE_DEGRADED_TITLE;
        renderTileRow("remote-tiles", [
            { label: "Rooms flagged", value, delta },
            { label: "Strongholds", value, delta },
            { label: "Remote hostiles", value, delta },
        ]);
        return;
    }
    // Keeper-only entries are excluded from the headline counts for the same
    // reason remoteEpisodes() excludes them: an SK remote permanently caches
    // its standing guards, so counting them would pin these tiles at a
    // non-zero "threat" the Class column and the activity log both call
    // routine, and a quiet empire would never read 0. They stay in the table
    // and get their own count on the sub line.
    const flagged = rt.filter(e => remoteThreatClass(e) !== "keepers");
    const keeperRooms = rt.length - flagged.length;
    const strongholds = flagged.filter(e => remoteThreatClass(e) === "stronghold").length;
    const hostiles = flagged.reduce((sum, e) => sum + e.h, 0);
    const stale = flagged.filter(e => e.age > REMOTE_STALE_AGE_TICKS).length;
    const holding = flagged.filter(e => e.h > 0).length;
    renderTileRow("remote-tiles", [
        {
            label: "Rooms flagged",
            value: String(flagged.length),
            delta: stale ? `${stale} stale` : "all fresh",
            // the cap applies to the whole published list, keepers included
            sub: [
                rt.length === MAX_REMOTE_THREATS ? "at the payload cap" : null,
                keeperRooms ? `plus ${keeperRooms} SK room${keeperRooms === 1 ? "" : "s"}` : null,
            ].filter(Boolean).join(" · ") || undefined,
        },
        { label: "Strongholds", value: String(strongholds), delta: strongholds ? "armed cores" : "none armed" },
        {
            label: "Remote hostiles", value: fmtInt.format(hostiles),
            delta: `${holding} room${holding === 1 ? "" : "s"} holding creeps`,
        },
    ]);
}

function remoteClassCell(entry) {
    const td = document.createElement("td");
    const cls = remoteThreatClass(entry);
    td.append(makeBadge(cssVar(REMOTE_CLASS_COLOR[cls]), cls));
    td.title = REMOTE_CLASS_TITLE[cls];
    return td;
}

// A corridor sighting has no `home` by design (the hostile cache is keyed by
// room, and an incidental sighting belongs to no colony) — that's an absence
// with a meaning, not a missing value, so it gets a word rather than an em dash.
function remoteHomeCell(home) {
    if (home) return roomLinkCell(home);
    const td = document.createElement("td");
    td.textContent = "corridor";
    td.className = "na";
    td.title = "incidental sighting, not a configured remote";
    return td;
}

// A `mem: 1` row was carried from the bot's persisted Memory, not read from
// its hostile cache, so nobody has looked: h: 0 there means UNKNOWN, and the
// cells must not report it as an observation. See screeps2 docs/stats-history-ring.md.
const NO_VISION_TITLE = "no vision — hostiles unknown, this row is carried from the bot's persisted memory";

function noHostilesTitle(entry) {
    return entry.mem ? NO_VISION_TITLE : "no hostile creeps cached";
}

function remoteRaahCell(entry) {
    if (entry.h === 0) return naCell(entry.mem ? "no vision" : "none", noHostilesTitle(entry));
    const td = document.createElement("td");
    td.textContent = `${fmtInt.format(entry.ranged ?? 0)}/${fmtInt.format(entry.melee ?? 0)}/${fmtInt.format(entry.heal ?? 0)}`;
    td.title = `ranged ${fmtInt.format(entry.ranged ?? 0)}/t · attack ${fmtInt.format(entry.melee ?? 0)}/t`
        + ` · heal ${fmtInt.format(entry.heal ?? 0)}/t`;
    return td;
}

function remoteCoreCell(entry) {
    if (entry.coreLvl === undefined) return naCell("no core", "no invader core seen in this room");
    const td = document.createElement("td");
    td.textContent = `L${entry.coreLvl} · ${fmtHits(entry.core)}`;
    if (entry.coreLvl > 0) td.className = "critical";
    // Hits come from live vision; a dark room has a level but no hit count, and
    // `entry.core ?? 0` would report that unknown as a core sitting at zero.
    const hits = entry.core === undefined ? "hits unknown (no vision)" : `${fmtInt.format(entry.core)} hits`;
    td.title = entry.coreLvl > 0
        ? `armed stronghold, ${hits}`
        : `reserving core, ${hits} — harmless`;
    return td;
}

// Ticks convert to wall clock the same way the safe-mode cooldown cell does
// (thr.smCd * ms fed to fmtDuration, with a raw-ticks fallback when no
// ms-per-tick ratio is available yet). A stale sighting can put `ticks`
// slightly negative — clamped rather than shown as a negative duration.
function remoteDeployCell(entry, msPerTick) {
    if (entry.coreLvl === undefined) return naCell("no core", "no invader core seen in this room");
    const info = remoteDeployPhase(entry.exp, latest.tick);
    if (!info) return naCell("unknown", "core lifecycle timer not tracked for this sighting");
    const ticks = Math.max(0, info.ticks);
    const ms = msPerTick != null ? ticks * msPerTick : null;
    const text = ms != null ? fmtDuration(ms) : `~${compact(ticks)} ticks`;
    const label = info.phase === "deploys" ? `deploys in ${text}` : `expires in ${text}`;
    const td = textCell(label, info.phase === "deploys" ? undefined : "critical");
    td.title = info.phase === "deploys"
        ? "invader core is still vulnerable — killing it now prevents the stronghold"
        : "armed stronghold's own collapse timer";
    return td;
}

// `age` is the bot's own cached age for the sighting, independent of how old
// the snapshot itself is: a fresh snapshot can carry a 2,000-tick-old memory.
// Rendered in wall clock (which is what "is this happening now?" wants) with
// the raw tick count always in the title, since ticks are what the replay
// links speak.
function remoteAgeCell(entry, msPerTick) {
    const age = entry.age;
    const td = document.createElement("td");
    const ms = msPerTick != null ? age * msPerTick : null;
    td.textContent = ms == null ? `${fmtInt.format(age)} ticks`
        : ms < 60000 ? "just now"
        : `~${fmtDuration(ms)} ago`;
    const parts = [`age ${fmtInt.format(age)} ticks`];
    if (age > REMOTE_STALE_AGE_TICKS) {
        td.className = "na";
        // A mem row outliving the cache is by design, not neglect: the bot stands
        // mining down next to a stronghold, so nobody is there to refresh it.
        parts.push(entry.mem
            ? `carried from the bot's persisted memory, so it outlives the ${REMOTE_STALE_AGE_TICKS}-tick hostile cache — the stronghold is still believed to be there, but nobody has eyes on it`
            : `past the bot's ${REMOTE_STALE_AGE_TICKS}-tick hostile cache — a memory of a room that has gone dark, not a live reading`);
    }
    td.title = parts.join(" · ");
    return td;
}

function remoteHostilesCell(entry) {
    // h: 0 on a row carried from persisted memory means UNKNOWN, not empty —
    // nobody has eyes on the room. That has to read as a word, not as a zero.
    if (entry.h === 0) return naCell(entry.mem ? "no vision" : "none cached", noHostilesTitle(entry));
    const td = document.createElement("td");
    td.textContent = String(entry.h);
    if (entry.owners?.length) td.title = entry.owners.join(", ");
    return td;
}

// Joined from `ar` by (home, room). A corridor sighting has no home, so no
// room could answer it — an absence with a meaning, worded as such.
function remoteResponseCell(entry) {
    if (!entry.home) return naCell("n/a", "corridor sighting — no home room answers it");
    const resolved = routeOrAbsence(latest, entry.home, entry.room);
    if (!resolved.route) {
        return resolved.absent === "none"
            ? naCell("none", "no squad planned for this room in the bot's army records")
            : naCell("unknown", ARMY_DEGRADED_TITLE);
    }
    const td = textCell(routeStatusText(resolved.route), resolved.route.dead > 0 ? "critical" : undefined);
    td.title = routeDetailTitle(resolved.route);
    return td;
}

function remoteColumns(msPerTick) {
    return [
        { key: "room", label: "Room", primary: true, cell: e => roomLinkCell(e.room) },
        { key: "class", label: "Class",
          hint: "how actionable this is, using the bot's own ranking: armed stronghold, then any non-Keeper hostile, then a level-0 core, then Keepers only",
          cell: remoteClassCell },
        { key: "home", label: "Home",
          hint: "home room farming this remote; “corridor” means an incidental sighting that belongs to no home",
          cell: e => remoteHomeCell(e.home) },
        { key: "response", label: "Response",
          hint: "squads the home room has fielded for this room, from the bot's army records: forming = still spawning at home, deployed = alive members in the room. Engaged squads never respawn, so “lost” is permanent",
          cell: remoteResponseCell },
        { key: "hostiles", label: "Hostiles", cell: remoteHostilesCell },
        { key: "dmgIn", label: "RA/A/H", hint: "hostile ranged / attack (melee) / heal damage per tick, boosts folded in",
          cell: remoteRaahCell },
        { key: "core", label: "Core",
          hint: "invader core hits and level — L0 is a harmless reserving core, L1-5 an armed stronghold",
          cell: remoteCoreCell },
        { key: "deploy", label: "Deploys/Expires",
          hint: "counts down to activation while the core is still vulnerable, or to its own collapse once armed",
          cell: e => remoteDeployCell(e, msPerTick) },
        { key: "age", label: "Last seen",
          hint: "the bot's own cached age for this sighting, not the snapshot's age",
          cell: e => remoteAgeCell(e, msPerTick) },
    ];
}

export function renderRemoteTable() {
    renderTable("remote-table", remoteColumns(observedMsPerTick(history)),
        latest.rt ? sortRemoteThreats(latest.rt) : [],
        hasThreatDetail(latest)
            ? { text: "no remote hostiles cached", why: REMOTE_NONE_TITLE }
            : { text: "no remote detail in this snapshot (payload degradation)", why: REMOTE_DEGRADED_TITLE });
}

// "When" is the last tick the hostiles were actually SEEN, not the last
// snapshot that carried the sighting — the bot's hostileCache keeps an entry
// for REMOTE_STALE_AGE_TICKS after a room goes dark, so reading toMs straight
// off the observing row would report a raid that ended ~300 ticks ago as
// happening now. remoteEpisodes() hands us that lag as `staleTicks`; converting
// it needs the ms-per-tick ratio, which only exists here, so with no ratio
// available we fall back to the observation clock and say so in the title.
function remoteWhenCell(ep, msPerTick) {
    const td = document.createElement("td");
    const lagMs = msPerTick != null ? ep.staleTicks * msPerTick : 0;
    const ago = Date.now() - ep.toMs.getTime() + lagMs;
    td.textContent = ago < 60000 ? "just now" : `${fmtDuration(ago)} ago`;
    const parts = [`${ep.fromMs.toLocaleString()} – ${ep.toMs.toLocaleString()} observed`];
    if (ep.staleTicks > 0) {
        parts.push(msPerTick != null
            ? `last seen ${fmtInt.format(ep.staleTicks)} ticks before that final snapshot`
            : `last seen ${fmtInt.format(ep.staleTicks)} ticks earlier — no tick rate in range to date it`);
    }
    if (ep.staleTicks > REMOTE_STALE_AGE_TICKS) td.className = "na";
    td.title = parts.join(" · ");
    return td;
}

function remotePeakCell(ep) {
    const td = document.createElement("td");
    td.textContent = String(ep.peakH);
    td.title = ep.owners.length ? ep.owners.join(", ") : "no hostile creeps — core only";
    return td;
}

function remoteLogRaahCell(ep) {
    const td = document.createElement("td");
    td.textContent = `${fmtInt.format(ep.peakRanged)}/${fmtInt.format(ep.peakMelee)}/${fmtInt.format(ep.peakHeal)}`;
    return td;
}

function remoteLogAggressorsCell(ep) {
    const owners = ep.owners.filter(o => o !== "Source Keeper");
    if (owners.length) return textCell(owners.join(", "));
    if (ep.peakCoreLvl !== undefined) {
        const cell = textCell(`core L${ep.peakCoreLvl}`, ep.peakCoreLvl > 0 ? "critical" : undefined);
        cell.title = ep.peakCoreLvl > 0
            ? "armed stronghold, no hostile creeps recorded"
            : "reserving core only, no hostile creeps — harmless";
        return cell;
    }
    return naCell("unnamed", "no owner was recorded for these hostiles — usually Invader NPCs");
}

// A corridor episode has no home by definition, so its table drops that column.
function remoteLogColumns(msPerTick, corridor) {
    return [
        { key: "room", label: "Room", primary: true, cell: ep => roomLinkCell(ep.room) },
        ...(corridor ? [] : [{ key: "home", label: "Home", cell: ep => remoteHomeCell(ep.home) }]),
        { key: "when", label: "When", cell: ep => remoteWhenCell(ep, msPerTick) },
        { key: "ticks", label: "Ticks", tier: 3,
          hint: "first through last tick the hostiles were actually seen — both ends come from the sighting's own age, not from the snapshots that carried it",
          // toTick is likewise back-dated: the last tick SEEN, not the last
          // snapshot that listed the sighting.
          cell: ep => episodeTicksCell(ep, "replay from the first tick the hostiles were seen, back-dated by the sighting's own age") },
        { key: "peakH", label: "Peak hostiles", cell: remotePeakCell },
        { key: "peakDmg", label: "Peak RA/A/H", cell: remoteLogRaahCell },
        { key: "owners", label: "Aggressors", cell: remoteLogAggressorsCell },
    ];
}

// Remotes (episodes with a home) and corridor sightings (no home) share one
// episode builder and are split into two tables here.
function renderEpisodeLog(tableId, corridor, noneText) {
    const { episodes, covered, total } = remoteEpisodes(history);
    renderTable(tableId, remoteLogColumns(observedMsPerTick(history), corridor),
        covered === 0 ? [] : episodes.filter(ep => !ep.home === corridor).slice(0, ATTACK_LOG_MAX_ROWS),
        covered === 0
            ? { text: "no remote detail in this range", why: REMOTE_DEGRADED_TITLE }
            : { text: noneText });
    $(`${tableId}-note`).textContent = covered < total
        ? `${covered} of ${total} snapshots in range carried remote detail — gaps are payload degradation, not quiet periods`
        : `${covered} of ${total} snapshots in range carried remote detail`;
}

export const renderRemoteLog = () =>
    renderEpisodeLog("remote-log", false, "no remote incursions observed in this range");

export const renderCorridorLog = () =>
    renderEpisodeLog("corridor-log", true, "no corridor sightings observed in this range");
