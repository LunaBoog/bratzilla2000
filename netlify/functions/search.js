// Bratzilla 2000 — Netlify serverless proxy
// Streams Anthropic API responses (SSE) to avoid 10s timeout

export default async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response("", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "API key not configured on server" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  try {
    const body = await req.json();
    const query = body.query;
    const mode = body.mode || "deals"; // deals | rare | lots

    if (!query || typeof query !== "string" || query.length > 200) {
      return new Response(
        JSON.stringify({ error: "Invalid query" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Tailor the search instructions based on mode
    let modeInstructions = "";
    if (mode === "rare") {
      modeInstructions = `Focus on RARE and COLLECTIBLE items: Tokyo A Go-Go, Genie Magic, First Edition, Princess, NRFB/sealed, limited editions, prototype, Twiins, Treasures, Wild Wild West. Prioritize high-value collectible listings.`;
    } else if (mode === "lots") {
      modeInstructions = `Focus on LOTS, BUNDLES, and BULK listings. Look for "lot", "bundle", "collection", "bulk", multiple dolls sold together. These are where the best profit margins hide.`;
    } else {
      modeInstructions = `Find a MIX of deals across all price ranges. Include cheap finds under $20, mid-range $20-60, and high-value collectibles $60+. Prioritize listings where the asking price looks lower than market value.`;
    }

    const anthropicBody = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 6000,
      stream: true,
      system: `You are a Bratz doll marketplace researcher. Your job is to search for REAL, currently active listings that someone can buy RIGHT NOW.

SEARCH STRATEGY:
1. Search eBay for "${query}" — this is the primary source, search it thoroughly
2. Search Mercari for "${query}"
3. Search Poshmark for "${query}"
4. If relevant, also check Depop

${modeInstructions}

OUTPUT FORMAT — use this EXACT format for every listing, no exceptions:

LISTING_START
TITLE: [exact listing title as shown on the platform]
PRICE: [number only, e.g. 24.99]
PLATFORM: [eBay|Mercari|Poshmark|Depop]
CONDITION: [New/NRFB|New|Like New|Good|Used|For Parts]
SHIPPING: [number or FREE]
URL: [full URL to the listing]
LISTING_END

CRITICAL RULES:
- Return 10-20 real listings. More is better.
- Every listing MUST have a real price in USD (numbers only, no $ sign in the PRICE field)
- Every listing MUST have a platform name
- Include the FULL URL so the user can click through and buy
- Do NOT invent or fabricate listings — only report what you actually find in search results
- Do NOT include sold/completed listings — only currently available ones
- If you find fewer than 10 listings, that's okay — quality over quantity
- Include the listing title EXACTLY as it appears on the platform`,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [
        {
          role: "user",
          content: `Search for "${query}" listings available to buy right now. Check eBay, Mercari, and Poshmark. Return results in the exact LISTING_START/LISTING_END format specified. I need real listings with real prices and real URLs.`,
        },
      ],
    };

    // Retry logic for rate limits
    let anthropicResponse;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, attempt * 15000));
      }

      anthropicResponse = await fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(anthropicBody),
        }
      );

      if (anthropicResponse.ok) break;

      if (anthropicResponse.status === 429) {
        console.log(`Rate limited (attempt ${attempt + 1}/3), waiting...`);
        continue;
      }

      // Non-retryable error
      const errText = await anthropicResponse.text();
      console.error("Anthropic error:", anthropicResponse.status, errText);
      return new Response(
        JSON.stringify({
          error: `API error (${anthropicResponse.status}). ${
            anthropicResponse.status === 401
              ? "Check your ANTHROPIC_API_KEY in Netlify environment variables."
              : anthropicResponse.status === 400
              ? "Bad request — try a simpler search term."
              : "Please try again in a moment."
          }`,
        }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    if (!anthropicResponse || !anthropicResponse.ok) {
      return new Response(
        JSON.stringify({
          error: "Rate limited after retries. Wait 1-2 minutes and try again. If this keeps happening, check your Anthropic billing at console.anthropic.com.",
        }),
        { status: 429, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Stream SSE directly back to the browser
    return new Response(anthropicResponse.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...corsHeaders,
      },
    });
  } catch (err) {
    console.error("Function error:", err);
    return new Response(
      JSON.stringify({ error: "Server error: " + err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config = {
  path: "/api/search",
};
