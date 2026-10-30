import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, roomFacts, buildTimeline, formatTimeline, DEFAULT_TICKS, DEFAULT_LIMIT } from "../scripts/timeline.mjs";

const HOME = "E23S45";
const TARGET = "E23S44";

const thr = { h: 0, twrArmed: 3, twrTotal: 3, smAvail: 1, def: [] };
const homeRoom = (over = {}) => ({
    rcl: { l: 8, p: 1, pt: 2 }, e: 1000, ec: 1000, se: 50000, te: 0, q: 0, sp: 3, sc: "vault",
    roles: [{ r: "hauler", c: 2, d: 2 }, { r: "remote_miner", rm: "E22S45", c: 1, d: 1 }],
    thr, ...over,
});
const squad = (over = {}) => ({ id: 1, st: "forming", n: [2, 0, 0, 0], at: [0, 0, 0], ...over });
const doc = (tick, over = {}) => ({ tick, rooms: { [HOME]: homeRoom() }, ...over });

describe("parseArgs", () => {
    test("defaults ticks and limit, derives start from end", () => {
        assert.deepEqual(parseArgs([TARGET, "--end", "5000"]), { room: TARGET, start: 5000 - DEFAULT_TICKS, end: 5000, limit: DEFAULT_LIMIT });
    });
    test("--start wins over --ticks", () => {
        assert.equal(parseArgs([TARGET, "--end", "5000", "--start", "4900", "--ticks", "10"]).start, 4900);
    });
    for (const [label, argv] of [
        ["missing room", ["--end", "5"]],
        ["missing end", [TARGET]],
        ["start after end", [TARGET, "--end", "5", "--start", "9"]],
        ["unknown flag", [TARGET, "--end", "5", "--bogus"]],
        ["non-numeric", [TARGET, "--end", "x"]],
    ]) {
        test(`rejects ${label}`, () => assert.throws(() => parseArgs(argv)));
    }
});

describe("roomFacts matching", () => {
    test("army route matches on home or target", () => {
        const route = { home: HOME, target: TARGET, sq: [squad()] };
        assert.ok(roomFacts({ tick: 1, ar: [route] }, HOME).has(`army ${HOME}→${TARGET}`));
        assert.ok(roomFacts({ tick: 1, ar: [route] }, TARGET).has(`army ${HOME}→${TARGET}`));
        assert.equal(roomFacts({ tick: 1, ar: [route] }, "E1S1").size, 0);
    });
    test("route with no squads is ignored", () => {
        assert.equal(roomFacts({ tick: 1, ar: [{ home: HOME, target: TARGET, sq: [] }] }, HOME).size, 0);
    });
    test("remote role deficit is found under the home room's roles", () => {
        const d = doc(1, { rooms: { [HOME]: homeRoom({ roles: [{ r: "remote_miner", rm: TARGET, c: 0, d: 1 }] }) } });
        assert.equal(roomFacts(d, TARGET).get(`remote roles from ${HOME}`), "short: remote_miner 0/1");
    });
    test("own roles exclude remote rows", () => {
        const d = doc(1, { rooms: { [HOME]: homeRoom({ roles: [{ r: "hauler", c: 1, d: 2 }, { r: "remote_miner", rm: TARGET, c: 0, d: 1 }] }) } });
        assert.equal(roomFacts(d, HOME).get("own roles"), "short: hauler 1/2");
    });
    test("siege verdict matches on home or target, with detail", () => {
        const d = { tick: 1, sv: [{ h: HOME, rm: TARGET, k: "above-bar", d: "L4", in: 300 }] };
        const text = "above auto-siege limit (core L4), retry in 300";
        assert.equal(roomFacts(d, HOME).get(`siege ${HOME}→${TARGET}`), text);
        assert.equal(roomFacts(d, TARGET).get(`siege ${HOME}→${TARGET}`), text);
    });
    test("defense verdict shows homes that gave up", () => {
        const d = { tick: 1, dv: [{ rm: TARGET, v: "undefendable", uh: [HOME], in: 120 }] };
        assert.equal(roomFacts(d, TARGET).get("defense verdict"), `undefendable (gave up: ${HOME}; retry in 120)`);
    });
    test("defense skip, remote threat and ledger rows", () => {
        const d = { tick: 1, ds: [{ rm: TARGET, r: "non-combat", h: 2 }], rt: [{ room: TARGET, h: 3, age: 5, coreLvl: 2, owners: ["Invader"] }], rl: [{ h: HOME, rm: TARGET, in: 204912, out: 109800, w: 2000 }] };
        const facts = roomFacts(d, TARGET);
        assert.equal(facts.get("defense skip"), "not defended · non-combat hostiles, 2 hostiles");
        assert.equal(facts.get("remote threat"), "3 hostiles, core L2 [Invader]");
        assert.equal(facts.get(`ledger ${HOME}→${TARGET}`), "in ~200k out ~110k");
    });
    test("posture reads thr", () => {
        const d = doc(1, { rooms: { [HOME]: homeRoom({ thr: { ...thr, h: 4, twrArmed: 0 } }) } });
        assert.equal(roomFacts(d, HOME).get("posture"), "exposed (no armed tower), 4 hostiles");
    });
});

describe("buildTimeline", () => {
    const kinds = rows => rows.map(r => `${r.tick}:${r.kind}`);

    test("prints a category only when its text changes", () => {
        const docs = [doc(100), doc(120), doc(140, { rooms: { [HOME]: homeRoom({ q: 3 }) } })];
        const rows = buildTimeline(docs, HOME);
        assert.deepEqual(kinds(rows.filter(r => r.kind === "spawn queue")), ["100:spawn queue", "140:spawn queue"]);
    });

    test("squad status transition, dead count and location shift each produce a row", () => {
        const route = sq => ({ home: HOME, target: TARGET, sq: [sq] });
        const docs = [
            doc(100, { ar: [route(squad())] }),
            doc(120, { ar: [route(squad({ st: "engaged", n: [0, 0, 2, 0], at: [2, 0, 0] }))] }),
            doc(140, { ar: [route(squad({ st: "engaged", n: [0, 0, 2, 0], at: [0, 0, 2] }))] }),
            doc(160, { ar: [route(squad({ st: "engaged", n: [0, 0, 1, 1], at: [0, 1, 0] }))] }),
            doc(180, { ar: [route(squad({ st: "engaged", n: [0, 0, 1, 1], at: [0, 1, 0] }))] }),
        ];
        const rows = buildTimeline(docs, TARGET).filter(r => r.kind.startsWith("army"));
        assert.deepEqual(rows.map(r => r.tick), [100, 120, 140, 160]);
        assert.match(rows[1].text, /staging · 2 at home/);
        assert.match(rows[2].text, /in transit · 2 en route/);
        assert.match(rows[3].text, /deployed · 1 in room · 1 lost/);
    });

    test("a route that disappears prints gone once", () => {
        const route = { home: HOME, target: TARGET, sq: [squad()] };
        const rows = buildTimeline([doc(100, { ar: [route] }), doc(120), doc(140)], TARGET);
        assert.deepEqual(kinds(rows.filter(r => r.kind.startsWith("army"))), ["100:army E23S45→E23S44", "120:army E23S45→E23S44"]);
        assert.equal(rows[1].text, "gone");
    });

    test("defense verdict flip", () => {
        const docs = [doc(100, { dv: [{ rm: TARGET, v: "covered" }] }), doc(120, { dv: [{ rm: TARGET, v: "holding" }] })];
        assert.deepEqual(buildTimeline(docs, TARGET).map(r => r.text), ["covered", "holding"]);
    });

    test("GAP marker for a hole wider than two publish intervals", () => {
        const rows = buildTimeline([doc(100), doc(180)], TARGET);
        assert.deepEqual(kinds(rows), ["180:GAP"]);
        assert.match(rows[0].text, /80 ticks since 100/);
    });

    test("degraded doc is marked and does not report routes as gone", () => {
        const route = { home: HOME, target: TARGET, sq: [squad()] };
        const degraded = { tick: 120, rooms: { [HOME]: { ...homeRoom(), roles: undefined, thr: undefined } } };
        const docs = [doc(100, { ar: [route] }), degraded, doc(140, { ar: [route] })];
        const rows = buildTimeline(docs, TARGET);
        assert.deepEqual(kinds(rows), ["100:army E23S45→E23S44", "120:DEGRADED", "140:DETAIL"]);
    });

    test("energy changes do not produce spawn queue rows", () => {
        const docs = [doc(100), doc(120, { rooms: { [HOME]: homeRoom({ e: 300, se: 49000 }) } })];
        assert.deepEqual(kinds(buildTimeline(docs, HOME).filter(r => r.kind === "spawn queue")), ["100:spawn queue"]);
    });

    test("a verdict vanishing inside a degraded run is gone on that tick", () => {
        const degradedRooms = { [HOME]: { ...homeRoom(), roles: undefined, thr: undefined } };
        const docs = [
            doc(100, { dv: [{ rm: TARGET, v: "holding" }] }),
            { tick: 120, rooms: degradedRooms, dv: [{ rm: TARGET, v: "holding" }] },
            { tick: 140, rooms: degradedRooms },
            doc(160),
        ];
        const rows = buildTimeline(docs, TARGET).filter(r => r.kind === "defense verdict");
        assert.deepEqual(rows.map(r => `${r.tick}:${r.text}`), ["100:holding", "140:gone"]);
    });

    test("out-of-order docs are sorted by tick", () => {
        const rows = buildTimeline([doc(140), doc(100)], HOME);
        assert.equal(rows[0].tick, 100);
    });

    test("room with nothing in the window yields no rows", () => {
        assert.deepEqual(buildTimeline([doc(100), doc(120)], "E1S1"), []);
    });
});

describe("formatTimeline", () => {
    test("empty window names the asked range", () => {
        assert.match(formatTimeline([], [], TARGET, 1, 2), /no snapshots in 1\.\.2/);
    });
    test("covered range and padded rows", () => {
        const docs = [doc(100), doc(120)];
        const out = formatTimeline(buildTimeline(docs, HOME), docs, HOME, 90, 130);
        assert.match(out, /2 snapshot\(s\) covering 100\.\.120 \(asked 90\.\.130\)/);
        assert.match(out, /^\s+100  spawn queue\s+0 queued$/m);
    });
    test("snapshots but no rows says nothing changed", () => {
        assert.match(formatTimeline([], [doc(100)], "E1S1", 1, 200), /nothing about E1S1 changed/);
    });
});
