import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    unseenEntries, interpolateTimestamps, assignLodFlags, buildSnapshotDoc,
} from "../scripts/collect.mjs";
import { LOD_BUCKET_MS } from "../public/calc.js";

const room = { rcl: { l: 8, p: 1, pt: 2 }, e: 1, ec: 1, se: 1, te: 1, q: 0 };
const entry = t => ({
    t, gcl: { l: 1, p: 1, pt: 2 }, gpl: { l: 3, p: 200, pt: 2000 },
    cpu: { u: 1, l: 20, b: 1000 }, cr: 0, rooms: { W1N1: room },
});

describe("unseenEntries", () => {
    test("payload with no ring returns just the head", () => {
        const payload = { ...entry(100) };
        assert.deepEqual(unseenEntries(payload, null).map(e => e.t), [100]);
    });

    test("payload with no prior tick returns head + ring, oldest-first", () => {
        const payload = { ...entry(140), h: [entry(120), entry(100)] };
        assert.deepEqual(unseenEntries(payload, null).map(e => e.t), [100, 120, 140]);
    });

    test("payload only returns entries strictly newer than the stored tick", () => {
        const payload = { ...entry(140), h: [entry(120), entry(100)] };
        assert.deepEqual(unseenEntries(payload, 100).map(e => e.t), [120, 140]);
    });

    test("payload fully caught up returns nothing", () => {
        const payload = { ...entry(140), h: [entry(120), entry(100)] };
        assert.deepEqual(unseenEntries(payload, 140), []);
    });

    test("dedups a tick that appears in both the head and the ring", () => {
        const payload = { ...entry(140), h: [entry(140), entry(100)] };
        assert.deepEqual(unseenEntries(payload, null).map(e => e.t), [100, 140]);
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
    // One case per tier, driven off the shared tier map so a new tier is
    // covered (here and in the index-file check below) without a new test.
    for (const [flag, widthMs] of Object.entries(LOD_BUCKET_MS)) {
        test(`flags the first entry in each new ${flag} bucket`, () => {
            const entries = [
                { tsMs: 0 },            // bucket 0
                { tsMs: widthMs - 1 },  // still bucket 0
                { tsMs: widthMs },      // bucket 1
            ];
            const { docs } = assignLodFlags(entries, null);
            assert.deepEqual(docs.map(d => Boolean(d[flag])), [true, false, true]);
        });
    }

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
        assert.deepEqual(lod, { b5: 1, b30: 0, b120: 0 });
    });
});

describe("buildSnapshotDoc", () => {
    test("maps core fields and converts tsMs to a Timestamp", () => {
        const doc = buildSnapshotDoc({ ...entry(100), tsMs: 12_345 });
        assert.equal(doc.tick, 100);
        assert.equal(doc.ts.toMillis(), 12_345);
        assert.deepEqual(doc.rooms, { W1N1: room });
        assert.deepEqual(doc.gpl, { l: 3, p: 200, pt: 2000 });
    });

    test("omits gpl/bmax/b5/b30/b120 when absent, includes them when present", () => {
        const noGpl = { ...entry(100), tsMs: 0 };
        delete noGpl.gpl; // e.g. a ring entry rehydrated from a pre-gpl segment after a global reset
        const bare = buildSnapshotDoc(noGpl);
        assert.equal("gpl" in bare, false);
        assert.equal("bmax" in bare, false);
        assert.equal("b5" in bare, false);
        assert.equal("b120" in bare, false);

        const full = buildSnapshotDoc({ ...entry(100), tsMs: 0, bmax: { XGHO2: 3000 }, b5: true, b30: true, b120: true });
        assert.deepEqual(full.bmax, { XGHO2: 3000 });
        assert.equal(full.b5, true);
        assert.equal(full.b30, true);
        assert.equal(full.b120, true);
    });
});

describe("firestore.indexes.json", () => {
    // A missing composite index is invisible locally — the collector writes
    // the flag happily and the failure only surfaces as FAILED_PRECONDITION
    // in a viewer's browser console. Keep the tier map and the index file
    // mechanically in sync instead of by comment.
    test("every LOD flag has its (flag ASC, ts ASC) composite index on snapshots", () => {
        const { indexes } = JSON.parse(
            readFileSync(new URL("../firestore.indexes.json", import.meta.url), "utf8"));
        for (const flag of Object.keys(LOD_BUCKET_MS)) {
            const found = indexes.some(ix => ix.collectionGroup === "snapshots"
                && JSON.stringify(ix.fields) === JSON.stringify([
                    { fieldPath: flag, order: "ASCENDING" },
                    { fieldPath: "ts", order: "ASCENDING" },
                ]));
            assert.ok(found, `missing composite index for ${flag}`);
        }
    });
});
