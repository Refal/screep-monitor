// Remote economy section.
import { fmtRate, fmtSignedRate } from "../ui/cells-economy.js";
import { renderTileRow } from "../ui/tiles.js";

export function renderRemoteEconomyTiles(s) {
    if (s.absent === "unknown") {
        const dropped = { value: "—", delta: "unknown — economy detail dropped" };
        renderTileRow("remote-economy-tiles", [
            { label: "Net energy", ...dropped },
            { label: "Income", ...dropped },
            { label: "Spend", ...dropped },
            { label: "Losing remotes", ...dropped },
        ]);
        return;
    }
    // Nothing counted yet is a different state from a counted zero: the tiles
    // would otherwise read "+0.0" over routes that are all still measuring.
    if (s.routes > 0 && s.counted === 0) {
        const measuring = { value: "—", delta: `all ${s.routes} route${s.routes === 1 ? "" : "s"} still measuring` };
        renderTileRow("remote-economy-tiles", [
            { label: "Net energy", ...measuring },
            { label: "Income", ...measuring },
            { label: "Spend", ...measuring },
            { label: "Losing remotes", ...measuring },
        ]);
        return;
    }
    const counted = s.measuring
        ? `${s.counted} route${s.counted === 1 ? "" : "s"} · ${s.measuring} measuring, not counted`
        : `${s.counted} route${s.counted === 1 ? "" : "s"}`;
    renderTileRow("remote-economy-tiles", [
        {
            label: "Net energy", value: `${fmtSignedRate(s.netRate)} /tick`,
            delta: s.routes ? counted : "nothing booked yet",
            tone: s.netRate < 0 ? "short" : undefined,
        },
        { label: "Income", value: `${fmtRate.format(s.inRate)} /tick`, delta: "delivered home by remote haulers" },
        { label: "Spend", value: `${fmtRate.format(s.outRate)} /tick`, delta: "spawn cost of remote creeps" },
        {
            label: "Losing remotes", value: String(s.losing.length),
            delta: s.losing.length ? s.losing.map(r => r.remote).join(" ") : "none",
            tone: s.losing.length ? "short" : undefined,
        },
    ]);
}
