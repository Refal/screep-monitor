// Pure calculation/formatting helpers shared by the dashboard (app.js) and
// the collector (../scripts/collect.mjs), covered directly by unit tests
// (../test/calc.test.js). Nothing in here touches the DOM, Chart.js, or
// Firebase, and nothing holds mutable module state — every input the
// functions need (history, in particular) is passed in explicitly, so they
// can be exercised without a browser environment.

const fmtCompact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
// Intl's compact notation can round a small negative magnitude down to "-0"
// (or "-0K" etc.) — strip the sign so a barely-negative rate doesn't read as
// "no change" to a caller (e.g. netWindowRate) that specifically wants a
// negative value to be legible as shrinking, not flat.
export const compact = n => {
    if (n == null) return "—";
    const s = fmtCompact.format(n);
    return /^-0(?:[A-Za-z]|$)/.test(s) ? s.slice(1) : s;
};
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

// The bot's own publish cadence (~20 ticks, ~82s at today's shard speed — see
// the LOD_BY_RANGE comment below), not the collector's 5-minute poll
// interval: the collector's ring backfill means stored rows land this far
// apart even though the collector itself only runs once every 5 minutes.
// This is the "normal spacing" baseline for detectGaps on the unflagged
// (raw) range, where LOD_BUCKET_MS has no entry to use instead.
export const RAW_INTERVAL_MS = 82_000;

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

// The dashboard's time-range buttons, in the order they appear. Exported so
// index.html no longer hardcodes them and route.js can reject a hash range
// that has no LOD flag behind it — see LOD_BY_RANGE above.
export const RANGES = [6, 24, 168, RETENTION_DAYS * 24];
export const DEFAULT_RANGE = 24;

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

// Shared accumulate-over-ticks loop behind stockRate and netWindowRate: sums
// the per-interval delta and elapsed ticks across history, skipping any
// interval touching a null reading or a non-positive dTick. `dropTolerant`
// is the one behavioral difference between the two callers — stockRate skips
// a dropped interval too (a nuke launch emptying the store must not poison
// the refill trend), netWindowRate counts it (a defender-zone rampart losing
// hits is real signal, not noise).
function accumulateDeltas(sel, history, { dropTolerant }) {
    let delta = 0, ticks = 0;
    for (let i = 1; i < history.length; i++) {
        const prev = sel(history[i - 1]), cur = sel(history[i]);
        const dTick = history[i].tick - history[i - 1].tick;
        if (prev == null || cur == null || dTick <= 0) continue;
        if (!dropTolerant && cur < prev) continue;
        delta += cur - prev;
        ticks += dTick;
    }
    return { delta, ticks };
}

// Average non-decreasing rate of a plain numeric series over the window —
// the nuker-fill analogue of windowRate, but for raw numbers rather than
// {l,p,pt}. Skips any interval where the value dropped (a nuke launch empties
// the store; that single step must not poison the refill trend it
// interrupted) and any interval touching a null reading (room/nuker absent
// from that snapshot, or predating this field entirely).
export function stockRate(sel, history) {
    const { delta, ticks } = accumulateDeltas(sel, history, { dropTolerant: false });
    return ticks > 0 && delta > 0 ? delta / ticks : null;
}

// Per-tick net delta of a plain numeric field between consecutive history
// rows — the drop-tolerant analogue of rateSeries, for fields that are NOT
// {l,p,pt} and where a decrease is real signal (e.g. defender-zone rampart
// hits taking combat damage or a rebuilt segment resetting the zone minimum), not noise
// to be filtered like a nuker launch. Unlike stockRate, a drop is returned as
// a negative value, never skipped.
export function netRateSeries(sel, history) {
    return history.map((r, i) => {
        if (i === 0) return null;
        const prev = sel(history[i - 1]), cur = sel(r);
        const dTick = r.tick - history[i - 1].tick;
        if (prev == null || cur == null || dTick <= 0) return null;
        return (cur - prev) / dTick;
    });
}

// Average net rate over the whole window — the drop-tolerant analogue of
// windowRate/stockRate for a plain numeric field. Unlike stockRate, does NOT
// skip an interval where the value dropped, and unlike windowRate, does NOT
// return null for a non-positive net change: zero or negative is a valid,
// meaningful answer (flat or shrinking), and the caller (netEta) is what
// decides a non-positive rate has no ETA. Null only when there's no usable
// coverage at all (fewer than 2 rows, or no interval had both a positive
// dTick and two non-null readings).
export function netWindowRate(sel, history) {
    if (history.length < 2) return null;
    const { delta, ticks } = accumulateDeltas(sel, history, { dropTolerant: true });
    if (ticks <= 0) return null;
    return { rate: delta / ticks, msPerTick: observedMsPerTick(history) };
}

// Plain arithmetic mean over non-null values — the flat avg reference line
// for a chart like CPU used that's a plain per-tick value, not a
// progress/rate field, so windowRate/netWindowRate don't apply.
export function average(values) {
    const nums = values.filter(v => v != null);
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Shared {rate, etaTicks, etaMs} construction behind netEta/levelEta.
function etaFromRate(wr, etaTicks) {
    return { rate: wr.rate, etaTicks, etaMs: wr.msPerTick ? etaTicks * wr.msPerTick : null };
}

// ETA to an explicit external target for a plain current value — the
// netWindowRate analogue of levelEta, for fields that carry their target
// externally (zoneTarget(rcl)) rather than embedded as {pt}. Takes
// an already-computed netWindowRate result rather than sel/history, since
// every caller already has (or needs) `wr` itself — see zoneGrowthTile in
// app.js. Null when there's nothing to reach (cur/target absent, or cur
// already at/above target — a maxed-out ETA of 0 would be as misleading as
// levelEta's !cur.pt case) or when the rate isn't positive (flat or
// shrinking is a real possibility here, unlike levelEta's monotonic
// progress).
export function netEta(cur, target, wr) {
    if (cur == null || target == null || cur >= target) return null;
    if (!wr || wr.rate <= 0) return null;
    const etaTicks = (target - cur) / wr.rate;
    return etaFromRate(wr, etaTicks);
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
    return etaFromRate(wr, etaTicks);
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

// How far apart two consecutive stored rows must be before the dashboard
// treats the space between them as a collection outage rather than normal
// cadence. The collector writes nothing when a poll fails outright or the
// bot's history buckets no longer cover the miss (see
// scripts/collect.mjs) — there's no placeholder doc, so a real outage is
// only visible as unusually wide spacing between two rows that do exist.
const GAP_FACTOR = 3;

// Flags each history[i] whose row is further from history[i-1] than
// GAP_FACTOR times the caller's normal cadence for the active view
// (raw polling interval, or the LOD_BUCKET_MS width behind the range's flag
// — see LOD_BY_RANGE). A fixed threshold would misfire on the coarser
// ranges, where rows are naturally spaced much further apart than on the
// raw one, so the expected interval has to come from the caller.
export function detectGaps(history, expectedIntervalMs) {
    if (!expectedIntervalMs) return [];
    const gaps = [];
    for (let i = 1; i < history.length; i++) {
        const startMs = history[i - 1].date.getTime();
        const endMs = history[i].date.getTime();
        const durationMs = endMs - startMs;
        if (durationMs > expectedIntervalMs * GAP_FACTOR) {
            gaps.push({ afterIndex: i, startMs, endMs, durationMs });
        }
    }
    return gaps;
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

// CRITICAL_RAMPAT_SAFE — screeps2 config/config.buildPriority.ts:33. Ramparts
// under this get repair priority 0 in the bot itself, so it's an absolute
// cliff, not a fraction-of-target ramp level.
export const CRITICAL_RAMPART_HITS = 4000;

// The role the standing remote guard slot spawns as (screeps2
// config/remoteRoles/provider.remoteDefender.ts). `thr.def[]` only ever
// contains home_defender/home_melee_defender (COMBAT_ROLES, threatReport.ts),
// so these guards are found by scanning `roles` separately and merged in by
// the caller. Only the STANDING guard is reliably visible this way: an
// on-demand squad has a manifest row solely while it is still spawning — the
// deployed phase lives in `ar`, see the "Army routes" section below.
export const MANIFEST_GUARD_ROLE = "army_member";

// Nuker capacities/cooldown — game constants, not in any payload.
export const NUKER_GHODIUM_CAPACITY = 5000;
export const NUKER_ENERGY_CAPACITY = 300000;
export const NUKER_COOLDOWN = 100000; // ticks after a launch

// RCL-scaled defender-zone rampart repair targets — screeps2
// config/config.repairs.ts DEFAULT_SAFE_ZONE_RAMPART_MAX_HEALTH, copied
// verbatim (REPAIRS_BY_SHARD is empty today, so the defaults are live
// everywhere). Colouring zone hits against these rather than an absolute
// threshold is the point: a healthy RCL6 rampart and a neglected RCL8 one
// must not read the same.
export const ZONE_RAMPART_TARGETS = { 1: 2_000, 2: 10_000, 3: 20_000, 4: 200_000, 5: 1_000_000, 6: 2_200_000, 7: 11_200_000, 8: 300_000_000, default: 10_000 };

// Storage class hysteresis — screeps2 config/config.storageClass.ts, copied
// verbatim. Only used to explain `sc` in words; the bot resolves the class
// itself (classifyStorageRoom) and the dashboard never re-derives it.
export const OUTPOST_MAX_RCL = 6;
export const VAULT_GRADUATION_HITS = 5_000_000;
export const VAULT_FLOOR_HITS = 3_000_000;

// `sc` (vault/outpost) plus `scm` (pin/config, only when an override decided
// it) → cell word and its explanation. null when the snapshot predates `sc`.
export function storageClassInfo(room) {
    if (!room?.sc) return null;
    const suffix = room.scm === "pin" ? " (pinned)" : room.scm === "config" ? " (config)" : "";
    const why = room.scm === "pin" ? "pinned via console setStorageClass"
        : room.scm === "config" ? "STORAGE_CLASS_BY_SHARD_AND_ROOM override"
        : room.rcl?.l != null && room.rcl.l <= OUTPOST_MAX_RCL ? `RCL ≤ ${OUTPOST_MAX_RCL} — always outpost`
        : `auto: zone ≥ ${fmtHits(VAULT_GRADUATION_HITS)} graduates to vault, < ${fmtHits(VAULT_FLOOR_HITS)} reverts`;
    return { word: room.sc + suffix, why };
}

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

export function zoneTarget(rcl) {
    return ZONE_RAMPART_TARGETS[rcl] ?? ZONE_RAMPART_TARGETS.default;
}

// null (not a ramp bucket) when hits is absent — absence must never render as
// "good" just because there's nothing to fill the bar with.
export function zoneLevel(hits, rcl) {
    if (hits == null) return null;
    const target = zoneTarget(rcl);
    return rampLevel(Math.min(1, hits / target));
}

// Absolute cliff below CRITICAL_RAMPART_HITS, independent of RCL.
export function isCriticalZone(hits) {
    return hits != null && hits < CRITICAL_RAMPART_HITS;
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

// ---------- the empire verdict ----------
// One answer to "is anything on fire?", for the board that sits above
// everything else on the page. Pure so it can be tested; all the wording,
// colour and DOM stays in app.js, the same split remoteThreatClass already
// has with REMOTE_CLASS_COLOR.
//
// The load-bearing rule: a payload that dropped its threat detail must NEVER
// produce a calm verdict. thr/roles/rt ride the FIRST degradation step in the
// bot's StatsManager, so the snapshots most likely to be degraded are exactly
// the busy ones — a green "all clear" on a degraded snapshot would be worse
// than the table it replaces. `degraded` says so, and callers must lead with
// it.
export function empireVerdict(latest) {
    const rooms = Object.values(latest?.rooms ?? {});
    // `nuked`/`spawnless`/`outgunned` REPLACE a room's posture here rather than
    // sitting beside it, so every room is counted exactly once and the
    // subtitle can't report one room twice. (`strongholds` below is a separate
    // axis — it comes from `rt`, not from these rooms.)
    const counts = { nuked: 0, spawnless: 0, outgunned: 0, exposed: 0, engaged: 0, unknown: 0, clear: 0 };
    for (const r of rooms) {
        counts[hasIncomingNuke(r) ? "nuked" : hasNoSpawn(r) ? "spawnless" : isOutgunned(r.thr) ? "outgunned" : roomPosture(r.thr).level]++;
    }
    const degraded = rooms.length > 0 && !hasThreatDetail(latest);
    const strongholds = (latest?.rt ?? []).filter(e => remoteThreatClass(e) === "stronghold").length;
    // Worst first, and `unknown` outranks `clear` for the same reason
    // POSTURE_RANK puts it there: silence is not safety. `nuked` leads even
    // `spawnless` — a scheduled, unavoidable hit outranks a structural
    // weakness — and `spawnless` outranks `outgunned` — a colony that cannot
    // rebuild lost creeps is worse off than one merely losing the current
    // fight.
    const level = counts.nuked ? "nuked"
        : counts.spawnless ? "spawnless"
        : counts.outgunned ? "outgunned"
        : counts.exposed ? "exposed"
        : counts.engaged ? "engaged"
        : strongholds ? "stronghold"
        : counts.unknown ? "unknown"
        : "clear";
    return { level, counts, strongholds, degraded, rooms: rooms.length };
}

// Every actionable item in one worst-first list, across two domains that the
// page used to keep in separate tables: owned rooms (from `rooms[].thr`) and
// non-owned rooms (from `rt`). Rooms that are genuinely clear are dropped;
// `unknown` ones are NOT — see empireVerdict.
//
// Ranking is an extension of POSTURE_RANK rather than a new scheme. An armed
// stronghold sorts below an engaged owned room on purpose: a remote has
// nothing to lose, an owned room has everything. `spawnless` leads even
// `outgunned` — see empireVerdict. `nuked` leads even `spawnless` — see
// empireVerdict.
const THREAT_RANK = { nuked: 0, spawnless: 1, outgunned: 2, exposed: 3, engaged: 4, stronghold: 5, unknown: 6 };

export function threatItems(latest) {
    const items = [];
    for (const [room, r] of Object.entries(latest?.rooms ?? {})) {
        const posture = roomPosture(r.thr);
        const spawnless = hasNoSpawn(r);
        const nuked = hasIncomingNuke(r);
        // A spawnless or nuked room must surface even with a clear combat
        // posture — both are structural/scheduled conditions, not threat ones,
        // and can be true whether or not the room is currently under attack.
        if (posture.level === "clear" && !spawnless && !nuked) continue;
        const net = r.thr ? netTowerDps(r.thr) : null;
        // "Outgunned" REPLACES the posture rather than qualifying it: a room whose
        // towers cannot break the heal leads the list whether the bot called it
        // exposed or merely engaged. See isOutgunned. `spawnless`/`nuked` replace
        // all of the above.
        const kind = nuked ? "nuked" : spawnless ? "spawnless" : isOutgunned(r.thr) ? "outgunned" : posture.level;
        items.push({
            scope: "room", kind, room, thr: r.thr, roles: r.roles, rcl: r.rcl, posture, net,
            spawnless, nukes: incomingNukes(r),
        });
    }
    for (const entry of latest?.rt ?? []) {
        if (remoteThreatClass(entry) !== "stronghold") continue;
        items.push({ scope: "remote", kind: "stronghold", room: entry.room, entry });
    }
    return items.sort((a, b) =>
        THREAT_RANK[a.kind] - THREAT_RANK[b.kind]
        // Within a kind: the hardest hit first, then by name so the order is
        // stable across polls.
        || (b.thr?.h ?? b.entry?.h ?? 0) - (a.thr?.h ?? a.entry?.h ?? 0)
        || a.room.localeCompare(b.room));
}

// A spawnless or nuked room is never "clear" — see empireVerdict/threatItems,
// which give both the same override treatment. Without this, a room with
// sp: 0 (or an incoming nuke) but a calm thr reading would show up here AND
// as a critical card on the threat board above it.
export function clearRooms(latest) {
    return Object.entries(latest?.rooms ?? {})
        .filter(([, r]) => roomPosture(r.thr).level === "clear" && !hasNoSpawn(r) && !hasIncomingNuke(r))
        .map(([name]) => name)
        .sort();
}
// The threat board's quiet tier: rooms the bot calls clear that a reader
// should still look at. Today that is one condition — an RCL8 room whose
// defender zone sits under the CRITICAL_RAMPART_HITS cliff, which the bot's
// posture never considers because it only judges rooms with hostiles in them.
// Deliberately never feeds empireVerdict: a watch item must not turn the
// headline red or claim the room is under threat. Weakest zone first.
export function watchItems(latest) {
    const clear = new Set(clearRooms(latest));
    return Object.entries(latest?.rooms ?? {})
        .filter(([name, r]) => clear.has(name) && r.rcl?.l === 8 && isCriticalZone(r.thr?.defRmp))
        .map(([room, r]) => ({ room, kind: "zone", hits: r.thr.defRmp }))
        .sort((a, b) => a.hits - b.hits || a.room.localeCompare(b.room));
}

// The clear rooms left once the watch line has taken its own: the rooms the
// page names as plainly "clear". The single place that split is made, so the
// verdict subtitle, the clear line and the phone Defense fold always agree.
export function quietRooms(latest) {
    const watched = new Set(watchItems(latest).map(w => w.room));
    return clearRooms(latest).filter(name => !watched.has(name));
}

export function sortByPosture(entries) {
    return [...entries].sort(([nameA, roomA], [nameB, roomB]) => {
        const rankA = POSTURE_RANK[roomPosture(roomA.thr).level];
        const rankB = POSTURE_RANK[roomPosture(roomB.thr).level];
        return rankA !== rankB ? rankA - rankB : nameA.localeCompare(nameB);
    });
}

// thr.dps is the bot's getSupportTowerDamage: every armed tower on the hostile
// they hit weakest, at its actual range (0 when the room is clear); heal is the hostiles'
// boost-folded healing per tick. Named (rather than left inline) so the
// table cell, the empire tile, and the balance chart can't drift apart on
// what "net" means.
export function netTowerDps(thr) {
    return thr.dps - (thr.heal ?? 0);
}

// Hostiles out-healing the towers. Not a posture the bot reports, and it
// outranks every posture the bot does report: until the towers can break the
// heal, nothing else about the room matters yet. Shared by empireVerdict,
// threatItems and the dashboard's Defense tile, so the banner, the cards and
// the tile cannot disagree about which rooms count. Callers earlier in this
// file reach it by hoisting, as they already do for netTowerDps.
export function isOutgunned(thr) {
    return !!thr && thr.h > 0 && netTowerDps(thr) < 0;
}

// A destroyed spawn structure — checked against an explicit 0, never a falsy
// `sp`, so a snapshot predating the bot deploy that adds this field (`sp` is
// `undefined` there) reads as "unknown", not "spawnless". Outranks even
// isOutgunned: a room that cannot rebuild lost creeps is in worse shape than
// one merely losing the current fight.
export function hasNoSpawn(r) {
    return r.sp === 0;
}

// The bot already publishes soonest-first, but re-sort defensively anyway —
// the same caution sortRemoteThreats takes with rt's bot-sorted order.
export function incomingNukes(r) {
    return [...(r.nukes ?? [])].sort((a, b) => a[0] - b[0]);
}

// A scheduled, unavoidable hit — see empireVerdict/threatItems, which give it
// the same override treatment hasNoSpawn gets, ranked even higher: a nuke in
// flight is the single most decision-relevant fact about a room when true.
export function hasIncomingNuke(r) {
    return incomingNukes(r).length > 0;
}

// Everything the dashboard needs to render the def[] cell/chart correctly,
// including both false-alarm traps around an empty def[]:
//
//  - def[] only ever contains home_defender/home_melee_defender slots
//    (COMBAT_ROLES). Standing army_member guards live in `roles`, not
//    `thr.def`, so they're found separately here and merged in as `guards`.
//    On-demand squads are NOT here — they come from `ar` (armyRoutesForHome),
//    which the callers render beside this summary.
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

// A forming on-demand squad still has a manifest row in `roles` tagged
// army_member, indistinguishable there from a standing guard — `ar` already
// has the fuller picture (phase, losses) for these targets, so guards whose
// target room is already covered by an ar route are dropped here to avoid
// the same squad rendering twice in a chart that merges both sources.
export function excludeRoutedGuards(guards, routes) {
    const routedTargets = new Set(routes.map(r => r.target));
    return guards.filter(g => !routedTargets.has(g.rm));
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
                        peakH: 0, peakMelee: 0, peakRanged: 0, peakHeal: 0, owners: new Set(), boosted: false,
                    };
                    open.set(room, ep);
                }
                ep.toMs = row.date;
                ep.toTick = row.tick;
                ep.peakH = Math.max(ep.peakH, r.thr.h);
                ep.peakMelee = Math.max(ep.peakMelee, r.thr.melee ?? 0);
                ep.peakRanged = Math.max(ep.peakRanged, r.thr.ranged ?? 0);
                ep.peakHeal = Math.max(ep.peakHeal, r.thr.heal ?? 0);
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

// ---------------------------------------------------------------------------
// Remote threats (rt) — hostiles cached in NON-owned rooms (remotes, SK rooms,
// corridors). screeps2/src/manager/StatsManager.ts (buildRemoteThreats,
// remoteThreatRank), src/utils/console/healthSnapshot.ts
// (collectRemoteThreats) and docs/stats-history-ring.md are the source of
// truth these mirror.
//
// `rt` is snapshot-level, not per-room: the bot's hostile cache is keyed by
// room, and a corridor sighting belongs to no home at all. It rides
// DEGRADATION_STEPS[0], the same step that drops `roles`/`thr`, so it is
// always complete on meta/latest but only best-effort in stored history.

// HOSTILE_CACHE_TTL — screeps2 src/manager/hostileCache.ts:6. `age` is
// Game.time - lastSeenTick, so past this the entry is a cached memory of a
// room that has gone dark, not a live reading, and must not render as one.
// A `mem: 1` row is the other way to land here: carried from the bot's
// Memory.roomIntel rather than its cache, it runs to the stronghold's decay
// deadline (~5000 ticks) by design, since the bot stops mining and loses vision.
export const REMOTE_STALE_AGE_TICKS = 300;

// STATS_CONFIG.maxRemoteThreats — screeps2 src/config/config.stats.ts. The bot
// ranks before it slices, so a list at exactly this length has had its least
// actionable rooms cut and the reader should know the view is truncated.
export const MAX_REMOTE_THREATS = 30;

// Reproduces remoteThreatRank (StatsManager.ts) term for term, so the
// dashboard and the bot never disagree about how alarming a remote is. Core
// presence alone is the wrong key: a level-0 reserving core is harmless (the
// bot keeps farming next to it) and an SK room permanently caches its three
// standing guards, so neither may outrank a room holding real hostiles.
export function remoteThreatClass(entry) {
    if (entry.coreLvl !== undefined && entry.coreLvl > 0) return "stronghold";
    if (entry.owners?.some(owner => owner !== "Source Keeper")) return "hostiles";
    if (entry.coreLvl !== undefined) return "core";
    return "keepers";
}

const REMOTE_CLASS_RANK = { stronghold: 0, hostiles: 1, core: 2, keepers: 3 };

// Sign convention published by screeps2 StatsManager (docs/stats-history-ring.md): exp > 0 is
// the absolute tick an armed stronghold's core collapses; exp < 0 is -(absolute tick) it
// finishes deploying, while it still counts down toward zero — hence "negative before
// deployment". Absent `exp` means neither is known.
export function remoteDeployPhase(exp, tick) {
    if (exp === undefined) return null;
    return exp > 0 ? { phase: "expires", ticks: exp - tick } : { phase: "deploys", ticks: -exp - tick };
}

// The bot already sorts and then slices to maxRemoteThreats, so the stored
// order is right — but the slice can cut mid-class and a hand-written doc need
// not be sorted at all. Sorting here makes the table's order self-evident
// rather than inherited. Ties break on hostile count then freshness, as the
// bot's own comparator does.
export function sortRemoteThreats(entries) {
    return [...entries].sort((a, b) =>
        REMOTE_CLASS_RANK[remoteThreatClass(a)] - REMOTE_CLASS_RANK[remoteThreatClass(b)]
        || b.h - a.h
        || a.age - b.age
        || a.room.localeCompare(b.room));
}

// Whether a snapshot still carries first-step detail — the probe that makes an
// absent `rt` readable.
//
// buildRemoteThreats returns undefined for an empty list, so a missing `rt`
// means EITHER "no remote hostiles cached" OR "degraded away" — unlike `thr`,
// which says h: 0 when clear. DEGRADATION_STEPS[0].drop deletes per-room
// roles/thr and top-level rt in one pass over the whole snapshot, and
// buildRoomStats sets `thr` unconditionally. So if any room here has `thr`,
// step 0 was not applied, and this snapshot's missing `rt` genuinely means
// "nothing cached". Without this, every quiet snapshot would count as a
// coverage gap and the log's note would cry wolf.
export function hasThreatDetail(row) {
    return Object.values(row.rooms ?? {}).some(r => r.thr);
}

// Collapses consecutive rt appearances per room into episodes for the remote
// activity log — the rt analogue of hostileEpisodes, and deliberately the same
// shape so the two logs read alike.
//
// Two differences from hostileEpisodes, both load-bearing:
//
//  - Keeper-only entries are excluded. An SK remote permanently caches its
//    three standing guards, so logging them would give every SK room one
//    endless episode in every range and bury the actual raids. A level-0 core
//    still logs: a core landing in a remote is an event, even a harmless one.
//  - BOTH ends of the tick range are the sighting's own, not the observing
//    snapshot's: fromTick is min(row.tick - entry.age) and toTick is
//    max(row.tick - entry.age). `age` recovers lookback the LOD sampling
//    throws away, so the replay link lands on the hostiles' actual arrival
//    rather than on whichever snapshot happened to be that bucket's leader.
//    Back-dating toTick as well is what keeps a finished raid from reading as
//    current: the bot's hostileCache holds an entry for REMOTE_STALE_AGE_TICKS
//    after the room went dark, so every snapshot in that tail still lists it,
//    and taking toTick from the snapshot would stretch the episode ~300 ticks
//    past its actual end (and let a later re-sighting open a second episode
//    overlapping the first). `staleTicks` carries how far behind the last
//    observing snapshot that final sighting already was, so the caller can
//    convert it to wall clock; fromMs/toMs stay the observing rows' own clocks
//    (there's no ms-per-tick ratio in scope here), so both ticks can predate
//    what their ms counterpart suggests.
//
// Rows that carry no first-step detail are skipped without closing an open
// episode, as in hostileEpisodes: one degraded row mid-raid must not split one
// incursion into two log entries.
export function remoteEpisodes(history) {
    const open = new Map(); // room -> in-progress episode
    const episodes = [];
    let covered = 0;
    for (const row of history) {
        if (!hasThreatDetail(row)) continue;
        covered++;
        const seen = new Set();
        for (const entry of row.rt ?? []) {
            const cls = remoteThreatClass(entry);
            if (cls === "keepers") continue;
            seen.add(entry.room);
            let ep = open.get(entry.room);
            if (!ep) {
                ep = {
                    room: entry.room, home: entry.home,
                    fromMs: row.date, toMs: row.date,
                    fromTick: row.tick - entry.age, toTick: row.tick - entry.age,
                    staleTicks: entry.age,
                    peakH: 0, peakMelee: 0, peakRanged: 0, peakHeal: 0, owners: new Set(),
                    peakCoreLvl: undefined,
                };
                open.set(entry.room, ep);
            }
            if (entry.home) ep.home = entry.home;
            ep.toMs = row.date;
            ep.fromTick = Math.min(ep.fromTick, row.tick - entry.age);
            ep.toTick = Math.max(ep.toTick, row.tick - entry.age);
            // assigned after toTick so it always describes the LAST observing row
            ep.staleTicks = row.tick - ep.toTick;
            ep.peakH = Math.max(ep.peakH, entry.h);
            ep.peakMelee = Math.max(ep.peakMelee, entry.melee ?? 0);
            ep.peakRanged = Math.max(ep.peakRanged, entry.ranged ?? 0);
            ep.peakHeal = Math.max(ep.peakHeal, entry.heal ?? 0);
            for (const o of entry.owners ?? []) ep.owners.add(o);
            if (entry.coreLvl !== undefined) ep.peakCoreLvl = Math.max(ep.peakCoreLvl ?? 0, entry.coreLvl);
        }
        for (const room of [...open.keys()]) {
            if (seen.has(room)) continue;
            episodes.push(finishEpisode(open.get(room)));
            open.delete(room);
        }
    }
    for (const ep of open.values()) episodes.push(finishEpisode(ep));
    // Newest-first on the tick the hostiles were last SEEN, which is what the
    // log's When column shows — sorting on toMs instead would order the rows by
    // which snapshot happened to still carry the cached sighting, so a raid
    // that ended hours ago could sort above a live one. Ticks need no
    // ms-per-tick ratio and are monotone across one history, so they're the
    // right key here; toMs only breaks ties.
    episodes.sort((a, b) => b.toTick - a.toTick || b.toMs - a.toMs);
    return { episodes, covered, total: history.length };
}

// ---------------------------------------------------------------------------
// Army routes (ar) — the squads a home room fields against a threat in another
// room. screeps2/src/manager/StatsManager.ts (buildArmyRoutes) reads them
// straight off Memory.armies; ArmyManager.ts owns the lifecycle they mirror.
//
// Why a separate field: the spawn manifest (`roles`) only ever carries a route
// while a FORMING squad still has a queued slot, so an engaged squad —
// marching, or fighting in the remote — has no manifest row at all. `ar` is
// what makes that phase visible. It is snapshot-level like `rt` (a route is
// home→target, not a room), rides the same first degradation step, and is
// omitted when no army exists, so an absent `ar` is read through
// hasThreatDetail exactly as an absent `rt` is: "no armies" when the snapshot
// still carries `thr`, "unknown" when it does not.
//
// Per-squad shape: `st` is 'forming' | 'engaged'; `n` is member slots by
// status [queued, spawning, alive, dead]; `at` is ALIVE members by location
// [home, target, elsewhere]. An engaged squad never respawns, so its dead
// count is a permanent loss, not a pending spawn — the two are kept apart
// here rather than summed into one "short by N".

export function squadSummary(sq) {
    const [queued, spawning, alive, dead] = sq.n;
    const [atHome, atTarget, inTransit] = sq.at;
    return {
        id: sq.id, status: sq.st,
        queued, spawning, alive, dead, total: queued + spawning + alive + dead,
        atHome, atTarget, inTransit,
        boosted: sq.b === 1, held: sq.hold === 1,
    };
}

const ROUTE_SUM_KEYS = ["queued", "spawning", "alive", "dead", "total", "atHome", "atTarget", "inTransit"];

export function routeSummary(route) {
    const squads = (route.sq ?? []).map(squadSummary);
    const out = {
        home: route.home, target: route.target, kind: route.kind ?? "defense", squads,
        forming: squads.filter(s => s.status === "forming").length,
        engaged: squads.filter(s => s.status === "engaged").length,
        boosted: squads.some(s => s.boosted),
        held: squads.some(s => s.held),
    };
    for (const k of ROUTE_SUM_KEYS) out[k] = squads.reduce((a, s) => a + s[k], 0);
    out.phase = routePhase(out);
    return out;
}

// One word for where a route stands. Checked in the order a reader needs
// answered: is anything left at all, has anything dispatched, has anyone
// arrived, is anyone on the way. A route with an engaged squad still wholly at
// home is "staging" — just engaged, or held there (`held`) because its escort
// chain was aborted before it spawned.
export function routePhase(r) {
    if (r.alive + r.spawning + r.queued === 0) return "wiped";
    if (r.engaged === 0) return "forming";
    if (r.atTarget > 0) return "deployed";
    if (r.inTransit > 0) return "in transit";
    return "staging";
}

// The one-line status a cell or board row shows for a route. Losses are named
// as "lost", never folded into a shortfall — see the section comment.
export function routeStatusText(r) {
    const parts = [];
    switch (r.phase) {
        case "forming": parts.push(`forming · ${r.alive + r.spawning} of ${r.total - r.dead} spawned`); break;
        case "staging": parts.push(`staging · ${r.alive} at home${r.held ? " (held)" : ""}`); break;
        case "in transit": parts.push(`in transit · ${r.inTransit} en route`); break;
        case "deployed":
            parts.push(`deployed · ${r.atTarget} in room${r.inTransit ? `, ${r.inTransit} en route` : ""}`);
            break;
        case "wiped": parts.push(`wiped · ${r.dead} lost`); break;
    }
    if (r.phase !== "forming" && r.forming) parts.push(`+${r.forming} forming`);
    if (r.phase !== "wiped" && r.dead) parts.push(`${r.dead} lost`);
    if (r.boosted) parts.push("boosted");
    return parts.join(" · ");
}

// Memoized on `latest`'s identity: `latest` is replaced wholesale each
// snapshot (bot → collector → Firestore → dashboard), so a single-slot
// reference-keyed cache is safe — a new snapshot always misses and
// recomputes — and saves every row/card in a render pass from re-summarizing
// the whole `ar` array on its own.
let armyRoutesCache = null; // { latest, routes }

export function armyRoutes(latest) {
    if (armyRoutesCache?.latest === latest) return armyRoutesCache.routes;
    const routes = (latest?.ar ?? [])
        // A route with no squads at all isn't a loss, just absent — without
        // this, routePhase's "nothing alive/spawning/queued" check reads an
        // empty roster as "wiped" and prints the nonsensical "wiped · 0 lost".
        .filter(r => (r.sq ?? []).length > 0)
        .map(routeSummary);
    armyRoutesCache = { latest, routes };
    return routes;
}

const ROUTE_PHASE_RANK = { wiped: 0, deployed: 1, "in transit": 2, staging: 3, forming: 4 };

// The route answering one `rt` entry: its `home` is the colony, its `room` the
// target. Null when no such route exists — the caller decides between "none"
// and "unknown" with hasThreatDetail. When more than one route matches the
// same pair (nothing in this payload rules that out), the most urgent phase
// wins rather than an arbitrary array-order pick.
export function armyRouteFor(latest, home, target) {
    const routes = armyRoutes(latest).filter(r => r.home === home && r.target === target);
    if (!routes.length) return null;
    return routes.reduce((worst, r) => ROUTE_PHASE_RANK[r.phase] < ROUTE_PHASE_RANK[worst.phase] ? r : worst);
}

export function armyRoutesForHome(latest, home) {
    return armyRoutes(latest)
        .filter(r => r.home === home)
        .sort((a, b) => a.target.localeCompare(b.target));
}

// What a route-status cell should show for one (home,target) pair: an actual
// route, or which of the two absence states the caller must otherwise derive
// itself via hasThreatDetail — "none planned" vs. "detail dropped this
// snapshot". Centralizes the branch every route cell in app.js needs.
export function routeOrAbsence(latest, home, target) {
    const route = armyRouteFor(latest, home, target);
    return route ? { route } : { absent: hasThreatDetail(latest) ? "none" : "unknown" };
}

export function routesOrAbsence(latest, home) {
    const routes = armyRoutesForHome(latest, home);
    return routes.length ? { routes } : { absent: hasThreatDetail(latest) ? "none" : "unknown" };
}

// ---------------------------------------------------------------------------
// Power harvesting (pb / ph / pba / pw) — the power-bank pipeline.
// screeps2/src/manager/StatsManager.ts (buildPowerBanks) reads it off
// Memory.highwayIntel + the planner's verdict cache; docs/stats-history-ring.md
// ("Power banks") is the field-by-field contract these mirror, and the bot's
// debugPowerBanks() console command is the same view in text form.
//
// Four fields, three of them snapshot-level because a bank is home-agnostic:
// several homes may hold a cached verdict on the same bank and only one ever
// reads `committed`.
//
//  - `pb`  live banks: power, last-seen hits, `dec` ticks to decay, `ft` free
//          adjacent tiles, `con` contestant totals [count, Σdps, Σheal], `dps`
//          our attackers' summed dps in the bank room, `pl` the planner's
//          CACHED decision per home, `sq` waves/fight squads, `hl` haulers.
//  - `ph`  haulers whose bank record is already gone: our own kill deletes the
//          intel record exactly while they are loading, so the loot leg home
//          would otherwise vanish from the payload entirely.
//  - `pba` the autoHarvest gate, a scalar that is ALWAYS published and never
//          degraded — the only thing that keeps "gate off" apart from "no
//          banks" apart from "degraded away".
//  - `pw`  per-room [storage, terminal, power spawn, processing 0|1]. It is in
//          no degradation step, so its history is complete going forward (the
//          `gpl` case); the only gap is the ticks before the collector began
//          persisting it, which cannot be backfilled.
//
// `pb`/`ph` ride DEGRADATION_STEPS[0] with roles/thr/rt/ar, so absence is read
// through hasThreatDetail exactly as `rt` and `ar` are.

// `age` is Game.time - lastSeenTick: StatsManager never reads the bank room,
// so hits/power only refresh while something of ours has vision there. Past a
// bank's own decay the record is dropped, but until then a row can outlive the
// real structure — the same "memory, not a live reading" caveat as a remote.
export const POWER_BANK_STALE_AGE_TICKS = 300;

// Which of the three readings a snapshot's gate carries. Deliberately not a
// boolean: `uncollected` is a snapshot stored before the collector persisted
// `pba` at all, and must never render as "off".
export function powerGateState(row) {
    if (row?.pba === undefined) return "uncollected";
    return row.pba === 1 ? "on" : "off";
}

// The banks a snapshot shows, or which absence it is. `pb` is omitted on an
// empty list AND dropped by degradation, so the branch needs hasThreatDetail
// the same way routesOrAbsence does. The gate is reported alongside because a
// reader's first question about an empty list is whether harvesting is even
// switched on.
export function powerBanksOrAbsence(latest) {
    const gate = powerGateState(latest);
    const banks = latest?.pb ?? [];
    if (banks.length) return { banks, gate };
    if (gate === "uncollected") return { absent: "uncollected", gate };
    if (gate === "off") return { absent: "off", gate };
    return { absent: hasThreatDetail(latest ?? {}) ? "none" : "unknown", gate };
}

// Ticks until our attackers break the bank, against the ticks until it decays
// on its own. `dps` is 0 whenever nothing of ours is swinging — including
// every bank we have not committed to — so "never" here is the normal case,
// not an error, and the caller renders it as a word rather than an infinity.
export function bankEta(bank) {
    const decayIn = bank.dec;
    if (!bank.dps) return { killIn: null, decaysFirst: true, decayIn };
    const killIn = Math.ceil(bank.hits / bank.dps);
    return { killIn, decaysFirst: killIn > decayIn, decayIn };
}

// Contestants are other players racing or fighting us for the same bank.
// `con` is omitted when there are none; [count, Σdps, Σheal] when there are.
export function bankContest(bank) {
    if (!bank.con) return null;
    const [count, dps, heal] = bank.con;
    return { count, dps, heal };
}

export function bankStale(bank) {
    return bank.age >= POWER_BANK_STALE_AGE_TICKS;
}

// The planner's CACHED decision per home (screeps2 powerBankVerdict.ts), never
// a fresh evaluation: `committed` is a cached go (`m` says loot/fight/race),
// `skip` a committed skip, `retry` a skip awaiting re-evaluation with `in`
// ticks to go (≤ 0 once due). The cache is heap state, so the first publish
// after a global reset legitimately carries no `pl` at all — an empty list is
// "not decided yet", not "no home in range".
// A `contested` skip/retry may carry `ab`, why the planner abandoned
// (dark / undefendable / holding / late / unreachable), and `abt`, the
// [our fight fleet ETA, rival's kill] clock in ticks from `t` — either side
// null when that abandon had no such number (`unreachable` has only the kill).
export function bankPlans(bank) {
    return (bank.pl ?? []).map(p => ({
        home: p.h,
        kind: p.k,
        mode: p.m ?? null,
        reason: p.r ?? null,
        retryIn: p.in ?? null,
        abandon: p.ab ?? null,
        fleetIn: p.abt?.[0] ?? null,
        killIn: p.abt?.[1] ?? null,
        text: planText(p),
    })).sort((a, b) => a.home.localeCompare(b.home));
}

function reasonText(p) {
    if (!p.r) return null;
    if (!p.ab) return p.r;
    const [fleet, kill] = p.abt ?? [null, null];
    const clock = fleet != null && kill != null ? `, fleet ${fleet}t > kill ${kill}t`
        : kill != null ? `, rival kills in ${kill}t` : "";
    return `${p.r}: ${p.ab}${clock}`;
}

function planText(p) {
    const why = reasonText(p);
    switch (p.k) {
        case "committed": return `committed ${p.m ?? "go"}`;
        case "skip": return `skip · ${why ?? "no reason given"}`;
        case "retry": {
            const suffix = why ? ` (${why})` : "";
            return (p.in ?? 0) > 0 ? `retry in ${p.in}t${suffix}` : `retry due${suffix}`;
        }
        default: return p.k;
    }
}

// `sq` carries only what `ar` lacks — the harvest wave number `w` and the
// fight flag `f` — so status and member counts come from joining back to the
// army route on home + bank room + squad id. Harvest armies are kind
// 'offense'. A join miss is normal rather than an error: `ar` and `pb` ride
// the same degradation step but `ar` is also omitted when Memory.armies is
// empty, and the two are built from different sources within one tick.
export function bankSquads(latest, bank) {
    return (bank.sq ?? []).map(s => {
        const route = armyRoutes(latest ?? {}).find(r =>
            r.home === s.home && r.target === bank.rm && r.squads.some(q => q.id === s.id));
        const squad = route?.squads.find(q => q.id === s.id) ?? null;
        return {
            id: s.id, home: s.home,
            fight: s.f === 1,
            wave: s.w ?? null,
            // Squad-level, not route-level: one route carries both the harvest
            // wave and its fight squad, so route phase/status would describe
            // the pair rather than the row the reader is pointing at.
            squad,
            status: squad?.status ?? null,
            route: route ?? null,
        };
    }).sort((a, b) => a.home.localeCompare(b.home) || a.id - b.id);
}

// One row per unit of ours on the power pipeline: every squad on a live bank
// (via bankSquads, so the `ar` join stays in one place) plus the `ph` haulers
// whose bank record is already gone. Live-bank haulers are not here — they
// stay a column on the bank itself. `pb`/`ph` share a degradation step, so a
// snapshot missing `pb` for any reason can still carry `ph` rows, and does.
export function powerFleetRows(latest) {
    const banks = latest?.pb ?? [];
    const squads = banks.flatMap(bank => bankSquads(latest, bank).map(s => ({
        kind: "squad", rm: bank.rm, live: true, ...s,
    })));
    const gone = (latest?.ph ?? []).map(h => ({ kind: "haulers", rm: h.rm, live: false, hl: h.hl }));
    // bankSquads already orders one bank's squads by (home, id); the stable
    // sort keeps that order within a room.
    return [...squads, ...gone].sort((a, b) => a.rm.localeCompare(b.rm) || Number(b.live) - Number(a.live));
}

// `hl` is [count, carried power, min ticksToLive]. The min ttl is 0 while
// EVERY hauler is still spawning — the one reading a caller must not print as
// a number, since "0" there says "about to die" when it means the opposite.
export function haulerSummary(hl) {
    if (!hl) return null;
    const [count, carrying, minTtl] = hl;
    return { count, carrying, minTtl, spawning: minTtl === 0 };
}

// Σ power held across the empire per snapshot, for the history chart, plus how
// many rooms are actually processing it. `pw` is omitted for a room with
// neither a power spawn nor any power in store, so a room without it holds
// zero — but a snapshot where NO room has `pw` is ambiguous: it is either an
// empire genuinely holding no power, or one stored before the field existed.
// `pba` resolves it the way hasThreatDetail resolves a missing `rt`: the bot
// commit that added `pw` added the always-published `pba` in the same payload,
// so a snapshot carrying `pba` and no `pw` anywhere really does hold zero,
// while one carrying neither predates both and returns null — a blank left
// edge on the chart rather than a fabricated zero (the `gpl` precedent).
export function powerStockPoint(row) {
    const rooms = Object.values(row.rooms ?? {});
    if (!rooms.some(r => r.pw)) return row?.pba === undefined ? null : { stock: 0, processing: 0 };
    let stock = 0, processing = 0;
    for (const r of rooms) {
        if (!r.pw) continue;
        const [storage, terminal, spawn, proc] = r.pw;
        stock += storage + terminal + spawn;
        if (proc === 1) processing += 1;
    }
    return { stock, processing };
}

export function powerStockSeries(history) {
    return history.map(row => ({ row, point: powerStockPoint(row) }));
}
