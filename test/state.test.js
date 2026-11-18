import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cachedHistory, historyKey, stashHistory } from "../public/state.js";

const rows = label => [{ label }];

describe("history cache", () => {
    const cases = [
        {
            name: "a stashed entry reads back as the same rows",
            run: () => { const r = rows("a"); stashHistory("t1|24", r); return cachedHistory("t1|24") === r; },
        },
        {
            name: "a key never stashed reads back as an empty array",
            run: () => cachedHistory("never|6").length === 0,
        },
        {
            name: "the same range on two shards keeps separate entries",
            run: () => {
                stashHistory(historyKey("shardA", 24), rows("A"));
                stashHistory(historyKey("shardB", 24), rows("B"));
                return cachedHistory(historyKey("shardA", 24))[0].label === "A"
                    && cachedHistory(historyKey("shardB", 24))[0].label === "B";
            },
        },
        {
            name: "stashing an empty array keeps the earlier entry",
            run: () => {
                const r = rows("kept");
                stashHistory("t2|168", r);
                stashHistory("t2|168", []);
                return cachedHistory("t2|168") === r;
            },
        },
        {
            name: "reading an entry leaves it in place for the next read",
            run: () => {
                const r = rows("twice");
                stashHistory("t3|504", r);
                cachedHistory("t3|504");
                return cachedHistory("t3|504") === r;
            },
        },
    ];
    for (const { name, run } of cases) test(name, () => assert.equal(run(), true));
});
