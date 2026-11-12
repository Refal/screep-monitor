// Dashboard entry point: applies the load-time overrides, then hands off to the controller.
import { themeOverride } from "./config.js";
import { boot } from "./controller.js";
import { setStatus } from "./dom.js";
import { initSectionToggle } from "./sections/index.js";

if (themeOverride) document.documentElement.dataset.theme = themeOverride;
initSectionToggle();
boot().catch(err => setStatus(String(err.message ?? err)));
