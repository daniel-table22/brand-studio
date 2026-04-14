// POST /api/refine
//
// Refine previously generated copy without re-running research.
// Pass back the tone from a prior /api/research (or /api/announce) response,
// plus an iteration note describing what to change.
//
// This is a thin variant of /api/generate — same minimal Haiku pattern,
// with the refinement note appended.
//
// Auth: x-api-key: howiai
//
// Request body:
//   name           string   required
//   website        string   required
//   announcement   string   required
//   types          string[] required
//   tone           object   required  (the ToneData from /api/research)
//   iteration      string   required  What to change
//   exampleContent string   optional
//   otherLabel     string   optional
//
// Response: the tool_use input — same shape as /api/generate.

import { anthropic, MODEL_GENERATE, clamp } from "./_lib.js";

const API_KEY = "howiai";
const VALID_TYPES = new Set(["sms", "email", "instagram", "banner", "push", "newsletter", "other"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const providedKey = req.headers["x-api-key"];
  if (providedKey !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized. Missing or incorrect x-api-key header." });
  }

  const { name, website, announcement, exampleContent, types, otherLabel, tone, iteration } = req.body || {};

  if (!name || !website || !announcement || !iteration || !tone || !Array.isArray(types) || types.length === 0) {
    return res.status(400).json({ error: "Missing required fields: name, website, announcement, types[], tone, iteration" });
  }

  const validTypes = types.filter((t) => VALID_TYPES.has(t));
  if (validTypes.length === 0) {
    return res.status(400).json({ error: "No valid content types." });
  }

  const properties = {};
  const required = [];

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
      properties.other = { type: "string", description: `${label}: revised copy for this format in the brand's voice.` };
      required.push("other");
    }
  }

  const adjectives = Array.isArray(tone.adjectives)
    ? tone.adjectives.slice(0, 8).map((a) => clamp(a, 40)).join(", ")
    : "";

  const productExamples = Array.isArray(tone.product_examples)
    ? tone.product_examples.slice(0, 6).map((p) => clamp(p, 120)).join(", ")
    : "";

  const businessType = clamp(tone.business_type || "", 120);

  const exampleSection = exampleContent
    ? `\n\nAdditional reference content from the user (match this voice too):\n${clamp(exampleContent, 2000)}`
    : "";

  const systemPrompt = `You write marketing copy for food and hospitality brands. Match the brand's voice exactly — capitalization, cadence, personality. Return via the write_announcement tool.`;

  const userPrompt = `Revise marketing copy for a product drop for this brand.

Business: ${clamp(name, 120)}
${businessType ? `Type: ${businessType}\n` : ""}Voice: ${clamp(tone.summary || "", 2000)}
Adjectives: ${adjectives}
${productExamples ? `Products they sell: ${productExamples}\n` : ""}
What to announce: ${clamp(announcement, 500)}${exampleSection}

Refinement note — apply precisely, change what's asked, keep what isn't:
${clamp(iteration, 500)}

Write everything in their exact voice.`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL_GENERATE,
      max_tokens: 2048,
      system: systemPrompt,
      tools: [{
        name: "write_announcement",
        description: "Write the revised announcement copy in the brand's voice for all requested formats.",
        input_schema: { type: "object", properties, required },
      }],
      tool_choice: { type: "tool", name: "write_announcement" },
      messages: [{ role: "user", content: userPrompt }],
    });

    const toolBlock = message.content.find((b) => b.type === "tool_use" && b.name === "write_announcement");
    if (!toolBlock) throw new Error("Model did not return structured output.");

    return res.status(200).json(toolBlock.input);
  } catch (err) {
    console.error("refine error", err?.status, err?.message);
    return res.status(500).json({ error: "Refinement failed.", detail: err?.error?.message || err?.message || String(err) });
  }
}
