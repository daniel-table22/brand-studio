// POST /api/announce
//
// All-in-one endpoint: researches brand voice then writes announcement copy.
// Chains /api/research and /api/generate logic in a single call.
//
// Auth: x-api-key: whats-my-vibe
//
// Request body:
//   name          string   required  Brand name
//   website       string   required  Brand website URL
//   announcement  string   required  What to announce (e.g. "A pizza product drop")
//   types         string[] required  Formats: ["sms","email","instagram","banner","push","newsletter","other"]
//   exampleContent string  optional  Example copy in this brand's voice
//   otherLabel    string   optional  Label for the "other" format
//
// Response:
//   tone          { adjectives: string[], summary: string }
//   sources       Array<{ label: string, url: string }>
//   sms           string   (if requested)
//   emailSubject  string   (if requested)
//   emailBody     string   (if requested)
//   instagram     string   (if requested)
//   bannerHeadline string  (if requested)
//   bannerSubhead  string  (if requested)
//   push          string   (if requested)
//   newsletter    string   (if requested)
//   other         string   (if requested)

import { anthropic, MODEL, extractText, parseJsonLoose, clamp } from "./_lib.js";

const API_KEY = "howiai";

const CONTENT_SPECS = {
  sms:        { label: "SMS",                spec: "max 160 characters including any link. Feels like a text from a friend, not a marketing blast." },
  email:      { label: "Email",              spec: "subject line (max 50 chars, lowercase if the brand writes lowercase) and body (2–4 short paragraphs, signed off the way the brand signs off)." },
  instagram:  { label: "Instagram caption",  spec: "2–5 short lines, the way this brand actually writes captions. Emoji only if the brand uses emoji." },
  banner:     { label: "Banner / Hero text", spec: "a punchy headline (max 8 words) plus a one-sentence subhead (max 20 words)." },
  push:       { label: "Push notification",  spec: "max 100 characters. Urgent and direct." },
  newsletter: { label: "Newsletter blurb",   spec: "2–3 paragraphs suitable for embedding in a newsletter section." },
};

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

  // ── Step 1: Research brand voice ──────────────────────────────────────────

  const researchSystem = `You are a brand voice researcher for a hospitality CRM tool.
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
  "suggestedAnnouncement": "A short (max 15 words) brand-appropriate drop announcement this business would plausibly make, inferred from what they actually sell.",
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

  let tone, sources, suggestedAnnouncement;
  try {
    const researchMsg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: researchSystem,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      messages: [{ role: "user", content: `Research the tone of voice for this hospitality business:\n\nName: ${brandName}\nWebsite: ${brandWebsite}\n\nReturn the JSON object as specified.` }],
    });

    const researchText = extractText(researchMsg);
    const researchData = parseJsonLoose(researchText);

    if (!researchData.tone || !Array.isArray(researchData.sources)) {
      throw new Error("Research returned unexpected shape.");
    }

    tone                  = researchData.tone;
    sources               = researchData.sources;
    suggestedAnnouncement = researchData.suggestedAnnouncement || "";
  } catch (err) {
    console.error("announce/research error", err);
    return res.status(500).json({ error: "Research failed.", detail: err?.message || String(err) });
  }

  // ── Step 2: Generate copy ─────────────────────────────────────────────────

  const properties = {};
  const required   = [];

  for (const t of validTypes) {
    if (t === "sms")         { properties.sms           = { type: "string", description: CONTENT_SPECS.sms.spec };                                                        required.push("sms"); }
    else if (t === "email")  { properties.emailSubject  = { type: "string", description: "Email subject line, max 50 chars." };
                               properties.emailBody     = { type: "string", description: "Email body, 2–4 paragraphs." };                                                  required.push("emailSubject", "emailBody"); }
    else if (t === "instagram") { properties.instagram  = { type: "string", description: CONTENT_SPECS.instagram.spec };                                                   required.push("instagram"); }
    else if (t === "banner") { properties.bannerHeadline = { type: "string", description: "Headline, max 8 words." };
                               properties.bannerSubhead  = { type: "string", description: "Subhead, max 20 words." };                                                      required.push("bannerHeadline", "bannerSubhead"); }
    else if (t === "push")   { properties.push          = { type: "string", description: CONTENT_SPECS.push.spec };                                                       required.push("push"); }
    else if (t === "newsletter") { properties.newsletter = { type: "string", description: CONTENT_SPECS.newsletter.spec };                                                 required.push("newsletter"); }
    else if (t === "other")  { const label = clamp(otherLabel || "Custom format", 60);
                               properties.other         = { type: "string", description: `${label}: appropriate short marketing copy for this format.` };                  required.push("other"); }
  }

  const specLines = validTypes.map((t) => {
    if (t === "other") return `${clamp(otherLabel || "Custom format", 60)}: ${properties.other?.description}`;
    return `${CONTENT_SPECS[t].label}: ${CONTENT_SPECS[t].spec}`;
  });

  const checkedSources = sources
    .filter((s) => s && s.checked)
    .slice(0, 12)
    .map((s) => `- ${clamp(s.label, 200)} (${clamp(s.url, 300)})`)
    .join("\n");

  const adjectives = Array.isArray(tone.adjectives)
    ? tone.adjectives.slice(0, 8).map((a) => clamp(a, 40)).join(", ")
    : "";

  const exampleSection = exampleContent
    ? `\nExample content written in this brand's voice — treat as primary tone reference:\n---\n${clamp(exampleContent, 2000)}\n---\n`
    : "";

  const generateSystem = `You are a copywriter for a hospitality CRM tool. Write in the exact voice of the brand — not generic hospitality.

You will receive a tone-of-voice brief and an announcement topic. Use the write_announcement tool to return the copy.

Formats needed:
${specLines.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Rules:
- Match the brand's cadence, slang, capitalization, signoffs, and punctuation.
- Mention the announcement concretely.
- No placeholder text. No [brackets].
- Never invent facts beyond the brief.
- Do not use em-dashes (—) unless the brand clearly does.${exampleContent ? "\n- Prioritize the example content as your primary tone reference." : ""}`;

  const generateUser = `Brand: ${brandName}
Website: ${clamp(brandWebsite, 300)}

Tone adjectives: ${adjectives}

Tone summary:
${clamp(tone.summary || "", 2000)}

Research sources:
${checkedSources || "(none)"}
${exampleSection}
What to announce:
${clamp(announcement, 500)}`;

  let copy;
  try {
    const generateMsg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
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
    suggestedAnnouncement,
    sources: sources.map(({ label, url }) => ({ label, url })),
    ...copy,
  });
}
