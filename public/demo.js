// Synthetic data generator for ?demo=1 — renders a full dashboard with no
// Firestore, for local layout checks (see README). Excluded from deploy via
// firebase.json's hosting.ignore, so app.js only ever reaches this file
// through a dynamic import gated on the DEMO flag — a static import here
// would 404 in production.
import {
    MANIFEST_GUARD_ROLE, NUKER_GHODIUM_CAPACITY, NUKER_ENERGY_CAPACITY, NUKER_COOLDOWN,
} from "./calc.js";

// Real controller.progressTotal per level (1..7 → points to reach the next
// level); level 8 has none (max). Used only to make the demo RCL series walk
// through realistic level-ups.
const RCL_LEVEL_PT = { 1: 200, 2: 45000, 3: 135000, 4: 405000, 5: 1215000, 6: 2405000, 7: 4805000 };

// Adds `gain` points to a {level, progress} pair, rolling over into the next
// level(s) exactly like controller.progress does — so demo history can cross
// a level-up mid-window and exercise progressDelta's level-up branch.
function advanceRcl(level, progress, gain) {
    let l = level, p = progress + gain;
    while (RCL_LEVEL_PT[l] !== undefined && p >= RCL_LEVEL_PT[l]) {
        p -= RCL_LEVEL_PT[l];
        l += 1;
    }
    return { l, p, pt: RCL_LEVEL_PT[l] };
}

// Nuker state per room (k) at row i — covers the states real history will
// show: armed and ready; ghodium full with energy still trickling in;
// filling then launched partway through the window (the one case that
// exercises stockRate's cur < prev skip, since the fill drops to zero at the
// launch row); full and refilled but still on cooldown; no nuker at all; and
// a nuker that only starts publishing partway through the window (the real
// shape of history right after this field ships — exercises the null-gap
// skip in stockRate). Returns null/undefined for "room has no nuk this row",
// which the caller drops from the payload rather than storing.
function demoNuk(k, i, n, f) {
    switch (k) {
        case 0: // ready from the start
            return [NUKER_GHODIUM_CAPACITY, NUKER_ENERGY_CAPACITY, 0];
        case 1: { // ghodium full, energy trickling in (the slow, gated leg) — kept
                   // short of full even at the last row, so the rooms table
                   // shows a genuine "still filling" state, not a second "ready"
            const fill = 0.55 * f;
            return [NUKER_GHODIUM_CAPACITY, Math.round(NUKER_ENERGY_CAPACITY * fill), 0];
        }
        case 2: { // filling, then a launch empties it partway through the window
            const launchAt = Math.floor(n * 0.6);
            if (i < launchAt) {
                const fill = Math.min(1, (i / launchAt) * 1.1);
                return [Math.round(NUKER_GHODIUM_CAPACITY * fill), Math.round(NUKER_ENERGY_CAPACITY * fill), 0];
            }
            return [0, 0, Math.max(0, NUKER_COOLDOWN - (i - launchAt) * 120)]; // tick step matches rows.push below
        }
        case 3: // full and refilled, just counting down cooldown
            return [NUKER_GHODIUM_CAPACITY, NUKER_ENERGY_CAPACITY, Math.round(NUKER_COOLDOWN * (1 - f) * 0.4)];
        case 4: // no nuker in this room
            return null;
        case 5: { // nuker starts publishing partway through the window
            const appearAt = Math.floor(n * 0.3);
            if (i < appearAt) return null;
            const fill = Math.min(1, (i - appearAt) / (n - appearAt));
            return [Math.round(NUKER_GHODIUM_CAPACITY * fill), Math.round(NUKER_ENERGY_CAPACITY * fill * 0.5), 0];
        }
        default:
            return null;
    }
}

// Incoming nukes per room (k) at row i. Real nukes are rare, so most rooms
// carry none. Covers: one with plenty of time left, landed on room 0 — quiet
// and otherwise clear (demoThr case 0), exercising the dashboard's "surfaces
// even with a clear posture" override; one about to land, stacked onto room
// 1's already-active attack; two stacked on room 3, deliberately supplied out
// of soonest-first order to exercise the dashboard's own defensive re-sort
// (incomingNukes); and one on room 5 — whose thr is dropped entirely
// (demoThr case 5) — that only starts publishing partway through the window,
// the same leading-gap shape as demoNuk's case 5/demoGpl, proving a nuke row
// doesn't depend on threat detail. `tick`/`now` mirror the row.tick formula
// below (76680000 + i * 120) so ticksToLand counts down by exactly one tick
// step per row, the way a real nuke's timeToLand does.
function demoNukes(k, i, n) {
    const tick = 76680000 + i * 120;
    const now = 76680000 + (n - 1) * 120;
    switch (k) {
        case 0: // plenty of time left, on an otherwise-clear room
            return [[now + 40000 - tick, "W6N6", 30, 40]];
        case 1: // about to land
            return [[now + 300 - tick, "W5N5", 10, 20]];
        case 3: // two stacked, supplied unsorted
            return [
                [now + 30000 - tick, "W9N3", 25, 25],
                [now + 2000 - tick, "W6N6", 15, 35],
            ];
        case 5: { // starts publishing partway through the window
            const appearAt = Math.floor(n * 0.4);
            if (i < appearAt) return undefined;
            return [[now + 1000 - tick, "W5N5", 5, 45]];
        }
        default:
            return undefined;
    }
}

// Repair-queue length per room (k) at row i — [own, remotes]. Mirrors the
// bot's "omit when both are 0" contract: returns null for "nothing queued
// this row", which the caller drops from the payload rather than storing a
// zero pair. Covers: a steady own-only backlog; both legs fluctuating
// together; a room that never has anything queued (always omitted, so its
// chart renders as one continuous gap); and a backlog that only starts
// appearing partway through the window (the real shape right after this
// field ships, same idea as demoNuk's case 5).
function demoRq(k, i, n, f) {
    switch (k) {
        case 0: { // steady own-room backlog, remotes always clear
            const own = 3 + Math.round(2 * Math.sin(i / 6));
            return own > 0 ? [own, 0] : null;
        }
        case 1: { // own and remote backlogs both drifting with overall growth
            const own = Math.max(0, Math.round(4 * f + 2 * Math.sin(i / 5)));
            const remote = Math.max(0, Math.round(6 * f + 3 * Math.sin(i / 7 + 1)));
            return own > 0 || remote > 0 ? [own, remote] : null;
        }
        case 2: // never anything queued — always omitted
            return null;
        case 3: { // backlog only starts appearing partway through the window
            const appearAt = Math.floor(n * 0.4);
            if (i < appearAt) return null;
            return [1 + ((i - appearAt) % 4), (i - appearAt) % 3];
        }
        default:
            return null;
    }
}

// Defense payload per room (k) — six rooms, six distinct posture states so
// every roomPosture/defenderSummary branch is exercised at once: quiet &
// healthy (with guard slots — one healthy, one short); a boosted attack the
// towers are winning against; towers dry with no defense plan at all (an
// empty def[] can't itself add a "defender slots short" posture reason —
// .some() on [] is vacuously false, so this room's exposed badge still
// attributes to "no armed tower" alone, while defenderSummary separately
// renders the worst defender state, "no-plan", in its own cell); a defender
// deficit stacked with no safe-mode charge and a critical defender-zone
// rampart (def[] recovers over the window, f-driven, so the bar chart has
// real shape); safe mode absorbing unarmed intruders (smAvail:0 must NOT
// read as exposed here — the active mode is the fallback); and thr dropped
// entirely (payload degradation — the caller must also drop `roles`
// alongside it, see DEGRADATION_STEPS in StatsManager.ts, so this demo row
// never teaches a shape that can't occur in the real payload). Barrier hits
// drift gently with f so they don't look frozen across a range switch.
function demoThr(k, i, n, f) {
    switch (k) {
        case 0: // quiet, healthy
            return {
                h: 0, twrArmed: 3, twrTotal: 3, dps: 450, smAvail: 1,
                bar: Math.round(1_900_000 * (0.9 + 0.1 * f)), defRmp: 42_000_000, def: [],
            };
        case 1: // boosted attack, towers holding
            return {
                h: 4, owners: ["Kasami"], melee: 480, ranged: 300, heal: 720, boosted: 26,
                twrArmed: 3, twrTotal: 3, dps: 450, smAvail: 1,
                bar: Math.round(180_000 * (0.7 + 0.3 * f)), defRmp: 3_100_000,
                def: [{ role: "home_defender", cur: 3, des: 3 }, { role: "home_melee_defender", cur: 1, des: 1 }],
            };
        case 2: // towers dry, no defense plan at all (defenderSummary's "no-plan" — the one bad empty def[])
            return {
                h: 2, melee: 120, ranged: 0, heal: 0,
                twrArmed: 0, twrTotal: 2, dps: 0, smAvail: 1, def: [],
            };
        case 3: { // defender deficit + no safe mode + critical defender-zone rampart, recovering over the window.
            // Only the defender zone can go critical now — the outside-zone
            // barrier is secondary/informational, so it stays a plain low
            // reading (never red) even while the zone value is critical.
            const cur = Math.max(1, Math.floor(4 * f));
            return {
                h: 6, melee: 640, ranged: 420, heal: 200, boosted: 12,
                twrArmed: 2, twrTotal: 3, dps: 300, smAvail: 0, smCd: 42000,
                defRmp: Math.round(3200 * (0.9 + 0.2 * f)), bar: 40_000,
                def: [{ role: "home_defender", cur, des: 4 }, { role: "home_melee_defender", cur: 0, des: 2 }],
            };
        }
        case 4: // safe mode active, unarmed intruders — smAvail:0 must not read as exposed
            return {
                h: 3, owners: ["Scout"], melee: 0, ranged: 0, heal: 240, boosted: 0,
                sm: 12000, smAvail: 0, smCd: 0, twrArmed: 1, twrTotal: 1, dps: 150, def: [],
            };
        case 5: // thr dropped entirely (payload degradation)
            return undefined;
        default:
            return undefined;
    }
}

// Spawn structure count per room (k) — independent of demoThr, so it can
// pair a spawn-loss scenario with any combat state (or none at all): the
// dashboard must flag a spawnless room whether it's mid-raid or long quiet.
// Room 2 ("towers dry, no defense plan") is the one picked to also have lost
// its spawn — a raid that broke through the towers plausibly took the spawn
// with it — proving the highlight doesn't depend on a fresh `thr` reading.
function demoSpawns(k) {
    return k === 2 ? 0 : 1;
}

// GPL (empire-wide, not per-room) state at row i. Modeled as a staircase, not
// a ramp: real GPL only advances while some room sits at EnergyLevel.HIGH
// (isPowerProcessingActive, screeps2 config.powerSpawn.ts), so gain happens
// in bursts separated by flat stretches, unlike GCL's steady climb. Also
// starts partway through the window — mirrors demoNuk's case 5 — since the
// field is new: real history will look exactly like this (a leading gap)
// until RETENTION_DAYS of collector runs catch up. Returns null before the
// field "starts publishing", which the caller drops from the row entirely
// rather than storing, exercising the null-gap path the live dashboard must
// also survive.
const GPL_LEVEL = 5;
const GPL_PT = 1000 * (GPL_LEVEL + 1) ** 2; // POWER_LEVEL_MULTIPLY * (level+1) ** POWER_LEVEL_POW
function demoGpl(i, n) {
    const appearAt = Math.floor(n * 0.25);
    if (i < appearAt) return null;
    const j = i - appearAt;
    const period = Math.max(6, Math.floor((n - appearAt) / 5)); // ~5 burst cycles across the visible span
    const burstSteps = Math.max(1, Math.floor(period * 0.3));   // processing only runs ~30% of each cycle
    const gainPerStep = 40;
    const fullCycles = Math.floor(j / period);
    const activeInPartial = Math.min((j % period) + 1, burstSteps);
    const p = Math.min(GPL_PT * 0.9, (fullCycles * burstSteps + activeInPartial) * gainPerStep);
    return { l: GPL_LEVEL, p, pt: GPL_PT };
}

// Role slots per room (k). Rooms 0 and 4 carry army_member guard rows (room
// 0: one healthy, one short) since their hostile state doesn't suppress
// remote requirements (no hostiles, and heal-only hostiles, respectively —
// see `suppressed` in defenderSummary); rooms 1-3 have combat hostiles, so
// generateSpawnManifest would suppress those rows in the real bot, and
// they're omitted here for the same reason. Room 5's thr is dropped, and
// `roles` is dropped alongside it (DEGRADATION_STEPS drops both together).
function demoRoles(k) {
    if (k === 5) return undefined;
    const base = [
        { r: "hauler", c: 3, d: 3 }, { r: "upgrader", c: 2 + k % 2, d: 3 },
        { r: "source_miner", c: 2, d: 2 }, { r: "builder", c: 1, d: 2 },
        { r: "remote_miner", rm: "E16S57", c: 1, d: 2 },
    ];
    if (k === 0) {
        return [...base,
            { r: MANIFEST_GUARD_ROLE, rm: "E16S57", c: 1, d: 1 },
            { r: MANIFEST_GUARD_ROLE, rm: "E14S58", c: 0, d: 1 }];
    }
    if (k === 4) return [...base, { r: MANIFEST_GUARD_ROLE, c: 1, d: 1 }];
    return base;
}

// Snapshot-level remote threats (rt) at row i — hostiles cached in NON-owned
// rooms. One pinned case per entry, chosen to cover every branch the renderers
// and remoteEpisodes() have:
//
//   - an armed stronghold, present the whole window (never logs as an episode
//     that closes, so the "still open at the end" path gets walked);
//   - a raid that both starts AND ends mid-window, the only case that
//     exercises the episode-close path;
//   - a level-0 reserving core with h: 0 — the hostiles cell must print "0",
//     not an em dash, since "a core and no creeps" is real information;
//   - a Source Keeper room, permanently cached, which must appear in the
//     latest-snapshot table but never in the activity log;
//   - a corridor sighting with no `home` at all;
//   - an entry whose `age` runs past REMOTE_STALE_AGE_TICKS, which must render
//     de-emphasised rather than as a live reading;
//   - a dark carried stronghold (`mem: 1`, h: 0, coreLvl but NO core hits),
//     re-scouted once mid-window. Covers the "no vision" copy, fmtHits(undefined)
//     rendering as an em dash, and — since it is present every row — an episode
//     that never closes whose toTick freezes between passes and jumps on one.
//
// Returns null for "no remote hostiles cached this row", which the caller
// drops from the payload rather than storing — the bot omits `rt` on an empty
// list, which is exactly what makes hasThreatDetail() necessary.
function demoRt(i, n, f) {
    const entries = [];
    // Armed stronghold, core slowly chewed down over the window, with a fixed
    // future collapse tick so the Deploys/Expires column shows a live
    // "expires in ~Xm" countdown.
    entries.push({
        room: "E16S57", home: "E15S57", h: 4, owners: ["Invader"],
        melee: 420, ranged: 240, heal: 180,
        core: Math.round(2_000_000 * (1 - 0.35 * f)), coreLvl: 3,
        age: 2 + (i % 5),
        exp: 76680000 + Math.floor(n * 1.4) * 120,
    });
    // A core still deploying — negative exp, the "before deployment" case the
    // bot commit added. Its activation tick sits past the end of the demo
    // window (deliberately never reached), so the live remote table — which
    // only ever shows the latest row — keeps reading "deploys in ~Xm" rather
    // than flashing past the transition on the very last sample.
    const deployAtTick = 76680000 + Math.floor(n * 1.5) * 120;
    entries.push({ room: "E25S48", home: "E24S48", h: 0, coreLvl: 0, age: 3, exp: -deployAtTick });
    // A raid with a beginning and an end — the episode-close path.
    const raidFrom = Math.floor(n * 0.3), raidTo = Math.floor(n * 0.65);
    if (i >= raidFrom && i < raidTo) {
        entries.push({
            room: "E19S59", home: "E18S59", h: 3, owners: ["Kasami"],
            melee: 240, ranged: 180, heal: 90, age: 1 + (i % 3),
        });
    }
    // Level-0 reserving core: harmless, and no creeps with it.
    if (i >= Math.floor(n * 0.5)) {
        entries.push({ room: "E22S41", home: "E21S41", h: 0, core: 100_000, coreLvl: 0, age: 4 });
    }
    // SK room's standing guards — routine, and must stay out of the log.
    entries.push({
        room: "E24S44", home: "E23S44", h: 3, owners: ["Source Keeper"],
        melee: 360, ranged: 0, heal: 0, age: 1,
    });
    // Incidental corridor sighting: no home room farms this one.
    if (f > 0.8) {
        entries.push({ room: "E20S50", h: 1, owners: ["Tigga"], melee: 0, ranged: 60, heal: 30, age: 6 });
    }
    // Cached memory of a room that has gone dark — age past the cache TTL.
    entries.push({
        room: "E28S41", home: "E27S41", h: 2, owners: ["Invader"],
        melee: 120, ranged: 0, heal: 0, age: 260 + Math.round(900 * f),
    });
    // Dark stronghold carried from the bot's Memory: no vision, so no hostile
    // detail and no core hits. One scout pass at the window's midpoint resets
    // `age`, which is what makes its episode's toTick jump exactly once.
    const lastPass = i < Math.floor(n * 0.5) ? 0 : Math.floor(n * 0.5);
    entries.push({
        room: "E31S38", home: "E30S38", h: 0, coreLvl: 5,
        age: 120 + (i - lastPass) * 40, mem: 1,
    });
    return entries.length ? entries : null;
}

// Snapshot-level army routes (ar) at row i — squads home rooms have fielded
// for other rooms, tied to the rt entries above so the Response column and the
// stronghold card have something to join on. One case per phase the
// renderers distinguish:
//
//   - E15S57 → E16S57 (the armed stronghold): an engaged, boosted squad
//     deployed in the room with one member lost — the permanent-loss case —
//     and, late in the window, a second squad forming behind it;
//   - E18S59 → E19S59 (the mid-window raid): a route that walks forming →
//     in transit → deployed over the raid's own span, so the log and the
//     latest table can disagree about its phase exactly as they would live;
//   - E27S41 → E28S41: a manual (console-spawned) squad still en route,
//     covering the `kind` field and the "in transit" word;
//   - E21S41 → E22S41: an engaged squad stuck staging at home under holdHome.
//
// Returns null for "no army exists this row", which the caller drops from the
// payload rather than storing — the bot omits `ar` on an empty list, the
// same contract as `rt`.
function demoAr(i, n, f) {
    const routes = [];
    const sq = [{ id: 4, st: "engaged", n: [0, 0, 2, 1], at: [0, 2, 0], b: 1 }];
    if (f > 0.6) sq.push({ id: 5, st: "forming", n: [1, 1, 1, 0], at: [1, 0, 0] });
    routes.push({ home: "E15S57", target: "E16S57", sq });

    const raidFrom = Math.floor(n * 0.3), raidTo = Math.floor(n * 0.65);
    if (i >= raidFrom && i < raidTo) {
        const g = (i - raidFrom) / (raidTo - raidFrom);
        routes.push({
            home: "E18S59", target: "E19S59",
            sq: [g < 0.3 ? { id: 7, st: "forming", n: [1, 1, 1, 0], at: [1, 0, 0] }
                : g < 0.5 ? { id: 7, st: "engaged", n: [0, 0, 3, 0], at: [0, 0, 3] }
                : { id: 7, st: "engaged", n: [0, 0, 3, 0], at: [0, 3, 0] }],
        });
    }
    routes.push({ home: "E27S41", target: "E28S41", kind: "manual", sq: [{ id: 9, st: "engaged", n: [0, 0, 1, 0], at: [0, 0, 1] }] });
    // The power-harvest armies behind demoPb's `sq` entries — kind 'offense',
    // and the only thing the squads table can join against for
    // a status. The E45N35 route ends with the bank, so late in the window
    // that bank's squads have no route record at all — the join-miss branch.
    routes.push({
        home: "E15S57", target: "E15N5", kind: "offense",
        sq: [{ id: 21, st: "engaged", n: [0, 0, 4, 0], at: [0, 4, 0], b: 1 },
             { id: 22, st: "engaged", n: [0, 0, 2, 0], at: [0, 2, 0] }],
    });
    // A second home on the same bank — four squads in all, the case that used
    // to push the bank table past the viewport.
    routes.push({
        home: "E18S59", target: "E15N5", kind: "offense",
        sq: [{ id: 41, st: "engaged", n: [0, 0, 3, 0], at: [0, 0, 3] },
             { id: 42, st: "forming", n: [2, 0, 0, 0], at: [2, 0, 0] }],
    });
    if (i < Math.floor(n * 0.8)) {
        routes.push({ home: "E27S41", target: "E45N35", kind: "offense", sq: [{ id: 31, st: "engaged", n: [0, 0, 4, 1], at: [0, 0, 4] }] });
    }
    if (i >= Math.floor(n * 0.5)) {
        routes.push({ home: "E21S41", target: "E22S41", sq: [{ id: 11, st: "engaged", n: [0, 0, 1, 1], at: [1, 0, 0], hold: 1 }] });
    }
    return routes.length ? routes : null;
}

// Per-room power stock (pw): [storage, terminal, power spawn, processing 0|1].
// Only the first two rooms hold power, and only from the window's midpoint —
// a room with no power spawn and no power in store publishes no `pw` at all,
// and a snapshot where NO room does predates the field entirely. That first
// half is the blank left edge the stock chart must draw instead of a zero
// line, and it is the only way to see it in a browser.
function demoPw(k, i, n, f) {
    if (i < Math.floor(n * 0.5) || k > 1) return null;  // see synthDemo's prePower note
    const g = (i - Math.floor(n * 0.5)) / (n - Math.floor(n * 0.5));
    // k === 0 owns a power spawn and is processing; k === 1 is a vault holding
    // stray power with no spawn, which must read as NOT processing.
    return k === 0
        ? [Math.round(4000 + 26000 * g), 2000, Math.round(80 * (1 - g)), 1]
        : [Math.round(1500 * g), 0, 0, 0];
}

// Live power banks (pb). One case per branch the renderers distinguish:
//
//   - E15N5: committed by two homes (four squads between them) with a third
//     home's skip folded into "+1 other", contested by a rival, haulers
//     already on it — the fully-engaged case, and the only one with `dps`, so
//     the "dead before it decays" badge has something to render;
//   - E25N15: a fresh sighting nothing has decided on yet — no `pl` at all
//     (the planner's cache is heap state), no squads, no haulers;
//   - E35N25: a retry pending on one home and a committed skip on another,
//     stale intel (the room has gone dark) and only one free tile;
//   - E55N45: a rival wins the race — the lone home abandons `late`, so the
//     fold chip names the reason and its tooltip the fleet-vs-kill clock.
function demoPb(i, n, f) {
    const banks = [{
        rm: "E15N5", p: 4800, hits: Math.round(2_000_000 * (1 - f * 0.6)), dec: 4200 - i * 8,
        age: i % 7, ft: 4, con: [2, 340, 120], dps: 1180,
        pl: [{ h: "E15S57", k: "committed", m: "fight" }, { h: "E18S59", k: "committed", m: "race" },
             { h: "E21S41", k: "skip", r: "too_far" }],
        sq: [{ id: 21, home: "E15S57", w: 1 }, { id: 22, home: "E15S57", f: 1 },
             { id: 41, home: "E18S59", w: 1 }, { id: 42, home: "E18S59", w: 2 }],
        // still spawning (min ttl 0) for the first stretch, then out on the road
        hl: i > Math.floor(n * 0.6) ? [2, 2400, 890] : [2, 0, 0],
    }];
    banks.push({ rm: "E25N15", p: 2600, hits: 2_000_000, dec: 3000 - i * 5, age: 2, ft: 6, dps: 0 });
    banks.push({
        rm: "E35N25", p: 6400, hits: 1_400_000, dec: 5000 - i * 6, age: 340 + i, ft: 1, dps: 0,
        pl: [{ h: "E21S41", k: "retry", in: 200 - i * 3, r: "no_pairs" }, { h: "E23S44", k: "skip", r: "bank_too_tough" }],
    });
    banks.push({
        rm: "E55N45", p: 3280, hits: Math.round(1_100_000 * (1 - f * 0.5)), dec: 2500 - i * 4,
        age: 1, ft: 4, con: [1, 2520, 1104], dps: 0,
        pl: [{ h: "E21S49", k: "retry", in: 100 - (i % 100), r: "contested", ab: "late", abt: [400, 316] }],
    });
    // The bank our own squad finishes late in the window — it leaves the list
    // exactly when demoPh starts publishing its haulers, which is the sequence
    // `ph` exists for.
    if (i < Math.floor(n * 0.8)) {
        banks.push({
            rm: "E45N35", p: 5200, hits: Math.round(900_000 * (1 - i / (n * 0.8))), dec: 2600 - i * 4,
            age: 1, ft: 3, dps: 940,
            pl: [{ h: "E27S41", k: "committed", m: "loot" }],
            sq: [{ id: 31, home: "E27S41", w: 2 }],
            hl: [2, 1200, 640],
        });
    }
    return banks;
}

// Haulers whose bank record is already gone (ph) — the loot leg home. Appears
// exactly when demoPb drops E15N5, which is the sequence this field exists
// for: our own kill deletes the intel record while the haulers are loading.
function demoPh(i, n) {
    return i >= Math.floor(n * 0.8) ? [{ rm: "E45N35", hl: [2, 5200, 760] }] : null;
}

// One contiguous stretch mid-window where the published payload outgrew its
// budget and DEGRADATION_STEPS[0] fired, dropping roles/thr/rt/ar together
// across the WHOLE snapshot — which is how the bot actually degrades, and the
// only thing that makes either activity log report coverage below 100%. Kept
// away from both ends: the first row feeds renderTiles' creep delta and the
// last row is `latest`, which every latest-snapshot section reads.
//
const degradedRow = (i, n) => i >= Math.floor(n * 0.45) && i < Math.floor(n * 0.52);

// ?demo=degraded strips the NEWEST row's threat detail, which the mid-window
// stretch above deliberately cannot do. That reaches the branches that need
// `latest` itself to be degraded — the remote table's two empty states, and
// the one that matters most: the threat board must headline "no threat data"
// rather than anything that reads like an all-clear (empireVerdict.degraded).
export function degradeLatest(rows) {
    if (!rows.length) return rows;
    const last = { ...rows.at(-1), rooms: {} };
    for (const [name, room] of Object.entries(rows.at(-1).rooms)) {
        const { thr, roles, ...rest } = room;
        last.rooms[name] = rest;
    }
    delete last.rt;
    delete last.ar;
    // pb/ph ride the same degradation step; `pba` does NOT and must survive,
    // or the section reads "gate off"/"no banks" instead of "degraded away".
    delete last.pb;
    delete last.ph;
    return [...rows.slice(0, -1), last];
}

export function synthDemo(rangeHours, maxPoints) {
    const roomNames = ["E15S57", "E18S59", "E21S41", "E21S55", "E23S44", "E27S41"];
    // Per-room fill band for the boosts matrix — spans empty/low/mid/high/full,
    // last room deliberately empty (mirrors a freshly-claimed room with no stock at all).
    const fillFrac = [0.08, 0.92, 0.45, 0.68, 0.28, 0];
    // Per-room RCL trajectory over the visible window: starting {level, progress},
    // total points gained by the last row, and an oscillation so the rate chart
    // has real shape (same reasoning as the gcl series below). E18S59 is seeded
    // just short of its level-6 threshold so it levels up partway through the
    // window; E21S55 starts already at level 8 (maxed, no next-level pt).
    // oscAmp is capped well under (totalGain / maxPoints) * oscPeriod — the
    // point where the oscillation's slope would exceed the trend's and the
    // rate would dip negative — so RCL/tick stays positive at every range,
    // including 21d where n hits the maxPoints ceiling and the trend is weakest.
    const rclSpecs = [
        { level: 5, progress: 300000, totalGain: 350000, oscAmp: 3500, oscPeriod: 9 },
        { level: 6, progress: 2100000, totalGain: 500000, oscAmp: 4000, oscPeriod: 7 },
        { level: 7, progress: 800000, totalGain: 300000, oscAmp: 2800, oscPeriod: 8 },
        { level: 8, progress: 5000000, totalGain: 200000, oscAmp: 1400, oscPeriod: 6 },
        { level: 4, progress: 150000, totalGain: 200000, oscAmp: 2300, oscPeriod: 10 },
        { level: 6, progress: 400000, totalGain: 250000, oscAmp: 3200, oscPeriod: 11 },
    ];
    const now = Date.now();
    const n = Math.min(maxPoints, rangeHours * 6);
    const rows = [];
    for (let i = 0; i < n; i++) {
        const f = i / n;
        const degraded = degradedRow(i, n);
        const date = new Date(now - (n - i) * (rangeHours / n) * 3600e3);
        const rooms = {};
        roomNames.forEach((name, k) => {
            const frac = fillFrac[k];
            const spec = rclSpecs[k];
            const nuk = demoNuk(k, i, n, f);
            const nukes = demoNukes(k, i, n);
            const rq = demoRq(k, i, n, f);
            const pw = demoPw(k, i, n, f);
            const roles = degraded ? null : demoRoles(k);
            const thr = degraded ? undefined : demoThr(k, i, n, f);
            const gained = spec.totalGain * f + spec.oscAmp * Math.sin(i / spec.oscPeriod + k);
            rooms[name] = {
                rcl: advanceRcl(spec.level, spec.progress, Math.max(0, gained)),
                upw: Math.max(0, (spec.totalGain / n + (spec.oscAmp / spec.oscPeriod) * Math.cos(i / spec.oscPeriod + k)) / 120),
                sp: demoSpawns(k),
                e: 1200 + Math.round(600 * Math.sin(i / 5 + k)), ec: 1800,
                se: 200000 + f * 80000 + 20000 * Math.sin(i / 9 + k), te: k * 40000,
                q: (i + k) % 9,
                ...(roles ? { roles } : {}),
                ...(thr ? { thr } : {}),
                lab: k === 0
                    ? { s: "reaction", o: "XGH2O",
                        i1: ["GH2O", Math.round(3000 * (1 - f))], i2: ["X", Math.round(2800 * (1 - f))],
                        ot: Math.round(2500 * f), cd: i % 10, lc: [2, 4, 0] }
                    : k === 1 ? { s: "boost", lc: [2, 4, 2] } : { s: "idle", lc: [0, 0, 0] },
                // spread across several purposes/tiers so the boosts matrix shows the
                // full ramp; compounds all-zero for the last room to exercise the
                // all-zero row, but with trace raw stock (below MIN_RAW_STOCK) to
                // exercise the "raw under 100" grey state.
                bst: frac === 0 ? { OH: 60, X: 12 } : {
                    UH: Math.round(3000 * frac), UH2O: Math.round(1000 * frac * 0.6),
                    KO: Math.round(3000 * Math.min(1, frac * 1.1)), KHO2: Math.round(1000 * frac * 0.5),
                    LO: Math.round(3000 * frac * 0.9), LHO2: Math.round(1000 * frac * 0.4),
                    GO: Math.round(3000 * frac * 0.7),
                    ZO: Math.round(3000 * frac), ZHO2: Math.round(1000 * frac * 0.3),
                    KH: Math.round(3000 * frac * 0.5),
                    LH: Math.round(3000 * frac * 0.6),
                    GH2O: Math.round(1000 * frac * frac),
                    OH: Math.round(11000 * frac),
                    X: Math.round(21000 * frac * 0.8),
                    G: Math.round(500 * frac), // present in bst but absent from bmax below — exercises "no max" chip
                },
                ...(nuk ? { nuk } : {}),
                ...(nukes ? { nukes } : {}),
                ...(rq ? { rq } : {}),
                ...(pw ? { pw } : {}),
            };
        });
        const gpl = demoGpl(i, n);
        const rt = degraded ? null : demoRt(i, n, f);
        const ar = degraded ? null : demoAr(i, n, f);
        // The first quarter of the window predates the power fields entirely —
        // snapshots the collector stored before it began persisting them. That
        // is the only way to see the chart's blank left edge, and the only way
        // to tell it apart from the stretch that follows, where `pba` is
        // present and no room holds power: a genuine empire-wide zero.
        const prePower = i < Math.floor(n * 0.25);
        const pb = degraded || prePower ? null : demoPb(i, n, f);
        const ph = degraded || prePower ? null : demoPh(i, n);
        rows.push({
            ts: { toDate: () => date }, date, tick: 76680000 + i * 120,
            // mild oscillation on top of the upward trend so the GCL/tick chart
            // has real shape in demo mode, and a steeper trend than the live
            // shard's so the ETA lands in a legible few-day range rather than
            // months. Phased on row index (not wall-clock time) so the cycle
            // count scales with n like every other synthetic series here,
            // instead of aliasing once 500 samples must cover 30 days.
            gcl: { l: 9, p: 6000000 + f * 6000000 + 60000 * Math.sin(i / 6), pt: 48032810 },
            ...(gpl ? { gpl } : {}),
            cpu: { u: 20 + 8 * Math.sin(i / 7), l: 110, b: Math.min(10000, 6000 + i * 40) },
            cr: 323000000 + i * 9000,
            rooms,
            ...(rt ? { rt } : {}),
            ...(ar ? { ar } : {}),
            ...(pb?.length ? { pb } : {}),
            ...(ph?.length ? { ph } : {}),
            // Always published and never degraded — that is the whole point of
            // the scalar, so it stays outside the `degraded` branch above. It
            // is absent only in the pre-power stretch, where the bot had no
            // such field at all.
            ...(prePower ? {} : { pba: 1 }),
            bmax: {
                UH: 3000, UH2O: 1000, XUH2O: 500,
                KO: 3000, KHO2: 1000,
                LO: 3000, LHO2: 1000,
                GO: 3000,
                ZO: 3000, ZHO2: 1000,
                KH: 3000, KH2O: 1000,
                LH: 3000,
                GH2O: 1000,
                OH: 11000, X: 21000,
                // G intentionally omitted — no configured max, shows the outline chip
            },
        });
    }
    return rows;
}
