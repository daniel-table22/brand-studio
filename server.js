// Minimal local dev server. Serves public/ as static files and routes
// /api/* POSTs to the same handler modules Vercel uses in production.
//
// Usage:  node server.js           (loads .env.local automatically)
//         PORT=4000 node server.js
//
// This exists so you don't need `vercel dev` locally. In prod, Vercel
// bypasses this file entirely and runs the handlers in api/*.js directly.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const API_DIR = path.join(__dirname, "api");

// ---- Load .env.local ----
try {
  const envPath = path.join(__dirname, ".env.local");
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m) continue;
      let [, k, v] = m;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
    console.log("Loaded .env.local");
  } else {
    console.warn("No .env.local found — API calls will fail. Run `vercel env pull` first.");
  }
} catch (e) {
  console.warn("Failed to load .env.local:", e.message);
}

// ---- MIME types ----
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".ico":  "image/x-icon",
};

// ---- Cache loaded API handlers ----
const handlerCache = new Map();
async function loadHandler(name) {
  if (handlerCache.has(name)) return handlerCache.get(name);
  const file = path.join(API_DIR, `${name}.js`);
  if (!fs.existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  const handler = mod.default;
  handlerCache.set(name, handler);
  return handler;
}

// ---- Read body & parse JSON ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

// ---- Shim req/res to match Vercel's handler shape ----
function shimRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (s) => { res.end(s); return res; };
  return res;
}

// ---- Serve static file ----
function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    res.end(data);
  });
}

// ---- Request handler ----
const server = http.createServer(async (req, res) => {
  shimRes(res);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // API routes
  if (pathname.startsWith("/api/")) {
    const name = pathname.slice("/api/".length).replace(/\/+$/, "");
    const handler = await loadHandler(name);
    if (!handler) {
      return res.status(404).json({ error: `Unknown API route: ${pathname}` });
    }
    try {
      req.body = await readBody(req);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[${name}]`, err);
      if (!res.writableEnded) res.status(500).json({ error: err.message || String(err) });
    }
    return;
  }

  // Static files from public/
  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return serveStatic(res, filePath);
  }
  // Fall back to index.html for any unknown paths (SPA-ish)
  serveStatic(res, path.join(PUBLIC_DIR, "index.html"));
});

server.listen(PORT, () => {
  console.log(`\n  Tone Dashboard dev server`);
  console.log(`  http://localhost:${PORT}\n`);
});
