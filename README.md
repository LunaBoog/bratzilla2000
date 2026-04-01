# Bratzilla 2000

Bratz Doll Market Scanner — finds real listings on eBay, Mercari, Poshmark with profit analysis.

## What's New (v2)

- **Search Modes**: Best Deals, Rare Finds, Lots & Bundles — each mode tailors the AI search
- **Better Parsing**: Structured LISTING_START/END format with fallback parser
- **Expanded Rarity DB**: 35+ collectible lines tracked (was 23)
- **Cleaner UI**: Refreshed dark theme with Syne + Instrument Sans fonts
- **Smarter Errors**: Specific messages for API key issues vs rate limits vs bad queries
- **More Tags**: Quick-search tags for wild west, forever diamondz, etc.

## Deploy

1. Push to GitHub (`git add . && git commit -m "v2" && git push`)
2. Connect to Netlify (or it auto-deploys if already connected)
3. Add `ANTHROPIC_API_KEY` in Netlify → Site config → Environment variables
4. Deploy

## Cost

Each scan costs ~$0.15-0.30 in Anthropic API credits. $5 gets you ~20-30 scans.

## Troubleshooting

- **429 errors**: Add credits at console.anthropic.com → Billing
- **"API key not configured"**: Check Netlify → Site config → Environment variables
- **No results**: Try a different/simpler search term
