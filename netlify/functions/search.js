// Lightweight proxy - forwards the request body to Anthropic and streams back
// This avoids timeout issues by using Netlify's streaming response

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "API key not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const query = body.query;

    if (!query || typeof query !== "string" || query.length > 200) {
      return new Response(
        JSON.stringify({ error: "Invalid query" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Build the Anthropic request
    const anthropicBody = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      stream: true,
      system: `You are a marketplace research assistant. Search for current Bratz doll listings available for purchase RIGHT NOW on eBay, Mercari, Poshmark, and other resale platforms.

For EACH listing, output it in this EXACT format:

**[Exact listing title]** - $[price] on [Platform]
- Condition: [condition]
- Shipping: $[amount] or Free
- URL: [full URL]

RULES:
- Only REAL, currently active listings with exact prices in USD
- Include the platform name (eBay, Mercari, Poshmark, Depop)
- Include URLs when available
- Find 10-20 listings across platforms and price ranges
- Include individual dolls AND lots/bundles
- Note rare/collectible items (Tokyo A Go-Go, Genie Magic, first editions, NRFB, etc.)`,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [
        {
          role: "user",
          content: `Search for currently available "${query}" listings on eBay, Mercari, Poshmark and other resale sites. Find REAL active listings with exact prices I can buy right now. 10-20 results, different platforms and price ranges. Focus on deals and rare finds.`,
        },
      ],
    };

    // Stream the response from Anthropic back to the client
    const anthropicResponse = await fetch(
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

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text();
      console.error("Anthropic error:", anthropicResponse.status, errText);
      return new Response(
        JSON.stringify({ error: `Anthropic API error: ${anthropicResponse.status}` }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // Stream the SSE response directly back to the browser
    return new Response(anthropicResponse.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("Function error:", err);
    return new Response(
      JSON.stringify({ error: "Server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config = {
  path: "/api/search",
};
