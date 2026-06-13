// Bratzilla 2000 — Multi-platform search (v3.4)
// Fan-out: eBay Browse API + Mercari (unofficial JSON endpoint), merged into one grid.
// If either platform fails or times out, the other still ships.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Env access that works on Netlify Edge (Deno) with safe fallbacks
function env(key) {
  try { if (typeof Netlify !== "undefined" && Netlify.env?.get) return Netlify.env.get(key); } catch (_) {}
  try { if (typeof Deno !== "undefined" && Deno.env?.get) return Deno.env.get(key); } catch (_) {}
  try { if (typeof process !== "undefined" && process.env) return process.env[key]; } catch (_) {}
  return null;
}

// Module-scope token cache for eBay
let cachedEbayToken = null;
let ebayTokenExpiry = 0;

// Wrap fetch with a hard timeout so we never hang on a slow upstream
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
   eBay
   ============================================================ */

async function getEbayToken(appId, certId) {
  if (cachedEbayToken && Date.now() < ebayTokenExpiry) return cachedEbayToken;

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
  cachedEbayToken = data.access_token;
  ebayTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedEbayToken;
}

async function searchEbay(token, query) {
  const params = new URLSearchParams({
    q: query,
    limit: "50",
    category_ids: "237",
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

// Right-size eBay image URLs (cards are ~300px max)
function upscaleImage(url) {
  if (!url) return "";
  return url.replace(/\/s-l\d+(\.(jpg|jpeg|png|webp))/i, "/s-l400$1");
}

function extractEbayPrice(item) {
  const candidates = [
    item.currentBidPrice?.value,
    item.price?.value,
    item.priceDisplay,
    item.minimumPriceToBid?.value,
  ];
  for (const c of candidates) {
    const n = parseFloat(c);
    if (n > 0) return n;
  }
  return 0;
}

/* ============================================================
   Mercari (unofficial — uses the same JSON endpoint mercari.com calls from the browser)
   ============================================================ */

async function searchMercari(query) {
  // This is the endpoint Mercari's own search page hits. It's public (no auth) but
  // requires the dpop header pattern they use for browser requests. We send a
  // minimal-but-valid request that mimics a real browser session.
  //
  // If they tighten this in the future, this whole function can throw and the
  // fan-out keeps eBay working.

  const body = {
    userId: "",
    pageSize: 60,
    pageToken: "",
    searchSessionId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    indexType: "INDEX_TYPE_DEFAULT",
    thumbnailTypes: [],
    searchCondition: {
      keyword: query,
      excludeKeyword: "",
      sort: "SORT_SCORE",
      order: "ORDER_DESC",
      status: ["STATUS_ON_SALE"],
      sizeId: [],
      categoryId: [],
      brandId: [],
      sellerId: [],
      priceMin: 0,
      priceMax: 0,
      itemConditionId: [],
      shippingPayerId: [],
      shippingFromArea: [],
      shippingMethod: [],
      colorId: [],
      hasCoupon: false,
      attributes: [],
      itemTypes: [],
      skuIds: [],
    },
    defaultDatasets: [],
    serviceFrom: "suruga",
    withItemBrand: true,
    withItemSize: false,
    withItemPromotions: true,
    withItemSizes: true,
    withShopName: false,
  };

  const resp = await fetchWithTimeout("https://api.mercari.com/v2/entities:search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Origin": "https://www.mercari.com",
      "Referer": "https://www.mercari.com/",
      "X-Platform": "web",
    },
    body: JSON.stringify(body),
  }, 7000);

  if (!resp.ok) {
    throw new Error(`Mercari search failed (${resp.status})`);
  }

  return await resp.json();
}

function extractMercariPrice(item) {
  const candidates = [item.price, item.priceData?.price, item.itemPrice];
  for (const c of candidates) {
    const n = parseFloat(c);
    if (n > 0) return n;
  }
  return 0;
}

function mercariConditionLabel(id) {
  // Mercari condition IDs roughly map to:
  const map = {
    1: "New", 2: "Like New", 3: "Good", 4: "Fair", 5: "Poor", 6: "For Parts",
  };
  return map[id] || "Used";
}

function mercariImageUrl(item) {
  // Mercari items have a `thumbnails` array or `photos` field; shape varies.
  if (Array.isArray(item.thumbnails) && item.thumbnails.length) return item.thumbnails[0];
  if (Array.isArray(item.photos) && item.photos.length) {
    const p = item.photos[0];
    return typeof p === "string" ? p : (p.url || p.uri || "");
  }
  if (item.thumbnail) return item.thumbnail;
  if (item.imageUrl) return item.imageUrl;
  return "";
}

/* ============================================================
   Shared market math
   ============================================================ */

function categorize(title, condition) {
  const t = (title || "").toLowerCase();
  const c = (condition || "").toLowerCase();

  if (/\b(nrfb|sealed|mib|misb|unopened|never removed)\b/.test(t)) return "premium";
  if (c === "new" || c === "new (other)" || c === "like new") return "premium";

  if (/\b(parts|broken|damaged|missing|incomplete|as.is|as\s+is|stained|tlc|nude\s+doll)\b/.test(t)) return "damaged";
  if (c === "for parts" || c === "acceptable" || c === "poor" || c === "fair") return "damaged";

  return "standard";
}

// Build a single combined market view across both platforms — gives a more
// accurate median when one platform has thin data.
function computeMarketStats(allUnified) {
  if (!allUnified || allUnified.length === 0) return null;

  const buckets = { premium: [], standard: [], damaged: [] };
  for (const item of allUnified) {
    if (item.price <= 0 || item.price > 2500) continue;
    const cat = categorize(item.title, item.condition);
    buckets[cat].push(item.price);
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

/* ============================================================
   Junk filter (shared)
   ============================================================ */

function isJunk(title, query) {
  const t = (title || "").toLowerCase();
  const q = (query || "").toLowerCase();

  if (/\b(keychain|key chain|ornament|poster|print\b|sticker|magnet|digital download|pdf|mug|t.?shirt|shirt only|patch|button pin|badge|funko pop|funko\b|coloring book|coloring page|video game|playstation|xbox|nintendo|dvd|vhs|blu.?ray|book\b|paperback|hardcover|novel|warriors|tigerstar|bobblehead|trading card|figurine\s+only)\b/.test(t)) {
    return true;
  }

  const dollSearch = q.includes("doll") || q.includes("bratz");
  if (dollSearch) {
    const hasBratzMention = /\b(bratz|bratzilla|bratzillaz|cloe|chloe|yasmin|jade|sasha|meygan|dana|fianna|nevra|jasmin|raya|nora|mga|babyz|kidz|boyz|tweevils|liltz|petz|pretty.n.punk|tokyo|genie|forever diamondz|rock angelz|wild wild west|passion 4 fashion|formal funk|slumber party|girls nite|ice champions|wintertime|treasures|princess|twiins|prom|featherageous|sun kissed|magic hair|spring break|sweet dreamz|passion 4|funk n glow|step out|fashion pixiez|dynamite|midnight dance|live in concert|secret date|nighty.nightz|space angelz|sleepover|on.the.mic|good vibes)\b/i.test(t);
    if (!hasBratzMention) return true;
  }

  return false;
}

/* ============================================================
   Normalizers — both platforms output the same shape
   ============================================================ */

function normalizeEbayItem(item, stats) {
  const price = extractEbayPrice(item);
  const shipping = parseFloat(item.shippingOptions?.[0]?.shippingCost?.value || 0);

  const condMap = {
    NEW: "New", NEW_OTHER: "New (other)", NEW_WITH_DEFECTS: "New w/ defects",
    MANUFACTURER_REFURBISHED: "Refurb", SELLER_REFURBISHED: "Refurb",
    USED_EXCELLENT: "Excellent", USED_VERY_GOOD: "Very Good",
    USED_GOOD: "Good", USED_ACCEPTABLE: "Acceptable",
    FOR_PARTS_OR_NOT_WORKING: "For Parts",
  };
  const condition = condMap[(item.condition || "").toUpperCase()] || item.condition || "Used";
  const category = categorize(item.title || "", condition);
  const marketValue = marketValueFor(category, stats, price);

  // eBay fees: ~15% final value + payment processing, then -$9 ship cost we'd eat
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

  if (sellerFeedback !== null && sellerFeedback < 95 && recommendation === "BUY NOW") {
    recommendation = "WATCH";
    recReason = `Seller feedback ${sellerFeedback}% — verify before buying`;
  }

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
    id: "ebay-" + (item.itemId || Math.random().toString(36).slice(2, 10)),
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

function normalizeMercariItem(item, stats) {
  const price = extractMercariPrice(item);
  // Mercari ships "free" to the buyer in the listed price for most items, but the
  // seller eats the shipping cost. From a flipper's POV (we're the buyer reselling),
  // shipping to us is included in the price — there's no separate ship line.
  const shipping = 0;

  const condition = mercariConditionLabel(item.itemConditionId || item.condition?.id);
  const category = categorize(item.name || item.title || "", condition);
  const title = item.name || item.title || "Untitled";
  const marketValue = marketValueFor(category, stats, price);

  // Mercari fees when WE eventually resell: 10% selling fee + 2.9% + $0.50 payment processing
  // = ~13% effective. Plus we'd ship at our cost (~$9 priority).
  const MERCARI_FEE = 0.13;
  const SHIP_COST = 9;
  const resaleNet = marketValue * (1 - MERCARI_FEE) - SHIP_COST;
  const totalCost = price; // no separate shipping at purchase
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

  const itemId = item.id || item.itemId || "";
  const url = itemId ? `https://www.mercari.com/us/item/${itemId}/` : "https://www.mercari.com/";

  return {
    id: "mercari-" + (itemId || Math.random().toString(36).slice(2, 10)),
    title,
    price,
    shipping,
    totalCost: +price.toFixed(2),
    platform: "Mercari",
    condition,
    category,
    url,
    image: mercariImageUrl(item),
    seller: item.seller?.name || item.sellerName || "",
    sellerFeedback: null, // Mercari uses star ratings, not %, so we hide for now
    sellerCount: item.seller?.numSellItems || 0,
    location: "US",
    buyingOption: "FIXED_PRICE",
    endDate: null,
    bids: 0,
    listingDate: item.created || item.updated || null,
    marketValue: +marketValue.toFixed(2),
    estimatedProfit: +profit.toFixed(2),
    profitPercent: Math.round(profitPct),
    recommendation,
    recReason,
    timeRemaining: null,
    endingSoon: false,
    rarityScore: null,
    rarityLabel: null,
    aiNotes: null,
  };
}

/* ============================================================
   Main handler
   ============================================================ */

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
    if (!/\bbratz/i.test(query)) {
      query = `bratz ${query}`;
    }

    if (mode === "rare") {
      if (!/nrfb|sealed|tokyo|genie|first edition|prototype|rock angelz|princess|twiins|vintage/i.test(query)) {
        query = `${query} NRFB sealed vintage`;
      }
    } else if (mode === "lots") {
      if (!/lot|bundle|collection|dolls/i.test(query)) {
        query = `${query} lot bundle`;
      }
    }

    // Fan out to both platforms in parallel — neither blocks the other
    const ebayPromise = (async () => {
      const token = await getEbayToken(appId, certId);
      return await searchEbay(token, query);
    })();

    const mercariPromise = searchMercari(query);

    const [ebayResult, mercariResult] = await Promise.allSettled([ebayPromise, mercariPromise]);

    // Track per-platform status so we can tell the user when one fails
    const platformStatus = { ebay: "ok", mercari: "ok" };
    const platformErrors = {};

    let ebayItems = [];
    if (ebayResult.status === "fulfilled") {
      ebayItems = ebayResult.value.itemSummaries || [];
    } else {
      platformStatus.ebay = "failed";
      platformErrors.ebay = ebayResult.reason?.message || "eBay request failed";
      console.error("eBay error:", platformErrors.ebay);
    }

    let mercariItems = [];
    if (mercariResult.status === "fulfilled") {
      // Mercari response shape: { items: [...] } or { data: { items: [...] } }
      mercariItems = mercariResult.value?.items
        || mercariResult.value?.data?.items
        || mercariResult.value?.results
        || [];
    } else {
      platformStatus.mercari = "failed";
      platformErrors.mercari = mercariResult.reason?.message || "Mercari request failed";
      console.warn("Mercari error:", platformErrors.mercari);
    }

    // Filter junk per platform (use raw user query for the strict-match rules)
    const preFilterEbay = ebayItems.length;
    const preFilterMercari = mercariItems.length;

    ebayItems = ebayItems.filter(i => !isJunk(i.title || "", rawQuery));
    mercariItems = mercariItems.filter(i => !isJunk(i.name || i.title || "", rawQuery));

    // Strict-match filter — title must contain a distinctive term the user mentioned
    const distinctiveTerms = [
      "cloe", "chloe", "yasmin", "jade", "sasha", "meygan", "dana", "fianna", "nevra",
      "jasmin", "raya", "nora", "phoebe", "roxxi",
      "rock angelz", "tokyo a go-go", "tokyo a go go", "tokyo", "genie magic", "wild wild west",
      "forever diamondz", "passion 4 fashion", "passion for fashion", "formal funk",
      "slumber party", "girls nite out", "girls night out", "ice champions", "wintertime",
      "treasures", "princess", "twiins", "twins", "prom", "featherageous", "sun kissed",
      "magic hair", "spring break", "sweet dreamz", "funk n glow", "step out", "pretty n punk",
      "fashion pixiez", "dynamite", "midnight dance", "live in concert", "secret date",
      "space angelz", "sleepover", "good vibes", "first edition", "starringas",
      "babyz", "kidz", "boyz", "tweevils", "liltz", "petz", "bratzilla", "bratzillaz",
      "nrfb", "sealed", "mib", "misb"
    ];

    const rawLower = rawQuery.toLowerCase();
    const userMentionedTerms = distinctiveTerms.filter(t => rawLower.includes(t));

    if (userMentionedTerms.length > 0) {
      const escaped = userMentionedTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const matchRe = new RegExp(`\\b(${escaped.join("|")})\\b`, "i");
      ebayItems = ebayItems.filter(i => matchRe.test(i.title || ""));
      mercariItems = mercariItems.filter(i => matchRe.test(i.name || i.title || ""));
    }

    // Drop priceless listings (transitional auctions, weird Mercari edge cases)
    ebayItems = ebayItems.filter(i => extractEbayPrice(i) > 0);
    mercariItems = mercariItems.filter(i => extractMercariPrice(i) > 0);

    const junkFiltered = (preFilterEbay + preFilterMercari) - (ebayItems.length + mercariItems.length);

    // Build the unified pricing pool BEFORE normalizing — so market median uses both platforms
    const pricingPool = [
      ...ebayItems.map(i => ({
        title: i.title || "",
        price: extractEbayPrice(i),
        condition: i.condition || "Used",
      })),
      ...mercariItems.map(i => ({
        title: i.name || i.title || "",
        price: extractMercariPrice(i),
        condition: mercariConditionLabel(i.itemConditionId || i.condition?.id),
      })),
    ];

    const stats = computeMarketStats(pricingPool);

    // Normalize both platforms with the unified market view
    let listings = [
      ...ebayItems.map(i => normalizeEbayItem(i, stats)),
      ...mercariItems.map(i => normalizeMercariItem(i, stats)),
    ];

    if (listings.length === 0) {
      return new Response(
        JSON.stringify({
          listings: [],
          stats: null,
          platformStatus,
          platformErrors,
          warning: "No listings found on either platform. Try a broader search.",
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...CORS } }
      );
    }

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

    const platformCounts = {
      eBay: listings.filter(l => l.platform === "eBay").length,
      Mercari: listings.filter(l => l.platform === "Mercari").length,
    };

    return new Response(
      JSON.stringify({
        listings: listings.slice(0, 80),
        stats,
        total: listings.length,
        junkFiltered,
        platformStatus,
        platformErrors,
        platformCounts,
        query,
        rawQuery,
        mode,
        timestamp: Date.now(),
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
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
};
