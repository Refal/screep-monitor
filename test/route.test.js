import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseHash, buildHash, OVERVIEW, ROOM } from "../public/route.js";
import { RANGES, DEFAULT_RANGE, LOD_BY_RANGE } from "../public/calc.js";

const OPTS = { ranges: RANGES, defaultRange: DEFAULT_RANGE };
const withRooms = rooms => ({ ...OPTS, rooms });

describe("parseHash", () => {
    test("an empty or bare hash is the overview at the default range", () => {
        for (const h of ["", "#", "#/", undefined, null]) {
            assert.deepEqual(parseHash(h, OPTS), { view: OVERVIEW, room: null, range: DEFAULT_RANGE });
        }
    });

    test("a room path selects the room view", () => {
        assert.deepEqual(parseHash("#/room/E23S45", OPTS), { view: ROOM, room: "E23S45", range: DEFAULT_RANGE });
        assert.deepEqual(parseHash("#/room/W1N1", OPTS).room, "W1N1");
    });

    test("range rides along as a query param", () => {
        assert.equal(parseHash("#/?range=168", OPTS).range, 168);
        assert.equal(parseHash("#/room/E23S45?range=6", OPTS).range, 6);
        assert.equal(parseHash("#/room/E23S45?range=6", OPTS).room, "E23S45");
    });

    test("a range outside RANGES falls back to the default", () => {
        // Not cosmetic: LOD_BY_RANGE has no flag for an unlisted window, so the
        // snapshots query would run unflagged at full resolution.
        for (const bad of ["0", "12", "-24", "1e6", "abc", ""]) {
            assert.equal(parseHash(`#/?range=${bad}`, OPTS).range, DEFAULT_RANGE, bad);
        }
        for (const hours of Object.keys(LOD_BY_RANGE)) {
            assert.equal(parseHash(`#/?range=${hours}`, OPTS).range, Number(hours));
        }
    });

    test("a room the snapshot doesn't have falls back to the overview", () => {
        const r = parseHash("#/room/E23S45", withRooms(["E11S11"]));
        assert.deepEqual(r, { view: OVERVIEW, room: null, range: DEFAULT_RANGE });
    });

    test("with no room list yet, a requested room survives", () => {
        // Cold load of a bookmark: no snapshot has arrived, so there is nothing
        // to validate against and dropping the room would lose the link.
        assert.equal(parseHash("#/room/E23S45", OPTS).view, ROOM);
        assert.equal(parseHash("#/room/E23S45", withRooms(null)).view, ROOM);
    });

    test("the range survives a room that gets dropped", () => {
        assert.equal(parseHash("#/room/E23S45?range=168", withRooms(["E11S11"])).range, 168);
    });

    test("a malformed room name is refused", () => {
        for (const bad of ["nope", "E23", "../etc", "E23S45/x", "<script>", "E9999S1"]) {
            assert.equal(parseHash(`#/room/${bad}`, OPTS).view, OVERVIEW, bad);
        }
    });

    test("a malformed percent escape is refused, not thrown", () => {
        // decodeURIComponent throws a URIError on these. parseHash has to stay
        // total: app.js calls readHash() at module top level, so a throw there
        // aborts the module and the page never finishes booting.
        for (const bad of ["%", "%E0%A4", "E23S45%", "%zz"]) {
            assert.deepEqual(
                parseHash(`#/room/${bad}`, OPTS),
                { view: OVERVIEW, room: null, range: DEFAULT_RANGE },
                bad);
        }
    });

    test("a malformed escape still yields the requested range", () => {
        assert.equal(parseHash("#/room/%?range=168", OPTS).range, 168);
    });

    test("an unknown path is the overview, not an error", () => {
        assert.equal(parseHash("#/whatever/else", OPTS).view, OVERVIEW);
    });
});

describe("buildHash", () => {
    test("the overview is #/", () => {
        assert.equal(buildHash({ view: OVERVIEW, range: DEFAULT_RANGE }, DEFAULT_RANGE), "#/");
    });

    test("the default range is left out, any other range included", () => {
        assert.equal(buildHash({ view: ROOM, room: "E23S45", range: DEFAULT_RANGE }, DEFAULT_RANGE), "#/room/E23S45");
        assert.equal(buildHash({ view: ROOM, room: "E23S45", range: 168 }, DEFAULT_RANGE), "#/room/E23S45?range=168");
        assert.equal(buildHash({ view: OVERVIEW, range: 6 }, DEFAULT_RANGE), "#/?range=6");
    });

    test("a room view with no room degrades to the overview", () => {
        assert.equal(buildHash({ view: ROOM, room: null, range: DEFAULT_RANGE }, DEFAULT_RANGE), "#/");
    });
});

describe("round trip", () => {
    test("every view survives buildHash -> parseHash", () => {
        const rooms = ["E23S45", "W1N1"];
        for (const view of [OVERVIEW, ROOM]) {
            for (const room of view === ROOM ? rooms : [null]) {
                for (const range of RANGES) {
                    const state = { view, room, range };
                    const back = parseHash(buildHash(state, DEFAULT_RANGE), withRooms(rooms));
                    assert.deepEqual(back, state, JSON.stringify(state));
                }
            }
        }
    });
});
