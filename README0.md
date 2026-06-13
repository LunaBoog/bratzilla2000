# Bratzilla 2000 v3.4

Real-time Bratz doll profit scanner across **eBay + Mercari**, with deep-link search to Etsy, Depop, and Poshmark. Powered by eBay Browse API, Mercari's public search endpoint, and Claude rarity analysis.

## v3.4 — multi-platform expansion

- **Mercari results** — live listings pulled in parallel with eBay, mixed into the same grid with their own profit math (10% fee + 2.9% processing vs eBay's ~15%)
- **Platform badges** — every card shows where the listing came from (blue eBay / orange Mercari)
- **Platform filter chips** — toggle eBay-only or Mercari-only with one tap
- **Unified market median** — combines both platforms' price data for a more accurate fair-value reference (especially helpful when one platform has thin data on a specific line)
- **Graceful degradation** — if Mercari (or eBay) fails or times out, the other still ships and a soft warning bar appears
- **Deep-link row** — Etsy, Depop, Poshmark buttons under the search bar, pre-filled with your current query, opens in a new tab. No backend, no breakage risk.
- **Cache key bumped** — `bratzilla_cache_v2` because the response shape changed

### Why no Facebook Marketplace, Etsy listings, or Depop listings inline?

| Platform | Why it's deep-link only |
|---|---|
| **Etsy** | Has a real API but requires OAuth approval (1-3 day wait). Could be added later as a Phase 2. |
| **Depop** | No public API. Their search endpoints are scrapeable but fragile and against ToS. |
| **Poshmark** | No public API. Same story as Depop. |
| **Facebook Marketplace** | Listings are geo-locked behind login, no API exists for buyers, and any login-based scraper risks the personal account. Not worth building. |

The deep-link buttons solve the practical problem (one-click cross-platform search) without any of the breakage risk of scraping.

## v3.3 features (still here)

- Edge caching, client-side cache, hard timeouts, request cancellation, connection-aware degradation, lighter images, preconnect hints, no backdrop-filter on cards, reduced-motion + saveData support

## v3.2 features (still here)

- Live eBay listings (1-2s response)
- Real profit math from market median (condition-aware buckets)
- BUY NOW / WATCH / MAYBE / SKIP recommendations with reasons
- Claude Haiku 4.5 rarity scoring with HOT / UNDERPRICED / OVERPRICED / FAKE_RISK / INCOMPLETE flags
- Skeleton loaders, autocomplete, keyword highlighting in titles
- Saved items with automatic price tracking
- Bell-icon alerts when watched items drop 10%+
- Share buttons, CSV export, copy-all
- Filter chips, auction countdowns, keyboard shortcuts (`/` to focus, Esc to close)

## Setup

### 1. Get eBay API credentials (free)

1. Sign up at [developer.ebay.com](https://developer.ebay.com)
2. **My Account → Application Keysets**
3. Under **Production**, create a keyset named "Bratzilla2000"
4. Copy **App ID (Client ID)** and **Cert ID (Client Secret)**
5. Click **User Tokens → Sign in to Production** once to accept terms

### 2. Get Anthropic API key

[console.anthropic.com](https://console.anthropic.com) → API Keys.

### 3. Add to Netlify

Site configuration → Environment variables:
- `EBAY_APP_ID` = your eBay App ID
- `EBAY_CERT_ID` = your eBay Cert ID
- `ANTHROPIC_API_KEY` = your Anthropic key

(Mercari needs no credentials — it's accessed through their public search endpoint.)

### 4. Deploy

```bash
git add .
git commit -m "v3.4: Mercari integration + Etsy/Depop/Poshmark deep-links"
git push
```

## Architecture

```
Browser
  │
  │  1. Check localStorage cache (60s TTL)
  │  2. Miss → GET /api/search?q=...&mode=...
  │           │
  │           └─→ Edge function fans out in parallel:
  │                 ├─→ eBay Browse API   (~1s, ~50 results)
  │                 └─→ Mercari search    (~1s, ~60 results)
  │               Promise.allSettled — neither blocks the other.
  │               Both normalized to same shape, merged, sorted.
  │
  └─→ POST /api/analyze (background, top 20 only, skipped on slow connections)
          └─→ Claude Haiku 4.5 (~2s, platform-agnostic)
```

## Profit math by platform

| Platform | Buyer ship | Resale fees we'd pay | Resale ship cost |
|---|---|---|---|
| eBay | varies (shown on card) | 15% | $9 |
| Mercari | always free to buyer | ~13% (10% fee + 2.9% processing) | $9 |

`profit = market_value × (1 − fees) − ship_cost − purchase_total`

The market value is the median of comparable-condition listings across **both** platforms — that's why mixing platforms makes the recommendations sharper, not noisier.

## Files

```
bratzilla2000/
├── netlify.toml
├── netlify/edge-functions/
│   ├── search.js     ← eBay + Mercari fan-out, market math
│   └── analyze.js    ← Claude Haiku rarity (platform-agnostic)
└── public/
    └── index.html    ← Frontend (single file, vanilla JS)
```

## Troubleshooting

- **"eBay didn't respond"** warning bar → eBay had a slow moment, results show Mercari only. Tap SCAN again.
- **"Mercari didn't respond"** warning bar → Mercari endpoint hiccup, results show eBay only. Tap SCAN again.
- **Empty Mercari counts every time** → Mercari may have changed their endpoint. Check the Netlify function logs for `Mercari error:` lines. eBay still works on its own.
- **Deep-link buttons don't open** → They use `target="_blank"` so a popup blocker may interfere. Allow popups from your Netlify domain.
- **No rarity scores on phone** → Cellular + Save Data turns off the AI step automatically to keep results fast.
