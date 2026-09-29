// The per-room view.
import {
    armyRoutesForHome, compact, defenderSummary, excludeRoutedGuards, fmtDuration, fmtHits, incomingNukes,
    isCriticalZone, levelEta, netTowerDps, NUKER_COOLDOWN, NUKER_ENERGY_CAPACITY, NUKER_GHODIUM_CAPACITY,
    observedMsPerTick, pct, roomPosture, stockRate, storageClassInfo, zoneTarget,
} from "../calc.js";
import { renderBarRows, renderRolesChart } from "../charts/bars.js";
import { lineDataset, netRateDatasets, rateDatasets, renderLine } from "../charts/core.js";
import { $, cssVar, fmtInt } from "../dom.js";
import { charts, history, latest, route, selectedRoom } from "../state.js";
import { DEGRADED_TITLE, pluralCount, SC_ABSENT_WHY, ZONE_ABSENT } from "../ui/cells-defense.js";
import { renderRoomRemoteEconomy } from "../ui/cells-economy.js";
import { labStatusWord, labTone, renderBoostGrid } from "../ui/cells-labs.js";
import { nukeEta, nukerStatus } from "../ui/cells-nuker.js";
import { screepsRoomLink } from "../ui/links.js";
import { renderTileRow, zoneGrowthTile } from "../ui/tiles.js";

// Stat strip for the selected room's controller: level, progress and upgrade
// ETA (with its throughput) to the next level — the per-room analogue of the GCL
// tile in renderTiles(). At max level (!pt) there's no next level, and
// rcl.p is gone too, so progress/rate/ETA would only be "max"/"—" filler:
// the strip becomes renderMaxedRoomTiles' short summary instead.
function renderRoomTiles(room) {
    const rclOf = r => r.rooms[room]?.rcl ?? null;
    const r = latest.rooms[room];
    const cur = r?.rcl;
    if (!cur?.pt) {
        renderMaxedRoomTiles(room);
        return;
    }
    const eta = levelEta(rclOf, cur, history);
    const tiles = [
        { label: "RCL", value: cur.l, delta: `${compact(cur.p)} / ${compact(cur.pt)}` },
        { label: `To level ${cur.l + 1}`, value: `${pct(cur.p, cur.pt).toFixed(1)}%`, delta: `${compact(cur.pt - cur.p)} left` },
        { label: "Upgrade ETA", value: eta ? (eta.etaMs != null ? `~${fmtDuration(eta.etaMs)}` : `~${compact(eta.etaTicks)} ticks`) : "—",
          delta: eta ? `${compact(eta.rate)}/tick` : "no gain in range" },
        // Stored energy is what a levelling room upgrades with; spawn capacity
        // is what the next level unlocks.
        { label: "Storage", value: compact(r.se ?? 0), delta: `spawn ${fmtInt.format(r.e)} / ${fmtInt.format(r.ec)}` },
    ];
    renderTileRow("room-tiles", tiles);
}

// A max-level room has no progress left to report, and orderRoomView puts
// Defense and Nuker directly below this strip — so it carries only what has
// no section of its own: the level (with UPW, still feeding GCL), labs and
// stored energy. Zone, safe mode and nuker status live in those sections
// once, in full, instead of twice within one screen.
function renderMaxedRoomTiles(room) {
    const r = latest.rooms[room];
    const upw = r?.upw;
    const lab = r?.lab;
    renderTileRow("room-tiles", [
        { label: "RCL", value: r?.rcl?.l ?? "—", delta: "max level",
          sub: upw != null ? `UPW ${compact(upw)}/tick` : "" },
        { label: "Labs",
          value: lab ? labStatusWord(lab.s) : "no labs",
          delta: lab?.o ? `→ ${lab.o}` : "",
          tone: labTone(lab?.s) },
        { label: "Storage", value: compact(r?.se ?? 0), delta: `terminal ${compact(r?.te ?? 0)}` },
    ]);
}

// Room-view block order by room class. The section head, tiles and gap note
// always lead; these follow in the listed order. Incoming nukes come first
// for both, since a scheduled hit outranks everything else about a room.
const ROOM_BLOCK_ORDER = {
    growing: ["nukes-section", "room-economy", "room-boosts", "defense-section", "nuker-section", "room-remote-economy"],
    maxed:   ["nukes-section", "defense-section", "nuker-section", "room-boosts", "room-economy", "room-remote-economy"],
};

// Moves the DOM nodes rather than using CSS `order`, so tab order and
// screen-reader order match what is on screen. Only touches the DOM when the
// layout actually changes, so a refresh doesn't shuffle live charts.
function orderRoomView(maxed) {
    const view = $("view-room");
    const layout = maxed ? "maxed" : "growing";
    if (view.dataset.layout === layout) return;
    view.dataset.layout = layout;
    for (const id of ROOM_BLOCK_ORDER[layout]) view.append($(id));
    // At max level the economy charts sit below defense and need a heading
    // of their own; while levelling they follow the RCL tiles directly.
    $("room-economy-title").hidden = !maxed;
}

// Incoming nukes for the selected room — tiles only, hidden entirely when
// there are none. No chart: ticksToLand counts down deterministically, so
// there's no trend to plot the way the nuker's fill stocks have one.
function renderNukes(room) {
    const nukes = incomingNukes(latest.rooms[room] ?? {});
    $("nukes-section").hidden = nukes.length === 0;
    if (nukes.length === 0) return;
    renderTileRow("nukes-tiles", nukes.map(([ticksToLand, launchRoom, x, y], i) => ({
        label: nukes.length > 1 ? `Nuke ${i + 1}` : "Nuke",
        value: nukeEta(ticksToLand),
        delta: `from ${launchRoom} · (${x}, ${y})`,
        sub: `lands at tick ${fmtInt.format(latest.tick + ticksToLand)}`,
    })));
}

// Nuker status for the selected room — tiles + a two-series fill chart,
// hidden entirely when the room has no nuker. `nuk` is [ghodium, energy,
// cooldown]; absence is never a truncated payload (see nukerCell) so it's an
// unambiguous "no nuker" signal to hide the whole section on.
function renderNuker(room, of) {
    const nuk = latest.rooms[room]?.nuk;
    $("nuker-section").hidden = !nuk;
    if (!nuk) {
        // Otherwise a chart left bound to a now-hidden 0×0 canvas keeps its
        // ResizeObserver alive across the next room switch.
        charts.nuker?.destroy();
        delete charts.nuker;
        return;
    }
    const [g, e, cd] = nuk;
    const gFull = g >= NUKER_GHODIUM_CAPACITY, eFull = e >= NUKER_ENERGY_CAPACITY;
    const status = nukerStatus(nuk);
    const ready = status.ready;

    // Ticks until armed: whichever of cooldown and the two independent fill
    // legs (ghodium via reactions, energy via a gated hauler trickle, see
    // config.nuker.ts) finishes last. Stays null if a short leg has no
    // observed positive rate — an honest "no ETA" beats a fabricated one.
    let readyTicks = ready ? 0 : cd;
    let etaKnown = true;
    for (const [full, cap, amount, rate] of [
        [gFull, NUKER_GHODIUM_CAPACITY, g, stockRate(r => r.rooms[room]?.nuk?.[0] ?? null, history)],
        [eFull, NUKER_ENERGY_CAPACITY, e, stockRate(r => r.rooms[room]?.nuk?.[1] ?? null, history)],
    ]) {
        if (full) continue;
        if (!rate) { etaKnown = false; continue; }
        readyTicks = Math.max(readyTicks, (cap - amount) / rate);
    }
    // Collector gaps (dedup on unchanged tick, or the bot skipping publication
    // under minBucket) inflate the observed ms/tick and so over-estimate this
    // ETA — pre-existing for the RCL ETA too, but the ~100k-tick cooldown
    // multiplies it far more.
    const ms = observedMsPerTick(history);
    const etaLabel = ready ? "ready"
        : !etaKnown ? "—"
        : ms != null ? `~${fmtDuration(readyTicks * ms)}` : `~${compact(readyTicks)} ticks`;

    const cooldownLabel = cd > 0
        ? (ms != null ? `~${fmtDuration(cd * ms)}` : `~${compact(cd)} ticks`)
        : "off cooldown";
    renderTileRow("nuker-tiles", [
        { label: "Status", value: status.word, delta: ready ? "armed" : "" },
        { label: "Ghodium", value: `${status.gPct}%`,
          delta: `${fmtInt.format(g)} / ${fmtInt.format(NUKER_GHODIUM_CAPACITY)}` },
        { label: "Energy", value: `${status.ePct}%`,
          delta: `${fmtInt.format(e)} / ${fmtInt.format(NUKER_ENERGY_CAPACITY)}` },
        { label: "Cooldown", value: cooldownLabel,
          delta: cd > 0 ? `${fmtInt.format(cd)} / ${fmtInt.format(NUKER_COOLDOWN)}` : "" },
        { label: "ETA ready", value: etaLabel, delta: ready || etaKnown ? "" : "no gain in range" },
    ]);

    const gDataset = lineDataset("Ghodium", of(r => r.nuk ? pct(r.nuk[0], NUKER_GHODIUM_CAPACITY) : null), "--series-1");
    const eDataset = lineDataset("Energy", of(r => r.nuk ? pct(r.nuk[1], NUKER_ENERGY_CAPACITY) : null), "--series-2");
    renderLine("nuker", "c-nuker", [gDataset, eDataset], { yMax: 100, unit: "%" });
}

// Per-room defense detail: five tiles + two cards (defense fleet roster,
// damage balance). Unlike renderNuker, the section itself is never hidden —
// thr is present on meta/latest for every owned room (nuk only exists for
// rooms with a nuker), so a section that vanishes on room switch would just
// be jarring; "unknown" is itself the information when thr really is
// absent. The two cards still hide+destroy individually on an empty roster
// / no hostiles, same ResizeObserver discipline as renderNuker.
function renderRoomDefense(room) {
    const r = latest.rooms[room];
    const thr = r?.thr;
    const owners = thr?.owners;
    $("defense-title").replaceChildren(`Defense · ${room}`,
        owners?.length ? ` · ${owners.join(", ")}` : "");

    if (!thr) {
        renderTileRow("defense-room-tiles", [
            { label: "Defense", value: "unknown", delta: DEGRADED_TITLE, sub: "payload degradation — see README" },
        ]);
        for (const key of ["defenders", "balance"]) { charts[key]?.destroy(); delete charts[key]; }
        $("defenders-card").hidden = true;
        $("balance-card").hidden = true;
        return;
    }

    const posture = roomPosture(thr);
    const netDps = netTowerDps(thr);
    const ms = observedMsPerTick(history);
    const smActive = thr.sm !== undefined;
    const smValue = smActive
        ? (ms != null ? `~${fmtDuration(thr.sm * ms)}` : `~${compact(thr.sm)} ticks`)
        : pluralCount(thr.smAvail, "charge");
    const smSub = smActive ? "" : (thr.smCd ? `cooldown ${ms != null ? fmtDuration(thr.smCd * ms) : `~${compact(thr.smCd)} ticks`}` : "");

    const zoneCovered = history.filter(row => row.rooms[room]?.thr).length;
    const zoneSub = zoneCovered < history.length ? `${zoneCovered}/${history.length} snapshots had zone detail` : "";
    const scInfo = storageClassInfo(r);
    renderTileRow("defense-room-tiles", [
        { label: "Posture", value: posture.label,
          delta: thr.h === 0 ? "no hostiles" : [`${fmtInt.format(thr.h)} hostiles`, ...(thr.owners ?? []), ...posture.reasons].join(" · "),
          sub: thr.h ? `melee ${fmtInt.format(thr.melee ?? 0)} · ranged ${fmtInt.format(thr.ranged ?? 0)} · heal ${fmtInt.format(thr.heal ?? 0)} per tick` : "" },
        { label: "Towers", value: `${thr.twrArmed}/${thr.twrTotal}`, delta: thr.h ? `${fmtInt.format(thr.dps)} dps on weakest-hit hostile` : "no hostiles",
          sub: thr.h ? (netDps < 0 ? `heal exceeds tower dps by ${fmtInt.format(-netDps)}` : `towers out-damage heal by ${fmtInt.format(netDps)}`) : "" },
        // The count alone for charges, so the value fits one line in a narrow tile.
        { label: "Safe mode", value: smActive ? smValue : String(thr.smAvail),
          delta: smActive ? "active" : thr.smAvail ? `${thr.smAvail === 1 ? "charge" : "charges"} available` : "no charges left",
          sub: smSub, tone: !smActive && thr.smAvail === 0 ? "critical" : undefined },
        // Target in the delta line: "3.5K/300.0M" at tile size overflows.
        { label: "Defender zone",
          value: thr.defRmp == null ? ZONE_ABSENT.word : fmtHits(thr.defRmp),
          delta: thr.defRmp == null ? ZONE_ABSENT.why : `of ${fmtHits(zoneTarget(r.rcl.l))} target at RCL ${r.rcl.l}`,
          tone: isCriticalZone(thr.defRmp) ? "critical" : undefined },
        { ...zoneGrowthTile("Zone growth", r2 => r2.rooms[room]?.thr?.defRmp ?? null,
            thr.defRmp, zoneTarget(r.rcl.l), history), sub: zoneSub },
        { label: "Storage class", value: scInfo?.word ?? "unknown", delta: scInfo?.why ?? SC_ABSENT_WHY },
    ]);

    // Defense fleet card: def[] home-defender slots, standing army_member
    // guards (a separate role, found via `roles`, not `thr.def` — see
    // MANIFEST_GUARD_ROLE in calc.js) and this room's on-demand squads (from
    // `ar`) merged into one current-vs-desired chart. For a squad "desired" is
    // its full roster, so an engaged squad's losses show as a gap that never
    // closes — which is the truth, it never respawns. An empty roster is
    // usually healthy (see defenderSummary), so its explanation moves into the
    // Posture tile's sub rather than being lost along with the hidden card.
    const defSummary = defenderSummary(thr, r.roles);
    const routes = armyRoutesForHome(latest, room);
    const rows = [
        ...defSummary.slots.map(s => ({ label: s.role + (s.room ? ` → ${s.room}` : ""), cur: s.cur, des: s.des })),
        // A forming on-demand squad still shows up here too (its manifest row
        // is tagged the same as a standing guard) — excluded so it isn't also
        // counted below via `ar`, see excludeRoutedGuards in calc.js.
        ...excludeRoutedGuards(defSummary.guards, routes).map(g => ({ label: `guard: ${g.r}${g.rm ? ` → ${g.rm}` : ""}`, cur: g.c, des: g.d })),
        ...routes.flatMap(route => route.squads.map(s => ({
            label: `squad ${s.id} → ${route.target} · ${s.status}${s.dead ? ` · ${s.dead} lost` : ""}`,
            cur: s.alive, des: s.total,
        }))),
    ];
    if (rows.length === 0) {
        charts.defenders?.destroy();
        delete charts.defenders;
        $("defenders-card").hidden = true;
    } else {
        $("defenders-card").hidden = false;
        renderBarRows("defenders", "c-defenders", rows.map(x => x.label), [
            { label: "Current", data: rows.map(x => x.cur), backgroundColor: cssVar("--series-1"),
              borderRadius: { topRight: 4, bottomRight: 4 }, maxBarThickness: 14 },
            { label: "Desired", data: rows.map(x => x.des), backgroundColor: cssVar("--series-2"),
              borderRadius: { topRight: 4, bottomRight: 4 }, maxBarThickness: 14 },
        ]);
    }

    // Damage balance card: nothing to compare against when there are no hostiles.
    if (thr.h === 0) {
        charts.balance?.destroy();
        delete charts.balance;
        $("balance-card").hidden = true;
    } else {
        $("balance-card").hidden = false;
        renderBarRows("balance", "c-balance", ["Incoming dmg/t", "Hostile heal/t", "Tower dps"], [{
            label: "per tick",
            data: [(thr.melee ?? 0) + (thr.ranged ?? 0), thr.heal ?? 0, thr.dps],
            backgroundColor: [cssVar("--status-critical"), cssVar("--status-warning"), cssVar("--series-3")],
            borderRadius: { topRight: 4, bottomRight: 4 }, maxBarThickness: 14,
        }], { rowHeight: 40 });
    }
}

// Defender-zone rampart hits-per-tick growth — the
// netRateSeries/netWindowRate analogue of the RCL-rate chart, for a plain
// non-monotonic numeric field. Separate from renderRoomDefense so that
// function stays about the *current* ratios while this one is about *trend*;
// does its own thr check since it owns different DOM (a chart card, not
// the tile row) than renderRoomDefense's own !thr early return.
function renderZoneRate(room) {
    const thr = latest.rooms[room]?.thr;
    $("zone-rate-card").hidden = !thr;
    if (!thr) {
        charts.zoneRate?.destroy();
        delete charts.zoneRate;
        return;
    }
    renderLine("zoneRate", "c-zone-rate",
        netRateDatasets("Zone hits/tick", r => r.rooms[room]?.thr?.defRmp ?? null));
}

export function renderRoomCharts() {
    const room = selectedRoom;
    $("room-title").replaceChildren(`Room ${room} `, screepsRoomLink(room));
    const of = fn => history.map(r => (r.rooms[room] ? fn(r.rooms[room]) : null));
    const curRcl = latest.rooms[room]?.rcl;
    const rclMaxed = !curRcl?.pt;
    // Before any chart is drawn, so none is built and then moved.
    orderRoomView(rclMaxed);
    renderRoomTiles(room);
    $("rcl-card").hidden = rclMaxed;
    if (rclMaxed) {
        charts.rcl?.destroy();
        delete charts.rcl;
    } else {
        renderLine("rcl", "c-rcl",
            [lineDataset("RCL progress", of(r => pct(r.rcl.p, r.rcl.pt)), "--series-1")],
            { yMax: 100, unit: "%" });
    }
    // At max level the RCL/tick series has nothing to difference (rcl.p is
    // undefined), so only UPW — which still feeds GCL — is worth plotting.
    // No UPW either means an empty chart, so the card goes like rcl-card's.
    const upw = of(r => r.upw ?? null);
    const rclRateShown = !rclMaxed || upw.some(v => v != null);
    $("rcl-rate-card").hidden = !rclRateShown;
    $("rcl-rate-title").textContent = rclMaxed ? "Controller upgrade · UPW" : "RCL gain · points per tick";
    if (!rclRateShown) {
        charts.rclRate?.destroy();
        delete charts.rclRate;
    } else {
        const rclDatasets = rclMaxed ? [] : rateDatasets("RCL/tick", r => r.rooms[room]?.rcl ?? null);
        rclDatasets.push(lineDataset("UPW", upw, "--series-3"));
        renderLine("rclRate", "c-rcl-rate", rclDatasets);
    }
    renderLine("energy", "c-energy", [
        lineDataset("Storage", of(r => r.se), "--series-1"),
        lineDataset("Terminal", of(r => r.te), "--series-2"),
    ]);
    renderLine("spawn", "c-spawn",
        [lineDataset("Spawn energy", of(r => pct(r.e, r.ec)), "--series-1")],
        { yMax: 100, unit: "%" });
    const topCompounds = Object.entries(latest.rooms[room]?.bst ?? {})
        .sort(([, a], [, b]) => b - a).slice(0, 3).map(([sym]) => sym);
    renderLine("bst", "c-bst", topCompounds.map((sym, i) =>
        lineDataset(sym, of(r => r.bst?.[sym] ?? null), `--series-${i + 1}`)));
    renderLine("repairQueue", "c-repair-queue", [
        lineDataset("This room", of(r => r.rq ? r.rq[0] : null), "--series-1"),
        lineDataset("Remotes", of(r => r.rq ? r.rq[1] : null), "--series-2"),
    ]);
    renderRolesChart(room);
    renderBoostGrid(room);
    renderNukes(room);
    renderNuker(room, of);
    renderRoomDefense(room);
    renderZoneRate(room);
    renderRoomRemoteEconomy(room);
}
