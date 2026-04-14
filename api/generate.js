// POST /api/generate
// Stage 2 of the pipeline. Takes the committed tone from /api/research and
// writes marketing copy in that voice.
//
// Uses Haiku (see _lib.js for why) and a deliberately minimal prompt.
// The model anchors on the 3-5 tone adjectives + summary from stage 1.
// Long rule lists push the model toward safe/generic — they are not here
// on purpose.
//
// tool_use gives us typed per-format fields without having to parse free JSON.

import { anthropic, MODEL_GENERATE, checkPassword, clamp } from "./_lib.js";

const VALID_TYPES = new Set(["sms", "email", "instagram", "banner", "push", "newsletter", "other"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = checkPassword(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { name, website, announcement, exampleContent, types, otherLabel, tone, iteration } = req.body || {};

  if (!name || !announcement || !tone || !Array.isArray(types) || types.length === 0) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const validTypes = types.filter((t) => VALID_TYPES.has(t));
  if (validTypes.length === 0) {
    return res.status(400).json({ error: "No valid content types requested." });
  }

  // Typed per-format output via tool_use. Descriptions are minimal — the voice
  // does the shaping, not the spec.
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
      properties.other = { type: "string", description: `${label}: copy for this format in the brand's voice.` };
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

  const iterationSection = iteration
    ? `\n\nRefinement note — revise based on this feedback, keeping everything else: ${clamp(iteration, 500)}`
    : "";

  const systemPrompt = `You write marketing copy for food and hospitality brands. Match the brand's voice exactly — capitalization, cadence, personality. Return via the write_announcement tool.`;

  const userPrompt = `Write marketing copy for a product drop for this brand.

Business: ${clamp(name, 120)}
${businessType ? `Type: ${businessType}\n` : ""}Voice: ${clamp(tone.summary || "", 2000)}
Adjectives: ${adjectives}
${productExamples ? `Products they sell: ${productExamples}\n` : ""}
What to announce: ${clamp(announcement, 500)}${exampleSection}${iterationSection}

Write everything in their exact voice.`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL_GENERATE,
      max_tokens: 2048,
      system: systemPrompt,
      tools: [{
        name: "write_announcement",
        description: "Write the announcement copy in the brand's voice for all requested formats.",
        input_schema: { type: "object", properties, required },
      }],
      tool_choice: { type: "tool", name: "write_announcement" },
      messages: [{ role: "user", content: userPrompt }],
    });

    const toolBlock = message.content.find((b) => b.type === "tool_use" && b.name === "write_announcement");
    if (!toolBlock) throw new Error("Model did not return structured output.");

    return res.status(200).json(toolBlock.input);
  } catch (err) {
    console.error("generate error", err?.status, err?.message, err?.error);
    const detail = err?.error?.message || err?.message || String(err);
    return res.status(500).json({ error: "Generation failed.", detail });
  }
}
