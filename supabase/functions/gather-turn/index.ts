// gather-turn – hands the browser short-lived TURN credentials from Cloudflare.
//
// Cloudflare's TURN service is free for the first 1,000 GB a month. Its API token
// must stay secret, so the browser asks this function, and this function asks
// Cloudflare. Deploy with:
//   npx.cmd supabase secrets set CF_TURN_KEY_ID="<key id>" CF_TURN_API_TOKEN="<api token>"
//   npx.cmd supabase functions deploy gather-turn --no-verify-jwt
//
// Without the secrets it returns an empty list and the app carries on with STUN only.

const KEY_ID = Deno.env.get("CF_TURN_KEY_ID") || "";
const API_TOKEN = Deno.env.get("CF_TURN_API_TOKEN") || "";
const TTL_SECONDS = 6 * 60 * 60; // credentials last six hours; a call rarely runs longer

const ALLOWED_ORIGINS = [
  "https://immmahh-sketch.github.io",
  "http://localhost:8765",
];

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "vary": "origin",
  };
}

let cache: { servers: unknown[]; expires: number } | null = null;

async function fetchIceServers(): Promise<unknown[]> {
  if (!KEY_ID || !API_TOKEN) return [];
  if (cache && cache.expires > Date.now()) return cache.servers;
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl: TTL_SECONDS }),
  });
  if (!r.ok) {
    console.error("cloudflare turn", r.status, await r.text());
    return [];
  }
  const data = await r.json();
  const servers = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
  // Hand out the same credentials for most of their life, then mint fresh ones.
  cache = { servers, expires: Date.now() + (TTL_SECONDS - 30 * 60) * 1000 };
  return servers;
}

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "content-type": "application/json", "cache-control": "no-store" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  try {
    const iceServers = await fetchIceServers();
    return new Response(JSON.stringify({ iceServers }), { headers });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ iceServers: [] }), { headers });
  }
});
