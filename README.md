# Edge SEO Toolkit

On-page SEO audits that run on Cloudflare's global network. Enter a URL and get a scored, 14-point audit in about a second, plus AI-written title and meta description rewrites. Pages on the watchlist are re-audited every morning, and score drops are flagged in the logs.

Built by [Zimtech Business Solutions](https://github.com/Zimtech-Business-Solutions) as a working example of the technical SEO and edge infrastructure work we do for clients.

## What it checks

| Check | Pass condition |
|---|---|
| HTTP status | 200 |
| Title tag | 30–60 characters |
| Meta description | 70–160 characters |
| H1 | Exactly one |
| Canonical | `<link rel="canonical">` present |
| Indexable | No `noindex` in meta robots |
| Mobile viewport | Viewport meta present |
| HTML lang | `lang` attribute set |
| Image alt text | Under 25% of images missing alt |
| Structured data | Valid JSON-LD, types listed (including `@graph`) |
| Open Graph | `og:title` and `og:image` set |
| Content depth | 300+ visible words (scripts and styles excluded) |
| Internal linking | 5+ same-host links |
| Server response | Under 800 ms time to first byte from the edge |

Each check scores pass (1), warn (0.5) or fail (0). The page score is the average, out of 100.

## How it uses Cloudflare Workers

| Capability | Where |
|---|---|
| **Static assets** on Cloudflare's CDN | `public/index.html` dashboard, served without invoking the Worker |
| **Back-end API** with Smart Placement | `src/index.ts` routes under `/api/*`; placement runs the Worker close to the sites being fetched |
| **Streaming HTML parsing** | `src/audit.ts` uses `HTMLRewriter` to extract signals as the page streams, with no DOM library or headless browser |
| **Workers AI** | `src/ai.ts` sends the page's signals to Llama 3.1 8B and returns a rewritten title and meta description |
| **KV storage** | Audit history (last 30 per URL, 90-day expiry) and the watchlist |
| **Cron Triggers** | `scheduled()` re-audits every watched URL daily at 11:00 UTC |
| **Observability** | Structured `console.log` events (`audit`, `score_drop`, `cron_complete`) visible in Workers Logs |

## API

```
GET    /api/audit?url=example.com          Run an audit
GET    /api/audit?url=example.com&ai=1     Audit plus AI title/meta suggestions
GET    /api/history?url=example.com        Last 30 audit scores for a URL
GET    /api/watchlist                      List watched URLs
POST   /api/watchlist   {"url": "..."}     Add a URL (admin token if set)
DELETE /api/watchlist?url=...              Remove a URL (admin token if set)
GET    /api/health                         Health and serving colo
```

Requests to private, local and non-HTTP addresses are rejected to prevent the Worker being used to probe internal networks.

## Run it

Requires Node 20+ and a Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler kv namespace create AUDITS   # paste the returned id into wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN       # optional: protects watchlist changes
npm run dev                               # local at http://localhost:8787
npm run deploy                            # live on *.workers.dev
```

## Continuous deployment

`.github/workflows/deploy.yml` typechecks and dry-run bundles every push and pull request, then deploys `main` to Cloudflare. Add two repository secrets:

- `CLOUDFLARE_API_TOKEN` — token with the "Edit Cloudflare Workers" template
- `CLOUDFLARE_ACCOUNT_ID`

## Project layout

```
src/
  index.ts     Router, watchlist, history, cron handler
  audit.ts     HTMLRewriter extraction, URL validation, scoring
  ai.ts        Workers AI title and meta description rewrite
public/
  index.html   Dashboard (static asset)
wrangler.jsonc Bindings: assets, AI, KV, cron, placement, observability
```

## License

MIT
