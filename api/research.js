// POST /api/research
// Body: { name: string, website: string }
// Returns: { tone:{adjectives,summary}, business_type, product_examples, suggestedAnnouncement, sources }
//
// Stage 1 of a two-stage pipeline. The whole point of this stage is to
// commit to a small set of tone descriptors the generate stage can anchor
// against. Keep the output small and opinionated — long fingerprints and
// verbatim voice samples were making the generate stage worse, not better.

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

  const systemPrompt = `You are a brand strategist specialising in food, hospitality, and small producer brands. Research the brand's tone of voice and return ONLY valid JSON — no surrounding text, no markdown fences. Use exactly this shape:

{
  "tone": {
    "adjectives": ["string", "string", "string"],
    "summary": "string"
  },
  "business_type": "string",
  "product_examples": ["string", "string", "string"],
  "suggestedAnnouncement": "string",
  "sources": [
    { "label": "string", "url": "string" }
  ]
}

adjectives: 3–5 words that capture how they write (e.g. "Warm", "Playful", "Lowercase", "Direct", "Irreverent")
summary: 2–3 sentences on their voice, cadence, capitalization, personality, and any signature phrases or signoffs
business_type: short label like "artisan bakery", "natural wine shop", "small-batch hot sauce maker"
product_examples: 3 real or likely products this business sells
suggestedAnnouncement: a short (max 15 words) brand-appropriate drop announcement grounded in what they actually sell
sources: every URL you actually read — label should be short and human-readable like "tartinebakery.com — About" or "Instagram @tartine — captions". Include 3–8 sources.

If the website doesn't load or you can't find enough signal, make a reasonable inference from the business name and any other sources you find.`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
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
          content: `Research the tone of voice for this business.

Business name: ${brandName}
Website: ${brandWebsite}

Search their website, Instagram, any press coverage or reviews, and other public materials to understand how they write and communicate. Return only JSON.`,
        },
      ],
    });

    const text = extractText(message);
    const parsed = parseJsonLoose(text);

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
