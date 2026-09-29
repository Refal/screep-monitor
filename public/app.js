// Dashboard entry point: applies the load-time overrides, then hands off to the controller.
import { SHARD } from "./calc.js";
import { themeOverride } from "./config.js";
import { boot } from "./controller.js";
import { $, setStatus } from "./dom.js";
import { initSectionToggle } from "./sections/index.js";

if (themeOverride) document.documentElement.dataset.theme = themeOverride;
// Keeps the header's shard label in sync with the shard the room/history
// links above point at — see SHARD in calc.js. The literal in index.html is
// only a no-JS fallback.
$("shard-label").textContent = SHARD;
initSectionToggle();
boot().catch(err => setStatus(String(err.message ?? err)));
