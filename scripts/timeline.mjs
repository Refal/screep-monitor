/**
 * Prints a change-only timeline for one room over a game-tick range, read back
 * from the stored `snapshots` collection. Built for the screeps2 /postmortem
 * skill: it narrows "the squad died around tick X" to one publish interval
 * before the multi-MB room-history fetch, and answers operation-level
 * questions (spawn starvation, verdict flips, remote deficits) that a 300-tick
 * history window cannot. Per-creep forensics stay with `npm run live -- history`.
 *
 * Usage:
 *   node scripts/timeline.mjs <room> --end <tick> [--start <tick> | --ticks <n>] [--limit <n>]
 *
 * Env:
 *   GOOGLE_APPLICATION_CREDENTIALS — path to a Firebase service-account JSON;
 *     defaults to ./service-account.json next to this repo so the script can be
 *     invoked from the screeps2 checkout.
 *
 * Reads only. A 2000-tick window is ~100 documents at the bot's 20-tick cadence.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
    routeSummary, routeStatusText, verdictInfo, siegeDetailText, hasThreatDetail, roomPosture,
    DEFENSE_VERDICT, DEFENSE_SKIP, SIEGE_VERDICT,
} from "../public/calc.js";

export const DEFAULT_TICKS = 2000;
export const DEFAULT_LIMIT = 500;
/** Two publish intervals (StatsManager publishes every 20 ticks). */
export const GAP_TICKS = 40;

export function parseArgs(argv) {
    const opts = { ticks: DEFAULT_TICKS, limit: DEFAULT_LIMIT };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--start" || arg === "--end" || arg === "--ticks" || arg === "--limit") {
            const value = Number(argv[++i]);
            if (!Number.isFinite(value)) throw new Error(`${arg} needs a number`);
            opts[arg.slice(2)] = value;
        } else if (arg.startsWith("--")) {
            throw new Error(`unknown flag ${arg}`);
        } else {
            positional.push(arg);
        }
    }
    const room = positional[0];
    if (!room) throw new Error("usage: timeline.mjs <room> --end <tick> [--start <tick> | --ticks <n>] [--limit <n>]");
    if (opts.end === undefined) throw new Error("--end <tick> is required");
    const start = opts.start ?? opts.end - opts.ticks;
    if (start > opts.end) throw new Error(`--start ${start} is after --end ${opts.end}`);
    return { room, start, end: opts.end, limit: opts.limit };
}

function routeLine(route) {
    const summary = routeSummary(route);
    const squads = summary.squads
        .map(s => `#${s.id} ${s.status} q${s.queued}/s${s.spawning}/a${s.alive}/d${s.dead} @home${s.atHome}/tgt${s.atTarget}/tr${s.inTransit}`)
        .join("; ");
    return `${summary.home}→${summary.target}${summary.kind !== "defense" ? ` (${summary.kind})` : ""}: ${routeStatusText(summary)} | ${squads}`;
}

/** Ledger sums creep every publish; 10k steps keep the row to a trend, not a heartbeat. */
function coarse(n) {
    return `${Math.round(n / 10_000) * 10}k`;
}

function roleDeficitLine(rows) {
    const short = rows.filter(r => r.c < r.d).map(r => `${r.r} ${r.c}/${r.d}`);
    return short.length ? `short: ${short.join(", ")}` : "all roles filled";
}

/** Everything in one snapshot that concerns `room`, keyed by timeline category. */
export function roomFacts(doc, room) {
    const facts = new Map();
    for (const route of doc.ar ?? []) {
        if ((route.home !== room && route.target !== room) || !(route.sq ?? []).length) continue;
        facts.set(`army ${route.home}→${route.target}`, routeLine(route));
    }
    for (const v of doc.dv ?? []) {
        if (v.rm !== room) continue;
        const extra = [v.uh?.length ? `gave up: ${v.uh.join(",")}` : null, v.in !== undefined ? `retry in ${v.in}` : null].filter(Boolean);
        facts.set("defense verdict", `${verdictInfo(DEFENSE_VERDICT, v.v).word}${extra.length ? ` (${extra.join("; ")})` : ""}`);
    }
    for (const v of doc.sv ?? []) {
        if (v.h !== room && v.rm !== room) continue;
        const detail = siegeDetailText(v);
        facts.set(`siege ${v.h}→${v.rm}`, `${verdictInfo(SIEGE_VERDICT, v.k).word}${detail ? ` (${detail})` : ""}${v.in !== undefined ? `, retry in ${v.in}` : ""}`);
    }
    for (const t of doc.rt ?? []) {
        if (t.room !== room) continue;
        facts.set("remote threat", `${t.h} hostiles${t.coreLvl !== undefined ? `, core L${t.coreLvl}` : ""}${t.owners?.length ? ` [${t.owners.join(",")}]` : ""}`);
        if (t.nd) facts.set("defense skip", verdictInfo(DEFENSE_SKIP, t.nd).word);
    }
    for (const l of doc.rl ?? []) {
        if (l.h === room || l.rm === room) facts.set(`ledger ${l.h}→${l.rm}`, `in ~${coarse(l.in)} out ~${coarse(l.out)}`);
    }
    const own = doc.rooms?.[room];
    if (own) {
        facts.set("spawn queue", `${own.q} queued`);
        if (own.roles) facts.set("own roles", roleDeficitLine(own.roles.filter(r => !r.rm)));
        if (own.thr) {
            const posture = roomPosture(own.thr);
            facts.set("posture", `${posture.label}${posture.reasons.length ? ` (${posture.reasons.join("; ")})` : ""}, ${own.thr.h} hostiles`);
        }
    }
    for (const [home, stats] of Object.entries(doc.rooms ?? {})) {
        if (home === room || !stats.roles) continue;
        const remoteRows = stats.roles.filter(r => r.rm === room);
        if (remoteRows.length) facts.set(`remote roles from ${home}`, roleDeficitLine(remoteRows));
    }
    return facts;
}

/** Kinds StatsManager never degrades (dv/sv and owned-room scalars), so their absence is real on any snapshot. */
function neverDegraded(kind) {
    return kind === "defense verdict" || kind === "spawn queue" || kind.startsWith("siege ");
}

/**
 * Rows `{tick, kind, text}`: one per category whose text changed since the
 * previous snapshot, plus `GAP` and `DEGRADED` markers. A category that
 * disappears prints "gone" once — an army route vanishing is the finding.
 * On a degraded snapshot only never-degraded kinds can be reported gone.
 */
export function buildTimeline(docs, room) {
    const rows = [];
    const sorted = [...docs].sort((a, b) => a.tick - b.tick);
    let previous = new Map();
    let previousTick;
    let previousDegraded = false;
    for (const doc of sorted) {
        if (previousTick !== undefined && doc.tick - previousTick > GAP_TICKS) {
            rows.push({ tick: doc.tick, kind: "GAP", text: `${doc.tick - previousTick} ticks since ${previousTick} (minBucket skip or collector miss)` });
        }
        const degraded = !hasThreatDetail(doc);
        if (degraded !== previousDegraded) {
            rows.push({ tick: doc.tick, kind: degraded ? "DEGRADED" : "DETAIL", text: degraded ? "roles/thr/rt/ar dropped to fit — absence below means unknown, not none" : "full detail resumed" });
        }
        const facts = roomFacts(doc, room);
        for (const [kind, text] of facts) {
            if (previous.get(kind) !== text) rows.push({ tick: doc.tick, kind, text });
        }
        for (const kind of previous.keys()) {
            if (facts.has(kind) || (degraded && !neverDegraded(kind))) continue;
            rows.push({ tick: doc.tick, kind, text: "gone" });
            previous.delete(kind);
        }
        if (degraded) {
            for (const [kind, text] of facts) previous.set(kind, text);
        } else {
            previous = facts;
        }
        previousTick = doc.tick;
        previousDegraded = degraded;
    }
    return rows;
}

export function formatTimeline(rows, docs, room, start, end) {
    const ticks = docs.map(d => d.tick);
    const header = ticks.length
        ? `${room}: ${docs.length} snapshot(s) covering ${Math.min(...ticks)}..${Math.max(...ticks)} (asked ${start}..${end})`
        : `${room}: no snapshots in ${start}..${end} (retention is 21 days; ring bridges 1200 ticks of collector outage)`;
    if (!rows.length) return ticks.length ? `${header}\nnothing about ${room} changed in this window` : header;
    const kindWidth = Math.max(...rows.map(r => r.kind.length));
    const lines = rows.map(r => `${String(r.tick).padStart(9)}  ${r.kind.padEnd(kindWidth)}  ${r.text}`);
    return [header, ...lines].join("\n");
}

function resolveCredentials() {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
    const fallback = resolve(dirname(fileURLToPath(import.meta.url)), "..", "service-account.json");
    if (!existsSync(fallback)) throw new Error(`set GOOGLE_APPLICATION_CREDENTIALS or place service-account.json at ${fallback}`);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = fallback;
}

async function fetchDocs(start, end, limit) {
    const { initializeApp, applicationDefault } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    initializeApp({ credential: applicationDefault() });
    const db = getFirestore();
    const snap = await db.collection("snapshots")
        .where("tick", ">=", start).where("tick", "<=", end).orderBy("tick").limit(limit).get();
    return snap.docs.map(d => d.data());
}

async function main() {
    const { room, start, end, limit } = parseArgs(process.argv.slice(2));
    resolveCredentials();
    const docs = await fetchDocs(start, end, limit);
    if (docs.length === limit) console.error(`::warning::hit --limit ${limit}; the window is truncated at tick ${docs[docs.length - 1].tick}`);
    console.log(formatTimeline(buildTimeline(docs, room), docs, room, start, end));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main().catch(err => {
        console.error(err.message ?? err);
        process.exit(1);
    });
}
