// Ordering helpers behind the tables: natural room-name order and the
// click-to-sort comparator in ui/table.js.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cmpRoom } from "../public/calc.js";
import { compareSortValues } from "../public/ui/table.js";

describe("cmpRoom", () => {
    test("compares the numbers in a room name numerically", () => {
        assert.deepEqual(["E10S5", "E9S5", "E9S12", "W1N1", "E9S3"].sort(cmpRoom),
            ["E9S3", "E9S5", "E9S12", "E10S5", "W1N1"]);
    });
});

describe("compareSortValues", () => {
    const sortBy = (values, dir) => [...values].sort((a, b) => compareSortValues(a, b, dir));

    test("numbers ascending and descending", () => {
        assert.deepEqual(sortBy([3, -1, 10, 0], 1), [-1, 0, 3, 10]);
        assert.deepEqual(sortBy([3, -1, 10, 0], -1), [10, 3, 0, -1]);
    });

    test("strings use room-name order", () => {
        assert.deepEqual(sortBy(["E10S5", "E9S5"], 1), ["E9S5", "E10S5"]);
        assert.deepEqual(sortBy(["E10S5", "E9S5"], -1), ["E10S5", "E9S5"]);
    });

    test("blanks sink to the bottom in both directions", () => {
        assert.deepEqual(sortBy([null, 2, undefined, NaN, 1], 1).slice(0, 2), [1, 2]);
        assert.deepEqual(sortBy([null, 2, undefined, NaN, 1], -1).slice(0, 2), [2, 1]);
    });
});
