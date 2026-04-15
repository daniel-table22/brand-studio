// POST /api/puppeteer-audit
//
// Launches a headless Chromium via Puppeteer, detects the site platform,
// applies platform-specific banner/overlay suppression, scrolls the page to
// trigger lazy content, then captures a full-page screenshot and sends it to
// Claude vision for visual-language analysis.
//
// Body:    { url: "https://..." }
// Response: { colors, typography, style, summary, layout, screenshot, platform }

import puppeteer from "puppeteer";
import { anthropic, MODEL, checkPassword } from "./_lib.js";

const SYSTEM_PROMPT = `You are a senior brand and UI designer. Analyse the provided screenshot and extract the visual language. Return ONLY valid JSON — no surrounding text, no markdown fences. Use exactly this shape:

{
  "colors": [
    { "hex": "#rrggbb", "role": "Background|Primary text|Accent|Secondary|Border|etc", "notes": "short observation" }
  ],
  "typography": {
    "heading": { "family": "font name or description", "weight": "e.g. 700 Bold", "style": "e.g. Serif, Uppercase, Tight tracking" },
    "body":    { "family": "font name or description", "weight": "e.g. 400 Regular", "style": "e.g. Sans-serif, 1.6 line-height" },
    "accent":  { "family": "third typeface or null", "usage": "e.g. Labels, captions, code" }
  },
  "style": ["adjective1", "adjective2", "adjective3", "adjective4", "adjective5"],
  "summary": "2-3 sentences describing the overall visual language, mood, and brand personality signals.",
  "layout": "1-2 sentences on spacing, grid, density, and hierarchy."
}

colors: 4-8 distinct colours that define the palette, most-to-least prominent, lowercase hex.
typography: infer from what you see — if you can't confirm exact font names, describe accurately (e.g. "Transitional serif").
style: 4-6 specific descriptors (e.g. "Editorial", "High-contrast", "Warm", "Structured"). Avoid generic adjectives.`;

// ─── Base suppression — consent managers and chat widgets present on any platform ───
const BASE_SUPPRESS_CSS = `
  /* OneTrust */
  #onetrust-consent-sdk, #onetrust-banner-sdk, .onetrust-pc-dark-filter { display: none !important; }

  /* Cookiebot */
  #CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay, .CybotCookiebotFader { display: none !important; }

  /* CookieHub */
  .cookiehub-widget, #cookiehub { display: none !important; }

  /* Cookie Consent (osano / insites cc-window) */
  .cc-window, .cc-banner, .cc-revoke, .cc-grower { display: none !important; }

  /* Generic cookie IDs */
  #cookie-notice, #cookie-law-info-bar, #cookie-banner, #cookiebanner,
  #cookie-consent, #gdpr-cookie-notice, #gdpr-banner { display: none !important; }

  /* Intercom */
  #intercom-container, .intercom-lightweight-app, .intercom-launcher { display: none !important; }

  /* Drift */
  .drift-widget-wrapper, #drift-widget, .drift-conductor-item { display: none !important; }

  /* HubSpot chat */
  #hubspot-messages-iframe-container { display: none !important; }

  /* Zendesk */
  #ze-snippet, .zEWidget-launcher, .zEWidget-webWidget { display: none !important; }

  /* Freshdesk / Jira service desk */
  [id^="jsd-widget"], .freshwidget-button { display: none !important; }
`;

// ─── Platform-specific rules — add to these as we find issues ───
const PLATFORM_RULES = {
  squarespace: `
    /* Squarespace cookie consent */
    .gdpr-cookie-banner, .cookie-banner-mount-point, .cookie-banner-manager,
    [class*="sqs-cookie-banner"] { display: none !important; }

    /* Squarespace announcement bar (often promo, not brand content) */
    .sqs-announcement-bar-dropzone { display: none !important; }
  `,

  shopify: `
    /* Shopify cookie consent */
    #shopify-pc__banner, .shopify-privacy-banner { display: none !important; }

    /* Shopify announcement bar — hides it so hero is fully visible */
    .announcement-bar, #announcement-bar, .shopify-section-announcement-bar { display: none !important; }

    /* Klaviyo / Privy popups */
    #kl-private-modal-id, .klaviyo-form-container,
    .privy-popup, .privy-overlay { display: none !important; }
  `,

  wordpress: `
    /* WP GDPR plugins */
    #wp-gdpr-cookie-notice, .wp-gdpr-cookie-notice,
    #cookie-notice, .cookie-notice-container,
    .moove-gdpr-infobar-allow-all { display: none !important; }

    /* Common WP chat: Tidio */
    #tidio-chat, #tidio-chat-iframe { display: none !important; }
  `,

  wix: `
    /* Wix cookie bar */
    [data-testid="cookiesBanner"], #WIX_ADS { display: none !important; }
  `,

  webflow: `
    /* Webflow cookie banners — usually custom, no standard selector */
    [class*="cookie-banner"], [class*="cookie-notice"] { display: none !important; }
  `,
};

// ─── Detect platform from page HTML ───
async function detectPlatform(page) {
  return page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const meta = document.querySelector('meta[name="generator"]')?.content || "";

    if (/squarespace/i.test(meta) || /static\.squarespace\.com/i.test(html)) return "squarespace";
    if (/shopify/i.test(meta) || /cdn\.shopify\.com/i.test(html)) return "shopify";
    if (/wordpress/i.test(meta) || /wp-content|wp-includes/i.test(html)) return "wordpress";
    if (/wix\.com/i.test(html) || /X-Wix-Published-Version/i.test(html)) return "wix";
    if (/webflow/i.test(meta) || /webflow\.com/i.test(html)) return "webflow";
    return "unknown";
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = checkPassword(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Provide a url." });
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-notifications",
        "--disable-geolocation",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    // Navigate and wait for full load
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }).catch(() => {});

    // Detect platform and apply targeted suppression
    const platform = await detectPlatform(page);
    const suppressCss = BASE_SUPPRESS_CSS + (PLATFORM_RULES[platform] || "");
    await page.addStyleTag({ content: suppressCss });

    // Click common "Accept" buttons
    await page.evaluate(() => {
      const keywords = ["accept all", "accept", "agree", "got it", "dismiss", "i understand"];
      for (const el of document.querySelectorAll("button, a[role='button'], [type='submit']")) {
        if (keywords.some(k => el.textContent.trim().toLowerCase() === k)) {
          try { el.click(); } catch {}
        }
      }
    }).catch(() => {});

    // Scroll down the page slowly to trigger lazy-loaded images and fonts,
    // then scroll back to top before screenshotting
    await page.evaluate(async () => {
      const totalHeight = document.body.scrollHeight;
      const step = 600;
      for (let y = 0; y < totalHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 80));
      }
      window.scrollTo(0, 0);
    });

    // Settle after scroll + any lazy-load triggers
    await new Promise(r => setTimeout(r, 1000));

    // Full-page screenshot — JPEG for size, capped at ~4MB for Claude
    const screenshotBuf = await page.screenshot({ type: "jpeg", quality: 82, fullPage: true });
    const base64 = Buffer.from(new Uint8Array(screenshotBuf)).toString("base64");
    if (!base64 || base64.length < 100) throw new Error("Screenshot capture returned empty data.");

    // If full-page is too large for Claude (>5MB base64 ≈ 3.75MB binary), fall back to viewport only
    const finalBase64 = base64.length > 5_000_000
      ? Buffer.from(new Uint8Array(
          await page.screenshot({ type: "jpeg", quality: 75, fullPage: false })
        )).toString("base64")
      : base64;

    const screenshotDataUrl = `data:image/jpeg;base64,${finalBase64}`;

    await browser.close();
    browser = null;

    // Send to Claude vision
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: finalBase64 } },
            { type: "text", text: `Analyse the visual language of this screenshot of ${url} and return the JSON.` },
          ],
        },
      ],
    });

    const raw = (message.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch {
      const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
      if (s !== -1 && e > s) parsed = JSON.parse(cleaned.slice(s, e + 1));
      else throw new Error("Could not parse JSON from model response.");
    }

    return res.status(200).json({ ...parsed, screenshot: screenshotDataUrl, platform });
  } catch (err) {
    if (browser) { try { await browser.close(); } catch {} }
    console.error("puppeteer-audit error", err);
    return res.status(500).json({ error: "Puppeteer audit failed.", detail: err?.message || String(err) });
  }
}
