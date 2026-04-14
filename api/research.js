// POST /api/research
// Body: { name: string, website: string }
// Returns: { tone: { adjectives: string[], summary: string }, sources: Array<{ label, url, checked }> }
//
// Uses Claude with the built-in web_search tool to scour the brand's
// website, Instagram, press coverage and founder interviews, then
// extracts a tone signature and a list of sources.

import { anthropic, MODEL, checkPassword, extractText, parseJsonLoose, clamp } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = checkPassword(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { name, website } = req.body || {};
  if (!name || !website) {
    return res.status(400).json({ error: "Missing name or website." });
  }

  const brandName = clamp(name, 120);
  const brandWebsite = clamp(website, 300);

  const systemPrompt = `You are a brand voice researcher for a hospitality CRM tool.
Your job is to analyze a hospitality business's public presence and extract a precise tone-of-voice signature that a copywriter could use to draft marketing messages in that exact voice.

You have access to a web_search tool. Use it aggressively — search for:
1. The brand's own website (homepage, About/Story page, menu pages)
2. The brand's Instagram handle and captions
3. Press coverage, founder interviews, podcast appearances
4. Newsletter archives or blog posts if public

Do 3-6 searches total. Be efficient.

When you have enough signal, return ONLY a JSON object (no prose, no code fences) with this exact shape:

{
  "tone": {
    "adjectives": ["5 short adjective tags", "..."],
    "summary": "2-3 sentences describing how this brand writes. Be specific: mention cadence, signature phrases, sentence length, whether they use first person, emoji habits, signoffs, things they avoid. Ground it in actual phrases you saw."
  },
  "suggestedAnnouncement": "A short (max 15 words) brand-appropriate drop announcement this business would plausibly make, inferred from what they actually sell. E.g. for a cookie brand: 'A limited-run weekly cookie flavor coming back'; for a natural wine shop: 'A rare magnum drop from a favorite small producer'; for a Thai restaurant with retail: 'A small-batch pantry sauce from the chef's family recipe'. Be specific to THIS brand.",
  "sources": [
    { "label": "Short description of what this source is + the key quote or signal", "url": "https://...", "checked": true }
  ]
}

Rules:
- 5-7 sources. The most useful ones should have "checked": true, less useful ones "checked": false.
- Every source must have a real URL you actually found via web_search.
- Labels should be specific, e.g. "Resy interview — calls wines 'kickass' and 'baller'", not "Resy article".
- suggestedAnnouncement must be grounded in what you actually saw they sell or do — not generic.
- No extra keys. No markdown. Just the JSON object.`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 6,
        },
      ],
      messages: [
        {
          role: "user",
          content: `Research the tone of voice for this hospitality business:\n\nName: ${brandName}\nWebsite: ${brandWebsite}\n\nReturn the JSON object as specified.`,
        },
      ],
    });

    const text = extractText(message);
    const parsed = parseJsonLoose(text);

    // Minimal validation
    if (!parsed.tone || !Array.isArray(parsed.sources)) {
      throw new Error("Model returned an unexpected shape.");
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("research error", err);
    return res.status(500).json({
      error: "Research failed.",
      detail: err?.message || String(err),
    });
  }
}
