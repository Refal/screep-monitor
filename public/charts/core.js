// Chart.js dataset/option builders and renderLine.
import { compact, fmtDuration, netRateSeries, netWindowRate, rateSeries, windowRate } from "../calc.js";
import { $, cssVar } from "../dom.js";
import { charts, history, historyGaps, rangeHours } from "../state.js";

function timeLabels() {
    const short = rangeHours <= 24;
    return history.map(r => short
        ? r.date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        : r.date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
}

// Default tooltip title (Chart.js's own default is the point's x-axis label)
// plus a note when the point right after it was flagged by detectGaps — the
// tooltip is where the exact outage duration lives, since the shaded band
// (gapBandPlugin) and the broken line (lineDataset's segment.borderColor)
// can't carry text of their own.
function tooltipTitle(items) {
    if (!items.length) return "";
    const title = items[0].label;
    const gap = historyGaps.find(g => g.afterIndex === items[0].dataIndex);
    return gap ? [title, `⚠ ${fmtDuration(gap.durationMs)} gap before this point — no data collected`] : title;
}

export function baseOptions(series) {
    const ink = { primary: cssVar("--text-primary"), muted: cssVar("--text-muted") };
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
            legend: {
                display: series >= 2,
                labels: { color: ink.primary, boxWidth: 18, boxHeight: 2, usePointStyle: false },
            },
            tooltip: {
                backgroundColor: cssVar("--surface-1"),
                titleColor: ink.primary,
                bodyColor: cssVar("--text-secondary"),
                borderColor: cssVar("--border"),
                borderWidth: 1,
                usePointStyle: false,
                callbacks: { title: tooltipTitle },
            },
        },
        scales: {
            x: {
                ticks: { color: ink.muted, maxTicksLimit: 5, maxRotation: 0, autoSkip: true },
                grid: { display: false },
                border: { color: cssVar("--axis") },
            },
            y: {
                ticks: { color: ink.muted, callback: v => compact(v) },
                grid: { color: cssVar("--grid") },
                border: { display: false },
                beginAtZero: true,
            },
        },
    };
}

export function lineDataset(label, data, colorVar) {
    const color = cssVar(colorVar);
    const nonNull = data.filter(v => v != null).length;
    return {
        label, data,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        // with only a few actual (non-null) points a 0-radius line is
        // invisible — show dots until enough real data fills in
        pointRadius: nonNull < 5 ? 3 : 0,
        pointHoverRadius: 4,
        pointHoverBorderColor: cssVar("--surface-1"),
        pointHoverBorderWidth: 2,
        tension: 0.15,
        // Breaks the line across a detected collection outage (historyGaps)
        // without discarding either real point on either side of it — unlike
        // a null data point, which would also blank out that point's own
        // (legitimate) value. Without this the category x-axis (see
        // timeLabels) draws the two points evenly spaced like any other step,
        // and the outage becomes invisible — the exact "false continuity"
        // this exists to prevent.
        segment: {
            borderColor: ctx => historyGaps.some(g => g.afterIndex === ctx.p1DataIndex) ? "transparent" : undefined,
        },
    };
}

// Shades each detected outage's column on the category x-axis so a gap reads
// at a glance, not just as a broken line (lineDataset's segment.borderColor).
// The axis stays category-based (see timeLabels), so the band's width is
// always exactly one column regardless of the outage's real duration — the
// tooltip title (tooltipTitle) carries the actual duration text.
const gapBandPlugin = {
    id: "gapBands",
    beforeDatasetsDraw(chart) {
        if (!historyGaps.length) return;
        const { ctx, chartArea, scales: { x } } = chart;
        if (!chartArea) return;
        ctx.save();
        ctx.fillStyle = cssVar("--status-warning") + "26"; // ~15% alpha
        for (const gap of historyGaps) {
            const left = x.getPixelForValue(gap.afterIndex - 1);
            const right = x.getPixelForValue(gap.afterIndex);
            ctx.fillRect(Math.min(left, right), chartArea.top, Math.abs(right - left), chartArea.bottom - chartArea.top);
        }
        ctx.restore();
    },
};

// Shared by rateDatasets/netRateDatasets: the raw-rate line plus a flat
// dashed line at the window average, so the current rate reads against the
// range's trend. The avg is omitted (and with it the legend, per
// baseOptions) when `wr` is null.
export function avgLineDataset(label, value) {
    const ds = lineDataset(label, history.map(() => value), "--series-2");
    Object.assign(ds, { borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, tension: 0 });
    return ds;
}

function rateLineDatasets(label, series, wr) {
    const datasets = [lineDataset(label, series, "--series-1")];
    if (wr) datasets.push(avgLineDataset(`avg ${compact(wr.rate)}/tick`, wr.rate));
    return datasets;
}

// Instantaneous per-tick rate for an {l,p,pt} field. Shared by the empire GCL
// chart and the per-room RCL chart. windowRate is null (so the avg line is
// omitted) when there's no positive gain in range.
export function rateDatasets(label, sel) {
    return rateLineDatasets(label, rateSeries(sel, history), windowRate(sel, history));
}

// The netRateSeries/netWindowRate analogue of rateDatasets, for plain
// (non {l,p,pt}) numeric fields such as defender-zone rampart hits, where the
// avg line can legitimately sit at or below zero — that's the shrinking signal this
// chart exists to show, not a "no data" state to omit like rateDatasets does
// for windowRate's null case.
export function netRateDatasets(label, sel) {
    return rateLineDatasets(label, netRateSeries(sel, history), netWindowRate(sel, history));
}

export function renderLine(key, canvasId, datasets, { yMax = undefined, unit = "" } = {}) {
    charts[key]?.destroy();
    const opts = baseOptions(datasets.length);
    if (yMax !== undefined) opts.scales.y.max = yMax;
    // Assigned onto the existing callbacks, not replacing them — tooltipTitle
    // (baseOptions) has to survive this or a unit'd chart loses its gap note.
    if (unit) opts.plugins.tooltip.callbacks.label = c => ` ${c.dataset.label}: ${compact(c.parsed.y)}${unit}`;
    charts[key] = new Chart($(canvasId), {
        type: "line", data: { labels: timeLabels(), datasets }, options: opts, plugins: [gapBandPlugin],
    });
}
