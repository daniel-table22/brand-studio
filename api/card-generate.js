// POST /api/card-generate
//
// Takes a brand's visual audit data and generates a self-contained HTML
// partner card (400×600) using the brand's visual language.
// Pure graphic design — typography, color, layout. No photos or illustrations.
//
// Body:    { brandName, businessType, auditData }
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

  const prompt = `You are a graphic designer creating a 400×600px partner loyalty card for ${brandName} (${businessType || "restaurant"}).

Here is the brand's visual language:

COLOURS:
${colors.map(c => `  ${c.hex}  — ${c.role}${c.notes ? ` (${c.notes})` : ""}`).join("\n")}

TYPOGRAPHY:
  Heading/Display: ${typography.heading?.family || "serif"} — ${typography.heading?.style || ""}
  Body: ${typography.body?.family || "sans-serif"} — ${typography.body?.style || ""}
  Accent: ${typography.accent?.family || "none"} — ${typography.accent?.usage || ""}

STYLE: ${style.join(", ")}

Generate a complete self-contained HTML document for a partner card. Exactly 400px wide × 600px tall. No scrollbars.

FIXED CONTENT — use exactly this copy:
- Brand name as a text logo at the top (use display/heading font, styled as a logotype)
- Headline: "Fresh handmade pasta, delivered monthly." — "delivered monthly." should be bold/emphasised
- Bullet list (use brand-appropriate bullet characters — dashes, dots, or typographic marks, NOT emoji):
  · Pasta + sauces for two
  · 10% off in-store  ← make "10% off" bold/prominent
  · Rotating extras
- CTA box at the bottom containing:
  - Left side: "JOIN TODAY:" in large bold uppercase stacked text
  - Right side: QR code using <img src="https://api.qrserver.com/v1/create-qr-code/?size=90x90&data=https://example.com&bgcolor=BGCOLOR&color=FGCOLOR&qzone=1" /> where BGCOLOR and FGCOLOR are the CTA box background and text hex colours WITHOUT the # symbol

DESIGN RULES — this is graphic design, not a photograph:
- No images, illustrations, or decorative photos — only typography, colour blocks, rules, and geometric shapes
- Load fonts via Google Fonts @import if they exist there (Cormorant Garamond, Playfair Display, Libre Baskerville, Montserrat, etc.)
- Use the brand's actual colours intelligently — background, text, accent blocks, ruled lines
- The brand name logo should feel like a real typographic logotype: consider letterspacing, weight, size, a thin rule above/below, or a simple geometric framing device
- Body and bullets should be clearly readable — generous leading
- CTA box should use a strong accent colour with high-contrast text — make it feel like a stamp or tag
- Overall proportions: logo ~20% of height, body+bullets ~50%, CTA ~30%
- Generous padding (28–36px sides), considered vertical rhythm
- The card should feel premium and considered — like something you'd actually hand to a customer
- No horizontal scrollbar — everything must fit in 400×600px exactly

Return ONLY the complete HTML document. Start with <!DOCTYPE html>.`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = (message.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
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
    console.error("card-generate error", err);
    return res.status(500).json({ error: "Card generation failed.", detail: err?.message || String(err) });
  }
}
