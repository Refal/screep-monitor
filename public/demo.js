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

// Defense payload per room (k) — six rooms, six distinct posture states so
// every roomPosture/defenderSummary branch is exercised at once: quiet &
// healthy (with guard slots — one healthy, one short); a boosted attack the
// towers are winning against; towers dry with no defense plan at all (an
// empty def[] can't itself add a "defender slots short" posture reason —
// .some() on [] is vacuously false, so this room's exposed badge still
// attributes to "no armed tower" alone, while defenderSummary separately
// renders the worst defender state, "no-plan", in its own cell); a defender
// deficit stacked with no safe-mode charge and a critical rampart (def[]
// recovers over the window, f-driven, so the bar chart has real shape); safe
// mode absorbing unarmed intruders (smAvail:0 must NOT read as exposed here
// — the active mode is the fallback); and thr dropped entirely (payload
// degradation — the caller must also drop `roles` alongside it, see
// DEGRADATION_STEPS in StatsManager.ts, so this demo row never teaches a
// shape that can't occur in the real payload). Barrier hits drift gently
// with f so they don't look frozen across a range switch.
function demoThr(k, i, n, f) {
    switch (k) {
        case 0: // quiet, healthy
            return {
                h: 0, twrArmed: 3, twrTotal: 3, dps: 450, smAvail: 1,
                rmp: Math.round(1_900_000 * (0.9 + 0.1 * f)), defRmp: 42_000_000, wall: 1_800_000, def: [],
            };
        case 1: // boosted attack, towers holding
            return {
                h: 4, owners: ["Kasami"], melee: 480, ranged: 300, heal: 720, boosted: 26,
                twrArmed: 3, twrTotal: 3, dps: 450, smAvail: 1,
                rmp: Math.round(180_000 * (0.7 + 0.3 * f)), defRmp: 3_100_000,
                def: [{ role: "home_defender", cur: 3, des: 3 }, { role: "home_melee_defender", cur: 1, des: 1 }],
            };
        case 2: // towers dry, no defense plan at all (defenderSummary's "no-plan" — the one bad empty def[])
            return {
                h: 2, melee: 120, ranged: 0, heal: 0,
                twrArmed: 0, twrTotal: 2, dps: 0, smAvail: 1, def: [],
            };
        case 3: { // defender deficit + no safe mode + critical rampart, recovering over the window
            const cur = Math.max(1, Math.floor(4 * f));
            return {
                h: 6, melee: 640, ranged: 420, heal: 200, boosted: 12,
                twrArmed: 2, twrTotal: 3, dps: 300, smAvail: 0, smCd: 42000,
                rmp: Math.round(3200 * (0.9 + 0.2 * f)), defRmp: 210_000, wall: 40_000,
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
    // Armed stronghold, core slowly chewed down over the window.
    entries.push({
        room: "E16S57", home: "E15S57", h: 4, owners: ["Invader"],
        melee: 420, ranged: 240, heal: 180,
        core: Math.round(2_000_000 * (1 - 0.35 * f)), coreLvl: 3,
        age: 2 + (i % 5),
    });
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

// One contiguous stretch mid-window where the published payload outgrew its
// budget and DEGRADATION_STEPS[0] fired, dropping roles/thr/rt together
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
            const roles = degraded ? null : demoRoles(k);
            const thr = degraded ? undefined : demoThr(k, i, n, f);
            const gained = spec.totalGain * f + spec.oscAmp * Math.sin(i / spec.oscPeriod + k);
            rooms[name] = {
                rcl: advanceRcl(spec.level, spec.progress, Math.max(0, gained)),
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
            };
        });
        const gpl = demoGpl(i, n);
        const rt = degraded ? null : demoRt(i, n, f);
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
