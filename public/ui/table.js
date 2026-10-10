// Shared table renderer: one column spec per table, desktop table and mobile card layouts.
import { cmpRoom } from "../calc.js";
import { $ } from "../dom.js";

// Single full-width "nothing to show" row. Both activity logs distinguish
// several empty states from each other (degraded vs genuinely quiet), so the
// text and its explanation are the caller's, not this helper's.
function naRow(colSpan, text, title) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = colSpan;
    td.className = "na";
    td.textContent = text;
    if (title) td.title = title;
    tr.append(td);
    return tr;
}

// Every table on this page has the same shape: a sorted row list and one cell
// builder per column. Declaring the columns instead of appending them lets one
// renderer serve all seven — and, more to the point, lets each cell carry the
// metadata the mobile card layout needs (`data-label` for the ::before label,
// `data-tier` for what folds away, `data-primary` for the room name) without
// any of the 26 cell builders having to know a card layout exists. The two
// modes live in styles.css; nothing below is aware of which one is active.
//
// A column spec entry:
//   key      stable id, also the key in the section's hints list
//   label    the <th> text AND the card's data-label
//   sym      optional muted symbol after the label (boost matrix headers)
//   hint     what the column means — was a <th title=…>, and step 7 surfaces
//            it as visible text; kept on the <th> as desktop redundancy only
//   cell     (row) => HTMLTableCellElement, i.e. the existing builders as-is
//   tier     1 (default) always shown; 3 = desktop table only, and in card
//            mode folded behind the row's own expand toggle
//   primary  exactly one column: sticky on desktop, card title on mobile
//   group    first column of a visual group (left border)
//   sort     optional (row) => number | string; makes the header clickable.
//            Left off composite cells (chips, RA/A/H) that have no one value
function applyColMeta(cell, col) {
    cell.dataset.label = col.sym ? `${col.label} ${col.sym}` : col.label;
    if (col.tier && col.tier !== 1) cell.dataset.tier = String(col.tier);
    if (col.primary) cell.dataset.primary = "";
    if (col.group) cell.classList.add("raw-group");
}

// Click-to-sort, on top of the order each caller already chose. A header
// cycles ascending → descending → off, and "off" is the caller's own order,
// so a table never loses the order it was designed around. State is per table
// id and lives here, not in state.js, so the controller's re-renders keep it
// without any section knowing sorting exists. Desktop only: card mode hides
// the <thead>, and cards keep the caller's order.
const sortState = new Map();    // tableId -> { key, dir: 1 | -1 }
const lastArgs = new Map();     // tableId -> renderTable arguments, for the re-render on click

const isBlank = v => v == null || Number.isNaN(v);

// Blanks sink to the bottom in both directions — "no reading" is never the
// biggest or the smallest value. Strings compare as room names (numeric-aware).
export function compareSortValues(a, b, dir) {
    if (isBlank(a) || isBlank(b)) return isBlank(a) - isBlank(b);
    const c = typeof a === "string" || typeof b === "string" ? cmpRoom(String(a), String(b)) : a - b;
    return dir * c;
}

function cycleSort(tableId, key) {
    const cur = sortState.get(tableId);
    if (cur?.key !== key) sortState.set(tableId, { key, dir: 1 });
    else if (cur.dir === 1) sortState.set(tableId, { key, dir: -1 });
    else sortState.delete(tableId);
    renderTable(tableId, ...lastArgs.get(tableId));
    // The <thead> was rebuilt; hand focus back so a keyboard user can keep cycling.
    $(tableId).querySelector(`th[data-sort-key="${key}"] .th-sort`)?.focus();
}

function sortedRows(tableId, spec, rows) {
    const state = sortState.get(tableId);
    const col = state && spec.find(c => c.key === state.key && c.sort);
    if (!col) return rows;
    // Array.prototype.sort is stable: ties keep the caller's order.
    return rows
        .map(row => ({ row, v: col.sort(row) }))
        .sort((a, b) => compareSortValues(a.v, b.v, state.dir))
        .map(e => e.row);
}

function buildHead(tableId, spec) {
    const tr = document.createElement("tr");
    const state = sortState.get(tableId);
    for (const col of spec) {
        const th = document.createElement("th");
        // A real <button> so the header sorts from the keyboard too.
        const label = col.sort ? document.createElement("button") : th;
        if (col.sort) {
            label.type = "button";
            label.className = "th-sort";
            label.addEventListener("click", () => cycleSort(tableId, col.key));
            th.append(label);
            th.dataset.sortKey = col.key;
            if (state?.key === col.key) th.setAttribute("aria-sort", state.dir === 1 ? "ascending" : "descending");
        }
        label.append(col.label);
        if (col.sym) {
            const sym = document.createElement("span");
            sym.className = "th-sym";
            sym.textContent = col.sym;
            label.append(" ", sym);
        }
        // Desktop-only redundancy: the same string is rendered as visible text
        // by the section's hints disclosure, which is what touch actually gets.
        if (col.hint) th.title = col.hint;
        applyColMeta(th, col);
        tr.append(th);
    }
    return tr;
}

// The column definitions, as visible (tappable) text rather than <th title>
// alone. A tooltip is fine as a second channel; it is not fine as the only
// one, and on a phone it is no channel at all. Rendered into a <details> right
// after the table, from the same spec the headers come from.
function renderColumnHints(table, spec) {
    const hinted = spec.filter(c => c.hint);
    const wrap = table.parentElement;
    let host = wrap.nextElementSibling;
    if (!host?.classList.contains("col-hints")) {
        if (!hinted.length) return;             // nothing to explain, nothing to insert
        host = document.createElement("details");
        host.className = "col-hints";
        wrap.insertAdjacentElement("afterend", host);
    }
    host.hidden = !hinted.length;
    if (!hinted.length) return;
    const summary = document.createElement("summary");
    summary.textContent = "What these columns mean";
    const dl = document.createElement("dl");
    for (const col of hinted) {
        const dt = document.createElement("dt");
        dt.textContent = col.sym ? `${col.label} (${col.sym})` : col.label;
        const dd = document.createElement("dd");
        dd.textContent = col.hint;
        dl.append(dt, dd);
    }
    host.replaceChildren(summary, dl);
}

// `empty` is {text, why} — the callers distinguish several empty states from
// each other (degraded vs genuinely quiet), so the wording stays theirs.
// `rowAttrs(row)` optionally names boolean attributes to set on that row's
// <tr>, so a caller can mark rows without pairing <tr>s back to rows itself.
export function renderTable(tableId, spec, rows, empty, rowAttrs) {
    lastArgs.set(tableId, [spec, rows, empty, rowAttrs]);
    // A column that comes and goes (Nukes, Progress) takes its sort with it,
    // rather than the sort silently reviving when the column reappears.
    const state = sortState.get(tableId);
    if (state && !spec.some(c => c.key === state.key && c.sort)) sortState.delete(tableId);
    const table = $(tableId);
    table.querySelector("thead").replaceChildren(buildHead(tableId, spec));
    renderColumnHints(table, spec);
    const tbody = table.querySelector("tbody");
    if (!rows.length) {
        const tr = naRow(spec.length, empty?.text ?? "nothing to show", empty?.why);
        tr.firstChild.dataset.primary = "";      // full card width in card mode
        tbody.replaceChildren(tr);
        return;
    }
    const expandable = spec.some(c => c.tier === 3);
    tbody.replaceChildren(...sortedRows(tableId, spec, rows).map(row => {
        const tr = document.createElement("tr");
        for (const attr of rowAttrs?.(row) ?? []) tr.setAttribute(attr, "");
        for (const col of spec) {
            const td = col.cell(row);
            applyColMeta(td, col);
            tr.append(td);
        }
        // Card mode hides tier-3 cells; this is the only thing that reveals
        // them, so a stray click elsewhere in the row can't shift the layout.
        // Hidden by CSS at desktop widths, where tier-3 is always shown.
        if (expandable) {
            tr.dataset.expandable = "";
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "row-expand-toggle";
            toggle.textContent = "+ more";
            toggle.addEventListener("click", () => {
                const open = tr.toggleAttribute("data-expanded");
                toggle.textContent = open ? "– less" : "+ more";
            });
            tr.append(toggle);
        }
        return tr;
    }));
}

// An absence with a meaning is not a missing value, so it gets a word rather
// than an em dash — remoteHomeCell has always done this ("corridor"), and this
// generalises it. The `why` is the long form: still a tooltip on the desktop
// table, but the word alone has to carry the meaning on a phone, where there
// is no hover at all.
export function naCell(word, why) {
    const td = document.createElement("td");
    td.className = "na";
    td.textContent = word;
    if (why) td.title = why;
    return td;
}

// Plain text cell — the default shape for anything carrying no badge, chip or
// link. Keeps the seven column specs below declarative.
export function textCell(text, cls) {
    const td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
}

// The three all-rooms tables (labs, boosts, rooms) all list every owned room
// alphabetically; the defense table is the one that sorts by severity instead.
export function byRoomName(rooms) {
    return Object.entries(rooms).sort(([a], [b]) => cmpRoom(a, b));
}
