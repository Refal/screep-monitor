import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    unseenEntries, interpolateTimestamps, assignLodFlags, buildSnapshotDoc,
} from "../scripts/collect.mjs";

const room = { rcl: { l: 8, p: 1, pt: 2 }, e: 1, ec: 1, se: 1, te: 1, q: 0 };
const entry = t => ({ t, gcl: { l: 1, p: 1, pt: 2 }, cpu: { u: 1, l: 20, b: 1000 }, cr: 0, rooms: { W1N1: room } });

describe("unseenEntries", () => {
    test("v1 payload with no prior tick returns just the head", () => {
        const payload = { v: 1, ...entry(100) };
        assert.deepEqual(unseenEntries(payload, null).map(e => e.t), [100]);
    });

    test("v1 payload already stored returns nothing", () => {
        const payload = { v: 1, ...entry(100) };
        assert.deepEqual(unseenEntries(payload, 100), []);
    });

    test("v2 payload with no prior tick returns head + ring, oldest-first", () => {
        const payload = { v: 2, ...entry(140), h: [entry(120), entry(100)] };
        assert.deepEqual(unseenEntries(payload, null).map(e => e.t), [100, 120, 140]);
    });

    test("v2 payload only returns entries strictly newer than the stored tick", () => {
        const payload = { v: 2, ...entry(140), h: [entry(120), entry(100)] };
        assert.deepEqual(unseenEntries(payload, 100).map(e => e.t), [120, 140]);
    });

    test("v2 payload fully caught up returns nothing", () => {
        const payload = { v: 2, ...entry(140), h: [entry(120), entry(100)] };
        assert.deepEqual(unseenEntries(payload, 140), []);
    });

    test("dedups a tick that appears in both the head and the ring", () => {
        const payload = { v: 2, ...entry(140), h: [entry(140), entry(100)] };
        assert.deepEqual(unseenEntries(payload, null).map(e => e.t), [100, 140]);
    });

    test("v1 field unknown/unrecognized falls back to head-only (defensive)", () => {
        const payload = { v: 1, ...entry(100), h: [entry(80)] }; // h present but v1 -> ignored
        assert.deepEqual(unseenEntries(payload, null).map(e => e.t), [100]);
    });
});

describe("interpolateTimestamps", () => {
    test("with a prior anchor, spreads entries proportionally across real elapsed time", () => {
        const entries = [{ t: 100 }, { t: 120 }, { t: 140 }];
        const out = interpolateTimestamps(entries, { headTick: 140, headMs: 2_000, latestTick: 100, latestMs: 1_000 });
        // 40 ticks spanned 1000ms real time -> 25ms/tick
        assert.deepEqual(out.map(e => e.tsMs), [1_000, 1_500, 2_000]);
    });

    test("with no prior anchor (first run ever), every entry gets the current fetch time", () => {
        const entries = [{ t: 100 }, { t: 120 }];
        const out = interpolateTimestamps(entries, { headTick: 120, headMs: 5_000, latestTick: null, latestMs: null });
        assert.deepEqual(out.map(e => e.tsMs), [5_000, 5_000]);
    });

    test("guards against a non-positive tick delta (stale/equal anchor)", () => {
        const entries = [{ t: 100 }];
        const out = interpolateTimestamps(entries, { headTick: 100, headMs: 5_000, latestTick: 100, latestMs: 4_000 });
        assert.deepEqual(out.map(e => e.tsMs), [5_000]);
    });
});

describe("assignLodFlags", () => {
    test("flags the first entry in each new 5-minute bucket", () => {
        const entries = [
            { tsMs: 0 },              // bucket 0
            { tsMs: 4 * 60_000 },     // still bucket 0
            { tsMs: 5 * 60_000 },     // bucket 1
            { tsMs: 11 * 60_000 },    // bucket 2
        ];
        const { docs } = assignLodFlags(entries, null);
        assert.deepEqual(docs.map(d => Boolean(d.b5)), [true, false, true, true]);
    });

    test("flags the first entry in each new 30-minute bucket independently of b5", () => {
        const entries = [{ tsMs: 0 }, { tsMs: 30 * 60_000 }];
        const { docs } = assignLodFlags(entries, null);
        assert.deepEqual(docs.map(d => Boolean(d.b30)), [true, true]);
    });

    test("carries bucket state across calls so a later run doesn't re-flag the same bucket", () => {
        const first = assignLodFlags([{ tsMs: 0 }], null);
        assert.equal(first.docs[0].b5, true);
        const second = assignLodFlags([{ tsMs: 1 * 60_000 }], first.lod); // same 5-min bucket as tsMs=0
        assert.equal(second.docs[0].b5, undefined);
    });

    test("returns lod state reflecting the last entry processed", () => {
        const { lod } = assignLodFlags([{ tsMs: 0 }, { tsMs: 6 * 60_000 }], null);
        assert.deepEqual(lod, { b5: 1, b30: 0 });
    });
});

describe("buildSnapshotDoc", () => {
    test("maps core fields and converts tsMs to a Timestamp", () => {
        const doc = buildSnapshotDoc({ ...entry(100), tsMs: 12_345 });
        assert.equal(doc.tick, 100);
        assert.equal(doc.ts.toMillis(), 12_345);
        assert.deepEqual(doc.rooms, { W1N1: room });
    });

    test("omits bmax/b5/b30 when absent, includes them when present", () => {
        const bare = buildSnapshotDoc({ ...entry(100), tsMs: 0 });
        assert.equal("bmax" in bare, false);
        assert.equal("b5" in bare, false);

        const full = buildSnapshotDoc({ ...entry(100), tsMs: 0, bmax: { XGHO2: 3000 }, b5: true, b30: true });
        assert.deepEqual(full.bmax, { XGHO2: 3000 });
        assert.equal(full.b5, true);
        assert.equal(full.b30, true);
    });
});
