// POST /api/announce
//
// All-in-one endpoint: researches brand voice (Sonnet + web_search) then
// writes announcement copy (Haiku). Chains /api/research and /api/generate
// logic in a single call.
//
// The two stages must stay separate even though they're in one handler —
// doing both in a single model call degrades copy quality significantly
// because the model doesn't have committed tone descriptors to anchor on.
//
// Auth: x-api-key: howiai
//
// Request body:
//   name           string   required  Brand name
//   website        string   required  Brand website URL
//   announcement   string   required  What to announce (e.g. "A pizza product drop")
//   types          string[] required  Formats: ["sms","email","instagram","banner","push","newsletter","other"]
//   exampleContent string   optional  Example copy in this brand's voice
//   otherLabel     string   optional  Label for the "other" format
//
// Response:
//   brand, tone, business_type, product_examples, suggestedAnnouncement, sources,
//   + one or more of: sms, emailSubject, emailBody, instagram, bannerHeadline,
//     bannerSubhead, push, newsletter, other (depending on requested types)

import { anthropic, MODEL_RESEARCH, MODEL_GENERATE, extractText, parseJsonLoose, clamp } from "./_lib.js";

const API_KEY = "howiai";
const VALID_TYPES = new Set(["sms", "email", "instagram", "banner", "push", "newsletter", "other"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const providedKey = req.headers["x-api-key"];
  if (providedKey !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized. Missing or incorrect x-api-key header." });
  }

  const { name, website, announcement, exampleContent, types, otherLabel } = req.body || {};

  if (!name || !website || !announcement || !Array.isArray(types) || types.length === 0) {
    return res.status(400).json({ error: "Missing required fields: name, website, announcement, types[]" });
  }

  const validTypes = types.filter((t) => VALID_TYPES.has(t));
  if (validTypes.length === 0) {
    return res.status(400).json({ error: "No valid content types. Valid values: sms, email, instagram, banner, push, newsletter, other" });
  }

  const brandName    = clamp(name, 120);
  const brandWebsite = clamp(website, 300);

  // ── Stage 1: Research brand voice ─────────────────────────────────────────

  const researchSystem = `You are a brand strategist specialising in food, hospitality, and small producer brands. Research the brand's tone of voice and return ONLY valid JSON — no surrounding text, no markdown fences. Use exactly this shape:

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
sources: every URL you actually read — label should be short and human-readable. Include 3–8 sources.

If the website doesn't load or you can't find enough signal, make a reasonable inference from the business name and any other sources you find.`;

  let tone, businessType, productExamples, suggestedAnnouncement, sources;
  try {
    const researchMsg = await anthropic.messages.create({
      model: MODEL_RESEARCH,
      max_tokens: 1024,
      system: researchSystem,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      messages: [{
        role: "user",
        content: `Research the tone of voice for this business.\n\nBusiness name: ${brandName}\nWebsite: ${brandWebsite}\n\nSearch their website, Instagram, any press coverage or reviews, and other public materials to understand how they write and communicate. Return only JSON.`,
      }],
    });

    const researchText = extractText(researchMsg);
    const researchData = parseJsonLoose(researchText);

    if (!researchData.tone || !Array.isArray(researchData.sources)) {
      throw new Error("Research returned unexpected shape.");
    }

    tone                  = researchData.tone;
    businessType          = researchData.business_type || "";
    productExamples       = Array.isArray(researchData.product_examples) ? researchData.product_examples : [];
    suggestedAnnouncement = researchData.suggestedAnnouncement || "";
    sources               = researchData.sources;
  } catch (err) {
    console.error("announce/research error", err);
    return res.status(500).json({ error: "Research failed.", detail: err?.message || String(err) });
  }

  // ── Stage 2: Generate copy ────────────────────────────────────────────────

  const properties = {};
  const required   = [];

  for (const t of validTypes) {
    if (t === "sms") {
      properties.sms = { type: "string", description: "SMS in the brand's voice, under 160 characters." };
      required.push("sms");
    } else if (t === "email") {
      properties.emailSubject = { type: "string", description: "Email subject line in the brand's voice." };
      properties.emailBody    = { type: "string", description: "Email body, 3-4 sentences in the brand's voice." };
      required.push("emailSubject", "emailBody");
    } else if (t === "instagram") {
      properties.instagram = { type: "string", description: "Instagram caption in the brand's voice with a few relevant hashtags (omit hashtags if the brand doesn't use them)." };
      required.push("instagram");
    } else if (t === "banner") {
      properties.bannerHeadline = { type: "string", description: "Headline, roughly 6-10 words." };
      properties.bannerSubhead  = { type: "string", description: "One-sentence subhead." };
      required.push("bannerHeadline", "bannerSubhead");
    } else if (t === "push") {
      properties.push = { type: "string", description: "Push notification, under 120 characters." };
      required.push("push");
    } else if (t === "newsletter") {
      properties.newsletter = { type: "string", description: "Newsletter blurb in the brand's voice — a paragraph or two." };
      required.push("newsletter");
    } else if (t === "other") {
      const label = clamp(otherLabel || "Custom format", 60);
      properties.other = { type: "string", description: `${label}: copy for this format in the brand's voice.` };
      required.push("other");
    }
  }

  const adjectives = Array.isArray(tone.adjectives)
    ? tone.adjectives.slice(0, 8).map((a) => clamp(a, 40)).join(", ")
    : "";

  const productsLine = productExamples.length
    ? productExamples.slice(0, 6).map((p) => clamp(p, 120)).join(", ")
    : "";

  const exampleSection = exampleContent
    ? `\n\nAdditional reference content from the user (match this voice too):\n${clamp(exampleContent, 2000)}`
    : "";

  const generateSystem = `You write marketing copy for food and hospitality brands. Match the brand's voice exactly — capitalization, cadence, personality. Return via the write_announcement tool.`;

  const generateUser = `Write marketing copy for a product drop for this brand.

Business: ${brandName}
${businessType ? `Type: ${clamp(businessType, 120)}\n` : ""}Voice: ${clamp(tone.summary || "", 2000)}
Adjectives: ${adjectives}
${productsLine ? `Products they sell: ${productsLine}\n` : ""}
What to announce: ${clamp(announcement, 500)}${exampleSection}

Write everything in their exact voice.`;

  let copy;
  try {
    const generateMsg = await anthropic.messages.create({
      model: MODEL_GENERATE,
      max_tokens: 2048,
      system: generateSystem,
      tools: [{
        name: "write_announcement",
        description: "Write the announcement copy in the brand's voice for all requested formats.",
        input_schema: { type: "object", properties, required },
      }],
      tool_choice: { type: "tool", name: "write_announcement" },
      messages: [{ role: "user", content: generateUser }],
    });

    const toolBlock = generateMsg.content.find((b) => b.type === "tool_use" && b.name === "write_announcement");
    if (!toolBlock) throw new Error("Model did not return structured output.");
    copy = toolBlock.input;
  } catch (err) {
    console.error("announce/generate error", err?.status, err?.message);
    return res.status(500).json({ error: "Generation failed.", detail: err?.error?.message || err?.message || String(err) });
  }

  return res.status(200).json({
    brand: { name: brandName, website: brandWebsite },
    tone,
    business_type: businessType,
    product_examples: productExamples,
    suggestedAnnouncement,
    sources: sources.map(({ label, url }) => ({ label, url })),
    ...copy,
  });
}
