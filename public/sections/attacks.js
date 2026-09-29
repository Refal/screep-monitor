// Attack log section.
import { fmtDuration, hostileEpisodes } from "../calc.js";
import { ATTACK_LOG_MAX_ROWS } from "../constants.js";
import { $, fmtInt } from "../dom.js";
import { history } from "../state.js";
import { DEGRADED_TITLE } from "../ui/cells-defense.js";
import { episodeTicksCell } from "../ui/format.js";
import { roomLinkCell } from "../ui/links.js";
import { naCell, renderTable, textCell } from "../ui/table.js";

function attackWhenCell(ep) {
    const td = document.createElement("td");
    const ago = Date.now() - ep.toMs.getTime();
    td.textContent = ago < 60000 ? "just now" : `${fmtDuration(ago)} ago`;
    td.title = `${ep.fromMs.toLocaleString()} – ${ep.toMs.toLocaleString()}`;
    return td;
}

function attackLogRaahCell(ep) {
    return textCell(`${fmtInt.format(ep.peakRanged)}/${fmtInt.format(ep.peakMelee)}/${fmtInt.format(ep.peakHeal)}`);
}

function attackLogColumns() {
    return [
        { key: "room", label: "Room", primary: true, cell: ep => roomLinkCell(ep.room) },
        { key: "when", label: "When", cell: attackWhenCell },
        { key: "ticks", label: "Ticks", tier: 3,
          hint: "first through last tick hostiles were observed — the link replays from the first",
          cell: ep => episodeTicksCell(ep, "replay from the first tick hostiles were observed") },
        { key: "peakH", label: "Peak hostiles",
          cell: ep => textCell(`${ep.peakH}${ep.boosted ? " ⚡" : ""}`) },
        { key: "peakDmg", label: "Peak RA/A/H", cell: attackLogRaahCell },
        { key: "owners", label: "Aggressors",
          cell: ep => ep.owners.length ? textCell(ep.owners.join(", "))
              : naCell("unnamed", "no owner was recorded for these hostiles — usually Invader NPCs") },
    ];
}

export function renderAttackLog() {
    const { episodes, covered, total } = hostileEpisodes(history);
    renderTable("attack-log", attackLogColumns(),
        covered === 0 ? [] : episodes.slice(0, ATTACK_LOG_MAX_ROWS),
        covered === 0
            ? { text: "no threat detail in this range", why: DEGRADED_TITLE }
            : { text: "no hostiles observed in this range" });
    const note = covered < total
        ? `${covered} of ${total} snapshots in range carried threat detail — gaps are payload degradation, not quiet periods`
        : `${covered} of ${total} snapshots in range carried threat detail`;
    $("attack-log-note").textContent = note;
}
