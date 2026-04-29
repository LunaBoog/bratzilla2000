# Bratzilla 2000 v3.3

Real-time Bratz doll profit scanner powered by eBay Browse API + Claude rarity analysis.

## v3.3 efficiency upgrades

- **Edge caching** — identical queries within 60s return instantly from Netlify's CDN, zero eBay calls
- **Client-side cache** — last 20 queries stored in localStorage, 60s TTL — search the same thing twice and the network is bypassed entirely
- **Hard timeouts on every request** — Safari/Chrome can't hang forever (8s eBay, 12s Anthropic, 15s overall)
- **Request cancellation** — typing fast and double-tapping SCAN cancels the older request automatically
- **Connection-aware** — slow/cellular connections skip the AI rarity step to save ~2-3s
- **Lighter images** — `s-l400` instead of `s-l500` saves ~40% bandwidth on cards
- **Preconnect hints** — early DNS/TLS to eBay's image CDN for faster first paint
- **No backdrop-filter on cards** — that single CSS prop was the biggest mobile Safari frame-time culprit
- **Reduced-motion + saveData support** — respects accessibility preferences automatically

## v3.2 features (still here)

- Live eBay listings via Browse API (1-2s response)
- Real profit math from market median (condition-aware buckets)
- BUY NOW / WATCH / MAYBE / SKIP recommendations with reasons
- Claude Haiku 4.5 rarity scoring with HOT / UNDERPRICED / OVERPRICED / FAKE_RISK / INCOMPLETE flags
- Skeleton loaders, autocomplete, keyword highlighting in titles
- Saved items with automatic price tracking
- Bell-icon alerts when watched items drop 10%+
- Share buttons, CSV export, copy-all
- Filter chips (Buy Now only, NRFB, Ending Soon, Free ship)
- Auction countdown badges
- Keyboard shortcuts (`/` to focus search, Esc to close)

## Setup

### 1. Get eBay API credentials (free)

1. Sign up at [developer.ebay.com](https://developer.ebay.com)
2. Go to **My Account → Application Keysets**
3. Under **Production**, create a keyset named "Bratzilla2000"
4. Copy **App ID (Client ID)** and **Cert ID (Client Secret)**
5. Click **User Tokens → Sign in to Production** once to accept terms

### 2. Get Anthropic API key

[console.anthropic.com](https://console.anthropic.com) → API Keys.

### 3. Add to Netlify

Netlify → Site configuration → Environment variables:
- `EBAY_APP_ID` = your eBay App ID
- `EBAY_CERT_ID` = your eBay Cert ID
- `ANTHROPIC_API_KEY` = your Anthropic key

### 4. Deploy

```bash
git add .
git commit -m "v3.3: edge caching + timeout protection"
git push
```

Netlify auto-deploys.

## Architecture

```
Browser
  │
  │  1. Check localStorage cache (60s TTL) ─── hit → instant render
  │  2. Miss → GET /api/search?q=...&mode=...
  │           │
  │           └─→ Netlify edge cache (60s) ─── hit → ~50ms response
  │                                       └─── miss → eBay Browse API (~1s)
  │
  └─→ POST /api/analyze (background, skipped on slow connections)
          └─→ Claude Haiku 4.5 (~2s)
```

## Cost per scan

- eBay Browse API: **free** (5,000 calls/day on production)
- Claude Haiku rarity: **~$0.002**
- Most scans cost nothing — they hit the edge cache or client cache

## Files

```
bratzilla2000/
├── netlify.toml
├── netlify/edge-functions/
│   ├── search.js     ← eBay Browse API + market math
│   └── analyze.js    ← Claude Haiku rarity + flags
└── public/
    └── index.html    ← Frontend (single file, vanilla JS)
```

## Troubleshooting

- **"eBay API credentials not configured"** → Add env vars in Netlify
- **eBay auth 401** → Verify App ID + Cert ID are from Production (not Sandbox)
- **Search timed out** → eBay had a slow moment; tap SCAN again, the second request usually hits the cache
- **No rarity scores on phone** → If you're on cellular with Save Data on, AI analysis is auto-skipped to keep results fast; the rest still works
