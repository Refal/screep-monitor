// Hash routing for the dashboard. "#/" is the empire overview, "#/room/E23S45"
// is the per-room view, and the time range rides along as a query param, so a
// single link carries the whole view: #/room/E23S45?range=168&shard=shard3.
//
// Deliberately its own module rather than part of calc.js: calc.js is game
// math shared with scripts/collect.mjs and its unit tests, and a URL grammar
// for one web page has no business there. This file is pure and testable the
// same way.
//
// ?demo=1 and ?theme= stay in the real query string, not the hash — config.js
// reads them once at load, so they are load-time flags rather than view state.

export const OVERVIEW = "overview";
export const ROOM = "room";

// Screeps room names: W/E<x>N/S<y>. Validated before it reaches the DOM or a
// screeps.com URL, so a hand-edited hash can't inject anything.
const ROOM_NAME = /^[WE]\d{1,3}[NS]\d{1,3}$/;

function splitHash(hash) {
    const raw = String(hash ?? "").replace(/^#/, "");
    const q = raw.indexOf("?");
    return q === -1
        ? { path: raw, params: new URLSearchParams() }
        : { path: raw.slice(0, q), params: new URLSearchParams(raw.slice(q + 1)) };
}

// decodeURIComponent throws a URIError on a malformed percent escape, and a
// hand-edited hash can easily carry one ("#/room/%"). parseHash has to stay
// total: boot() calls readHash() before the first render, so a throw there
// aborts the boot and leaves a dead page. null falls through to the same
// overview fallback a bad room name gets.
function decodeSegment(raw) {
    try { return decodeURIComponent(raw); } catch { return null; }
}

// `rooms` is the list of rooms the current snapshot knows about, or null when
// no snapshot has loaded yet. Null means "can't judge": keep the requested
// room so a cold load of a bookmarked link still lands on it, and let a later
// parse (once data exists) drop it if it has genuinely gone.
export function parseHash(hash, { ranges, rooms = null, defaultRange, shards, defaultShard } = {}) {
    const { path, params } = splitHash(hash);

    // A range outside the button set must not survive. LOD_BY_RANGE has no
    // flag for it, so the snapshots query would quietly run unflagged — full
    // resolution over the whole window, thousands of reads.
    const asked = Number(params.get("range"));
    const range = ranges?.includes(asked) ? asked : defaultRange;

    // Same reasoning as range: the shard picks a Firestore path, so only a
    // known one may survive.
    const askedShard = params.get("shard");
    const shard = shards?.includes(askedShard) ? askedShard : defaultShard;

    const m = /^\/room\/([^/?]+)$/.exec(path);
    const room = m ? decodeSegment(m[1]) : null;
    if (!room || !ROOM_NAME.test(room)) return { view: OVERVIEW, room: null, range, shard };
    // A bookmark can outlive a room. Fall back to the overview rather than
    // rendering an empty room view.
    if (rooms && !rooms.includes(room)) return { view: OVERVIEW, room: null, range, shard };
    return { view: ROOM, room, range, shard };
}

// The default range and shard are left out so the common link stays
// "#/room/E23S45"; parseHash fills them back in, so this still round-trips.
export function buildHash({ view, room, range, shard } = {}, defaultRange, defaultShard) {
    const path = view === ROOM && room ? `#/room/${encodeURIComponent(room)}` : "#/";
    const params = new URLSearchParams();
    if (range != null && range !== defaultRange) params.set("range", String(range));
    if (shard != null && shard !== defaultShard) params.set("shard", shard);
    const query = params.toString();
    return query ? `${path}?${query}` : path;
}
