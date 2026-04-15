Proxy Screenshot Tool — Engineering Brief
Overview
A web-based tool that loads a target URL through a server-side proxy, renders it in an iframe (same-origin), and allows the user to capture a screenshot of the page at any point — including any iframes within it.

Goals
Load any URL in a visible iframe without cross-origin restrictions
Capture a screenshot of the rendered page on demand
Output a clean image suitable for piping into a Figma-to-AI tool
Architecture
1. Server-side proxy (/proxy)
Accepts a ?url= query parameter
Fetches the target page server-side and returns the HTML
Rewrites all relative asset URLs (src, href) to route back through the proxy
Strips or neutralises cookie banners, overlays, and third-party scripts (optional — see below)
Stack: Node.js + Express. Use http-proxy-middleware or a custom fetch-and-rewrite approach.

Asset URL rewriting — at minimum, rewrite:

src="/..." and href="/..." → src="/proxy?url=https://origin.com/..."
src="https://other-origin.com/..." → pass through or proxy separately
A regex replace on the raw HTML covers ~80% of cases. For full fidelity, use a proper HTML parser (e.g. node-html-parser or cheerio).

2. Frontend iframe viewer
Text input to enter the target URL
Loads the proxied URL in an iframe: <iframe src="/proxy?url=TARGET_URL">
Since the iframe is now same-origin, the DOM is fully accessible
"Capture" button triggers the screenshot
3. Screenshot capture
Use html2canvas on the iframe's contentDocument.body:

const iframe = document.querySelector('iframe');
html2canvas(iframe.contentDocument.body).then(canvas => {
  const img = canvas.toDataURL('image/png');
  // download or send to pipeline
});
Alternatively, serialize the live DOM and POST it to a Puppeteer endpoint for a higher-fidelity render:

const html = iframe.contentDocument.documentElement.outerHTML;
const res = await fetch('/screenshot', {
  method: 'POST',
  body: JSON.stringify({ html }),
});
const blob = await res.blob();
Two build paths
80% version (fast, hackathon-ready)
Regex-based URL rewriting
html2canvas for capture
Expect some broken images/fonts on complex pages
Good enough to demo the flow end-to-end
100% version (production-grade)
Full HTML parser for asset rewriting (cheerio or similar)
Puppeteer on the backend for screenshot capture (full fidelity)
Script sandboxing to suppress popups and banners
CSS injection to hide known overlay patterns before capture
Banner / popup suppression (optional but recommended)
Inject this before rendering:

await page.addStyleTag({
  content: `
    [class*="cookie"], [class*="banner"], [class*="popup"],
    [class*="overlay"], [id*="gdpr"], [id*="consent"] {
      display: none !important;
    }
  `
});
Or strip <script> tags from third-party domains during the proxy rewrite step.

Output
A PNG of the rendered page, captured at whatever state the user has navigated to — ready for downstream use in the Figma-to-AI pipeline.

Out of scope
Authentication / login flows on target pages
JavaScript-heavy SPAs that require full browser execution (use Puppeteer path for these)
Saving or managing multiple captures (handle in the wider pipeline)