// POST /api/banner-generate
//
// Takes a brand's CSS audit data (colors, typography, style) and generates
// a self-contained HTML "Closed" sign banner using the brand's visual language.
//
// Body: { brandName, businessType, auditData }
// Response: { html: "..." }

import { anthropic, MODEL, checkPassword } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = checkPassword(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { brandName, businessType, auditData } = req.body || {};
  if (!brandName || !auditData) {
    return res.status(400).json({ error: "Provide brandName and auditData." });
  }

  const { colors = [], typography = {}, style = [] } = auditData;

  const prompt = `You are a brand designer creating a physical "Closed" door sign for ${brandName} (${businessType || "restaurant"}).

Here is the brand's visual language extracted from their CSS:

COLOURS:
${colors.map(c => `  ${c.hex}  — ${c.role}${c.notes ? ` (${c.notes})` : ""}`).join("\n")}

TYPOGRAPHY:
  Heading/Display: ${typography.heading?.family || "serif"} — ${typography.heading?.style || ""}
  Body: ${typography.body?.family || "sans-serif"} — ${typography.body?.style || ""}
  Accent: ${typography.accent?.family || "none"} — ${typography.accent?.usage || ""}

STYLE: ${style.join(", ")}

Generate a complete self-contained HTML document for a "Closed" door sign. The banner must be exactly 400px wide and render at natural height (no fixed height — let it be as tall as it needs to be).

FIXED CONTENT — use exactly this copy, only customise to fit the brand:
- Small label at top: "Side B — Closed"
- Script/display line: "Sorry, we're"
- Large bold line: "CLOSED!"
- Subtext: infer from the business type, e.g. "Get our pasta at home." for an Italian restaurant, "Get wine at home." for a wine shop, "Get our cookies at home." for a cookie brand
- CTA box at the bottom: "JOIN OUR [TYPE] CLUB:" — infer the type (PASTA CLUB, WINE CLUB, COOKIE CLUB, DINNER CLUB, etc.) from the business
- Include a QR code in the CTA box using: <img src="https://api.qrserver.com/v1/create-qr-code/?size=90x90&data=https://example.com&bgcolor=HEXCODE&color=HEXCODE&qzone=1" /> where HEXCODE values are the CTA box background and text colours without the # symbol

DESIGN RULES:
- Use the brand's actual colors intelligently — background, text, accent for CTA
- Load fonts via Google Fonts @import if the font exists there (e.g. Cormorant Garamond, Playfair Display, Libre Baskerville, Montserrat, etc.). For custom fonts not on Google Fonts, use a close system alternative (e.g. a script font → cursive, a geometric sans → system-ui)
- "Sorry, we're" should use the heading/display font at roughly 2.2–2.8rem, styled elegantly
- "CLOSED!" should be large (4–5rem), heavy weight, uppercase, tracking
- The CTA box should use the accent/brand colour with high contrast text
- Overall feel should match the brand's style adjectives
- Generous padding, considered spacing — this is a premium door sign
- No horizontal scrollbar — everything fits in 400px

Return ONLY the complete HTML document, nothing else. Start with <!DOCTYPE html>.`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = (message.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();

    // Strip markdown fences if Claude wrapped it
    const html = raw
      .replace(/^```html\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    if (!html.startsWith("<!DOCTYPE") && !html.startsWith("<html")) {
      throw new Error("Model did not return valid HTML.");
    }

    return res.status(200).json({ html });
  } catch (err) {
    console.error("banner-generate error", err);
    return res.status(500).json({ error: "Banner generation failed.", detail: err?.message || String(err) });
  }
}
