// POST /api/logo-search
//
// Test-bed endpoint. Given a list of URLs, for each URL:
//   1. Fetch the page and extract <title>
//   2. Derive a brand name from the domain
//   3. Pull the primary logo from Logo.dev's Image API (img.logo.dev/{domain})
//   4. Call Logo.dev's Brand Search API for alternates that match the brand name
//   5. Return all candidates
//
// Requires env vars:
//   LOGO_DEV_PUBLISHABLE_KEY  — starts with pk_  (used for img.logo.dev)
//   LOGO_DEV_SECRET_KEY       — starts with sk_  (used for api.logo.dev/search)
//
// Request body:
//   urls:  string[]  required  List of URLs to process
//
// Response:
//   { results: [ { url, ok, pageTitle, domain, brandName, logos, error? } ] }

import { checkPassword, clamp } from "./_lib.js";

const MAX_URLS = 20;
const LOGO_IMG_BASE    = "https://img.logo.dev";
const LOGO_SEARCH_BASE = "https://api.logo.dev/search";

// Pull a domain's short name out of its hostname.
// e.g. "www.helenswines.com" -> "helenswines"
function domainCore(hostname) {
  return hostname
    .replace(/^www\./i, "")
    .split(".")
    .slice(0, -1)
    .join(" ")
    .trim();
}

// Cheap brand-name derivation: use page title up to the first " - ", " | ",
// " — ", or the domain core as fallback.
function deriveBrandName(pageTitle, domain) {
  if (pageTitle) {
    const split = pageTitle.split(/\s+[-|—–·]\s+/)[0]?.trim();
    if (split && split.length > 1 && split.length < 60) return split;
  }
  return domainCore(domain);
}

async function fetchPageTitle(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ToneDashboardBot/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return { title: "", finalUrl: url };
    const html = await res.text();
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = m ? m[1].replace(/\s+/g, " ").trim() : "";
    return { title, finalUrl: res.url || url };
  } catch {
    return { title: "", finalUrl: url };
  }
}

// Build an img.logo.dev URL for a given domain.
// size: 64-512 typical; format: png/jpg/webp
function logoImageUrl(domain, publishableKey, { size = 200, format = "png", retina = true } = {}) {
  const params = new URLSearchParams({
    token: publishableKey,
    size: String(size),
    format,
  });
  if (retina) params.set("retina", "true");
  return `${LOGO_IMG_BASE}/${encodeURIComponent(domain)}?${params.toString()}`;
}

// Call Logo.dev Brand Search for alternate candidates matching a brand name.
// Returns [] on any failure — this is a best-effort enrichment.
async function brandSearch(query, secretKey, publishableKey, limit = 8) {
  try {
    const url = `${LOGO_SEARCH_BASE}?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data?.results || data?.data || []);
    return items.slice(0, limit).map((it) => {
      const dom = it.domain || it.url || "";
      const name = it.name || it.brand || dom;
      // Prefer the API's logo_url, but fall back to img.logo.dev for consistency
      const imgUrl = it.logo_url
        || (dom ? logoImageUrl(dom, publishableKey, { size: 200 }) : "");
      return {
        url: imgUrl,
        thumbnail: imgUrl,
        title: name,
        source: dom,
        width: 200,
        height: 200,
      };
    }).filter((x) => x.url);
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = checkPassword(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const publishableKey = process.env.LOGO_DEV_PUBLISHABLE_KEY;
  const secretKey      = process.env.LOGO_DEV_SECRET_KEY;
  if (!publishableKey) {
    return res.status(500).json({
      error: "Server misconfigured: LOGO_DEV_PUBLISHABLE_KEY must be set in env vars.",
    });
  }

  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: "Provide urls[] in the request body." });
  }

  const cleaned = urls
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter(Boolean)
    .slice(0, MAX_URLS)
    .map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`));

  if (cleaned.length === 0) {
    return res.status(400).json({ error: "No valid URLs provided." });
  }

  // Process in parallel — this is a test bed, not a production path.
  const results = await Promise.all(
    cleaned.map(async (url) => {
      let hostname;
      try {
        hostname = new URL(url).hostname;
      } catch {
        return { url, ok: false, error: "Invalid URL" };
      }

      const bareDomain = hostname.replace(/^www\./i, "");
      const { title: pageTitle } = await fetchPageTitle(url);
      const brandName = deriveBrandName(pageTitle, hostname);

      try {
        // 1. Primary: Logo.dev Image API on the URL's own domain
        const primary = {
          url: logoImageUrl(bareDomain, publishableKey, { size: 400 }),
          thumbnail: logoImageUrl(bareDomain, publishableKey, { size: 200 }),
          title: `${brandName} (${bareDomain})`,
          source: bareDomain,
          width: 400,
          height: 400,
        };

        // 2. Alternates: Brand Search by brand name (if secret key present)
        let alternates = [];
        if (secretKey) {
          alternates = await brandSearch(brandName, secretKey, publishableKey, 8);
          // De-dupe: drop any alternate whose domain matches the primary
          alternates = alternates.filter((a) => a.source && a.source !== bareDomain);
        }

        return {
          url,
          ok: true,
          pageTitle: clamp(pageTitle, 300),
          domain: hostname,
          brandName: clamp(brandName, 120),
          query: `img.logo.dev/${bareDomain} + search "${brandName}"`,
          logos: [primary, ...alternates],
        };
      } catch (err) {
        return {
          url,
          ok: false,
          pageTitle: clamp(pageTitle, 300),
          domain: hostname,
          brandName: clamp(brandName, 120),
          error: err?.message || String(err),
        };
      }
    })
  );

  return res.status(200).json({ results });
}
