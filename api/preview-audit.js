// POST /api/preview-audit
//
// Takes a URL, captures a screenshot via thum.io (free, no API key),
// converts it to base64, and runs the same Claude vision analysis as
// /api/visual-audit.
//
// Body:  { url: "https://..." }
// Response: same shape as /api/visual-audit

import { anthropic, MODEL, checkPassword } from "./_lib.js";

const SYSTEM_PROMPT = `You are a senior brand and UI designer. Analyse the provided screenshot and extract the visual language. Return ONLY valid JSON — no surrounding text, no markdown fences. Use exactly this shape:

{
  "colors": [
    { "hex": "#rrggbb", "role": "Background|Primary text|Accent|Secondary|Border|etc", "notes": "short observation" }
  ],
  "typography": {
    "heading": { "family": "font name or description", "weight": "e.g. 700 Bold", "style": "e.g. Serif, Uppercase, Tight tracking" },
    "body":    { "family": "font name or description", "weight": "e.g. 400 Regular", "style": "e.g. Sans-serif, 1.6 line-height" },
    "accent":  { "family": "third typeface or null", "usage": "e.g. Labels, captions, code" }
  },
  "style": ["adjective1", "adjective2", "adjective3", "adjective4", "adjective5"],
  "summary": "2-3 sentences describing the overall visual language, mood, and brand personality signals.",
  "layout": "1-2 sentences on spacing, grid, density, and hierarchy."
}

colors: 4-8 distinct colours that define the palette, most-to-least prominent, lowercase hex.
typography: infer from what you see — if you can't confirm exact font names, describe accurately (e.g. "Transitional serif").
style: 4-6 specific descriptors (e.g. "Editorial", "High-contrast", "Warm", "Structured"). Avoid generic adjectives.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = checkPassword(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Provide a url." });
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  // 1. Fetch screenshot from thum.io (free, no API key needed)
  // Returns a JPEG of the page at 1440px wide, cropped to 900px tall.
  const screenshotUrl = `https://image.thum.io/get/width/1440/crop/900/png/${encodeURIComponent(url)}`;

  let imageBase64, mediaType;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(screenshotUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Screenshot service returned HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 5000) throw new Error("Screenshot too small — page may have failed to load.");
    imageBase64 = Buffer.from(buf).toString("base64");
    mediaType = "image/png";
  } catch (e) {
    return res.status(502).json({ error: `Could not capture screenshot: ${e.message}` });
  }

  // 2. Send to Claude vision
  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
            { type: "text", text: `Analyse the visual language of this screenshot of ${url} and return the JSON.` },
          ],
        },
      ],
    });

    const raw = (message.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch {
      const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
      if (s !== -1 && e > s) parsed = JSON.parse(cleaned.slice(s, e + 1));
      else throw new Error("Could not parse JSON from model response.");
    }

    return res.status(200).json({ ...parsed, _screenshotUrl: screenshotUrl });
  } catch (err) {
    console.error("preview-audit error", err);
    return res.status(500).json({ error: "Analysis failed.", detail: err?.message || String(err) });
  }
}
