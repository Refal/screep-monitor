// Tunables and game-fact tables shared across the dashboard modules.

export const MAX_POINTS = 500;

// firestore.rules caps snapshots list() queries at request.query.limit <= 9000
// (anonymous-scan quota defense — see README "On the web apiKey"). Both
// history queries in data.js must carry it or Firestore denies them.
export const MAX_HISTORY_DOCS = 9000;

// Game facts (compound ladders per boost purpose), same order as the bot CLI.
// Stock amounts come from the payload (`bst`), maxes from `bmax` — only the
// symbols are safe to hardcode here.
export const BOOST_LADDERS = [
    ["attack", ["UH", "UH2O", "XUH2O"]],
    ["ranged", ["KO", "KHO2", "XKHO2"]],
    ["heal", ["LO", "LHO2", "XLHO2"]],
    ["tough", ["GO", "GHO2", "XGHO2"]],
    ["harvest", ["UO", "UHO2", "XUHO2"]],
    ["build/repair", ["LH", "LH2O", "XLH2O"]],
    ["dismantle", ["ZH", "ZH2O", "XZH2O"]],
    ["upgrade", ["GH", "GH2O", "XGH2O"]],
    ["move", ["ZO", "ZHO2", "XZHO2"]],
    ["carry", ["KH", "KH2O", "XKH2O"]],
];

// Reaction inputs shown as raw stock, not boostable parts.
export const RAW_INPUTS = [["hydroxide", "OH"], ["catalyst", "X"], ["ghodium", "G"]];

// All-rooms matrix drops harvest/carry to keep the column count tight — still
// shown in the per-room detail grid, which uses BOOST_LADDERS directly.
export const MATRIX_LADDERS = BOOST_LADDERS.filter(([purpose]) => purpose !== "harvest" && purpose !== "carry");

export const POLL_MS = 5 * 60e3;

export const STALE_PROBE_MS = 2.5 * 60e3;

export const STALE_AFTER_MS = 15 * 60e3;

export const ATTACK_LOG_MAX_ROWS = 20;
