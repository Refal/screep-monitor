import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    unseenEntries, interpolateTimestamps, assignLodFlags, buildSnapshotDoc, mergeBuckets, bucketSegmentIds, parseSegment,
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

    test("on a tick collision, the head wins over its bucket copy, not the reverse", () => {
        // The bot always writes the exact same JSON into both the head and its
        // bucket, so this can't happen in practice today — but the dedup must
        // still honor "head wins" if that guarantee is ever relaxed.
        const degradedCopy = { ...entry(140), rt: undefined };
        const payload = { ...entry(140), rt: [{ room: "W2N1" }], h: [degradedCopy] };
        const [head] = unseenEntries(payload, null);
        assert.deepEqual(head.rt, [{ room: "W2N1" }]);
    });
});

describe("mergeBuckets", () => {
    test("no buckets yields a head-only payload", () => {
        const head = entry(140);
        assert.deepEqual(mergeBuckets(head, []), { ...head, h: [] });
    });

    test("flattens buckets in fetched order; bucket order is not tick order and unseenEntries sorts", () => {
        const head = entry(140);
        const bucketEntries = [
            [entry(120), entry(140)],
            [entry(80), entry(100)],
        ];
        const merged = mergeBuckets(head, bucketEntries);
        assert.deepEqual(merged.h.map(e => e.t), [120, 140, 80, 100]);
        assert.deepEqual(unseenEntries(merged, null).map(e => e.t), [80, 100, 120, 140]);
    });

    test("a bucket missing from the fetched list (e.g. it failed) is simply absent", () => {
        const head = entry(140);
        const bucketEntries = [
            [entry(120)],
            [entry(80)],
        ];
        assert.deepEqual(mergeBuckets(head, bucketEntries).h.map(e => e.t), [120, 80]);
    });

    test("preserves every head field alongside the merged h", () => {
        const head = entry(140);
        const merged = mergeBuckets(head, []);
        assert.equal(merged.t, 140);
        assert.deepEqual(merged.rooms, head.rooms);
    });
});

describe("bucketSegmentIds", () => {
    for (const [label, head, expected] of [
        ["no buckets field (older wire format)", {}, []],
        ["buckets: 0", { buckets: 0 }, []],
        ["buckets: 6", { buckets: 6 }, [91, 92, 93, 94, 95, 96]],
        ["buckets above the cap", { buckets: 12 }, [91, 92, 93, 94, 95, 96, 97, 98, 99]],
    ]) {
        test(label, () => {
            assert.deepEqual(bucketSegmentIds(head, 90), expected);
        });
    }
});

describe("parseSegment", () => {
    test("parses a valid numeric string", () => {
        assert.equal(parseSegment("90"), 90);
    });

    test("throws on an empty string instead of silently defaulting to segment 0", () => {
        assert.throws(() => parseSegment(""), /non-negative integer/);
    });

    test("throws on a negative number", () => {
        assert.throws(() => parseSegment("-1"), /non-negative integer/);
    });

    test("throws on a non-numeric string", () => {
        assert.throws(() => parseSegment("abc"), /non-negative integer/);
    });

    test("throws on a non-integer number", () => {
        assert.throws(() => parseSegment("90.5"), /non-negative integer/);
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

    test("omits gpl/bmax/rt/ar/b5/b30/b120 when absent, includes them when present", () => {
        const noGpl = { ...entry(100), tsMs: 0 };
        delete noGpl.gpl; // e.g. a ring entry rehydrated from a pre-gpl segment after a global reset
        const bare = buildSnapshotDoc(noGpl);
        assert.equal("gpl" in bare, false);
        assert.equal("bmax" in bare, false);
        // The bot omits `rt` on an empty list, and drops it entirely under
        // payload degradation — both must persist as an absent field rather
        // than an empty array, or the dashboard can't tell "quiet" from
        // "degraded away" (see hasThreatDetail in public/calc.js).
        assert.equal("rt" in bare, false);
        // ...and an EMPTY rt must be omitted too: an array is truthy, so a
        // truthiness test would store `rt: []`, which reads as neither
        // "quiet" nor "degraded" and renders a table with no rows at all.
        assert.equal("rt" in buildSnapshotDoc({ ...entry(100), tsMs: 0, rt: [] }), false);
        // `ar` (army routes) follows the same omit-on-empty contract as `rt`.
        assert.equal("ar" in bare, false);
        assert.equal("ar" in buildSnapshotDoc({ ...entry(100), tsMs: 0, ar: [] }), false);
        assert.equal("b5" in bare, false);
        assert.equal("b120" in bare, false);

        // `exp` (invader core deploy/collapse tick, screeps2 8e22d802) is just
        // another opaque field on an rt entry — no collector change needed for
        // it to reach Firestore, which this deepEqual below locks in.
        const rt = [{ room: "W2N1", home: "W1N1", h: 1, owners: ["Invader"], melee: 30, ranged: 0, heal: 12, age: 30, exp: -500 }];
        const ar = [{ home: "W1N1", target: "W2N1", sq: [{ id: 1, st: "engaged", n: [0, 0, 2, 1], at: [0, 2, 0], b: 1 }] }];
        const full = buildSnapshotDoc({ ...entry(100), tsMs: 0, bmax: { XGHO2: 3000 }, rt, ar, b5: true, b30: true, b120: true });
        assert.deepEqual(full.bmax, { XGHO2: 3000 });
        assert.deepEqual(full.rt, rt);
        assert.deepEqual(full.ar, ar);
        assert.equal(full.b5, true);
        assert.equal(full.b30, true);
        assert.equal(full.b120, true);
    });

    test("power harvesting: pb/ph omit-on-empty, pba persists even as 0", () => {
        const bare = buildSnapshotDoc({ ...entry(100), tsMs: 0 });
        // `pb`/`ph` ride the bot's first degradation step alongside rt/ar, so
        // they follow the same contract: absent, never `[]`.
        assert.equal("pb" in bare, false);
        assert.equal("ph" in bare, false);
        assert.equal("pb" in buildSnapshotDoc({ ...entry(100), tsMs: 0, pb: [] }), false);
        assert.equal("ph" in buildSnapshotDoc({ ...entry(100), tsMs: 0, ph: [] }), false);
        // A ring entry published before the bot emitted `pba` carries none —
        // the field has to stay absent rather than become `undefined`, which
        // firebase-admin rejects outright.
        assert.equal("pba" in bare, false);

        // The trap: `pba: 0` is "autoHarvest gate is off", the single reading
        // this scalar exists to keep apart from "no live banks". A truthiness
        // test here would drop exactly that state.
        const gateOff = buildSnapshotDoc({ ...entry(100), tsMs: 0, pba: 0 });
        assert.equal(gateOff.pba, 0);

        const pb = [{
            rm: "W5N5", p: 4200, hits: 1_800_000, dec: 3100, age: 12, ft: 3,
            con: [2, 300, 120], dps: 600,
            pl: [{ h: "W1N1", k: "committed", m: "loot" }],
            sq: [{ id: 1, home: "W1N1", w: 2 }],
            hl: [2, 1600, 0],
        }];
        const ph = [{ rm: "W6N6", hl: [1, 800, 940] }];
        const full = buildSnapshotDoc({ ...entry(100), tsMs: 0, pb, ph, pba: 1 });
        assert.deepEqual(full.pb, pb);
        assert.deepEqual(full.ph, ph);
        assert.equal(full.pba, 1);
    });

    test("per-room pw rides through `rooms` with no collector change", () => {
        const pwRoom = { ...room, pw: [12_000, 3000, 80, 1] };
        const doc = buildSnapshotDoc({ ...entry(100), tsMs: 0, rooms: { W1N1: pwRoom } });
        assert.deepEqual(doc.rooms.W1N1.pw, [12_000, 3000, 80, 1]);
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
