// POST /api/css-audit
//
// Fetches a URL's HTML + stylesheets server-side, extracts colour values,
// font declarations, and CSS design tokens, then sends a structured summary
// to Claude for visual language analysis.
//
// Body: { url: "https://..." }
// Response: same shape as /api/visual-audit plus top-level confidence fields

import { anthropic, MODEL, checkPassword } from "./_lib.js";

// ---- Overlay/third-party selector patterns ----
const OVERLAY_PATTERNS = [
  /cookie/i, /consent/i, /gdpr/i, /onetrust/i, /cookiebot/i, /cookiehub/i,
  /modal/i, /overlay/i, /popup/i, /pop-up/i, /lightbox/i,
  /newsletter/i, /subscribe/i, /opt-in/i, /optin/i,
  /banner/i, /toast/i, /snackbar/i, /notification/i,
  /intercom/i, /hubspot/i, /drift/i, /zendesk/i, /hotjar/i,
  /klaviyo/i, /mailchimp/i, /privy/i,
  /social-share/i, /share-btn/i, /follow-btn/i,
];

function isOverlaySelector(selector) {
  return OVERLAY_PATTERNS.some(p => p.test(selector));
}

// ---- Split CSS into brand vs overlay blocks ----
function splitCss(css) {
  const brand = [];
  const overlay = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) { brand.push(css.slice(i)); break; }
    const selector = css.slice(i, open);
    // Walk to matching close brace (handles nesting)
    let depth = 1, j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const block = css.slice(open, j);
    if (isOverlaySelector(selector)) overlay.push(block);
    else brand.push(selector + block);
    i = j;
  }
  return { brandCss: brand.join("\n"), overlayCss: overlay.join("\n") };
}

// ---- Color extraction ----
function expandHex(h) {
  return h.length === 4
    ? "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]
    : h.toLowerCase();
}
function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map(n => Math.min(255, parseInt(n)).toString(16).padStart(2, "0")).join("");
}
function extractColors(css) {
  const counts = new Map();
  for (const m of css.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const hex = expandHex(m[0]);
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  for (const m of css.matchAll(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/gi)) {
    const hex = rgbToHex(m[1], m[2], m[3]);
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  return counts;
}

// ---- Font extraction ----
function extractFonts(css) {
  const counts = new Map();
  for (const m of css.matchAll(/font-family\s*:\s*([^;{}]+)/gi)) {
    const val = m[1].trim().replace(/\s+/g, " ");
    if (val && !val.startsWith("inherit") && !val.startsWith("var(")) {
      counts.set(val, (counts.get(val) || 0) + 1);
    }
  }
  return counts;
}

// ---- CSS custom properties — grab everything in :root, no name filtering ----
function extractCustomProps(css) {
  const props = {};
  // Find all :root { ... } blocks (sites can have multiple)
  for (const block of css.matchAll(/:root\s*\{([^}]+)\}/gi)) {
    for (const m of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      props[m[1]] = m[2].trim();
    }
  }
  return props;
}

// ---- @font-face names ----
function extractFontFaces(css) {
  const names = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
    const nm = m[1].match(/font-family\s*:\s*['"]?([^'";]+)['"]?/i);
    if (nm) names.push(nm[1].trim());
  }
  return [...new Set(names)];
}

// ---- Fetch helper ----
async function fetchText(url, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BrandStudioBot/1.0)",
        Accept: "text/html,text/css,*/*",
      },
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { text: await r.text(), finalUrl: r.url || url };
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// CDN hostnames whose CSS is third-party widget code, not brand styles
const SKIP_HOSTS = [
  "googletagmanager.com", "connect.facebook.net", "platform.twitter.com",
  "static.klaviyo.com", "js.hs-scripts.com", "cdn.jsdelivr.net",
  "unpkg.com", "cdnjs.cloudflare.com",
];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = checkPassword(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Provide a url." });
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  // 1. Fetch HTML
  let html, baseUrl;
  try {
    const { text, finalUrl } = await fetchText(url, 12000);
    html = text;
    baseUrl = new URL(finalUrl);
  } catch (e) {
    return res.status(502).json({ error: `Could not fetch ${url}: ${e.message}` });
  }

  // 2. Collect stylesheet hrefs
  const hrefs = new Set();
  for (const m of html.matchAll(/<link[^>]+>/gi)) {
    const tag = m[0];
    if (!/rel=["']stylesheet["']/i.test(tag)) continue;
    const hm = tag.match(/href=["']([^"']+)["']/i);
    if (hm) hrefs.add(hm[1]);
  }

  // 3. Gather CSS blocks (inline + external)
  const cssBlocks = [];
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    cssBlocks.push(m[1]);
  }
  for (const href of [...hrefs].slice(0, 10)) {
    try {
      const absUrl = new URL(href, baseUrl).toString();
      if (SKIP_HOSTS.some(h => absUrl.includes(h))) continue;
      const { text } = await fetchText(absUrl, 6000);
      cssBlocks.push(text);
    } catch { /* skip failed sheets */ }
  }

  if (!cssBlocks.length) {
    return res.status(422).json({ error: "No CSS found on this page." });
  }

  // 4. Split and extract signals
  const brandColorCounts = new Map();
  const overlayColorCounts = new Map();
  const brandFontCounts = new Map();
  const customProps = {};
  const fontFaces = [];

  for (const css of cssBlocks) {
    const { brandCss, overlayCss } = splitCss(css);

    for (const [hex, n] of extractColors(brandCss))
      brandColorCounts.set(hex, (brandColorCounts.get(hex) || 0) + n);
    for (const [hex, n] of extractColors(overlayCss))
      overlayColorCounts.set(hex, (overlayColorCounts.get(hex) || 0) + n);
    for (const [font, n] of extractFonts(brandCss))
      brandFontCounts.set(font, (brandFontCounts.get(font) || 0) + n);

    Object.assign(customProps, extractCustomProps(css));
    fontFaces.push(...extractFontFaces(css));
  }

  // 5. Rank & filter
  const NOISE = new Set(["#ffffff", "#000000", "#fff", "#000", "#ffffffff", "#00000000"]);
  const topBrandColors = [...brandColorCounts.entries()]
    .filter(([hex]) => !NOISE.has(hex))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  const overlayOnlyColors = [...overlayColorCounts.entries()]
    .filter(([hex]) => !brandColorCounts.has(hex))
    .slice(0, 8)
    .map(([hex]) => hex);

  const topFonts = [...brandFontCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const uniqueFontFaces = [...new Set(fontFaces)].slice(0, 6);

  // Detect likely utility-CSS site (Tailwind etc.) — too many unique colours
  const isUtilityCss = topBrandColors.length > 60;
  const usefulColors = isUtilityCss ? topBrandColors.slice(0, 12) : topBrandColors;

  // 6. Build Claude prompt
  const summary = [
    `URL: ${url}`,
    isUtilityCss ? "\nNOTE: This site appears to use a utility CSS framework (e.g. Tailwind). Colour list has been trimmed to the most-used values." : "",
    "\n== BRAND COLOURS (frequency-sorted, overlay/modal selectors excluded) ==",
    usefulColors.length
      ? usefulColors.map(([hex, n]) => `  ${hex}  (${n} uses)`).join("\n")
      : "  (none found)",
    "\n== COLOURS FOUND ONLY IN OVERLAY/MODAL/COOKIE SELECTORS (excluded) ==",
    overlayOnlyColors.length ? `  ${overlayOnlyColors.join(", ")}` : "  (none)",
    "\n== FONT FAMILIES (frequency-sorted, brand CSS only) ==",
    topFonts.length
      ? topFonts.map(([f, n]) => `  ${f}  (${n} uses)`).join("\n")
      : "  (none found)",
    "\n== @FONT-FACE DECLARED NAMES ==",
    uniqueFontFaces.length ? `  ${uniqueFontFaces.join(", ")}` : "  (none)",
    "\n== :root CUSTOM PROPERTIES (highest-signal — these are the designer's intentional palette, whatever they named them) ==",
    Object.keys(customProps).length
      ? Object.entries(customProps).map(([k, v]) => `  ${k}: ${v}`).join("\n")
      : "  (none)",
  ].join("\n");

  const systemPrompt = `You are a senior brand and UI designer. You receive extracted CSS data from a website — colour hex values with usage frequency, font declarations, and :root custom properties. The :root custom properties are the most reliable signal: they are whatever the designer chose to name their palette tokens (e.g. --red, --cream, --midnight — any name is valid). Prioritise these over frequency counts. Analyse the data and return the brand's visual language as ONLY valid JSON, no surrounding text, no markdown fences. Shape:

{
  "colors": [
    { "hex": "#rrggbb", "role": "Background|Primary text|Accent|Secondary|Border|etc", "notes": "short observation", "confidence": "high|medium|low" }
  ],
  "typography": {
    "heading": { "family": "name", "weight": "e.g. 700 Bold", "style": "e.g. Serif, Uppercase" },
    "body":    { "family": "name", "weight": "e.g. 400 Regular", "style": "e.g. Sans-serif" },
    "accent":  { "family": "third typeface or null", "usage": "e.g. Labels, captions" }
  },
  "style": ["adjective1", "adjective2", "adjective3", "adjective4"],
  "summary": "2–3 sentences on the visual language and brand personality.",
  "layout": "1–2 sentences on spacing and hierarchy signals from the CSS.",
  "confidence": "high|medium|low",
  "confidence_notes": "Brief note if results are uncertain — e.g. utility CSS framework detected, very few colours found, etc. Omit if confidence is high."
}

Colour confidence: high = many uses across brand CSS, medium = moderate use, low = few uses or role is ambiguous.
Overall confidence: high = rich CSS with clear brand tokens, medium = reasonable signal, low = sparse/utility CSS.
Be specific and opinionated. Avoid generic adjectives like "clean" unless truly diagnostic.`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: `Analyse the visual language from this CSS data:\n\n${summary}` }],
    });

    const raw = (message.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch {
      const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
      if (s !== -1 && e > s) {
        try { parsed = JSON.parse(cleaned.slice(s, e + 1)); }
        catch (e2) {
          console.error("css-audit raw response:", cleaned.slice(0, 500));
          throw new Error("Could not parse JSON from model response.");
        }
      } else {
        console.error("css-audit raw response:", cleaned.slice(0, 500));
        throw new Error("Could not parse JSON from model response.");
      }
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("css-audit error", err);
    return res.status(500).json({ error: "Analysis failed.", detail: err?.message || String(err) });
  }
}
