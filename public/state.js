// Shared mutable dashboard state. Readers import the bindings directly (they are live);
// writers go through the setters at the bottom.
import { DEFAULT_RANGE } from "./calc.js";
import { OVERVIEW } from "./route.js";

export let rangeHours = DEFAULT_RANGE;

// The view, mirrored from location.hash. Every control writes the hash and
// lets onHashChange drive the state, so a bookmark, the Back button and a
// click all take exactly the same path.
export let route = { view: OVERVIEW, room: null, range: DEFAULT_RANGE };

export let selectedRoom = null;

export let latest = null;

export let history = [];        // downsampled [{date, tick, gcl, gpl?, cpu, cr, rooms}]

export let historyRaw = [];     // every fetched row for the current range, un-downsampled

export let historyGaps = [];    // detectGaps(history, ...) — collection outages within `history`

export const charts = {};

// ES imports are read-only for the importer, so a module that needs to change
// one of the bindings above goes through its setter. Readers just import the
// name and always see the current value. The arrays are replaced, never
// mutated in place, so every write to shared state is one of these setters.
export const setLatest = value => { latest = value; };
export const setHistory = value => { history = value; };
export const setHistoryRaw = value => { historyRaw = value; };
export const setHistoryGaps = value => { historyGaps = value; };
export const setRoute = value => { route = value; };
export const setSelectedRoom = value => { selectedRoom = value; };
export const setRangeHours = value => { rangeHours = value; };
