// Bratzilla 2000 — eBay Browse API search (v3.1)
// Fast (<2s), free, real data with condition-aware market pricing

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Env access that works on Netlify Edge (Deno) with safe fallbacks
function env(key) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env?.get) return Netlify.env.get(key);
  } catch (_) {}
  try {
    if (typeof Deno !== "undefined" && Deno.env?.get) return Deno.env.get(key);
  } catch (_) {}
  try {
    if (typeof process !== "undefined" && process.env) return process.env[key];
  } catch (_) {}
  return null;
}

// Module-scope token cache
let cachedToken = null;
let tokenExpiry = 0;

async function getEbayToken(appId, certId) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const credentials = btoa(`${appId}:${certId}`);
  const resp = await fetchWithTimeout("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  }, 6000);

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`eBay auth failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// Wrap fetch with a hard timeout so we never hang on a slow eBay response
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchEbay(token, query) {
  // Use relevance (default) — eBay's "best match" beats price-asc for deal hunting
  // fieldgroups=EXTENDED gives us conditionId + better images
  const params = new URLSearchParams({
    q: query,
    limit: "50",
    fieldgroups: "EXTENDED",
    filter: [
      "buyingOptions:{FIXED_PRICE|AUCTION}",
      "itemLocationCountry:US",
    ].join(","),
  });

  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`;

  const resp = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "X-EBAY-C-ENDUSERCTX": "contextualLocation=country=US,zip=07094",
      "Accept-Language": "en-US",
      "Accept-Encoding": "gzip",
    },
  }, 8000);

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`eBay search failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  return await resp.json();
}

// Right-size eBay image URLs for the card display (cards are ~300px max)
// s-l400 hits a sweet spot: sharp on retina, ~half the bytes of s-l500/640
function upscaleImage(url) {
  if (!url) return "";
  return url.replace(/\/s-l\d+(\.(jpg|jpeg|png|webp))/i, "/s-l400$1");
}

// Bucket listings by condition so we can compute fair market medians
function categorize(title, condition) {
  const t = (title || "").toLowerCase();
  const c = (condition || "").toLowerCase();

  if (/\b(nrfb|sealed|mib|misb|unopened|never removed)\b/.test(t)) return "premium";
  if (c === "new" || c === "new (other)") return "premium";

  if (/\b(parts|broken|damaged|missing|incomplete|as.is|as\s+is|stained|tlc|nude\s+doll)\b/.test(t)) return "damaged";
  if (c === "for parts" || c === "acceptable") return "damaged";

  return "standard";
}

// Compute market stats per category + overall, with outlier trimming
function computeMarketStats(items) {
  if (!items || items.length === 0) return null;

  const condMap = {
    NEW: "New", NEW_OTHER: "New (other)", NEW_WITH_DEFECTS: "New",
    USED_EXCELLENT: "Excellent", USED_VERY_GOOD: "Very Good",
    USED_GOOD: "Good", USED_ACCEPTABLE: "Acceptable",
    FOR_PARTS_OR_NOT_WORKING: "For Parts",
  };

  const buckets = { premium: [], standard: [], damaged: [] };
  for (const item of items) {
    const price = parseFloat(item.price?.value || 0);
    if (price <= 0 || price > 2500) continue;
    const cond = condMap[(item.condition || "").toUpperCase()] || item.condition || "Used";
    const cat = categorize(item.title || "", cond);
    buckets[cat].push(price);
  }

  const summarize = (arr) => {
    if (arr.length < 2) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const trimCount = Math.floor(sorted.length * 0.1);
    const trimmed = trimCount > 0 ? sorted.slice(trimCount, -trimCount) : sorted;
    const mean = trimmed.reduce((s, p) => s + p, 0) / trimmed.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
      count: sorted.length,
      median: +median.toFixed(2),
      mean: +mean.toFixed(2),
      q1: +sorted[Math.floor(sorted.length * 0.25)].toFixed(2),
      q3: +sorted[Math.floor(sorted.length * 0.75)].toFixed(2),
      min: +sorted[0].toFixed(2),
      max: +sorted[sorted.length - 1].toFixed(2),
    };
  };

  return {
    premium: summarize(buckets.premium),
    standard: summarize(buckets.standard),
    damaged: summarize(buckets.damaged),
    overall: summarize([...buckets.premium, ...buckets.standard, ...buckets.damaged]),
  };
}

function marketValueFor(category, stats, fallbackPrice) {
  if (!stats) return fallbackPrice;
  return stats[category]?.median || stats.overall?.median || fallbackPrice;
}

// Drop obvious junk results from doll searches (keychains, t-shirts, posters, etc.)
function isJunk(title, query) {
  const t = (title || "").toLowerCase();
  const q = (query || "").toLowerCase();

  const dollSearch = q.includes("doll") || (q.includes("bratz") && !q.includes("accessor"));
  if (dollSearch) {
    if (/\b(keychain|key chain|ornament|poster|print\b|sticker|magnet|digital|pdf|mug|t.?shirt|shirt only|patch|button pin|badge|funko)\b/.test(t)) {
      return true;
    }
  }
  return false;
}

function normalizeItem(item, stats) {
  const price = parseFloat(item.price?.value || 0);
  const shipping = parseFloat(item.shippingOptions?.[0]?.shippingCost?.value || 0);

  const condMap = {
    NEW: "New",
    NEW_OTHER: "New (other)",
    NEW_WITH_DEFECTS: "New w/ defects",
    MANUFACTURER_REFURBISHED: "Refurb",
    SELLER_REFURBISHED: "Refurb",
    USED_EXCELLENT: "Excellent",
    USED_VERY_GOOD: "Very Good",
    USED_GOOD: "Good",
    USED_ACCEPTABLE: "Acceptable",
    FOR_PARTS_OR_NOT_WORKING: "For Parts",
  };
  const condition = condMap[(item.condition || "").toUpperCase()] || item.condition || "Used";
  const category = categorize(item.title || "", condition);
  const marketValue = marketValueFor(category, stats, price);

  // Profit math — eBay fees (~15% final value + payment processing) + avg $9 ship
  const EBAY_FEE = 0.15;
  const SHIP_COST = 9;
  const resaleNet = marketValue * (1 - EBAY_FEE) - SHIP_COST;
  const totalCost = price + shipping;
  const profit = resaleNet - totalCost;
  const profitPct = totalCost > 0 ? (profit / totalCost) * 100 : 0;

  let recommendation = "SKIP";
  let recReason = "Priced at or above market";
  if (profit > 25 && profitPct > 30) {
    recommendation = "BUY NOW";
    recReason = `$${Math.round(profit)} profit · ${Math.round(profitPct)}% margin`;
  } else if (profit > 10 && profitPct > 15) {
    recommendation = "WATCH";
    recReason = `$${Math.round(profit)} profit · ${Math.round(profitPct)}% margin`;
  } else if (profit > 0) {
    recommendation = "MAYBE";
    recReason = `Thin margin · ${Math.round(profitPct)}%`;
  }

  const sellerFeedback = item.seller?.feedbackPercentage
    ? parseFloat(item.seller.feedbackPercentage)
    : null;

  // Penalize BUY NOW recs if seller feedback is shaky
  if (sellerFeedback !== null && sellerFeedback < 95 && recommendation === "BUY NOW") {
    recommendation = "WATCH";
    recReason = `Seller feedback ${sellerFeedback}% — verify before buying`;
  }

  // Auction countdown
  let timeRemaining = null;
  let endingSoon = false;
  if (item.itemEndDate) {
    const ms = new Date(item.itemEndDate).getTime() - Date.now();
    if (ms > 0) {
      const hours = ms / 3600000;
      if (hours < 1) {
        timeRemaining = `${Math.floor(ms / 60000)}m`;
        endingSoon = true;
      } else if (hours < 24) {
        timeRemaining = `${Math.floor(hours)}h ${Math.floor((ms % 3600000) / 60000)}m`;
        endingSoon = hours < 2;
      } else {
        timeRemaining = `${Math.floor(hours / 24)}d ${Math.floor(hours % 24)}h`;
      }
    }
  }

  return {
    id: item.itemId || "rnd-" + Math.random().toString(36).slice(2, 10),
    title: item.title || "Untitled",
    price,
    shipping,
    totalCost: +(price + shipping).toFixed(2),
    platform: "eBay",
    condition,
    category,
    url: item.itemWebUrl || "",
    image: upscaleImage(item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || ""),
    seller: item.seller?.username || "",
    sellerFeedback,
    sellerCount: item.seller?.feedbackScore || 0,
    location: item.itemLocation?.country || "",
    buyingOption: item.buyingOptions?.[0] || "FIXED_PRICE",
    endDate: item.itemEndDate || null,
    bids: item.bidCount || 0,
    listingDate: item.itemCreationDate || null,
    marketValue: +marketValue.toFixed(2),
    estimatedProfit: +profit.toFixed(2),
    profitPercent: Math.round(profitPct),
    recommendation,
    recReason,
    timeRemaining,
    endingSoon,
    rarityScore: null,
    rarityLabel: null,
    aiNotes: null,
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers: CORS });
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const appId = env("EBAY_APP_ID");
  const certId = env("EBAY_CERT_ID");

  if (!appId || !certId) {
    return new Response(
      JSON.stringify({
        error: "eBay API credentials not configured. Add EBAY_APP_ID and EBAY_CERT_ID to Netlify → Site config → Environment variables.",
      }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }

  try {
    let rawQuery, mode;
    if (req.method === "GET") {
      const u = new URL(req.url);
      rawQuery = (u.searchParams.get("q") || "").trim();
      mode = u.searchParams.get("mode") || "deals";
    } else {
      const body = await req.json();
      rawQuery = (body.query || "").trim();
      mode = body.mode || "deals";
    }

    if (!rawQuery || rawQuery.length > 200) {
      return new Response(JSON.stringify({ error: "Invalid query (1-200 chars)" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    let query = rawQuery;
    if (mode === "rare") {
      if (!/nrfb|sealed|tokyo|genie|first edition|prototype|rock angelz|princess|twiins|vintage/i.test(query)) {
        query = `${query} NRFB sealed vintage`;
      }
    } else if (mode === "lots") {
      if (!/lot|bundle|collection|dolls/i.test(query)) {
        query = `${query} lot bundle`;
      }
    }

    const token = await getEbayToken(appId, certId);
    const searchData = await searchEbay(token, query);

    let items = searchData.itemSummaries || [];
    const preFilterCount = items.length;
    items = items.filter((i) => !isJunk(i.title || "", rawQuery));
    const junkFiltered = preFilterCount - items.length;

    if (items.length === 0) {
      return new Response(
        JSON.stringify({
          listings: [],
          stats: null,
          warning: "No listings found. Try a broader search term.",
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...CORS } }
      );
    }

    const stats = computeMarketStats(items);
    let listings = items.map((item) => normalizeItem(item, stats));

    const recOrder = { "BUY NOW": 4, WATCH: 3, MAYBE: 2, SKIP: 1 };
    if (mode === "deals") {
      listings.sort((a, b) => {
        const r = (recOrder[b.recommendation] || 0) - (recOrder[a.recommendation] || 0);
        if (r !== 0) return r;
        return b.estimatedProfit - a.estimatedProfit;
      });
    } else if (mode === "rare") {
      const rareRe = /\b(nrfb|sealed|tokyo|genie|first edition|prototype|rock angelz|princess|twiins|wild.wild.west|vintage|200[1-5])\b/i;
      listings.sort((a, b) => {
        const aR = rareRe.test(a.title) ? 1 : 0;
        const bR = rareRe.test(b.title) ? 1 : 0;
        if (aR !== bR) return bR - aR;
        return (recOrder[b.recommendation] || 0) - (recOrder[a.recommendation] || 0);
      });
    } else if (mode === "lots") {
      const lotRe = /\b(lot|bundle|collection|bulk|\d+\s*dolls?)\b/i;
      listings.sort((a, b) => {
        const aL = lotRe.test(a.title) ? 1 : 0;
        const bL = lotRe.test(b.title) ? 1 : 0;
        if (aL !== bL) return bL - aL;
        return b.estimatedProfit - a.estimatedProfit;
      });
    }

    return new Response(
      JSON.stringify({
        listings: listings.slice(0, 50),
        stats,
        total: searchData.total || items.length,
        junkFiltered,
        query,
        rawQuery,
        mode,
        timestamp: Date.now(),
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          // Browser: don't cache (we want fresh prices on next page load)
          "Cache-Control": "private, max-age=0, must-revalidate",
          // Netlify edge: cache for 60s, serve stale for up to 5min while refreshing.
          // Identical queries within 60s are returned instantly from edge — zero eBay calls.
          "Netlify-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300, durable",
          ...CORS,
        },
      }
    );
  } catch (err) {
    console.error("Search error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Search failed" }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }
};

export const config = {
  path: "/api/search",
  cache: "manual",
};
