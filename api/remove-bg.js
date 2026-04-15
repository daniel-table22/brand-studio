// POST /api/remove-bg
//
// Removes the background from an image using the remove.bg API.
// Fetches the source image server-side first, then sends it to remove.bg as
// base64 — more reliable than passing a URL directly (avoids CORS / CDN auth issues).
//
// Requires env var:
//   REMOVE_BG_API_KEY  — your remove.bg API key
//
// Request body:
//   imageUrl: string  required  URL of the image to process
//
// Response (success):
//   { resultDataUrl: "data:image/png;base64,..." }
//
// Response (error):
//   { error: string }

import { checkPassword } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = checkPassword(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server misconfigured: REMOVE_BG_API_KEY must be set. Restart server after updating .env.local." });
  }

  const { imageUrl } = req.body || {};
  if (!imageUrl || typeof imageUrl !== "string") {
    return res.status(400).json({ error: "Provide imageUrl in the request body." });
  }

  try {
    // 1. Fetch the source image server-side (avoids remove.bg having to pull it)
    const imgRes = await fetch(imageUrl, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ToneDashboardBot/1.0)" },
    });
    if (!imgRes.ok) {
      return res.status(400).json({ error: `Could not fetch logo image: HTTP ${imgRes.status}` });
    }
    const imgBuf = Buffer.from(await imgRes.arrayBuffer());
    const imageBase64 = imgBuf.toString("base64");

    // 2. Send to remove.bg as base64 (application/x-www-form-urlencoded)
    const r = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        image_base64: imageBase64,
        size: "auto",
        format: "png",
      }).toString(),
    });

    if (!r.ok) {
      let errMsg = `remove.bg error ${r.status}`;
      try {
        const e = await r.json();
        errMsg = e?.errors?.[0]?.title || errMsg;
      } catch {}
      return res.status(r.status >= 400 && r.status < 600 ? r.status : 502).json({ error: errMsg });
    }

    const outBuf = Buffer.from(await r.arrayBuffer());
    return res.status(200).json({
      resultDataUrl: `data:image/png;base64,${outBuf.toString("base64")}`,
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
