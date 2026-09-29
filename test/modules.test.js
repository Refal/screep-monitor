// Guards for the dashboard's module tree (public/**/*.js).
//
// There is no build step: the browser resolves these imports itself, so a
// wrong export name or a missing ".js" is a page-wide SyntaxError at load that
// nothing else in CI would notice. Linking every module under Node catches
// the former for free; a small static scan covers what linking can't see.
//
// Linking also enforces the "no top-level side effects outside app.js" rule
// the split relies on: a stray `document.…` at import time throws here.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import module from "node:module";
import { dashboardFiles, PUBLIC, readDashboardFile } from "./dashboard-files.js";

const files = dashboardFiles;
const source = readDashboardFile;

// The page's only entry point: it boots the dashboard on import.
const ENTRY = "app.js";

// Firebase is loaded from gstatic in the browser, which Node cannot import.
// Serve a stub exporting the names the dashboard uses — a name used but absent
// here (or a typo in one) still fails to link, so add new ones deliberately.
const GSTATIC_NAMES = [
    "initializeApp", "getFirestore", "doc", "getDoc", "collection", "query", "where",
    "orderBy", "limit", "getDocs", "Timestamp", "initializeAppCheck", "ReCaptchaV3Provider",
];
const stubSource = GSTATIC_NAMES.map(n => `export const ${n} = () => {};`).join("\n");
const isGstatic = url => url.startsWith("https://www.gstatic.com/");
const hooks = {
    resolve: (specifier, context, next) =>
        isGstatic(specifier) ? { url: specifier, shortCircuit: true } : next(specifier, context),
    load: (url, context, next) =>
        isGstatic(url) ? { format: "module", source: stubSource, shortCircuit: true } : next(url, context),
};

// Every static `import … from "x"` / `export … from "x"` and dynamic `import("x")`.
const importsOf = f => {
    const text = source(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\w])\/\/.*$/gm, "$1");
    const statics = [...text.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm)].map(m => m[1]);
    const bare = [...text.matchAll(/^import\s+["']([^"']+)["']/gm)].map(m => m[1]);
    const dynamics = [...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]);
    return { statics: [...statics, ...bare], dynamics };
};
const isRelative = s => s.startsWith("./") || s.startsWith("../");
const target = (f, spec) => relative(PUBLIC, resolve(dirname(join(PUBLIC, f)), spec)).split("\\").join("/");

describe("dashboard module tree", () => {
    test("the split modules are present", () => {
        assert.ok(files.length > 10, `expected the dashboard split across public/, found ${files.join(", ")}`);
        assert.ok(files.includes(ENTRY));
    });

    describe("links under Node", () => {
        before(() => {
            // registerHooks is Node >= 22.15; register (async, off-thread) is the older API.
            if (module.registerHooks) module.registerHooks(hooks);
            else {
                module.register(
                    "data:text/javascript," + encodeURIComponent(
                        `const N=${JSON.stringify(GSTATIC_NAMES)};` +
                        `const g=u=>u.startsWith("https://www.gstatic.com/");` +
                        `export const resolve=(s,c,n)=>g(s)?{url:s,shortCircuit:true}:n(s,c);` +
                        `export const load=(u,c,n)=>g(u)?{format:"module",shortCircuit:true,` +
                        `source:N.map(x=>"export const "+x+" = () => {};").join("\\n")}:n(u,c);`),
                );
            }
        });

        for (const f of files.filter(f => f !== ENTRY)) {
            test(f, async () => {
                await import(pathToFileURL(join(PUBLIC, f)).href);
            });
        }
    });

    describe("static scan", () => {
        test("every relative import names a real .js file", () => {
            for (const f of files) {
                const { statics, dynamics } = importsOf(f);
                for (const spec of [...statics, ...dynamics].filter(isRelative)) {
                    assert.ok(spec.endsWith(".js"), `${f}: "${spec}" needs its .js extension (the browser will not add it)`);
                    assert.ok(existsSync(join(PUBLIC, target(f, spec))), `${f}: "${spec}" does not exist`);
                }
            }
        });

        test("demo.js is only ever reached by a dynamic import", () => {
            // firebase.json's hosting.ignore keeps demo.js out of every deploy,
            // so a static import would 404 in production and take the page with it.
            for (const f of files) {
                const { statics, dynamics } = importsOf(f);
                for (const spec of statics.filter(isRelative)) {
                    assert.notEqual(target(f, spec), "demo.js", `${f} statically imports demo.js`);
                }
                for (const spec of dynamics.filter(isRelative)) {
                    if (target(f, spec) === "demo.js") assert.equal(f, "data.js");
                }
            }
            const ignore = JSON.parse(readFileSync(new URL("../firebase.json", import.meta.url), "utf8")).hosting.ignore;
            assert.ok(ignore.includes("demo.js"), "firebase.json must keep excluding demo.js from deploys");
            assert.ok(existsSync(join(PUBLIC, "demo.js")), "demo.js must stay at the public/ root, where the ignore rule matches");
        });

        test("the import graph has no cycles", () => {
            const graph = new Map(files.map(f => [f, importsOf(f).statics.filter(isRelative).map(s => target(f, s))]));
            const state = new Map();
            const stack = [];
            const visit = f => {
                if (state.get(f) === 2) return;
                assert.notEqual(state.get(f), 1, `import cycle: ${[...stack.slice(stack.indexOf(f)), f].join(" -> ")}`);
                state.set(f, 1); stack.push(f);
                for (const t of graph.get(f) ?? []) visit(t);
                stack.pop(); state.set(f, 2);
            };
            for (const f of graph.keys()) visit(f);
        });

        test("layering: ui/ and charts/ are leaves, sections never import each other", () => {
            // ui/ + charts/ may use state/dom/constants/calc and each other; sections use ui/ + charts/.
            // Anything two sections need is hoisted into ui/ — that is what keeps the graph acyclic.
            const upward = /^(sections\/|controller\.js|render\.js|data\.js|nav\.js|app\.js)/;
            for (const f of files.filter(f => /^(ui|charts)\//.test(f))) {
                for (const spec of importsOf(f).statics.filter(isRelative)) {
                    assert.doesNotMatch(target(f, spec), upward, `${f} imports ${spec}: ui/ and charts/ must not depend on sections or the controller layer`);
                }
            }
            for (const f of files.filter(f => /^sections\//.test(f) && f !== "sections/index.js")) {
                for (const spec of importsOf(f).statics.filter(isRelative)) {
                    assert.doesNotMatch(target(f, spec), /^(sections\/|controller\.js|render\.js|app\.js)/, `${f} imports ${spec}: move the shared helper into ui/`);
                }
            }
        });

        test("index.html preloads exactly the deployed modules", () => {
            // The import graph is ~10 levels deep, and the JS is served no-cache, so without
            // <link rel="modulepreload"> a cold load is ~10 serial conditional GETs.
            const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
            const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1]).sort();
            const expected = files.filter(f => f !== ENTRY && f !== "demo.js").sort();
            assert.deepEqual(preloaded, expected, "keep the modulepreload list in index.html in step with public/**/*.js");
            assert.match(html, /<script type="module" src="app\.js"><\/script>/);
        });

        test("no module imports a name it never mentions", () => {
            for (const f of files) {
                const text = source(f);
                const importRe = /^import\s*\{([^}]*)\}\s*from\s*"[^"]+";?/gm;
                const names = [...text.matchAll(importRe)]
                    .flatMap(m => m[1].split(",").map(s => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
                const body = text.replace(importRe, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\w])\/\/.*$/gm, "$1");
                for (const n of names) {
                    // `$` is only a use when called: a bare "$" also matches every `${…}` in a template literal.
                    const re = new RegExp("(?<![\\w$])" + n.replace(/\$/g, "\\$") + (n === "$" ? "(?=\\()" : "(?![\\w$])"));
                    assert.ok(re.test(body), `${f}: imports ${n} but never uses it`);
                }
            }
        });

        test("only app.js is an entry point", () => {
            const importedBy = new Set(files.flatMap(f => importsOf(f).statics.filter(isRelative).map(s => target(f, s))));
            const roots = files.filter(f => !importedBy.has(f) && f !== ENTRY && f !== "demo.js" && f !== "firebase-config.js");
            assert.deepEqual(roots, [], "module(s) nothing imports — dead code, or a missing import");
        });
    });
});
