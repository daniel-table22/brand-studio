# Tone of Voice — Drop Announcement Dashboard

A live tool for hospitality brands. You give it a business website and a product drop to announce. Claude scours the brand's website, Instagram and press coverage with real web search, extracts a tone-of-voice signature, and drafts an SMS, Email and Instagram caption in that brand's exact voice.

## What's in here

```
tone-dashboard/
├── public/
│   └── index.html        # The dashboard UI with password gate
├── api/
│   ├── _lib.js           # Shared helpers (auth, Anthropic client, JSON parsing)
│   ├── research.js       # POST /api/research — Claude + web_search
│   └── generate.js       # POST /api/generate — Claude drafts the 3 messages
├── package.json
├── vercel.json
├── .gitignore
├── .env.local.example
└── README.md
```

## Safety model

- **No secrets in the browser.** The frontend never sees your Anthropic API key. It sends requests to `/api/research` and `/api/generate`, which run server-side on Vercel.
- **Shared-password gate.** Every API request must include an `x-app-password` header that matches the `SHARED_PASSWORD` env var. The frontend prompts for the password on load and stores it in `sessionStorage` (cleared when the tab closes).
- **Environment variables only.** Both `ANTHROPIC_API_KEY` and `SHARED_PASSWORD` live in Vercel's environment variables. Never in the repo. `.env.local` is gitignored.

This is not bulletproof auth — if you share the password, anyone who has it can hit the API. But it's enough to keep the URL out of Google and prevent random strangers from burning your Anthropic budget.

## Deploy in ~5 commands

You'll need:
- [Node 20+](https://nodejs.org/)
- [GitHub CLI](https://cli.github.com/) (`gh auth login` once)
- [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`, then `vercel login`)
- An [Anthropic API key](https://console.anthropic.com/settings/keys)

From inside the `tone-dashboard/` folder:

```bash
# 1. Install dependencies
npm install

# 2. Create a private GitHub repo and push
gh repo create tone-dashboard --private --source=. --remote=origin --push

# 3. Link the folder to a new Vercel project
vercel link

# 4. Add your environment variables to Vercel (prod + preview + dev)
vercel env add ANTHROPIC_API_KEY
vercel env add SHARED_PASSWORD

# 5. Deploy to production
vercel --prod
```

Vercel will print a URL like `https://tone-dashboard-xxxx.vercel.app`. Open it, enter the password you set in step 4, and click **Generate** on any row.

## Local dev

```bash
cp .env.local.example .env.local
# edit .env.local and paste your real ANTHROPIC_API_KEY and SHARED_PASSWORD
vercel dev
```

Then open http://localhost:3000.

## Changing things

**Pre-loaded brands.** Edit the `BRANDS` object at the top of `public/index.html`. Each entry is just `{ name, category, location, website, drop }`.

**Model.** In `api/_lib.js`, change `MODEL`. `claude-sonnet-4-6` is a good default; swap to `claude-opus-4-6` if you want the highest quality at a higher cost.

**Research depth.** In `api/research.js`, `max_uses: 6` in the `web_search` tool config controls how many searches Claude can run per request. Bump it up for better signal or down to save tokens.

**Message style rules.** The system prompts live in `api/research.js` and `api/generate.js`. Edit them to change what Claude extracts and how it writes.

## Rotating the password

```bash
vercel env rm SHARED_PASSWORD production
vercel env add SHARED_PASSWORD production
vercel --prod   # redeploy so the new value is picked up
```

## Cost notes

Each `Generate` click is two Claude calls:
1. `/api/research` — one message with up to 6 web searches. This is the expensive one.
2. `/api/generate` — one message, no tools. Cheap.

A single end-to-end generation on Sonnet costs roughly a few cents. Keep an eye on your Anthropic dashboard when you first share the link.

## What to add next

- A per-IP rate limit on the API routes (use `@vercel/kv` + `@upstash/ratelimit` or Vercel's built-in rate limiting).
- Caching research results per brand so repeat Generates don't re-spend tokens.
- A "regenerate in a different tone" button that lets the user tweak the tone summary and re-run `/api/generate` only.
- CSV export of all generated messages.
