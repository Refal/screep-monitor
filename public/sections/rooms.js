// Rooms table and the room selector.
import { compact, hasIncomingNuke, hasNoSpawn, incomingNukes, levelEta, pct } from "../calc.js";
import { $ } from "../dom.js";
import { history, latest, route, selectedRoom, setSelectedRoom } from "../state.js";
import { DEGRADED_TITLE, shortfallClass } from "../ui/cells-defense.js";
import { nukerCell, nukesCell } from "../ui/cells-nuker.js";
import { etaCellText } from "../ui/format.js";
import { roomLinkCell } from "../ui/links.js";
import { byRoomName, naCell, renderTable, textCell } from "../ui/table.js";

function creepsCell(roles) {
    const td = document.createElement("td");
    if (!roles) return naCell("unknown", DEGRADED_TITLE);   // roles/thr are dropped first, see StatsManager
    const cur = roles.reduce((a, x) => a + x.c, 0);
    const des = roles.reduce((a, x) => a + x.d, 0);
    td.textContent = `${cur} / ${des}`;
    if (cur < des) {
        td.className = shortfallClass(cur, des);
        td.title = "short: " + roles.filter(x => x.c < x.d)
            .map(x => `${x.rm ? `${x.r} → ${x.rm}` : x.r} ${x.c}/${x.d}`).join(", ");
    }
    return td;
}

function roomsColumns() {
    // The ETA cell is the one that needs history, not just the snapshot — it
    // reads the room's own RCL series to get an observed points-per-tick.
    const etaFor = (name, rcl) => etaCellText(levelEta(row => row.rooms[name]?.rcl ?? null, rcl, history), !rcl.pt);
    // Incoming nukes are rare — unlike spawns/nuker, this column only appears
    // at all once some room actually has one, so a normal day doesn't carry a
    // column of "none" cells nobody needs to see.
    const anyNukes = Object.values(latest.rooms).some(hasIncomingNuke);
    // Same idea for controller progress: once every room is at max level
    // (!pt), Progress and ETA would be a whole column of "max" each.
    const anyLeveling = Object.values(latest.rooms).some(r => r.rcl?.pt);
    return [
        { key: "room", label: "Room", primary: true, cell: ([n]) => roomLinkCell(n) },
        { key: "rcl", label: "RCL", cell: ([, r]) => textCell(String(r.rcl.l)) },
        ...(anyLeveling ? [
            { key: "progress", label: "Progress",
              cell: ([, r]) => textCell(!r.rcl.pt ? "max" : `${pct(r.rcl.p, r.rcl.pt).toFixed(1)}%`) },
            { key: "eta", label: "ETA → next", cell: ([n, r]) => textCell(etaFor(n, r.rcl)) },
        ] : []),
        { key: "spawns", label: "Spawns",
          hint: "STRUCTURE_SPAWN count — 0 means the room's spawn was destroyed and cannot rebuild lost creeps",
          cell: ([, r]) => textCell(r.sp ?? "—", hasNoSpawn(r) ? "critical" : undefined) },
        ...(anyNukes ? [{ key: "nukes", label: "Nukes",
            hint: "incoming nukes on this room, soonest first — see the room view for full detail",
            cell: ([, r]) => nukesCell(incomingNukes(r)) }] : []),
        { key: "spawnEnergy", label: "Spawn energy", cell: ([, r]) => textCell(`${r.e} / ${r.ec}`) },
        { key: "storage", label: "Storage", cell: ([, r]) => textCell(compact(r.se)) },
        { key: "terminal", label: "Terminal", tier: 3, cell: ([, r]) => textCell(compact(r.te)) },
        { key: "creeps", label: "Creeps", cell: ([, r]) => creepsCell(r.roles) },
        { key: "queue", label: "Queue", hint: "spawn queue length", cell: ([, r]) => textCell(String(r.q)) },
        { key: "nuker", label: "Nuker", tier: 3,
          hint: "ghodium \u00b7 energy fill vs capacity; ready = both full and off cooldown",
          cell: ([, r]) => nukerCell(r.nuk) },
    ];
}

export function renderRoomsTable() {
    renderTable("rooms-table", roomsColumns(), byRoomName(latest.rooms));
}

export function renderRoomSelect() {
    const names = Object.keys(latest.rooms).sort();
    // The hash decides which room is shown when it names one (reconcileRoute
    // has already dropped a room that no longer exists). Otherwise the select
    // just needs a valid default for whenever the room view is next opened.
    if (route.room) setSelectedRoom(route.room);
    else if (!selectedRoom || !names.includes(selectedRoom)) setSelectedRoom(names[0]);
    const sel = $("room-select");
    sel.replaceChildren(...names.map(n => {
        const o = document.createElement("option");
        o.value = o.textContent = n;
        o.selected = n === selectedRoom;
        return o;
    }));
}
