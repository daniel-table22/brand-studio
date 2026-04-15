// POST /api/visual-audit
//
// Accepts a screenshot as base64 and returns a structured visual language
// breakdown: colour palette, typography, style descriptors, layout notes.
//
// Body: { image: "<base64 string>", mediaType: "image/png"|"image/jpeg"|"image/webp" }
// Response: { colors, typography, style, summary, layout }

import { anthropic, MODEL, checkPassword } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = checkPassword(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { image, mediaType = "image/png" } = req.body || {};
  if (!image) return res.status(400).json({ error: "Provide image as base64 in request body." });

  const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  if (!allowed.includes(mediaType)) {
    return res.status(400).json({ error: `Unsupported mediaType. Use: ${allowed.join(", ")}` });
  }

  const systemPrompt = `You are a senior brand and UI designer. Analyse the provided screenshot and extract the visual language. Return ONLY valid JSON — no surrounding text, no markdown fences. Use exactly this shape:

{
  "colors": [
    { "hex": "#rrggbb", "role": "Background|Primary text|Accent|Secondary|Border|etc", "notes": "short observation" }
  ],
  "typography": {
    "heading": { "family": "font name or description", "weight": "e.g. 700 Bold", "style": "e.g. Serif, Uppercase, Tight tracking" },
    "body": { "family": "font name or description", "weight": "e.g. 400 Regular", "style": "e.g. Sans-serif, 16px, 1.6 line-height" },
    "accent": { "family": "any third typeface or monospace, or null", "usage": "e.g. Labels, captions, code" }
  },
  "style": ["adjective1", "adjective2", "adjective3", "adjective4", "adjective5"],
  "summary": "2-3 sentences describing the overall visual language, mood, and brand personality signals.",
  "layout": "1-2 sentences on spacing, grid, density, and hierarchy."
}

colors: extract 4-8 distinct colours that define the palette. List them most-to-least prominent. Use lowercase hex.
typography: infer from what you see — if you cannot confirm exact font names, describe accurately (e.g. "Transitional serif", "Geometric sans-serif").
style: 4-6 single-word or short-phrase descriptors (e.g. "Editorial", "Minimal", "High-contrast", "Warm", "Structured").
Be precise and specific — avoid generic adjectives like "clean" unless they're genuinely diagnostic.`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: image },
            },
            {
              type: "text",
              text: "Analyse the visual language of this screenshot and return the JSON.",
            },
          ],
        },
      ],
    });

    const raw = (message.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    // Strip markdown fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start !== -1 && end > start) parsed = JSON.parse(cleaned.slice(start, end + 1));
      else throw new Error("Could not parse JSON from model response.");
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("visual-audit error", err);
    return res.status(500).json({ error: "Analysis failed.", detail: err?.message || String(err) });
  }
}
