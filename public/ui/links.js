// Room links and badges.
import { DEFAULT_RANGE, roomUrl } from "../calc.js";
import { buildHash, ROOM } from "../route.js";
import { latest, route } from "../state.js";

// Always a real <a href> rather than a click handler, so middle-click,
// copy-link and open-in-new-tab all work. External links (screeps.com room
// views and tick replays) get target=_blank, which also keeps this tab's poll
// loop (scheduleNextPoll) running underneath; internal ones are hash routes
// and must stay in this tab.
export function roomLink({ href, text, title, external = true } = {}) {
    const a = document.createElement("a");
    a.className = "room-link";
    a.href = href;
    if (external) { a.target = "_blank"; a.rel = "noopener"; }
    a.textContent = text;
    if (title) a.title = title;
    return a;
}

// Only an owned room has a per-room view to navigate to. `rt` names remotes,
// SK rooms and corridor sightings — a disjoint set from `latest.rooms`, since
// the hostile cache is keyed by the room next door, not by the colony (an rt
// row's `home` is the colony). Those rooms carry no rcl/roles/thr/bst/nuk at
// all, so an internal route would resolve straight back to the overview and
// strand a dead `#/room/…` in the address bar. Send them to the game instead,
// which is where they pointed before the room view existed.
//
// Still a plain href either way, so nothing about it needs preventDefault.
const isOwnedRoom = room => !!latest?.rooms?.[room];

export function roomNameLink(room) {
    return isOwnedRoom(room)
        ? roomLink({
            href: buildHash({ view: ROOM, room, range: route.range }, DEFAULT_RANGE),
            text: room,
            external: false,
        })
        : roomLink({
            href: roomUrl(room),
            text: room,
            title: `${room} is not an owned room — open it on screeps.com`,
        });
}

// The escape hatch to the game itself, offered explicitly in the room view
// header rather than by hijacking every room name.
export function screepsRoomLink(room) {
    return roomLink({ href: roomUrl(room), text: "↗ Screeps", title: `open ${room} on screeps.com` });
}

export function roomLinkCell(room) {
    const td = document.createElement("td");
    td.append(roomNameLink(room));
    return td;
}

export function makeBadge(color, text) {
    const badge = document.createElement("span");
    badge.className = "badge";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = color;
    const label = document.createElement("span");
    label.textContent = text;
    badge.append(swatch, label);
    return badge;
}
