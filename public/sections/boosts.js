// Boost matrix and labs sections.
import { MATRIX_LADDERS, RAW_INPUTS } from "../constants.js";
import { cssVar, fmtInt } from "../dom.js";
import { latest } from "../state.js";
import { boostChip, boostChipText, chipsCell, LAB_WARNING_STATES, labStatusWord } from "../ui/cells-labs.js";
import { makeBadge, roomLinkCell } from "../ui/links.js";
import { byRoomName, naCell, renderTable, textCell } from "../ui/table.js";

function labStatusBadge(s) {
    const colors = {
        reaction: cssVar("--status-good"),
        boost: cssVar("--series-1"),
        idle: cssVar("--text-muted"),
    };
    const color = LAB_WARNING_STATES.has(s) ? cssVar("--status-warning") : colors[s];
    return makeBadge(color ?? cssVar("--text-muted"), labStatusWord(s));
}

function labStatusCell(lab) {
    if (!lab) return naCell("no labs", "this room has no labs built");
    const td = document.createElement("td");
    td.append(labStatusBadge(lab.s));
    return td;
}

// Every lab field is absent in two different ways — the room has no labs at
// all, or it has labs and simply isn't running a reaction right now — and the
// reader needs to tell them apart.
function labCell(lab, value) {
    if (!lab) return naCell("no labs", "this room has no labs built");
    if (value == null) return naCell("idle", "labs are built but no reaction is running in this room");
    return textCell(value);
}

function labsColumns() {
    return [
        { key: "room", label: "Room", primary: true, cell: ([n]) => roomLinkCell(n) },
        { key: "status", label: "Status", cell: ([, r]) => labStatusCell(r.lab) },
        { key: "reaction", label: "Reaction",
          cell: ([, r]) => labCell(r.lab, r.lab?.o ? `${r.lab.i1?.[0] ?? "?"} + ${r.lab.i2?.[0] ?? "?"} → ${r.lab.o}` : null) },
        { key: "in1", label: "In 1", tier: 3, hint: "contents of the first input lab",
          cell: ([, r]) => labCell(r.lab, r.lab?.i1 ? `${r.lab.i1[0]} ${fmtInt.format(r.lab.i1[1])}` : null) },
        { key: "in2", label: "In 2", tier: 3, hint: "contents of the second input lab",
          cell: ([, r]) => labCell(r.lab, r.lab?.i2 ? `${r.lab.i2[0]} ${fmtInt.format(r.lab.i2[1])}` : null) },
        { key: "out", label: "Output", hint: "output compound held across the output labs",
          cell: ([, r]) => labCell(r.lab, r.lab?.ot != null ? fmtInt.format(r.lab.ot) : null) },
        { key: "cd", label: "Cooldown", tier: 3, hint: "longest remaining cooldown among the output labs",
          cell: ([, r]) => labCell(r.lab, r.lab?.cd != null ? String(r.lab.cd) : null) },
        { key: "lc", label: "Labs i/o/b", tier: 3, hint: "lab counts: input / output / boost",
          cell: ([, r]) => labCell(r.lab, r.lab ? r.lab.lc.join("/") : null) },
    ];
}

export function renderLabsTable() {
    renderTable("labs-table", labsColumns(), byRoomName(latest.rooms));
}

// Built from MATRIX_LADDERS rather than hand-listed, so the header labels can
// no longer drift from the symbols the cells actually read (they used to be
// duplicated in index.html).
function boostMatrixColumns(bmax) {
    const ladders = MATRIX_LADDERS.map(([purpose, tiers]) => ({
        key: `b-${purpose}`,
        label: purpose === "build/repair" ? "build" : purpose,
        sym: tiers[0],
        hint: `${purpose} boosts, T1 · T2 · T3 — ${tiers.join(" · ")}`,
        cell: ([name, r]) => chipsCell(
            tiers.map((sym, i) => boostChip(`${name} · ${purpose} T${i + 1} · ${sym}`, (r.bst ?? {})[sym] ?? 0, bmax[sym], false)),
            tiers.map(sym => boostChipText((r.bst ?? {})[sym] ?? 0, bmax[sym], false)).join(" · ")),
    }));
    const raw = RAW_INPUTS.map(([label, sym], i) => ({
        key: `raw-${sym}`,
        label: sym,
        group: i === 0,
        hint: `${label} — raw reaction input, shown as stock rather than boostable parts`,
        cell: ([name, r]) => chipsCell(
            [boostChip(`${name} · ${label}`, (r.bst ?? {})[sym] ?? 0, bmax[sym], true)],
            boostChipText((r.bst ?? {})[sym] ?? 0, bmax[sym], true)),
    }));
    return [
        { key: "room", label: "Room", primary: true, cell: ([n]) => roomLinkCell(n) },
        ...ladders,
        ...raw,
    ];
}

export function renderBoostMatrix() {
    renderTable("boost-matrix", boostMatrixColumns(latest.bmax ?? {}), byRoomName(latest.rooms));
}
