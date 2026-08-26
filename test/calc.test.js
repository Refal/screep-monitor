import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    compact, pct, progressDelta, rateSeries, observedMsPerTick, windowRate, stockRate,
    levelEta, fmtDuration, downsample, rampLevel, boostFillLevel, boostFloor,
    PARTS_PER_BOOST, MIN_RAW_STOCK,
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
