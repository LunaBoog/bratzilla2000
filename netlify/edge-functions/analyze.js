// Bratzilla 2000 — Claude rarity & insight analyzer (v3.2)
// Runs after eBay search to add collector context + sales recommendations
// Uses Claude Haiku 4.5 for speed (~$0.002 per scan)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function env(key) {
  try { if (typeof Netlify !== "undefined" && Netlify.env?.get) return Netlify.env.get(key); } catch (_) {}
  try { if (typeof Deno !== "undefined" && Deno.env?.get) return Deno.env.get(key); } catch (_) {}
  try { if (typeof process !== "undefined" && process.env) return process.env[key]; } catch (_) {}
  return null;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const apiKey = env("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured", ratings: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  try {
    const { listings } = await req.json();
    if (!Array.isArray(listings) || listings.length === 0 || listings.length > 25) {
      return new Response(JSON.stringify({ error: "Send 1-25 listings", ratings: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    // Include price + condition so Claude can flag over/underpriced items
    const numbered = listings
      .map((l, i) => `${i}: "${l.title}" — $${l.price} (${l.condition || "Used"})`)
      .join("\n");

    const prompt = `You are an expert Bratz doll collector and reseller advising a flipper. For each listing below, score rarity and give a short actionable note.

RARITY SCALE (1-10):
10 = prototype, pre-production samples, ultra-rare variants
9 = Tokyo A Go-Go, Genie Magic, first-wave 2001 NRFB, con exclusives
8 = Rock Angelz NRFB, Princess NRFB, Twiins NRFB, Treasures NRFB, Wintertime Wonderland NRFB
7 = Forever Diamondz NRFB, Wild Wild West NRFB, Passion 4 Fashion NRFB, complete 2002-2005 vintage
6 = Formal Funk, Slumber Party, standard line NRFB, Babyz NRFB
5 = 2001-2005 loose complete with accessories
4 = 2006+ loose complete, or standard loose
3 = used played-with, nude dolls, partial accessories
2 = damaged, missing major parts
1 = for parts / severely damaged

FLAGS to use in "flag" field (pick ONE most-relevant or leave empty):
- "HOT" = actively hot right now, expect price to rise
- "UNDERPRICED" = asking price looks below market for this item
- "OVERPRICED" = asking price looks above typical market
- "FAKE_RISK" = common knockoff / reproduction territory
- "INCOMPLETE" = title suggests missing accessories
- "" = no special flag

Return ONLY valid JSON (no markdown, no prose), array:
[{"i":0,"score":8,"label":"Rock Angelz Cloe NRFB","flag":"HOT","note":"2005 first release — market rising"}]

Keep "label" under 30 chars (the specific line/character). Keep "note" under 15 words and actionable.
For generic/uncertain items, still return an entry with best-guess score and empty label/flag/note.

LISTINGS:
${numbered}`;

    // Hard timeout — if Anthropic is slow, give up at 12s and let the user keep their results
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);

    let resp;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2500,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") {
        return new Response(JSON.stringify({ error: "Analysis timed out", ratings: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS },
        });
      }
      throw e;
    }
    clearTimeout(timer);

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Anthropic error:", resp.status, text.slice(0, 200));
      return new Response(
        JSON.stringify({ error: `Analysis failed (${resp.status})`, ratings: [] }),
        { status: 200, headers: { "Content-Type": "application/json", ...CORS } }
      );
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || "[]";
    const clean = text.replace(/```json|```/g, "").trim();

    let ratings = [];
    try {
      ratings = JSON.parse(clean);
    } catch (e) {
      const match = clean.match(/\[[\s\S]*\]/);
      if (match) {
        try { ratings = JSON.parse(match[0]); } catch (e2) { ratings = []; }
      }
    }

    return new Response(JSON.stringify({ ratings }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  } catch (err) {
    console.error("Analyze error:", err);
    return new Response(JSON.stringify({ error: err.message, ratings: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
};

export const config = { path: "/api/analyze" };
