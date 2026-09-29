// Horizontal bar-chart renderer and the roles chart.
import { $, cssVar } from "../dom.js";
import { charts, latest } from "../state.js";
import { baseOptions } from "./core.js";

// Shared horizontal-bar recipe for "current vs desired"-style charts — roles,
// the defense fleet, and the damage-balance bars all use this. The options
// object (axes swapped, per-row height) is identical across all three; only
// the labels/datasets differ.
export function renderBarRows(key, canvasId, labels, datasets, { rowHeight = 34, minHeight = 200 } = {}) {
    charts[key]?.destroy();
    const opts = baseOptions(datasets.length);
    // legend swatches mirror the mark: rects for bars, not line keys
    opts.plugins.legend.labels.boxWidth = 10;
    opts.plugins.legend.labels.boxHeight = 10;
    opts.indexAxis = "y";
    opts.interaction = { mode: "index", intersect: false, axis: "y" };
    opts.scales = {
        x: {
            ticks: { color: cssVar("--text-muted"), precision: 0 },
            grid: { color: cssVar("--grid") },
            border: { display: false },
            beginAtZero: true,
        },
        y: {
            ticks: { color: cssVar("--text-primary"), autoSkip: false, font: { size: 11 } },
            grid: { display: false },
            border: { color: cssVar("--axis") },
        },
    };
    charts[key] = new Chart($(canvasId), { type: "bar", data: { labels, datasets }, options: opts });
    const card = $(canvasId).closest(".plot");
    card.style.height = `${Math.max(minHeight, labels.length * rowHeight + 60)}px`;
}

export function renderRolesChart(room) {
    const roles = latest.rooms[room]?.roles ?? [];
    const labels = roles.map(x => x.rm ? `${x.r} → ${x.rm}` : x.r);
    renderBarRows("roles", "c-roles", labels, [
        { label: "Current", data: roles.map(x => x.c), backgroundColor: cssVar("--series-1"),
          borderRadius: { topRight: 4, bottomRight: 4 }, maxBarThickness: 14 },
        { label: "Desired", data: roles.map(x => x.d), backgroundColor: cssVar("--series-2"),
          borderRadius: { topRight: 4, bottomRight: 4 }, maxBarThickness: 14 },
    ]);
}
