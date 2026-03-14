# Bratzilla 2000 🎀

**Bratz Doll Market Scanner** — Scans eBay, Mercari, Poshmark and more for Bratz doll listings, analyzes rarity, and calculates profit potential for reselling.

## Live Site

Deployed on Netlify — just open the URL and start scanning!

## How It Works

1. Enter a search term (e.g. "bratz doll", "bratz nrfb", "bratz genie magic")
2. Hit **SCAN** — searches real marketplace listings via Claude AI + web search
3. Each listing shows price, estimated resale value, profit potential, and rarity score
4. Click **View Deal** to go directly to the listing
5. **Save** items to your watchlist for tracking

## Tech Stack

- **Frontend**: Single HTML file, vanilla JS, no build step
- **Backend**: Netlify serverless function (proxies Claude API)
- **AI**: Claude Sonnet 4 with web search for live marketplace data
- **Rarity Engine**: Custom scoring based on Bratz doll collectibility database

## Deploy Your Own

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Bratzilla 2000"
git remote add origin https://github.com/YOUR_USERNAME/bratzilla2000.git
git push -u origin main
```

### 2. Deploy on Netlify

1. Go to [netlify.com](https://netlify.com) and sign in
2. Click **"Add new site"** → **"Import an existing project"**
3. Connect your GitHub repo
4. Build settings are auto-detected from `netlify.toml` — just click **Deploy**

### 3. Add Your API Key

1. In Netlify dashboard, go to **Site settings** → **Environment variables**
2. Add a new variable:
   - **Key**: `ANTHROPIC_API_KEY`
   - **Value**: `sk-ant-api03-...` (your Anthropic API key)
3. Click **Save**
4. Trigger a redeploy: **Deploys** → **Trigger deploy** → **Deploy site**

That's it! Share the Netlify URL with anyone — they can use it without needing their own API key.

## Project Structure

```
bratzilla2000/
├── public/
│   └── index.html          # Frontend (single file, no build)
├── netlify/
│   └── functions/
│       └── search.js        # Serverless function (proxies Claude API)
├── netlify.toml             # Netlify config
└── README.md
```
