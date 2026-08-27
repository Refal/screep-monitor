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
