// Small formatters, tone classes and degraded-data captions shared by several sections.
import { compact, fmtDuration, observedMsPerTick, roomHistoryUrl } from "../calc.js";
import { history, route } from "../state.js";
import { roomLink } from "./links.js";

export const ARMY_DEGRADED_TITLE = "army detail dropped from this snapshot (payload degradation)";

// Per-squad breakdown for a tooltip; the cell text itself carries the phase.
export function routeDetailTitle(r) {
    return r.squads.map(s => {
        const counts = [`${s.alive} alive`];
        if (s.spawning) counts.push(`${s.spawning} spawning`);
        if (s.queued) counts.push(`${s.queued} queued`);
        if (s.dead) counts.push(`${s.dead} dead`);
        return `squad ${s.id} ${s.status}: ${counts.join(", ")} — ${s.atHome} home / ${s.atTarget} target / ${s.inTransit} en route`;
    }).join("\n");
}

export const TONE_COLOR = {
    good: "--status-good", short: "--status-warning", serious: "--status-serious",
    critical: "--status-critical", na: "--text-muted",
};

// Board rows and table cells share the critical/serious/short/na classes;
// "good" is the unmarked default.
export const toneClass = tone => (tone === "good" || tone == null ? undefined : tone);

export const SAMPLED_NOTE = "sampled every 20 ticks, so a decision that flipped and flipped back in between is not shown";

// Tick-relative countdowns (`in`, `kt`, `ht`, `exp`) read as wall time when
// the history gives a tick rate, as ticks otherwise.
export function ticksText(ticks) {
    const t = Math.max(0, ticks);
    const ms = observedMsPerTick(history);
    return ms != null ? fmtDuration(t * ms) : `~${compact(t)} ticks`;
}

// Shared by both activity logs: a replay link on the first tick the hostiles
// were seen, plus the closing tick as plain text.
export function episodeTicksCell(ep, linkTitle) {
    const td = document.createElement("td");
    td.append(
        roomLink({ href: roomHistoryUrl(ep.room, ep.fromTick), text: String(ep.fromTick), title: linkTitle }),
        ` – ${ep.toTick}`,
    );
    return td;
}

export const REMOTE_DEGRADED_TITLE = "remote detail dropped from this snapshot";

// ETA cell text shared by the rooms table — mirrors the room stat strip's
// ETA tile, but compact enough for a table cell.
export function etaCellText(eta, maxed) {
    if (maxed) return "max";
    if (!eta) return "—";
    return eta.etaMs != null ? `~${fmtDuration(eta.etaMs)}` : `~${compact(eta.etaTicks)} ticks`;
}
