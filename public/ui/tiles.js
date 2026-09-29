// Stat-tile row renderer and tile helpers.
import { compact, fmtDuration, netEta, netWindowRate } from "../calc.js";
import { $ } from "../dom.js";
import { ZONE_ABSENT } from "./cells-defense.js";

// ETA text shared by the empire GCL tile and the per-room stat strip.
export function etaText(eta) {
    return eta
        ? `ETA ~${eta.etaMs != null ? fmtDuration(eta.etaMs) : `${compact(eta.etaTicks)} ticks`} · ${compact(eta.rate)}/tick`
        : "ETA — no gain in range";
}

// Past a year an ETA is noise (a trickle against RCL8's 300M target gives
// six-digit day counts), so it reads as a plain "over a year" instead.
const ZONE_ETA_HORIZON_MS = 365 * 24 * 3600e3;

// Growth-rate + ETA tile for a plain (non {l,p,pt}) numeric field tracked
// against an explicit target — the netWindowRate/netEta analogue of the RCL
// tile's Upgrade ETA. A null `cur` (no rampart in the defender zone at all —
// a real, page-wide-recognized state, see ZONE_ABSENT in cells-defense.js)
// reads the same way here as it does in the zone column, instead of showing
// a stale historical rate next to a contradictory "no gain in range". Once
// `cur` is known, three branches: already at/above target, a genuinely
// shrinking/flat trend (a dropping zone is real signal, not silence — must
// not read the same as "no data"), and a normal positive ETA.
export function zoneGrowthTile(label, sel, cur, target, history) {
    if (cur == null) return { label, value: ZONE_ABSENT.word, delta: ZONE_ABSENT.why };
    const wr = netWindowRate(sel, history);
    const atTarget = target != null && cur >= target;
    const eta = netEta(cur, target, wr);
    const delta = atTarget ? "at target"
        : wr && wr.rate < 0 ? "shrinking — no ETA"
        : eta?.etaMs > ZONE_ETA_HORIZON_MS ? "ETA over a year"
        : etaText(eta);
    return { label, value: wr ? `${compact(wr.rate)}/tick` : "—", delta };
}

export function renderTileRow(containerId, tiles) {
    $(containerId).replaceChildren(...tiles.map(t => {
        const el = document.createElement("div");
        el.className = "tile";
        // Optional status colour for the value — the same critical/serious/
        // short vocabulary the table cells use.
        if (t.tone) el.classList.add(t.tone);
        const rows = [["label", t.label], ["value", t.value], ["delta", t.delta]];
        if (t.sub) rows.push(["sub", t.sub]);
        for (const [cls, text] of rows) {
            const d = document.createElement("div");
            d.className = cls;
            d.textContent = text;
            el.append(d);
        }
        return el;
    }));
}
