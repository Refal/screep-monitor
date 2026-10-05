// The lazily rendered overview sections registry.
import { remoteLedgerSummary } from "../calc.js";
import { latest } from "../state.js";
import { renderRemoteEconomyTable } from "../ui/cells-economy.js";
import { renderArmyTable, renderArmyTiles } from "./army.js";
import { renderAttackLog } from "./attacks.js";
import { renderBoostMatrix, renderLabsTable } from "./boosts.js";
import { renderCampaignCharts, renderCampaignTable, renderCampaignTiles } from "./campaigns.js";
import { renderDefenseTable, renderDefenseTiles } from "./defense.js";
import { renderDepositLedgerTable, renderDepositTiles } from "./deposit.js";
import { renderEmpireCharts } from "./overview.js";
import { renderPowerFleetTable, renderPowerLedgerTable, renderPowerTiles } from "./power.js";
import { renderRemoteEconomyTiles } from "./remote-economy.js";
import { renderCorridorLog, renderRemoteLog, renderRemoteTable, renderRemoteTiles } from "./remote.js";
import { renderRoomsTable } from "./rooms.js";

// Each overview section is a <details> (see index.html). A collapsed one is
// display:none, and a Chart.js chart built inside a zero-sized container bakes
// a wrong devicePixelRatio it does not recover from — renderBarRows also sizes
// its .plot against a box that measures nothing. So render lazily: new data
// marks every section dirty, only the open ones render now, and the rest
// render when they are opened. On a phone with one section open that is 2-3
// charts instead of 16.
// Page order, matching index.html: live state an RCL8 empire acts on first,
// trend charts after it, and the two activity logs — history, not state —
// last. `history: true` keeps a section collapsed even on a wide screen.
export const SECTIONS = [
    { id: "defense",    render: () => { renderDefenseTiles(); renderDefenseTable(); } },
    { id: "army",       render: () => { renderArmyTiles(); renderArmyTable(); } },
    { id: "campaigns",  render: () => { renderCampaignTiles(); renderCampaignTable(); renderCampaignCharts(); } },
    { id: "power",      render: () => { renderPowerTiles(); renderPowerFleetTable(); renderPowerLedgerTable(); } },
    { id: "deposit",    render: () => { renderDepositTiles(); renderDepositLedgerTable(); } },
    { id: "boosts",     render: renderBoostMatrix },
    { id: "labs",       render: renderLabsTable },
    { id: "rooms",      render: renderRoomsTable },
    { id: "empire",     render: renderEmpireCharts },
    { id: "remote",     render: () => { renderRemoteTiles(); renderRemoteTable(); } },
    { id: "remote-economy", render: () => {
        const economy = remoteLedgerSummary(latest);
        renderRemoteEconomyTiles(economy);
        renderRemoteEconomyTable(economy);
    } },
    { id: "attacks",    render: renderAttackLog, history: true },
    { id: "remote-log", render: renderRemoteLog, history: true },
    { id: "corridor-log", render: renderCorridorLog, history: true },
];

export const dirtySections = new Set();

export const sectionEl = id => document.querySelector(`details[data-section="${id}"]`);

function resizeChartsIn(root) {
    if (!root) return;
    for (const canvas of root.querySelectorAll("canvas")) Chart.getChart(canvas)?.resize();
}

export function renderSection(section) {
    dirtySections.delete(section.id);
    section.render();
    resizeChartsIn(sectionEl(section.id));
}

export function initSectionToggle() {
    // `toggle` does not bubble, so this has to run in the capture phase.
    document.addEventListener("toggle", e => {
        const el = e.target;
        if (!(el instanceof HTMLDetailsElement) || !el.open) return;
        const section = SECTIONS.find(s => s.id === el.dataset.section);
        // No data yet (the boot-time open policy fires before the first fetch) or
        // already current: there is nothing to build, but a chart that was last
        // drawn while hidden still needs to re-measure.
        if (section && latest && dirtySections.has(section.id)) renderSection(section);
        else resizeChartsIn(el);
    }, true);
}

// A wide screen has room for every live section at once, so those open
// there; the two activity logs stay one click away, since ~1,300px of
// Invader sightings would otherwise sit between the state sections and the
// bottom of the page. Narrower than that, the one section index.html ships
// `open` (Defense, the per-room board the threat board points at) stands on
// its own — which is what keeps the default phone view short.
export function applySectionDefaults() {
    if (!matchMedia("(min-width: 1100px)").matches) return;
    for (const s of SECTIONS) {
        const el = sectionEl(s.id);
        if (el && !s.history) el.open = true;
    }
}
