// Pure calculation/formatting helpers shared by the dashboard (app.js) and
// the collector (../scripts/collect.mjs), covered directly by unit tests
// (../test/calc.test.js). Nothing in here touches the DOM, Chart.js, or
// Firebase, and nothing holds mutable module state — every input the
// functions need (history, in particular) is passed in explicitly, so they
// can be exercised without a browser environment.

const fmtCompact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const compact = n => (n == null ? "—" : fmtCompact.format(n));
export const pct = (p, pt) => (pt ? (100 * p / pt) : 0);

export const PARTS_PER_BOOST = 30; // LAB_BOOST_MINERAL
export const MIN_RAW_STOCK = 100;  // LabManager.MIN_STORAGE_AMOUNT — below this a reagent is unusable

// The shard the collector polls and the only shard this dashboard shows.
// Single source for the header label, the collector's API URL default and the
// screeps.com deep links below, so they cannot drift apart.
export const SHARD = "shard2";

// Screeps keeps room history in 100-tick files, and the history viewer's `t`
// is one of those file ids — an arbitrary tick renders an empty replay, so
// floor to the block boundary.
const HISTORY_TICK_BLOCK = 100;

export const roomUrl = room =>
    `https://screeps.com/a/#!/room/${SHARD}/${room}`;

export const roomHistoryUrl = (room, tick) =>
    `https://screeps.com/a/#!/history/${SHARD}/${room}` +
    `?t=${Math.floor(tick / HISTORY_TICK_BLOCK) * HISTORY_TICK_BLOCK}`;

// LOD tiers: flag name → wall-clock bucket width. The collector stamps the
// first stored doc per bucket with the flag; the dashboard's coarse ranges
// query the flags to fetch a downsampled slice. Lives here so producer and
// consumer can never disagree about a width. Each flag needs a composite
// index in firestore.indexes.json (asserted in test/collect.test.js; the
// flags' auto single-field indexes are disabled there — only the composite
// is ever queried).
export const LOD_BUCKET_MS = { b5: 5 * 60_000, b30: 30 * 60_000, b120: 120 * 60_000 };

// Snapshot retention window. Drives both the collector's daily prune sweep
// and the longest selectable dashboard range (the "21d" button), so the UI
// can never offer a window the data doesn't cover. Was 60; the ring raised
// stored volume ~5x (see README "Operations").
export const RETENTION_DAYS = 21;

// Range (hours) → LOD flag queried by the dashboard. The bot publishes
// roughly once every 20 ticks (~82s at today's shard speed), so full
// resolution over the longer ranges would blow past the dashboard's
// MAX_HISTORY_DOCS query cap (21d is ~22,000 docs) — and even where it fits,
// most of the fetch would be discarded by the MAX_POINTS downsample.
// collect.mjs flags the first stored doc per wall-clock bucket (widths in
// LOD_BUCKET_MS above), so each range queries a slice sized just under the
// 500-point render cap: 24h at b5 ≈ 288 docs, 7d at b30 ≈ 336, 21d at
// b120 ≈ 252. Each flag needs a composite index — see firestore.indexes.json.
// Ranges absent here (6h, ~260 docs) fetch every doc unfiltered. Keys must
// match the data-range buttons in index.html (asserted in test/calc.test.js).
export const LOD_BY_RANGE = { 24: "b5", 168: "b30", [RETENTION_DAYS * 24]: "b120" };

// Which wall-clock bucket a timestamp falls in. The collector's flagging and
// the dashboard's poll-skip must agree on this alignment, so both call this.
export const bucketId = (tsMs, widthMs) => Math.floor(tsMs / widthMs);

// Progress points gained between two consecutive {l,p,pt} readings, level-up
// aware — p resets to ~0 when l increments, so a naive p-delta would go
// sharply negative right at a level-up. Used for both GCL and per-room RCL.
export function progressDelta(prev, cur) {
    if (!prev || !cur) return null; // room absent from one of the snapshots
    if (cur.l === prev.l) return cur.p - prev.p;
    if (cur.l === prev.l + 1) return (prev.pt - prev.p) + cur.p;
    return null; // multi-level jump — intermediate progressTotal unknown, can't attribute
}

// Points gained per tick between consecutive history rows, aligned with
// timeLabels (index 0 has no predecessor, so it's null). `sel` reads the
// {l,p,pt} reading off a history row (e.g. r => r.gcl, r => r.rooms[room]?.rcl).
export function rateSeries(sel, history) {
    return history.map((r, i) => {
        if (i === 0) return null;
        const prev = history[i - 1];
        const dTick = r.tick - prev.tick;
        const d = dTick > 0 ? progressDelta(sel(prev), sel(r)) : null;
        return d == null ? null : d / dTick;
    });
}

// Observed wall-clock ms per tick over the whole visible window, from the
// first/last history rows. Standalone (unlike inline in windowRate) so it can
// back ETAs that aren't {l,p,pt}-shaped, e.g. nuker cooldown ticks. Guards its
// own length since history can legitimately be empty (latest loads
// independently of history).
export function observedMsPerTick(history) {
    if (history.length < 2) return null;
    const first = history[0], last = history[history.length - 1];
    const dTick = last.tick - first.tick;
    return dTick > 0 ? (last.date - first.date) / dTick : null;
}

// Average gain rate over the whole visible window — aggregated rather than
// extrapolated from the last point so a single noisy interval can't skew the
// estimate — plus the observed wall-clock ms per tick over that window.
export function windowRate(sel, history) {
    if (history.length < 2) return null;
    let points = 0, ticks = 0;
    for (let i = 1; i < history.length; i++) {
        const prev = history[i - 1], cur = history[i];
        const dTick = cur.tick - prev.tick;
        if (dTick <= 0) continue;
        const d = progressDelta(sel(prev), sel(cur));
        if (d == null) continue;
        points += d;
        ticks += dTick;
    }
    if (ticks <= 0 || points <= 0) return null;
    const rate = points / ticks;
    return { rate, msPerTick: observedMsPerTick(history) };
}

// Average non-decreasing rate of a plain numeric series over the window —
// the nuker-fill analogue of windowRate, but for raw numbers rather than
// {l,p,pt}. Skips any interval where the value dropped (a nuke launch empties
// the store; that single step must not poison the refill trend it
// interrupted) and any interval touching a null reading (room/nuker absent
// from that snapshot, or predating this field entirely).
export function stockRate(sel, history) {
    let gained = 0, ticks = 0;
    for (let i = 1; i < history.length; i++) {
        const prev = sel(history[i - 1]), cur = sel(history[i]);
        const dTick = history[i].tick - history[i - 1].tick;
        if (prev == null || cur == null || dTick <= 0 || cur < prev) continue;
        gained += cur - prev;
        ticks += dTick;
    }
    return ticks > 0 && gained > 0 ? gained / ticks : null;
}

// ETA to the next level for a current {l,p,pt} reading. `pt` is falsy at max
// level (controller.progressTotal is undefined and JSON.stringify drops it),
// which reads as "no next level" rather than the misleading 0%/instant ETA
// a naive division would produce.
export function levelEta(sel, cur, history) {
    if (!cur?.pt) return null;
    const wr = windowRate(sel, history);
    if (!wr) return null;
    const etaTicks = (cur.pt - cur.p) / wr.rate;
    return { rate: wr.rate, etaTicks, etaMs: wr.msPerTick ? etaTicks * wr.msPerTick : null };
}

export function fmtDuration(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
    const mins = ms / 60000;
    if (mins < 60) return `${Math.round(mins)}m`;
    const hours = mins / 60;
    if (hours < 24) return `${Math.floor(hours)}h ${Math.round(mins % 60)}m`;
    const days = hours / 24;
    if (days < 30) return `${Math.floor(days)}d ${Math.round(hours % 24)}h`;
    return `${Math.round(days)}d`;
}

export function downsample(rows, max) {
    if (rows.length <= max) return rows;
    const step = rows.length / max;
    const out = [];
    for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]);
    out[out.length - 1] = rows[rows.length - 1];
    return out;
}

// Fill ramp (red = short, green = stocked) — 5 buckets plus zero/no-max.
// 1..5 fill-ramp bucket for an in-range, non-zero fraction — red = short,
// green = stocked. Zero/floor/no-max handling is caller-specific (e.g. boost
// stock treats an empty compound as "absent, not short"; the nuker cell
// wants 0 ghodium to read red, a real shortfall) so it stays out of here.
export function rampLevel(fill) {
    if (fill < 0.20) return 1;
    if (fill < 0.40) return 2;
    if (fill < 0.60) return 3;
    if (fill < 0.85) return 4;
    return 5;
}

// A boost costs PARTS_PER_BOOST per part, so a compound stock under that can't
// boost anything: treat it as absent rather than flagging it red. Raw reagents
// (OH/X/G) have their own, much higher floor — LabManager won't run a reaction
// below MIN_RAW_STOCK in storage, so dust below that is unusable too.
// For raw, the floor is checked before the no-max case: a trace amount reads
// as absent even when the reagent has no configured max (e.g. G today), so it
// doesn't get mistaken for a healthy-but-uncapped stock. Compounds keep the
// opposite order — no-max still wins over the dust floor there — since this
// change is scoped to raw reagents only.
export function boostFillLevel(amount, max, raw) {
    if (raw && !(amount >= MIN_RAW_STOCK)) return 0;   // unusable by LabManager — absent, not "short"
    if (!raw && !max) return null;                     // no configured max — rendered as an outline chip
    if (!raw && amount < PARTS_PER_BOOST) return 0;    // dust — can't boost a single part
    if (!max) return null;                              // raw, past the floor, but no configured max
    if (!amount) return 0;                              // in-range but empty
    return rampLevel(amount / max);
}

// Floor + reason shared by the chip/cell tooltips, so the "why is this grey"
// text matches boostFillLevel's own precedence.
export function boostFloor(raw) {
    return raw
        ? { amount: MIN_RAW_STOCK, reason: `below lab minimum (${MIN_RAW_STOCK})` }
        : { amount: PARTS_PER_BOOST, reason: `under one boost (${PARTS_PER_BOOST})` };
}

// ---------------------------------------------------------------------------
// Defense (thr / ThreatSummary) — screeps2/src/utils/console/threatReport.ts
// and healthSnapshot.ts are the source of truth these mirror. `thr` is
// dropped first by StatsManager's payload-size degradation (same step as
// `roles`), so it's present on meta/latest but only best-effort in stored
// history — see README. Every function here treats an absent `thr` as
// "unknown", never "clear": a degraded snapshot carries no information about
// safety, and reading it as safe would hide the exact rooms most likely to
// be under-observed during a real fight (the payload gets big when there's a
// lot going on).

// towerDamageAtRange(TOWER_FALLOFF_RANGE) — screeps2 fleetSizing.ts:83-87.
export const TOWER_DPS_PER_ARMED = 150;

// CRITICAL_RAMPAT_SAFE — screeps2 config/config.buildPriority.ts:33. Ramparts
// under this get repair priority 0 in the bot itself, so it's an absolute
// cliff, not a fraction-of-target ramp level.
export const CRITICAL_RAMPART_HITS = 4000;

// The only role generateSpawnManifest still emits for on-demand squads/guards
// (screeps2 config/remoteRoles/provider.remoteDefender.ts:56). `thr.def[]`
// only ever contains home_defender/home_melee_defender (COMBAT_ROLES,
// threatReport.ts:20-25 — the remote_defender/remote_healer entries there are
// dead, no provider emits them any more), so army_member guards have to be
// found by scanning `roles` separately and merged in by the caller.
export const MANIFEST_GUARD_ROLE = "army_member";

// RCL-scaled repair targets — screeps2 config/config.repairs.ts:18-27,
// DEFAULT_WALL_MAX_HEALTH / DEFAULT_RAMPART_MAX_HEALTH /
// DEFAULT_SAFE_ZONE_RAMPART_MAX_HEALTH, copied verbatim (REPAIRS_BY_SHARD is
// empty today, so the defaults are live everywhere). Colouring barrier hits
// against these rather than an absolute threshold is the point: a healthy
// RCL6 rampart and a neglected RCL8 one must not read the same.
export const BARRIER_TARGETS = {
    wall: { 1: 1000, 2: 5000, 3: 10_000, 4: 50_000, 5: 100_000, 6: 300_000, 7: 1_000_000, 8: 2_000_000, default: 5000 },
    rampart: { 1: 2000, 2: 10_000, 3: 20_000, 4: 50_000, 5: 200_000, 6: 500_000, 7: 1_000_000, 8: 2_000_000, default: 10_000 },
    zoneRampart: { 1: 2_000, 2: 10_000, 3: 20_000, 4: 200_000, 5: 1_000_000, 6: 2_000_000, 7: 5_000_000, 8: 50_000_000, default: 10_000 },
};

// Mirrors the bot's own console formatter — threatReport.ts:99-103 — term for
// term, so a value on the dashboard reads identically to the same value in
// threatReport()/healthSnapshot(). Deliberately not compact(): Intl's
// "compact" notation renders "1M" (no decimal) and is locale-sensitive: this
// needs to match the bot's fixed one-decimal K/M formatting exactly.
export function fmtHits(hits) {
    if (hits == null) return "—";
    if (hits >= 1_000_000) return `${(hits / 1_000_000).toFixed(1)}M`;
    if (hits >= 1_000) return `${(hits / 1_000).toFixed(1)}K`;
    return `${hits}`;
}

export function barrierTarget(kind, rcl) {
    const ladder = BARRIER_TARGETS[kind];
    if (!ladder) return null;
    return ladder[rcl] ?? ladder.default;
}

// null (not a ramp bucket) when hits is absent — absence must never render as
// "good" just because there's nothing to fill the bar with.
export function barrierLevel(hits, kind, rcl) {
    if (hits == null) return null;
    const target = barrierTarget(kind, rcl);
    if (!target) return null;
    return rampLevel(Math.min(1, hits / target));
}

// Absolute cliff below CRITICAL_RAMPART_HITS, independent of RCL — walls
// aren't covered (the bot's own priority-0 rule is rampart-only).
export function isCriticalBarrier(hits, kind) {
    return kind !== "wall" && hits != null && hits < CRITICAL_RAMPART_HITS;
}

// Reproduces roomStatusIcon (threatReport.ts:120-126) term for term, so this
// dashboard and the bot's own console command never disagree about a room's
// posture. `thr.def` is guarded with `?? []` since a hand-written or
// pre-field Firestore doc could lack it even though live payloads always
// have it.
export function roomPosture(thr) {
    if (!thr) return { level: "unknown", label: "unknown", reasons: [] };
    if (thr.h === 0) return { level: "clear", label: "clear", reasons: [] };
    const reasons = [];
    if (thr.twrArmed === 0) reasons.push(thr.twrTotal ? "no armed tower" : "no tower built");
    if (thr.sm === undefined && thr.smAvail === 0) reasons.push("no safe-mode charge");
    if ((thr.def ?? []).some(s => s.cur < s.des)) reasons.push("defender slots short");
    const level = reasons.length ? "exposed" : "engaged";
    return { level, label: level, reasons };
}

// Order for the empire defense table — an alarm panel, not an alphabetical
// listing: the rooms that need eyes on them belong at the top. `unknown`
// ranks above `clear` on purpose — an unknown room might be the one that's
// actually burning; a payload that's silent about a room is not the same as
// a payload that says it's fine.
const POSTURE_RANK = { exposed: 0, engaged: 1, unknown: 2, clear: 3 };
export function sortByPosture(entries) {
    return [...entries].sort(([nameA, roomA], [nameB, roomB]) => {
        const rankA = POSTURE_RANK[roomPosture(roomA.thr).level];
        const rankB = POSTURE_RANK[roomPosture(roomB.thr).level];
        return rankA !== rankB ? rankA - rankB : nameA.localeCompare(nameB);
    });
}

// thr.dps is already worst-case armed-tower damage; heal is the hostiles'
// boost-folded healing per tick. Named (rather than left inline) so the
// table cell, the empire tile, and the balance chart can't drift apart on
// what "net" means.
export function netTowerDps(thr) {
    return thr.dps - (thr.heal ?? 0);
}

// Everything the dashboard needs to render the def[] cell/chart correctly,
// including both false-alarm traps around an empty def[]:
//
//  - def[] only ever contains home_defender/home_melee_defender slots
//    (COMBAT_ROLES). On-demand army_member guards live in `roles`, not
//    `thr.def`, so they're found separately here and merged in as `guards`.
//  - def[] being EMPTY is the normal, healthy state most of the time:
//    computePlan (homeDefensePlan.ts:118-125) returns undefined — meaning no
//    requirement is ever generated — when there are no hostiles, when
//    hostiles carry no attack parts, or while safe mode is active. Only one
//    of the possible "empty" states (armed hostiles, no plan at all) is bad.
//  - `roles` legitimately loses its army_member rows the moment a home room
//    has combat hostiles in it (generateSpawnManifest suppresses all remote
//    requirements then, spawnManifest.ts:8-11) — `suppressed` flags this so
//    the caller can say "absent, not lost" instead of implying attrition.
export function defenderSummary(thr, roles) {
    const guards = (roles ?? []).filter(x => x.r === MANIFEST_GUARD_ROLE);
    const suppressed = !!thr && thr.h > 0 && ((thr.melee ?? 0) + (thr.ranged ?? 0)) > 0;
    if (!thr) return { state: "unknown", cur: 0, des: 0, slots: [], guards, suppressed };

    const slots = thr.def ?? [];
    if (slots.length === 0) {
        let state;
        if (thr.sm !== undefined) state = "safe-mode";
        else if (thr.h === 0) state = "none-needed";
        else if ((thr.melee ?? 0) + (thr.ranged ?? 0) === 0) state = "unarmed";
        else state = "no-plan"; // armed hostiles present and no plan at all — the only bad empty
        return { state, cur: 0, des: 0, slots, guards, suppressed };
    }

    const cur = slots.reduce((a, s) => a + s.cur, 0);
    const des = slots.reduce((a, s) => a + s.des, 0);
    return { state: cur < des ? "short" : "staffed", cur, des, slots, guards, suppressed };
}

// Collapses consecutive thr.h>0 rows per room into episodes for the attack
// log. Rows without a `thr` at all (degraded) are skipped without ending an
// in-progress episode — a single degraded row mid-fight must not split one
// attack into two log entries. Reports its own coverage (rows that carried
// any thr vs total rows walked) so the caller can say "N of M snapshots had
// threat detail" instead of ever implying an uncovered stretch was quiet —
// see the README note on why `thr` history coverage isn't guaranteed.
export function hostileEpisodes(history) {
    const open = new Map(); // room -> in-progress episode
    const episodes = [];
    let covered = 0;
    for (const row of history) {
        let rowCovered = false;
        for (const [room, r] of Object.entries(row.rooms ?? {})) {
            if (!r.thr) continue;
            rowCovered = true;
            if (r.thr.h > 0) {
                let ep = open.get(room);
                if (!ep) {
                    ep = {
                        room, fromMs: row.date, toMs: row.date, fromTick: row.tick, toTick: row.tick,
                        peakH: 0, peakDmg: 0, owners: new Set(), boosted: false,
                    };
                    open.set(room, ep);
                }
                ep.toMs = row.date;
                ep.toTick = row.tick;
                ep.peakH = Math.max(ep.peakH, r.thr.h);
                ep.peakDmg = Math.max(ep.peakDmg, (r.thr.melee ?? 0) + (r.thr.ranged ?? 0));
                for (const o of r.thr.owners ?? []) ep.owners.add(o);
                if ((r.thr.boosted ?? 0) > 0) ep.boosted = true;
            } else if (open.has(room)) {
                episodes.push(finishEpisode(open.get(room)));
                open.delete(room);
            }
        }
        if (rowCovered) covered++;
    }
    for (const ep of open.values()) episodes.push(finishEpisode(ep));
    episodes.sort((a, b) => b.toMs - a.toMs);
    return { episodes, covered, total: history.length };
}

function finishEpisode(ep) {
    return { ...ep, owners: [...ep.owners] };
}
