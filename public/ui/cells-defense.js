// Defense-related table cells (posture, hostiles, towers, zone, storage, defenders).
import {
    compact, defenderSummary, fmtHits, isCriticalZone, netTowerDps, rampLevel, roomPosture,
    storageClassInfo, zoneLevel, zoneTarget,
} from "../calc.js";
import { cssVar, fmtInt } from "../dom.js";
import { makeBadge } from "./links.js";
import { naCell, textCell } from "./table.js";

// Every cell here treats a missing `thr` as "unknown" (na + an explanatory
// title), never as "clear" — see the note atop the defense section of
// calc.js for why that distinction matters.

const POSTURE_COLOR = { clear: "--status-good", engaged: "--status-warning", exposed: "--status-critical", unknown: "--text-muted" };

export const DEGRADED_TITLE = "threat detail dropped from this snapshot";

export const pluralCount = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Shared cur-vs-des severity threshold for the two "current/desired" cells on
// this page (creeps, def[]) — half of desired or worse is critical, any
// shortfall short of that is just short.
export const shortfallClass = (cur, des) => (cur < des ? (cur < des * 0.5 ? "critical" : "short") : "");

export function postureBadge(thr) {
    const td = document.createElement("td");
    const { level, reasons } = roomPosture(thr);
    td.append(makeBadge(cssVar(POSTURE_COLOR[level]), level));
    td.title = reasons.length ? reasons.join(" · ") : (level === "unknown" ? DEGRADED_TITLE : "");
    return td;
}

export function hostilesCell(thr) {
    if (!thr) return naCell("unknown", DEGRADED_TITLE);
    const td = document.createElement("td");
    if (thr.h === 0) { td.textContent = "0"; td.className = "na"; return td; }
    td.textContent = String(thr.h);
    td.className = thr.boosted > 0 ? "critical" : "serious";
    const parts = [];
    if (thr.owners?.length) parts.push(thr.owners.join(", "));
    parts.push(`melee ${fmtInt.format(thr.melee ?? 0)}/t`, `ranged ${fmtInt.format(thr.ranged ?? 0)}/t`, `heal ${fmtInt.format(thr.heal ?? 0)}/t`);
    if (thr.boosted > 0) parts.push(`${thr.boosted} boosted parts`);
    td.title = parts.join(" · ");
    return td;
}

// One column rather than three — the split is what you want to see, but each
// part still fits one row, so a room's threat composition reads at a glance.
export function raahCell(thr) {
    if (!thr) return naCell("unknown", DEGRADED_TITLE);
    if (thr.h === 0) return naCell("none", "no hostiles in this room");
    const td = document.createElement("td");
    td.textContent = `${fmtInt.format(thr.ranged ?? 0)}/${fmtInt.format(thr.melee ?? 0)}/${fmtInt.format(thr.heal ?? 0)}`;
    td.title = `ranged ${fmtInt.format(thr.ranged ?? 0)}/t · attack ${fmtInt.format(thr.melee ?? 0)}/t `
        + `· heal ${fmtInt.format(thr.heal ?? 0)}/t${thr.boosted ? ` · ${thr.boosted} boosted parts` : ""}`;
    return td;
}

export function towersCell(thr) {
    if (!thr) return naCell("unknown", DEGRADED_TITLE);
    if (thr.twrTotal === 0) return naCell("no tower", "no tower built in this room (RCL < 3?)");
    const td = document.createElement("td");
    td.textContent = `${thr.twrArmed}/${thr.twrTotal}`;
    if (thr.twrArmed === 0) td.className = "critical";
    else if (thr.twrArmed < thr.twrTotal) td.className = "short";
    if (thr.h) td.title = `${fmtInt.format(thr.dps)} dps on the weakest-hit hostile`;
    return td;
}

// The single most decision-relevant number on the page: negative means
// towers alone cannot out-damage what the hostiles are healing back.
export function netDpsCell(thr) {
    if (!thr) return naCell("unknown", DEGRADED_TITLE);
    const td = document.createElement("td");
    if (thr.h === 0) return naCell("—", "no hostiles — the bot only prices towers against live hostiles");
    const net = netTowerDps(thr);
    td.textContent = `${net >= 0 ? "+" : ""}${fmtInt.format(net)}`;
    if (net < 0) td.className = "critical";
    td.title = `tower dps ${fmtInt.format(thr.dps)} on the weakest-hit hostile `
        + `− hostile heal ${fmtInt.format(thr.heal ?? 0)}/t`;
    return td;
}

export function safeModeCell(thr) {
    if (!thr) return naCell("unknown", DEGRADED_TITLE);
    const td = document.createElement("td");
    if (thr.sm !== undefined) {
        td.append(makeBadge(cssVar("--series-1"), `active ${compact(thr.sm)}t`));
    } else {
        td.textContent = pluralCount(thr.smAvail, "charge");
        if (thr.smAvail === 0) td.className = thr.h > 0 ? "critical" : "short";
    }
    if (thr.smCd) td.title = `cooldown ${fmtInt.format(thr.smCd)}`;
    return td;
}

// `rcl` resolves the RCL-scaled repair target the hits are ramped against, so
// a healthy low-RCL rampart and a neglected high-RCL one never read the same
// color.
export const ZONE_ABSENT = { word: "no zone", why: "no rampart inside the configured defender zone" };

export function zoneCell(hits, rcl) {
    const td = document.createElement("td");
    if (hits == null) return naCell(ZONE_ABSENT.word, ZONE_ABSENT.why);
    const level = zoneLevel(hits, rcl);
    const critical = isCriticalZone(hits);
    td.append(makeBadge(cssVar(critical ? "--status-critical" : `--fill-${level}`), fmtHits(hits)));
    td.title = `${fmtHits(hits)} / target ${fmtHits(zoneTarget(rcl))} at RCL ${rcl}`;
    return td;
}

export const SC_ABSENT_WHY = "no storage class in this snapshot (published before the bot shipped sc)";

export function storageClassCell(r) {
    const info = storageClassInfo(r);
    if (!info) return naCell("unknown", SC_ABSENT_WHY);
    const td = textCell(info.word);
    td.title = info.why;
    return td;
}

// def[] slots and army_member guard rows use different field names
// (role/room/cur/des vs RoleStats' r/rm/c/d) — format each the same way here
// so both read consistently in tooltips.
const fmtSlot = (role, room, cur, des) => `${role}${room ? ` → ${room}` : ""} ${cur}/${des}`;

const slotLabel = s => fmtSlot(s.role, s.room, s.cur, s.des);

const guardLabel = g => fmtSlot(g.r, g.rm, g.c, g.d);

// The short form shown in the cell. Each is a statement about why no fleet is
// planned, which is the thing a reader needs; DEF_STATE_EXPLAIN below is the
// long form, and the column-hints list carries it where hover cannot.
const DEF_STATE_WORD = {
    unknown: "unknown",
    "none-needed": "not needed",
    "safe-mode": "safe mode",
    unarmed: "unarmed foe",
    "no-plan": "none",
};

export const DEF_STATE_EXPLAIN = {
    unknown: DEGRADED_TITLE,
    "none-needed": "no threat — no defense fleet planned",
    "safe-mode": "safe mode active — no fleet planned while it holds",
    unarmed: "hostiles present but carry no attack parts — no fleet planned",
    "no-plan": "armed hostiles and no home defense plan — sizing failed or nothing fieldable",
};

export function defCell(thr, roles) {
    const td = document.createElement("td");
    const s = defenderSummary(thr, roles);
    // Suppressed remote requirements (including army_member guards) vanish
    // from `roles` by design while combat hostiles are in the room — say so
    // rather than let an empty guard list read as attrition.
    const suppressedNote = s.suppressed
        ? `remote spawn requirements (incl. ${s.guards.length ? `${s.guards.length} ` : ""}army_member guards) `
            + `are suppressed while combat hostiles are in this room — absent, not lost`
        : (s.guards.length ? `guards: ${s.guards.map(guardLabel).join(", ")}` : "");

    if (s.state in DEF_STATE_EXPLAIN) {
        td.textContent = DEF_STATE_WORD[s.state];
        td.className = s.state === "no-plan" ? "critical" : "na";
        td.title = [DEF_STATE_EXPLAIN[s.state], suppressedNote].filter(Boolean).join(" · ");
        return td;
    }

    // staffed / short — shortfallClass, so the two current-vs-desired cells
    // on this page read alike.
    td.className = shortfallClass(s.cur, s.des);
    const wrap = document.createElement("span");
    wrap.className = "def-fill";
    wrap.append(document.createTextNode(`${s.cur}/${s.des}`));
    const chipsWrap = document.createElement("span");
    chipsWrap.className = "chips";
    for (const slot of s.slots) {
        const chip = document.createElement("span");
        chip.className = "chip";
        const frac = slot.des ? slot.cur / slot.des : 1;
        chip.style.background = slot.cur === 0 ? cssVar("--grid") : cssVar(`--fill-${rampLevel(Math.min(1, frac))}`);
        chip.title = slotLabel(slot);
        chipsWrap.append(chip);
    }
    wrap.append(chipsWrap);
    td.append(wrap);
    td.title = suppressedNote;
    return td;
}
