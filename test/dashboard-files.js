// Shared by the tests that read the dashboard's own source: every public/**/*.js
// except vendor/ (third-party), as forward-slash paths relative to public/.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));

export const dashboardFiles = readdirSync(PUBLIC, { recursive: true })
    .map(f => f.split("\\").join("/"))
    .filter(f => f.endsWith(".js") && !f.startsWith("vendor/"));

export const readDashboardFile = f => readFileSync(join(PUBLIC, f), "utf8");
