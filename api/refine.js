// POST /api/refine
//
// Refine previously generated copy without re-running research.
// Pass back the tone + sources from a prior /api/announce response,
// plus an iteration note describing what to change.
//
// Auth: x-api-key: howiai
//
// Request body:
//   name          string   required  Brand name
//   website       string   required  Brand website URL
//   announcement  string   required  Original announcement topic
//   types         string[] required  Formats to regenerate
//   tone          object   required  Returned by /api/announce
//   sources       array    required  Returned by /api/announce
//   iteration     string   required  What to change — e.g. "make the SMS more urgent"
//   exampleContent string  optional  Original example content if any
//   otherLabel    string   optional  Label for the "other" format
//
// Response: same shape as /api/announce copy fields (no tone/sources — pass them through yourself)

import { anthropic, MODEL, clamp } from "./_lib.js";

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

  const { name, website, announcement, exampleContent, types, otherLabel, tone, sources, iteration } = req.body || {};

  if (!name || !website || !announcement || !iteration || !tone || !Array.isArray(types) || types.length === 0) {
    return res.status(400).json({ error: "Missing required fields: name, website, announcement, types[], tone, sources, iteration" });
  }

  const validTypes = types.filter((t) => VALID_TYPES.has(t));
  if (validTypes.length === 0) {
    return res.status(400).json({ error: "No valid content types. Valid values: sms, email, instagram, banner, push, newsletter, other" });
  }

  const brandName    = clamp(name, 120);
  const brandWebsite = clamp(website, 300);

  const properties = {};
  const required   = [];

  for (const t of validTypes) {
    if (t === "sms")            { properties.sms           = { type: "string", description: CONTENT_SPECS.sms.spec };                                                        required.push("sms"); }
    else if (t === "email")     { properties.emailSubject  = { type: "string", description: "Email subject line, max 50 chars." };
                                  properties.emailBody     = { type: "string", description: "Email body, 2–4 paragraphs." };                                                  required.push("emailSubject", "emailBody"); }
    else if (t === "instagram") { properties.instagram     = { type: "string", description: CONTENT_SPECS.instagram.spec };                                                   required.push("instagram"); }
    else if (t === "banner")    { properties.bannerHeadline = { type: "string", description: "Headline, max 8 words." };
                                  properties.bannerSubhead  = { type: "string", description: "Subhead, max 20 words." };                                                      required.push("bannerHeadline", "bannerSubhead"); }
    else if (t === "push")      { properties.push          = { type: "string", description: CONTENT_SPECS.push.spec };                                                       required.push("push"); }
    else if (t === "newsletter"){ properties.newsletter    = { type: "string", description: CONTENT_SPECS.newsletter.spec };                                                  required.push("newsletter"); }
    else if (t === "other")     { const label = clamp(otherLabel || "Custom format", 60);
                                  properties.other         = { type: "string", description: `${label}: appropriate short marketing copy for this format.` };                  required.push("other"); }
  }

  const specLines = validTypes.map((t) => {
    if (t === "other") return `${clamp(otherLabel || "Custom format", 60)}: ${properties.other?.description}`;
    return `${CONTENT_SPECS[t].label}: ${CONTENT_SPECS[t].spec}`;
  });

  const checkedSources = (sources || [])
    .slice(0, 12)
    .map((s) => `- ${clamp(s.label || "", 200)} (${clamp(s.url || "", 300)})`)
    .join("\n");

  const adjectives = Array.isArray(tone.adjectives)
    ? tone.adjectives.slice(0, 8).map((a) => clamp(a, 40)).join(", ")
    : "";

  const exampleSection = exampleContent
    ? `\nExample content written in this brand's voice:\n---\n${clamp(exampleContent, 2000)}\n---\n`
    : "";

  const systemPrompt = `You are a copywriter for a hospitality CRM tool. Write in the exact voice of the brand — not generic hospitality.

You will receive a tone-of-voice brief, an announcement topic, and a refinement note describing what to change from a previous draft. Use the write_announcement tool to return revised copy.

Formats needed:
${specLines.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Rules:
- Match the brand's cadence, slang, capitalization, signoffs, and punctuation.
- Apply the refinement note precisely — change what's asked, keep what isn't.
- No placeholder text. No [brackets].
- Never invent facts beyond the brief.
- Do not use em-dashes (—) unless the brand clearly does.`;

  const userPrompt = `Brand: ${brandName}
Website: ${clamp(brandWebsite, 300)}

Tone adjectives: ${adjectives}

Tone summary:
${clamp(tone.summary || "", 2000)}

Research sources:
${checkedSources || "(none)"}
${exampleSection}
What to announce:
${clamp(announcement, 500)}

Refinement note — revise the copy based on this feedback:
${clamp(iteration, 500)}`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
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
