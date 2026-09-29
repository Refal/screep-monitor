// Hash-route reading/writing. No rendering imports, so sections can navigate without a cycle.
import { DEFAULT_RANGE, RANGES } from "./calc.js";
import { $ } from "./dom.js";
import { buildHash, OVERVIEW, parseHash, ROOM } from "./route.js";
import { latest, route, setRoute } from "./state.js";

// Everything that depends on the route but not on a re-fetch: which view is
// visible, and which range button reads as pressed. Called on every render, so
// a cold load of #/room/E18S59?range=168 paints the right button — which the
// old click-only handler never did.
export function applyRoute() {
    $("view-overview").hidden = route.view !== OVERVIEW;
    $("view-room").hidden = route.view !== ROOM;
    // Carries the range across, so leaving a room at 7d doesn't silently snap
    // the overview back to DEFAULT_RANGE and refetch.
    $("back-to-overview").href = buildHash({ view: OVERVIEW, range: route.range }, DEFAULT_RANGE);
    for (const b of $("range-group").querySelectorAll("button")) {
        b.setAttribute("aria-pressed", String(Number(b.dataset.range) === route.range));
    }
}

// Until a snapshot loads there is no way to know whether the hash's room is
// real, so parseHash keeps it. Once one has, re-resolve: a bookmark can
// outlive a room, and the honest answer is the overview. replaceState, not
// push, so Back doesn't bounce between the two.
// NB window.history — `history` alone is the snapshot array from state.js.
export function reconcileRoute() {
    const resolved = readHash();
    if (resolved.view === route.view && resolved.room === route.room) return;
    setRoute(resolved);
    window.history.replaceState(null, "", buildHash(route, DEFAULT_RANGE));
}

function currentRooms() {
    return latest ? Object.keys(latest.rooms) : null;
}

export function readHash() {
    return parseHash(location.hash, { ranges: RANGES, rooms: currentRooms(), defaultRange: DEFAULT_RANGE });
}

export function go(patch) {
    const next = buildHash({ ...route, ...patch }, DEFAULT_RANGE);
    if (next === (location.hash || "#/")) return;
    location.hash = next;
}
