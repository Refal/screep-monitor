// Player campaigns section (pc). Stronghold sieges are the Army section's.
import {
    campaignHoldText, campaignNow, campaignOutcomeText, campaignPhaseInfo, campaignPicketInfo, campaignSafeModeText, campaignStarve,
    campaignTargets, campaignTrend, campaignVerdict, campaigns, compact,
} from "../calc.js";
import { lineDataset, renderLine } from "../charts/core.js";
import { $, cssVar } from "../dom.js";
import { history, latest } from "../state.js";
import { TONE_COLOR, ticksText, toneClass } from "../ui/format.js";
import { makeBadge, roomLinkCell } from "../ui/links.js";
import { naCell, renderTable, textCell } from "../ui/table.js";
import { renderTileRow } from "../ui/tiles.js";

const SERIES = ["--series-1", "--series-2", "--series-3", "--series-4"];
const NOT_PUBLISHED = "the bot did not publish this field for this campaign yet";
const VISION_NOTE = "known only when the bot has vision of the room, about every 1000 ticks, so it changes in steps";

const badgeCell = (info, text, title) => {
    const td = document.createElement("td");
    td.append(makeBadge(cssVar(TONE_COLOR[info.tone] ?? TONE_COLOR.na), text));
    td.title = title ?? info.explain;
    return td;
};

function phaseCell(c) {
    const info = campaignPhaseInfo(c.ph);
    const hold = campaignHoldText(c);
    const outcome = campaignOutcomeText(c);
    const td = badgeCell(info, `${info.word} · ${ticksText(c.pa)}`);
    const parked = c.ph === "starve" && c.vd != null && c.vd !== "go";
    const steady = !parked ? null
        : campaignStarve(c)?.inScope > 0 ? "steady state: breach skipped, starve keeps running" : "parked in starve: breach skipped";
    const note = hold ?? outcome ?? steady;
    if (note) {
        const el = document.createElement("div");
        el.className = "cell-note";
        el.textContent = note;
        td.append(el);
    }
    return td;
}

function nowCell(c) {
    const now = campaignNow(c);
    const td = textCell(now.text, toneClass(now.tone));
    td.title = "what the bot is doing to this campaign right now";
    return td;
}

function verdictCell(c) {
    const v = campaignVerdict(c);
    if (!v) return naCell("none yet", NOT_PUBLISHED);
    return badgeCell(v, v.detail ? `${v.word} · ${v.detail}` : v.word, v.explain);
}

function numberCell(value, why) {
    if (value == null) return naCell("—", `${why ?? NOT_PUBLISHED}`);
    const td = textCell(compact(value));
    td.title = VISION_NOTE;
    return td;
}

function ringCell(c) {
    if (!Array.isArray(c.rg)) return naCell("—", NOT_PUBLISHED);
    const [ramparts, walls, seats, open] = c.rg;
    const td = textCell(`${ramparts} ramparts · ${walls} walls · ${seats} seat${seats === 1 ? "" : "s"}${open ? " · open approach" : ""}`);
    td.title = "barrier counts of the target's ring, seats kept, and whether an approach is left open";
    return td;
}

function safeModeCell(c) {
    const text = campaignSafeModeText(c);
    if (text == null) return naCell("—", NOT_PUBLISHED);
    return textCell(text, c.sm[1] > 0 ? toneClass("serious") : undefined);
}

function starveCell(c) {
    const s = campaignStarve(c);
    if (!s) return naCell("—", "only the starve phase publishes starve coverage");
    if (s.inScope === 0) return naCell("nothing to starve", `no reserved remotes of ${c.ow} within 2 hops known`);
    const td = textCell(`${s.covered}/${s.inScope} covered · ${s.kills} killed : ${s.lost} lost`,
        s.lost > s.kills ? toneClass("short") : undefined);
    td.title = "denial rooms covered of those in scope; creeps we killed against creeps we lost";
    return td;
}

function attritionCell(c) {
    if (!Array.isArray(c.lb)) return naCell("—", NOT_PUBLISHED);
    const td = textCell(`${c.lb[0]} · ratio ${compact(c.lb[1])}`);
    td.title = "ledger estimate only; the bot does not run this lever";
    return td;
}

function picketCell(c) {
    const info = campaignPicketInfo(c);
    if (!info) return naCell("—", NOT_PUBLISHED);
    return badgeCell(info, info.word);
}

function keyStructuresCell(c) {
    return c.ke == null ? naCell("—", NOT_PUBLISHED) : textCell(`${c.ke} spawns + towers`);
}

function visionAgeCell(c) {
    return c.va == null ? naCell("—", NOT_PUBLISHED) : textCell(ticksText(c.va), c.va > 2000 ? toneClass("short") : undefined);
}

const CAMPAIGN_COLUMNS = [
    { key: "target", label: "Target", primary: true, sort: c => c.tg, cell: c => roomLinkCell(c.tg) },
    { key: "owner", label: "Owner", sort: c => c.ow, cell: c => textCell(c.ow) },
    { key: "now", label: "Now", hint: "what the bot is doing to this campaign right now", cell: nowCell },
    { key: "phase", label: "Phase", hint: "the campaign's phase and how long it has been in it, with the hold reason or outcome underneath", cell: phaseCell },
    { key: "verdict", label: "Verdict", hint: "whether a breach force can be fielded; for a go, the doctrine, home, waves and breach time", cell: verdictCell },
    { key: "ring", label: "Ring", tier: 3, cell: ringCell },
    { key: "ringHits", label: "Ring hits", hint: `summed hits of the target's ring barriers at the last vision — ${VISION_NOTE}`, sort: c => c.rh, cell: c => numberCell(c.rh) },
    { key: "energy", label: "Target energy", hint: `storage plus terminal energy at the last vision — ${VISION_NOTE}`, sort: c => c.te, cell: c => numberCell(c.te) },
    { key: "keys", label: "Key structures", tier: 3, hint: "hostile spawns plus towers", sort: c => c.ke, cell: keyStructuresCell },
    { key: "safeMode", label: "Safe mode", hint: "charges left and ticks of active safe mode", cell: safeModeCell },
    { key: "starve", label: "Starve", hint: "denial rooms covered of those in scope, creeps killed against lost", cell: starveCell },
    { key: "attrition", label: "Attrition estimate", tier: 3, hint: "ledger only — the bot does not run this lever; ratio = their credits lost per credit we'd spend", cell: attritionCell },
    { key: "picket", label: "Picket", tier: 3, hint: "the boosted raider kept outside the ring: committed, pending, or why it was skipped", cell: picketCell },
    { key: "vision", label: "Vision age", tier: 3, hint: "ticks since the bot last saw the target room", sort: c => c.va, cell: visionAgeCell },
];

function campaignTiles(list) {
    const active = list.filter(c => c.ph !== "done" && c.ph !== "abandoned");
    const tiles = [{
        label: "Active campaigns", value: String(active.length),
        delta: list.length > active.length ? `${list.length - active.length} finished` : active.length ? active.map(c => c.tg).join(" ") : "none",
    }];
    for (const c of list) {
        const info = campaignPhaseInfo(c.ph);
        const s = campaignStarve(c);
        const safe = c.sm?.[1] > 0;
        const parts = [
            campaignNow(c).text,
            s?.inScope > 0 ? `kills ${s.kills}:${s.lost}` : null,
            safe ? `SAFE MODE ${ticksText(c.sm[1])} left` : null,
        ].filter(Boolean);
        tiles.push({
            label: `${c.tg} · ${c.ow}`, value: `${info.word} · ${ticksText(c.pa)}`,
            delta: parts.join(" · ") || "no verdict yet",
            tone: safe ? "serious" : s && s.lost > s.kills ? "short" : undefined,
        });
    }
    return tiles;
}

export function renderCampaignTiles() {
    const list = campaigns(latest);
    renderTileRow("campaign-tiles", list.length ? campaignTiles(list) : [{ label: "Active campaigns", value: "0", delta: "none" }]);
}

export function renderCampaignTable() {
    renderTable("campaign-table", CAMPAIGN_COLUMNS, campaigns(latest),
        { text: "no player campaigns", why: "the bot publishes pc only while a campaign exists" });
}

// Steps, not slopes: rh / te only change at a vision (see campaignTrend).
function stepDataset(label, data, colorVar, dashed) {
    const ds = lineDataset(label, data, colorVar);
    Object.assign(ds, { stepped: "after", spanGaps: false, pointRadius: 0, tension: 0 });
    if (dashed) ds.borderDash = [5, 4];
    return ds;
}

export function renderCampaignCharts() {
    const targets = campaignTargets(history, latest);
    $("campaign-charts").hidden = !targets.length;
    if (!targets.length) return;
    const ring = [], energy = [], denial = [];
    targets.forEach((tg, i) => {
        const t = campaignTrend(history, tg);
        const color = SERIES[i % SERIES.length];
        ring.push(stepDataset(`${tg} ring hits`, t.rh, color));
        energy.push(stepDataset(`${tg} energy`, t.te, color));
        denial.push(stepDataset(`${tg} killed`, t.kills, color));
        denial.push(stepDataset(`${tg} lost`, t.lost, color, true));
    });
    renderLine("campaignRing", "c-campaign-ring", ring);
    renderLine("campaignEnergy", "c-campaign-energy", energy);
    renderLine("campaignDenial", "c-campaign-denial", denial);
}
