// Defense section.
import {
    compact, CRITICAL_RAMPART_HITS, fmtDuration, fmtHits, isCriticalZone, isOutgunned, netTowerDps,
    observedMsPerTick, quietRooms, sortByPosture,
} from "../calc.js";
import { $, fmtInt } from "../dom.js";
import { history, latest } from "../state.js";
import {
    defCell, hostilesCell, netDpsCell, pluralCount, postureBadge, raahCell, safeModeCell, storageClassCell,
    towersCell, zoneCell,
} from "../ui/cells-defense.js";
import { roomLinkCell } from "../ui/links.js";
import { renderTable } from "../ui/table.js";
import { renderTileRow } from "../ui/tiles.js";

// Empire-wide defense rollup tiles. Rooms with no `thr` this snapshot are
// excluded from every aggregate below rather than counted as zero — a
// degraded room contributes no information, and treating its absence as
// "safe" would hide exactly the rooms most likely to be mid-fight (the
// payload gets big, and thr/roles are dropped first, when there's a lot
// going on). Each tile has a fixed unit regardless of state.
export function renderDefenseTiles() {
    const rooms = Object.entries(latest.rooms);
    const withThr = rooms.filter(([, r]) => r.thr);
    const unknownCount = rooms.length - withThr.length;
    const rcl8 = withThr.filter(([, r]) => r.rcl?.l === 8);

    const totalH = withThr.reduce((a, [, r]) => a + r.thr.h, 0);
    const hostileRoomCount = withThr.filter(([, r]) => r.thr.h > 0).length;
    const owners = new Set();
    let anyBoosted = false;
    for (const [, r] of withThr) {
        for (const o of r.thr.owners ?? []) owners.add(o);
        if ((r.thr.boosted ?? 0) > 0) anyBoosted = true;
    }

    const armedSum = withThr.reduce((a, [, r]) => a + r.thr.twrArmed, 0);
    const totalSum = withThr.reduce((a, [, r]) => a + r.thr.twrTotal, 0);
    // thr.dps is 0 in a clear room (the bot only prices towers against live
    // hostiles), so the sum only means something across rooms with hostiles.
    const contested = withThr.filter(([, r]) => r.thr.h > 0);
    const dpsSum = contested.reduce((a, [, r]) => a + r.thr.dps, 0);
    const noArmedTower = withThr.filter(([, r]) => r.thr.twrArmed === 0 && r.thr.twrTotal > 0).length;

    // Same predicate the threat board ranks on (calc.js), so this tile can't
    // count a room the board above it never names.
    const outgunned = withThr
        .map(entry => [entry, netTowerDps(entry[1].thr)])
        .filter(([[, r]]) => isOutgunned(r.thr))
        .sort((a, b) => a[1] - b[1]);
    const worstOutgunned = outgunned[0]?.[0];
    const worstOutgunnedNet = outgunned[0]?.[1];

    const smAvails = rcl8.map(([, r]) => r.thr.smAvail);
    const minSmAvail = smAvails.length ? Math.min(...smAvails) : null;
    const activeSm = withThr.filter(([, r]) => r.thr.sm !== undefined).length;
    const zeroSm = withThr.filter(([, r]) => r.thr.smAvail === 0).length;
    const longestCd = withThr.reduce((a, [, r]) => Math.max(a, r.thr.smCd ?? 0), 0);
    const ms = observedMsPerTick(history);

    const defRmpEntries = rcl8.filter(([, r]) => r.thr.defRmp != null);
    const weakestDefRmp = defRmpEntries.length ? defRmpEntries.reduce((a, b) => a[1].thr.defRmp < b[1].thr.defRmp ? a : b) : null;
    const criticalZoneCount = rcl8.filter(([, r]) => isCriticalZone(r.thr.defRmp)).length;

    const tiles = [
        {
            label: "Hostiles", value: fmtInt.format(totalH), delta: `in ${hostileRoomCount} room${hostileRoomCount === 1 ? "" : "s"}`,
            sub: [owners.size ? [...owners].join(", ") : null, anyBoosted ? "⚡ boosted parts" : null, unknownCount ? `${unknownCount} rooms unknown` : null]
                .filter(Boolean).join(" · ") || undefined,
        },
        {
            label: "Towers", value: `${armedSum}/${totalSum}`, delta: noArmedTower ? `${noArmedTower} room${noArmedTower === 1 ? "" : "s"} with no armed tower` : "all armed",
            sub: contested.length ? `${fmtInt.format(dpsSum)} dps vs hostiles` : undefined,
        },
        {
            label: "Outgunned", value: outgunned.length, delta: outgunned.length ? "heal beats tower dps" : "—",
            sub: worstOutgunned ? `${worstOutgunned[0]} ${fmtInt.format(worstOutgunnedNet)}` : "—",
        },
        {
            label: "Safe-mode charges (min, RCL8)", value: minSmAvail ?? "—", delta: `${activeSm} active · ${zeroSm} room${zeroSm === 1 ? "" : "s"} at 0`,
            sub: longestCd ? `longest cooldown ~${ms != null ? fmtDuration(longestCd * ms) : `${compact(longestCd)} ticks`}` : undefined,
        },
        {
            label: "Weakest defender zone (RCL8)", value: weakestDefRmp ? fmtHits(weakestDefRmp[1].thr.defRmp) : "—", delta: weakestDefRmp ? weakestDefRmp[0] : "—",
            sub: `${criticalZoneCount} zone${criticalZoneCount === 1 ? "" : "s"} under ${fmtHits(CRITICAL_RAMPART_HITS)}`,
        },
    ];
    renderTileRow("defense-tiles", tiles);
}

function defenseColumns() {
    return [
        { key: "room", label: "Room", primary: true, cell: ([n]) => roomLinkCell(n) },
        { key: "posture", label: "Posture", cell: ([, r]) => postureBadge(r.thr) },
        { key: "hostiles", label: "Hostiles", cell: ([, r]) => hostilesCell(r.thr) },
        { key: "dmgIn", label: "RA/A/H", hint: "hostile ranged / attack (melee) / heal damage per tick, boosts folded in",
          cell: ([, r]) => raahCell(r.thr) },
        { key: "towers", label: "Towers", hint: "towers with energy / built", cell: ([, r]) => towersCell(r.thr) },
        { key: "netDps", label: "Net dps",
          hint: "tower dps on the hostile the towers hit weakest (at its actual range) minus hostile heal/tick — negative means towers alone cannot break the heal",
          cell: ([, r]) => netDpsCell(r.thr) },
        { key: "safeMode", label: "Safe mode", cell: ([, r]) => safeModeCell(r.thr) },
        { key: "zone", label: "Zone",
          hint: "weakest rampart inside the configured defender zone — the one you actually fight behind",
          cell: ([, r]) => zoneCell(r.thr?.defRmp, r.rcl.l) },
        { key: "sc", label: "Class",
          hint: "storage class — a vault holds the empire's war chest, an outpost keeps only what its own defense consumes; above RCL 6 a room graduates to vault at 5.0M zone hits and reverts below 3.0M, unless pinned or overridden in config",
          cell: ([, r]) => storageClassCell(r) },
        { key: "defenders", label: "Defenders",
          hint: "home defense fleet from the live spawn manifest, plus this room's standing remote guards; on-demand squads are in the Army section",
          cell: ([, r]) => defCell(r.thr, r.roles) },
    ];
}

export function renderDefenseTable() {
    const rows = sortByPosture(Object.entries(latest.rooms));
    // A room with nothing to look at: the same quietRooms the threat board's
    // clear line names. Only card mode acts on it (see styles.css) — the
    // desktop table is dense enough to keep every row.
    const quiet = quietRooms(latest);
    const quietSet = new Set(quiet);
    renderTable("defense-table", defenseColumns(), rows, undefined,
        ([name]) => quietSet.has(name) ? ["data-quiet"] : []);
    const table = $("defense-table");
    table.toggleAttribute("data-all-quiet", rows.length > 0 && quiet.length === rows.length);
    const toggle = $("defense-show-all");
    toggle.hidden = quiet.length === 0;
    const syncToggle = () => {
        const all = table.hasAttribute("data-show-all");
        toggle.setAttribute("aria-expanded", String(all));
        toggle.textContent = all
            ? "Hide clear rooms"
            : `+ ${pluralCount(quiet.length, "clear room")} · ${quiet.join(" ")}`;
    };
    toggle.onclick = () => { table.toggleAttribute("data-show-all"); syncToggle(); };
    syncToggle();
}
