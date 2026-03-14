// Netlify serverless function - proxies requests to Claude API
// Your ANTHROPIC_API_KEY is stored in Netlify environment variables, never exposed to the browser

export default async (req) => {
  // Only allow POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "API key not configured on server" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const query = body.query;

    if (!query || typeof query !== "string" || query.length > 200) {
      return new Response(
        JSON.stringify({ error: "Invalid search query" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const systemPrompt = `You are a marketplace research assistant. Search for current Bratz doll listings available for purchase RIGHT NOW on eBay, Mercari, Poshmark, and other resale platforms.

For EACH listing, output it in this EXACT format on its own block:

**[Exact listing title as shown on the site]** - $[price] on [Platform]
- Condition: [condition]
- Shipping: $[amount] or Free
- URL: [full URL]

RULES:
- Only REAL, currently active listings
- Exact prices in USD
- Platform name (eBay, Mercari, Poshmark, Depop)
- Include URLs when available
- Find 10-20 listings across platforms and price ranges
- Include individual dolls AND lots/bundles
- Note rare items (Tokyo A Go-Go, Genie Magic, first editions, NRFB, etc.)`;

    const userPrompt = `Search for currently available "${query}" listings on eBay, Mercari, Poshmark and other resale sites. I need REAL active listings with exact prices and titles I can actually buy right now. Find 10-20 results across platforms. Focus on good deals and rare finds.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        system: systemPrompt,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      return new Response(
        JSON.stringify({
          error: `Anthropic API error: ${response.status}`,
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();

    // Extract just the text content to send back
    const textContent = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    return new Response(
      JSON.stringify({ text: textContent }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Function error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config = {
  path: "/api/search",
};
