// Lab status and boost-stock helpers shared by the boosts section, the room view and the power table.
import { boostFillLevel, boostFloor, compact, PARTS_PER_BOOST } from "../calc.js";
import { BOOST_LADDERS, RAW_INPUTS } from "../constants.js";
import { $, cssVar, fmtInt } from "../dom.js";
import { latest } from "../state.js";
import { makeBadge } from "./links.js";
import { naCell } from "./table.js";

// The bot's lab states, with its two internal names spelled for a reader.
const LAB_STATUS_LABEL = { resource_check: "resources", boost: "boosting" };

export const labStatusWord = s => LAB_STATUS_LABEL[s] ?? s;

// Stalled between reactions. The badge's warning colour and the "short" tone
// of the room strip and glance row all come from this one list.
export const LAB_WARNING_STATES = new Set(["prepare", "resource_check", "finished"]);

export const labTone = s => LAB_WARNING_STATES.has(s) ? "short" : undefined;

// A chip is a colour and nothing else, so on its own it says only "roughly
// this full". The number lives in `title`, which touch never sees — chipText()
// below is what the card layout prints instead.
export function boostChipText(amount, max, raw) {
    const value = raw ? (amount ?? 0) : Math.floor((amount ?? 0) / PARTS_PER_BOOST);
    if (!value) return "0";
    return max ? `${compact(value)}/${compact(raw ? max : Math.floor(max / PARTS_PER_BOOST))}` : compact(value);
}

export function boostChip(label, amount, max, raw) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const level = boostFillLevel(amount, max, raw);
    const value = raw ? (amount ?? 0) : Math.floor((amount ?? 0) / PARTS_PER_BOOST);
    if (level === null) {
        chip.classList.add("nomax");
        chip.title = `${label} · ${compact(value)} parts · no max configured`;
    } else {
        chip.style.background = level === 0 ? cssVar("--grid") : cssVar(`--fill-${level}`);
        if (level === 0 && amount) {
            chip.title = `${label} · ${fmtInt.format(amount)} · ${boostFloor(raw).reason}`;
        } else if (level === 0) {
            chip.title = `${label} · none`;
        } else {
            const fillPct = max ? Math.round(Math.min(1, amount / max) * 100) : 0;
            chip.title = `${label} · ${fmtInt.format(value)} parts · ${fillPct}% of max`;
        }
    }
    return chip;
}

function boostCell(amount, max, raw) {
    const floor = boostFloor(raw);
    // Below the floor is not "nothing in stock": it is stock too small to be
    // worth anything, which is a different thing to know.
    if (!amount) return naCell("none", raw ? "no stock of this compound" : "no stock of this boost");
    if (amount < floor.amount) return naCell("trace", `${fmtInt.format(amount)} · ${floor.reason}`);
    const td = document.createElement("td");
    const value = raw ? amount : Math.floor(amount / PARTS_PER_BOOST);
    if (!max) {
        td.textContent = compact(value);
        return td;
    }
    const level = boostFillLevel(amount, max, raw);
    const fill = Math.min(1, amount / max);
    td.append(makeBadge(cssVar(`--fill-${level}`), `${compact(value)} · ${Math.round(fill * 100)}%`));
    return td;
}

export function renderBoostGrid(room) {
    $("room-boosts-title").textContent = `Boosts · ${room} · parts boostable, fill vs configured max`;
    const bst = latest.rooms[room]?.bst ?? {};
    const bmax = latest.bmax ?? {};
    const tbody = $("boost-grid").querySelector("tbody");
    const ladderRows = BOOST_LADDERS.map(([purpose, tiers]) => {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.textContent = purpose;
        tr.append(td);
        for (const sym of tiers) tr.append(boostCell(bst[sym] ?? 0, bmax[sym], false));
        return tr;
    });
    const rawRows = RAW_INPUTS.map(([name, sym]) => {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.textContent = `${name} (${sym}) · raw`;
        tr.append(td, boostCell(bst[sym] ?? 0, bmax[sym], true));
        for (let i = 0; i < 2; i++) {
            const empty = document.createElement("td");
            empty.textContent = "";
            tr.append(empty);
        }
        return tr;
    });
    tbody.replaceChildren(...ladderRows, ...rawRows);
}

export function chipsCell(chips, text) {
    const td = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "chips";
    wrap.append(...chips);
    td.append(wrap);
    if (text) {
        // Only rendered in card mode (see styles.css): at table density the
        // chips plus a tooltip are enough, and 12 columns of numbers would not
        // fit anyway.
        const values = document.createElement("span");
        values.className = "chip-values";
        values.textContent = text;
        td.append(values);
    }
    return td;
}
