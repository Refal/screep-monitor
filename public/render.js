// renderAll and the header status line.
import { STALE_AFTER_MS } from "./constants.js";
import { $, fmtInt, setStatus } from "./dom.js";
import { applyRoute, reconcileRoute } from "./nav.js";
import { OVERVIEW } from "./route.js";
import { dirtySections, renderSection, sectionEl, SECTIONS } from "./sections/index.js";
import { renderDataGapNote, renderRoomsGlance, renderTiles } from "./sections/overview.js";
import { renderRoomCharts } from "./sections/room-view.js";
import { renderRoomSelect } from "./sections/rooms.js";
import { renderThreatBoard } from "./sections/threat-board.js";
import { latest, route } from "./state.js";

// Renders whichever view the route selects. Skipping the hidden one is not
// just an economy: Chart.js sizes a canvas from its container, so building the
// room view's charts while it is display:none produces six 0x0 charts and
// leaks the ResizeObserver that renderNuker and renderRoomDefense already
// guard against individually.
export function renderAll() {
    reconcileRoute();
    applyRoute();
    renderThreatBoard();
    renderTiles();
    renderRoomsGlance();
    renderDataGapNote();
    renderRoomSelect();
    for (const s of SECTIONS) dirtySections.add(s.id);
    if (route.view === OVERVIEW) {
        for (const s of SECTIONS) if (sectionEl(s.id)?.open) renderSection(s);
    } else {
        renderRoomCharts();
    }
    renderStatus();
}

// Ms since latest's snapshot was taken, shared by renderStatus (the "(N min
// ago)" readout) and scheduleNextPoll (aiming the next poll at latest's age).
export function dataAgeMs() {
    return latest ? Date.now() - latest.ts.toDate().getTime() : 0;
}

// Redraws only the header status line — tick, timestamp, and age. Cheap
// enough to run on its own 30s tick so "(N min ago)" counts up live between
// polls instead of only updating when a full refresh happens to land.
export function renderStatus() {
    if (!latest) return;
    const when = latest.ts.toDate();
    const ageMs = dataAgeMs();
    const age = Math.round(ageMs / 60000);
    const sameDay = when.toDateString() === new Date().toDateString();
    const stamp = sameDay
        ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        : when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const stale = ageMs > STALE_AFTER_MS;
    setStatus(`tick ${fmtInt.format(latest.tick)} · updated ${stamp} (${age} min ago)${stale ? " · stale" : ""}`);
    $("status").classList.toggle("stale", stale);
}
