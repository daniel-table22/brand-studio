#!/usr/bin/env node
// Bumps the build-tag version number in public/index.html by 1.
// Run via `npm run bump` or automatically before `npm run deploy` / `npm run dev`.
//
// Matches: <span class="build-tag" id="build-tag">v3</span>
// Updates to:   <span class="build-tag" id="build-tag">v4</span>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, "..", "public", "index.html");

const src = fs.readFileSync(htmlPath, "utf8");
const re = /(<span class="build-tag" id="build-tag">v)(\d+)(<\/span>)/;
const m = src.match(re);

if (!m) {
  console.error("bump-version: could not find build-tag span in index.html");
  process.exit(1);
}

const next = Number(m[2]) + 1;
const out = src.replace(re, `$1${next}$3`);
fs.writeFileSync(htmlPath, out);
console.log(`bump-version: v${m[2]} → v${next}`);
