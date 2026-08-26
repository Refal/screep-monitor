#!/usr/bin/env node
// Guard: public/firebase-config.js must stay a REPLACE_ME placeholder in the
// repo — the real key is injected at deploy time by gen-web-config.mjs from
// the FIREBASE_WEB_CONFIG secret. Fails CI (and can be wired as a
// pre-commit hook) if a real-looking Firebase API key gets committed.
//
// Run directly: node scripts/check-no-secrets.mjs

import { readFileSync } from "node:fs";

const path = new URL("../public/firebase-config.js", import.meta.url);
const text = readFileSync(path, "utf8");

const apiKeyPattern = /AIzaSy[\w-]{33}/;
const match = text.match(apiKeyPattern);

if (match) {
    console.error(
        `✗ public/firebase-config.js contains what looks like a real Firebase API key (${match[0].slice(0, 10)}…).\n` +
        "  This file must stay a REPLACE_ME placeholder in git; the real value is\n" +
        "  generated at deploy time by scripts/gen-web-config.mjs from the\n" +
        "  FIREBASE_WEB_CONFIG secret. Revert this file before committing."
    );
    process.exit(1);
}

console.log("✓ public/firebase-config.js has no committed API key.");
