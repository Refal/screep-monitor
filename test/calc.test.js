import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    compact, pct, progressDelta, rateSeries, observedMsPerTick, windowRate, stockRate,
    levelEta, fmtDuration, downsample, rampLevel, boostFillLevel, boostFloor,
    PARTS_PER_BOOST, MIN_RAW_STOCK, LOD_BUCKET_MS, LOD_BY_RANGE, RETENTION_DAYS,
    fmtHits, barrierTarget, barrierLevel, isCriticalBarrier, roomPosture, defenderSummary,
    netTowerDps, sortByPosture, hostileEpisodes, CRITICAL_RAMPART_HITS, MANIFEST_GUARD_ROLE,
    SHARD, roomUrl, roomHistoryUrl,
} from "../public/calc.js";

describe("pct", () => {
    test("returns the percentage of progress toward the total", () => {
        assert.equal(pct(50, 200), 25);
    });
    test("returns 0 when the total is falsy (avoids divide by zero)", () => {
        assert.equal(pct(50, 0), 0);
        assert.equal(pct(50, undefined), 0);
    });
});

describe("compact", () => {
    test("formats numbers compactly", () => {
        assert.equal(compact(1500), "1.5K");
    });
    test("renders an em dash for null/undefined", () => {
        assert.equal(compact(null), "—");
        assert.equal(compact(undefined), "—");
    });
});

describe("progressDelta", () => {
    test("returns null when either reading is missing (room absent from a snapshot)", () => {
        assert.equal(progressDelta(null, { l: 1, p: 10, pt: 100 }), null);
        assert.equal(progressDelta({ l: 1, p: 10, pt: 100 }, null), null);
    });
    test("returns the plain progress delta within the same level", () => {
        assert.equal(progressDelta({ l: 3, p: 100, pt: 1000 }, { l: 3, p: 250, pt: 1000 }), 150);
    });
    test("attributes points correctly across a single level-up", () => {
        // prev: 900/1000 into level 3; cur: 50/2000 into level 4.
        // gained = (1000 - 900) + 50 = 150
        const prev = { l: 3, p: 900, pt: 1000 };
        const cur = { l: 4, p: 50, pt: 2000 };
        assert.equal(progressDelta(prev, cur), 150);
    });
    test("returns null on a multi-level jump (intermediate progressTotal unknown)", () => {
        const prev = { l: 3, p: 900, pt: 1000 };
        const cur = { l: 5, p: 50, pt: 4000 };
        assert.equal(progressDelta(prev, cur), null);
    });
});

describe("rateSeries", () => {
    test("first point is always null (no predecessor)", () => {
        const history = [
            { tick: 100, gcl: { l: 1, p: 0, pt: 200 } },
            { tick: 200, gcl: { l: 1, p: 100, pt: 200 } },
        ];
        const series = rateSeries(r => r.gcl, history);
        assert.equal(series[0], null);
        assert.equal(series[1], 1); // 100 points / 100 ticks
    });
    test("returns null for an interval where tick didn't advance", () => {
        const history = [
            { tick: 100, gcl: { l: 1, p: 0, pt: 200 } },
            { tick: 100, gcl: { l: 1, p: 50, pt: 200 } },
        ];
        assert.equal(rateSeries(r => r.gcl, history)[1], null);
    });
});

describe("observedMsPerTick", () => {
    test("returns null with fewer than 2 rows", () => {
        assert.equal(observedMsPerTick([]), null);
        assert.equal(observedMsPerTick([{ tick: 1, date: new Date(0) }]), null);
    });
    test("computes wall-clock ms per tick across the window", () => {
        const history = [
            { tick: 100, date: new Date(0) },
            { tick: 200, date: new Date(10_000) },
        ];
        assert.equal(observedMsPerTick(history), 100); // 10s / 100 ticks
    });
    test("returns null when ticks didn't advance across the window", () => {
        const history = [
            { tick: 100, date: new Date(0) },
            { tick: 100, date: new Date(10_000) },
        ];
        assert.equal(observedMsPerTick(history), null);
    });
});

describe("windowRate", () => {
    test("returns null with fewer than 2 history rows", () => {
        assert.equal(windowRate(r => r.gcl, []), null);
        assert.equal(windowRate(r => r.gcl, [{ tick: 1, gcl: { l: 1, p: 0, pt: 200 } }]), null);
    });
    test("aggregates gain over the whole window rather than the last interval alone", () => {
        const history = [
            { tick: 0, date: new Date(0), gcl: { l: 1, p: 0, pt: 45000 } },
            { tick: 100, date: new Date(1000), gcl: { l: 1, p: 1000, pt: 45000 } }, // noisy fast interval
            { tick: 200, date: new Date(2000), gcl: { l: 1, p: 1100, pt: 45000 } }, // slow interval
        ];
        const wr = windowRate(r => r.gcl, history);
        // total gain 1100 over 200 ticks = 5.5/tick, not skewed by the last interval's 1/tick
        assert.equal(wr.rate, 5.5);
        assert.equal(wr.msPerTick, 10); // 2000ms / 200 ticks
    });
    test("skips intervals with no tick advance and intervals with no attributable delta", () => {
        const history = [
            { tick: 0, gcl: { l: 1, p: 0, pt: 45000 } },
            { tick: 0, gcl: { l: 1, p: 500, pt: 45000 } }, // dTick <= 0, skipped
            { tick: 50, gcl: { l: 3, p: 10, pt: 135000 } }, // multi-level jump, skipped
            { tick: 150, gcl: { l: 3, p: 110, pt: 135000 } }, // usable: +100 over 100 ticks
        ];
        const wr = windowRate(r => r.gcl, history);
        assert.equal(wr.rate, 1);
    });
    test("returns null when there is no positive gain in range", () => {
        const history = [
            { tick: 0, gcl: { l: 1, p: 100, pt: 45000 } },
            { tick: 100, gcl: { l: 1, p: 100, pt: 45000 } },
        ];
        assert.equal(windowRate(r => r.gcl, history), null);
    });
});

describe("stockRate", () => {
    test("returns null with no data", () => {
        assert.equal(stockRate(r => r.nuk, []), null);
    });
    test("skips a launch that empties the store instead of poisoning the trend", () => {
        const history = [
            { tick: 0, nuk: 1000 },
            { tick: 100, nuk: 4000 }, // filling: +3000/100 ticks
            { tick: 200, nuk: 0 },    // launch — value dropped, this interval skipped
            { tick: 300, nuk: 1000 }, // refilling again: +1000/100 ticks
        ];
        const rate = stockRate(r => r.nuk, history);
        // only the two non-dropping intervals count: (3000 + 1000) / (100 + 100)
        assert.equal(rate, 20);
    });
    test("skips intervals touching a null reading (field absent from that snapshot)", () => {
        const history = [
            { tick: 0, nuk: null },
            { tick: 100, nuk: null },
            { tick: 200, nuk: 500 },
            { tick: 300, nuk: 1000 },
        ];
        assert.equal(stockRate(r => r.nuk, history), 5); // 500 / 100
    });
    test("returns null when nothing was gained", () => {
        const history = [
            { tick: 0, nuk: 500 },
            { tick: 100, nuk: 500 },
        ];
        assert.equal(stockRate(r => r.nuk, history), null);
    });
});

describe("levelEta", () => {
    const history = [
        { tick: 0, date: new Date(0), gcl: { l: 1, p: 0, pt: 200 } },
        { tick: 100, date: new Date(1000), gcl: { l: 1, p: 100, pt: 200 } },
    ];
    test("returns null at max level (falsy pt)", () => {
        assert.equal(levelEta(r => r.gcl, { l: 8, p: 100, pt: undefined }, history), null);
    });
    test("returns null when there's no window rate to extrapolate from", () => {
        assert.equal(levelEta(r => r.gcl, { l: 1, p: 100, pt: 200 }, []), null);
    });
    test("computes eta ticks/ms from the observed rate", () => {
        const eta = levelEta(r => r.gcl, { l: 1, p: 100, pt: 200 }, history);
        assert.equal(eta.rate, 1); // 100 points / 100 ticks
        assert.equal(eta.etaTicks, 100); // (200 - 100) / 1
        assert.equal(eta.etaMs, 1000); // 100 ticks * 10ms/tick
    });
});

describe("fmtDuration", () => {
    test("returns null for invalid input", () => {
        assert.equal(fmtDuration(null), null);
        assert.equal(fmtDuration(NaN), null);
        assert.equal(fmtDuration(-1), null);
    });
    test("formats minutes under an hour", () => {
        assert.equal(fmtDuration(30 * 60_000), "30m");
    });
    test("formats hours and minutes under a day", () => {
        assert.equal(fmtDuration(2 * 3600_000 + 15 * 60_000), "2h 15m");
    });
    test("formats days and hours under a month", () => {
        assert.equal(fmtDuration(3 * 86400_000 + 5 * 3600_000), "3d 5h");
    });
    test("formats bare days at/after a month", () => {
        assert.equal(fmtDuration(35 * 86400_000), "35d");
    });
});

describe("downsample", () => {
    test("returns the input unchanged when under the cap", () => {
        const rows = [1, 2, 3];
        assert.deepEqual(downsample(rows, 10), rows);
    });
    test("downsamples to exactly max points and always keeps the last row", () => {
        const rows = Array.from({ length: 1000 }, (_, i) => i);
        const out = downsample(rows, 500);
        assert.equal(out.length, 500);
        assert.equal(out[out.length - 1], 999);
    });
});

describe("rampLevel", () => {
    test("buckets fill fractions into 1..5", () => {
        assert.equal(rampLevel(0.1), 1);
        assert.equal(rampLevel(0.3), 2);
        assert.equal(rampLevel(0.5), 3);
        assert.equal(rampLevel(0.7), 4);
        assert.equal(rampLevel(0.99), 5);
    });
    test("bucket boundaries are inclusive of the upper bucket", () => {
        assert.equal(rampLevel(0.20), 2);
        assert.equal(rampLevel(0.40), 3);
        assert.equal(rampLevel(0.60), 4);
        assert.equal(rampLevel(0.85), 5);
    });
});

describe("boostFillLevel", () => {
    test("raw reagent below the lab minimum reads as absent, not short", () => {
        assert.equal(boostFillLevel(MIN_RAW_STOCK - 1, undefined, true), 0);
    });
    test("raw reagent past the floor with no configured max is uncapped (null)", () => {
        assert.equal(boostFillLevel(MIN_RAW_STOCK + 1, undefined, true), null);
    });
    test("raw reagent past the floor with a max ramps normally", () => {
        assert.equal(boostFillLevel(5000, 10000, true), rampLevel(0.5));
    });
    test("compound with no configured max renders as outline (null), even above the boost floor", () => {
        assert.equal(boostFillLevel(500, undefined, false), null);
    });
    test("compound under a single boost's worth of parts is dust (0), even with a max configured", () => {
        assert.equal(boostFillLevel(PARTS_PER_BOOST - 1, 3000, false), 0);
    });
    test("compound at zero stock is empty (0)", () => {
        assert.equal(boostFillLevel(0, 3000, false), 0);
    });
    test("compound past the boost floor with a max ramps normally", () => {
        assert.equal(boostFillLevel(1500, 3000, false), rampLevel(0.5));
    });
});

describe("boostFloor", () => {
    test("raw reagents use the lab minimum floor", () => {
        assert.deepEqual(boostFloor(true), { amount: MIN_RAW_STOCK, reason: `below lab minimum (${MIN_RAW_STOCK})` });
    });
    test("boostable compounds use the one-boost floor", () => {
        assert.deepEqual(boostFloor(false), { amount: PARTS_PER_BOOST, reason: `under one boost (${PARTS_PER_BOOST})` });
    });
});

describe("fmtHits", () => {
    test("mirrors the bot's own console formatter, including its sub-1K/1M quirks", () => {
        assert.equal(fmtHits(999), "999");
        assert.equal(fmtHits(1000), "1.0K");
        assert.equal(fmtHits(1500), "1.5K");
        // Deliberately matching the bot's own fmtHits, not "fixing" it here:
        // 999_999 stays in the K bucket rather than rounding up into "1.0M".
        assert.equal(fmtHits(999_999), "1000.0K");
        assert.equal(fmtHits(1_000_000), "1.0M");
        assert.equal(fmtHits(2_500_000), "2.5M");
        assert.equal(fmtHits(0), "0");
    });
    test("renders an em dash for a missing reading", () => {
        assert.equal(fmtHits(null), "—");
        assert.equal(fmtHits(undefined), "—");
    });
});

describe("barrierTarget", () => {
    test("resolves the RCL-scaled ladder per kind", () => {
        assert.equal(barrierTarget("rampart", 1), 2000);
        assert.equal(barrierTarget("rampart", 8), 2_000_000);
        assert.equal(barrierTarget("wall", 1), 1000);
        assert.equal(barrierTarget("wall", 8), 2_000_000);
        assert.equal(barrierTarget("zoneRampart", 8), 50_000_000); // not a copy of the plain rampart ladder
    });
    test("falls back to the ladder's default outside RCL 1-8", () => {
        assert.equal(barrierTarget("rampart", 0), 10_000);
        assert.equal(barrierTarget("rampart", 9), 10_000);
    });
    test("returns null for an unknown barrier kind", () => {
        assert.equal(barrierTarget("moat", 5), null);
    });
});

describe("barrierLevel", () => {
    test("returns null when hits are absent (unknown, never good)", () => {
        assert.equal(barrierLevel(null, "rampart", 1), null);
    });
    test("ramps against the RCL target", () => {
        assert.equal(barrierLevel(2000, "rampart", 1), 5);  // at target
        assert.equal(barrierLevel(200, "rampart", 1), 1);   // 10% of target
    });
    test("clamps above-target hits to the top bucket instead of overflowing", () => {
        assert.equal(barrierLevel(4000, "rampart", 1), 5);  // 2x target
    });
});

describe("isCriticalBarrier", () => {
    test("flags a rampart just under the absolute critical-repair floor", () => {
        assert.equal(isCriticalBarrier(CRITICAL_RAMPART_HITS - 1, "rampart"), true);
    });
    test("does not flag a rampart at or above the floor", () => {
        assert.equal(isCriticalBarrier(CRITICAL_RAMPART_HITS, "rampart"), false);
    });
    test("never flags walls (the bot's priority-0 rule is rampart-only)", () => {
        assert.equal(isCriticalBarrier(100, "wall"), false);
    });
    test("does not flag an absent reading", () => {
        assert.equal(isCriticalBarrier(null, "rampart"), false);
    });
});

describe("roomPosture", () => {
    test("a missing thr is unknown, not clear", () => {
        assert.deepEqual(roomPosture(undefined), { level: "unknown", label: "unknown", reasons: [] });
    });
    test("no hostiles is clear", () => {
        assert.deepEqual(roomPosture({ h: 0 }), { level: "clear", label: "clear", reasons: [] });
    });
    test("an unarmed tower alone is exposed with exactly that reason", () => {
        const p = roomPosture({ h: 1, twrArmed: 0, twrTotal: 3, smAvail: 1, def: [] });
        assert.equal(p.level, "exposed");
        assert.deepEqual(p.reasons, ["no armed tower"]);
    });
    test("no towers built reads distinctly from an unarmed tower", () => {
        const p = roomPosture({ h: 1, twrArmed: 0, twrTotal: 0, smAvail: 1, def: [] });
        assert.deepEqual(p.reasons, ["no tower built"]);
    });
    test("no inactive safe-mode charge alone is exposed with exactly that reason", () => {
        const p = roomPosture({ h: 1, twrArmed: 1, twrTotal: 1, smAvail: 0, def: [] });
        assert.equal(p.level, "exposed");
        assert.deepEqual(p.reasons, ["no safe-mode charge"]);
    });
    test("a defender deficit alone is exposed with exactly that reason", () => {
        const p = roomPosture({ h: 1, twrArmed: 1, twrTotal: 1, smAvail: 1, def: [{ role: "home_defender", cur: 1, des: 2 }] });
        assert.equal(p.level, "exposed");
        assert.deepEqual(p.reasons, ["defender slots short"]);
    });
    test("all three red conditions at once report all three reasons", () => {
        const p = roomPosture({ h: 1, twrArmed: 0, twrTotal: 2, smAvail: 0, def: [{ role: "home_defender", cur: 1, des: 2 }] });
        assert.equal(p.level, "exposed");
        assert.equal(p.reasons.length, 3);
    });
    test("hostiles present but every defense layer holding is engaged, not exposed", () => {
        const p = roomPosture({ h: 2, twrArmed: 1, twrTotal: 1, smAvail: 1, def: [] });
        assert.deepEqual(p, { level: "engaged", label: "engaged", reasons: [] });
    });
    test("active safe mode with smAvail 0 is not a reason (the mode itself is the fallback)", () => {
        const p = roomPosture({ h: 1, twrArmed: 1, twrTotal: 1, sm: 100, smAvail: 0, def: [] });
        assert.deepEqual(p.reasons, []);
    });
    test("does not throw when def is absent from an otherwise-valid thr", () => {
        assert.doesNotThrow(() => roomPosture({ h: 1, twrArmed: 1, twrTotal: 1, smAvail: 1 }));
    });
});

describe("defenderSummary", () => {
    test("unknown when thr is absent, but guards are still read from roles", () => {
        const s = defenderSummary(undefined, [{ r: MANIFEST_GUARD_ROLE, c: 1, d: 1 }]);
        assert.equal(s.state, "unknown");
        assert.equal(s.cur, 0);
        assert.equal(s.des, 0);
        assert.equal(s.guards.length, 1);
        assert.equal(s.suppressed, false);
    });
    test("safe-mode: active safe mode explains an empty def[]", () => {
        assert.equal(defenderSummary({ h: 2, sm: 100, def: [] }, []).state, "safe-mode");
    });
    test("none-needed: no hostiles explains an empty def[]", () => {
        assert.equal(defenderSummary({ h: 0, def: [] }, []).state, "none-needed");
    });
    test("unarmed: hostiles with no attack parts explain an empty def[]", () => {
        assert.equal(defenderSummary({ h: 2, melee: 0, ranged: 0, def: [] }, []).state, "unarmed");
    });
    test("no-plan: armed hostiles and an empty def[] is the only bad empty state", () => {
        assert.equal(defenderSummary({ h: 2, melee: 100, ranged: 0, def: [] }, []).state, "no-plan");
    });
    test("staffed: def[] fully meets desired", () => {
        const thr = { h: 2, melee: 100, def: [{ role: "home_defender", cur: 2, des: 2 }] };
        const s = defenderSummary(thr, []);
        assert.equal(s.state, "staffed");
        assert.equal(s.cur, 2);
        assert.equal(s.des, 2);
    });
    test("short: def[] under desired", () => {
        const thr = { h: 2, melee: 100, def: [{ role: "home_defender", cur: 1, des: 2 }, { role: "home_melee_defender", cur: 0, des: 1 }] };
        const s = defenderSummary(thr, []);
        assert.equal(s.state, "short");
        assert.equal(s.cur, 1);
        assert.equal(s.des, 3);
    });
    test("suppressed is true when hostiles carry attack parts (remote slots vanish by design)", () => {
        const thr = { h: 2, melee: 50, ranged: 0, def: [{ role: "home_defender", cur: 1, des: 1 }] };
        assert.equal(defenderSummary(thr, []).suppressed, true);
    });
    test("suppressed is false for heal-only hostiles (not combat hostiles to the manifest gate)", () => {
        const thr = { h: 2, melee: 0, ranged: 0, heal: 50, def: [{ role: "home_defender", cur: 1, des: 1 }] };
        assert.equal(defenderSummary(thr, []).suppressed, false);
    });
    test("guards default to empty when roles is undefined", () => {
        const thr = { h: 0, def: [] };
        assert.deepEqual(defenderSummary(thr, undefined).guards, []);
    });
});

describe("netTowerDps", () => {
    test("towers outpacing heal is positive", () => {
        assert.equal(netTowerDps({ dps: 450, heal: 200 }), 250);
    });
    test("heal outpacing towers is negative", () => {
        assert.equal(netTowerDps({ dps: 100, heal: 300 }), -200);
    });
    test("treats an absent heal as zero", () => {
        assert.equal(netTowerDps({ dps: 150 }), 150);
    });
});

describe("sortByPosture", () => {
    test("orders exposed, then engaged, then unknown, then clear", () => {
        const exposed = { thr: { h: 1, twrArmed: 0, twrTotal: 1, smAvail: 1, def: [] } };
        const engaged = { thr: { h: 1, twrArmed: 1, twrTotal: 1, smAvail: 1, def: [] } };
        const unknown = { thr: undefined };
        const clear = { thr: { h: 0 } };
        const sorted = sortByPosture([["D", clear], ["C", unknown], ["B", engaged], ["A", exposed]]);
        assert.deepEqual(sorted.map(([name]) => name), ["A", "B", "C", "D"]);
    });
    test("ties within a posture level break alphabetically by room name", () => {
        const exposed = { thr: { h: 1, twrArmed: 0, twrTotal: 1, smAvail: 1, def: [] } };
        const sorted = sortByPosture([["W2N2", exposed], ["W1N1", exposed]]);
        assert.deepEqual(sorted.map(([name]) => name), ["W1N1", "W2N2"]);
    });
});

describe("hostileEpisodes", () => {
    // rooms: { name: {h,melee,...} | null }; null means that room's thr was
    // dropped from this row entirely (degraded), not that it's quiet.
    function row(tick, ms, rooms) {
        const out = {};
        for (const [name, t] of Object.entries(rooms)) out[name] = t ? { thr: t } : {};
        return { tick, date: new Date(ms), rooms: out };
    }

    test("empty history yields no episodes and zero coverage", () => {
        assert.deepEqual(hostileEpisodes([]), { episodes: [], covered: 0, total: 0 });
    });
    test("merges consecutive hostile rows into one episode, tracking peaks", () => {
        const history = [
            row(0, 0, { W1: { h: 1, melee: 50, ranged: 0 } }),
            row(100, 1000, { W1: { h: 3, melee: 100, ranged: 20 } }),
            row(200, 2000, { W1: { h: 0 } }),
        ];
        const { episodes, covered, total } = hostileEpisodes(history);
        assert.equal(episodes.length, 1);
        assert.equal(episodes[0].room, "W1");
        assert.equal(episodes[0].peakH, 3);
        assert.equal(episodes[0].peakDmg, 120);
        assert.equal(episodes[0].fromTick, 0);
        assert.equal(episodes[0].toTick, 100);
        assert.equal(covered, 3);
        assert.equal(total, 3);
    });
    test("splits into separate episodes across a quiet gap", () => {
        const history = [
            row(0, 0, { W1: { h: 2, melee: 50, ranged: 0 } }),
            row(100, 1000, { W1: { h: 0 } }),
            row(200, 2000, { W1: { h: 1, melee: 30, ranged: 0 } }),
        ];
        const { episodes } = hostileEpisodes(history);
        assert.equal(episodes.length, 2);
        // newest first
        assert.equal(episodes[0].fromTick, 200);
        assert.equal(episodes[1].fromTick, 0);
    });
    test("a degraded row (thr absent) mid-fight does not split the episode or end it early", () => {
        const history = [
            row(0, 0, { W1: { h: 1, melee: 50, ranged: 0 } }),
            row(100, 1000, { W1: null }), // degraded — room present but no thr this tick
            row(200, 2000, { W1: { h: 2, melee: 80, ranged: 0 } }),
        ];
        const { episodes, covered, total } = hostileEpisodes(history);
        assert.equal(episodes.length, 1);
        assert.equal(episodes[0].fromTick, 0);
        assert.equal(episodes[0].toTick, 200);
        assert.equal(episodes[0].peakH, 2);
        assert.equal(covered, 2);
        assert.equal(total, 3);
    });
    test("an episode still open at the end of history is still reported", () => {
        const history = [row(0, 0, { W1: { h: 1, melee: 10, ranged: 0 } })];
        const { episodes } = hostileEpisodes(history);
        assert.equal(episodes.length, 1);
        assert.equal(episodes[0].toTick, 0);
    });
    test("aggregates owners and boosted-part sightings across an episode", () => {
        const history = [
            row(0, 0, { W1: { h: 1, melee: 50, ranged: 0, owners: ["Bob"], boosted: 0 } }),
            row(100, 1000, { W1: { h: 2, melee: 80, ranged: 0, owners: ["Bob", "Alice"], boosted: 5 } }),
        ];
        const { episodes } = hostileEpisodes(history);
        assert.deepEqual([...episodes[0].owners].sort(), ["Alice", "Bob"]);
        assert.equal(episodes[0].boosted, true);
    });
    test("tracks two rooms under attack in the same row as independent episodes", () => {
        const history = [
            row(0, 0, { W1: { h: 1, melee: 10, ranged: 0 }, W2: { h: 2, melee: 20, ranged: 0 } }),
        ];
        const { episodes } = hostileEpisodes(history);
        assert.equal(episodes.length, 2);
        assert.deepEqual(episodes.map(e => e.room).sort(), ["W1", "W2"]);
    });
});

describe("roomUrl / roomHistoryUrl", () => {
    test("roomUrl links to the room view on the default shard", () => {
        assert.equal(roomUrl("E23S45"), "https://screeps.com/a/#!/room/shard2/E23S45");
    });
    test("roomHistoryUrl links to the history viewer at the given tick", () => {
        assert.equal(roomHistoryUrl("E23S45", 76746600), "https://screeps.com/a/#!/history/shard2/E23S45?t=76746600");
    });
    test("roomHistoryUrl floors a mid-block tick to its 100-tick file boundary", () => {
        assert.equal(roomHistoryUrl("E23S45", 76746637), "https://screeps.com/a/#!/history/shard2/E23S45?t=76746600");
    });
    test("roomHistoryUrl leaves a tick already on a boundary unchanged", () => {
        assert.equal(roomHistoryUrl("E23S45", 76746700), "https://screeps.com/a/#!/history/shard2/E23S45?t=76746700");
    });
});

const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

describe("header shard label vs SHARD", () => {
    // index.html hardcodes "shard2" as a no-JS fallback for #shard-label;
    // app.js overwrites it with SHARD at load. If SHARD ever changes, the
    // fallback would silently show the wrong shard until JS runs — keep them
    // in sync mechanically, same reasoning as the range-vs-retention check
    // below.
    test("the #shard-label fallback text matches SHARD", () => {
        const m = indexHtml.match(/<span class="sub" id="shard-label">([^<]*)<\/span>/);
        assert.ok(m, "#shard-label span not found in index.html");
        assert.equal(m[1], SHARD);
    });
});

describe("time-range buttons vs retention", () => {
    // The dashboard's range buttons, the LOD_BY_RANGE map, and the collector's
    // prune window live in three different files; a range outside retention
    // fails silently (the query just returns the shorter window under the
    // longer label). Keep them mechanically in sync, like the composite-index
    // check in collect.test.js.
    const ranges = [...indexHtml.matchAll(/data-range="(\d+)"/g)].map(m => Number(m[1]));

    test("index.html defines at least one range button", () => {
        assert.ok(ranges.length > 0);
    });
    test("no button offers a window longer than retention", () => {
        for (const hours of ranges) {
            assert.ok(hours <= RETENTION_DAYS * 24, `${hours}h button exceeds ${RETENTION_DAYS}d retention`);
        }
    });
    test("the longest button spans exactly the retention window", () => {
        assert.equal(Math.max(...ranges), RETENTION_DAYS * 24);
    });
    test("every LOD_BY_RANGE key has a matching button, and every flag a bucket width", () => {
        for (const [hours, flag] of Object.entries(LOD_BY_RANGE)) {
            assert.ok(ranges.includes(Number(hours)), `LOD_BY_RANGE has ${hours}h but index.html has no such button`);
            assert.ok(flag in LOD_BUCKET_MS, `LOD_BY_RANGE flag ${flag} missing from LOD_BUCKET_MS`);
        }
    });
});
