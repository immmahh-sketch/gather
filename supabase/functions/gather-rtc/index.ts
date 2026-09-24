// gather-rtc – the browser's door to Cloudflare Realtime.
//
// Two jobs, both needing secrets that must not sit in the page:
//   GET  /ice                                   short-lived TURN credentials
//   POST /sessions/new                          }
//   POST /sessions/{id}/tracks/new              }  forwarded to the Cloudflare
//   PUT  /sessions/{id}/tracks/update           }  Realtime SFU session API
//   PUT  /sessions/{id}/tracks/close            }
//   PUT  /sessions/{id}/renegotiate             }
//
// Secrets (set with `npx.cmd supabase secrets set NAME="value"`):
//   CF_SFU_APP_ID, CF_SFU_APP_SECRET   Realtime → SFU → your application
//   CF_TURN_KEY_ID, CF_TURN_API_TOKEN  Realtime → TURN → your key (optional)
// Deploy with `npx.cmd supabase functions deploy gather-rtc --no-verify-jwt`.

const SFU_APP_ID = Deno.env.get("CF_SFU_APP_ID") || "";
const SFU_APP_SECRET = Deno.env.get("CF_SFU_APP_SECRET") || "";
const TURN_KEY_ID = Deno.env.get("CF_TURN_KEY_ID") || "";
const TURN_API_TOKEN = Deno.env.get("CF_TURN_API_TOKEN") || "";
const TURN_TTL_SECONDS = 6 * 60 * 60;
// Site password. The pages ask for it once per device and send it with every call.
const GATHER_PASSWORD = Deno.env.get("GATHER_PASSWORD") || "";

const CF = "https://rtc.live.cloudflare.com/v1";
const ALLOWED_ORIGINS = [
  "https://gathercall.uk",
  "https://www.gathercall.uk",
  "https://immmahh-sketch.github.io",
  "http://localhost:8765",
];

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "authorization, apikey, content-type, x-gather-key",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "vary": "origin",
    "cache-control": "no-store",
  };
}
function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json" } });
}

// ---- TURN credentials, reused for most of their life ----
let turnCache: { servers: unknown[]; expires: number } | null = null;
async function iceServers(): Promise<unknown[]> {
  if (!TURN_KEY_ID || !TURN_API_TOKEN) return [];
  if (turnCache && turnCache.expires > Date.now()) return turnCache.servers;
  const r = await fetch(`${CF}/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { authorization: `Bearer ${TURN_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
  });
  if (!r.ok) { console.error("cloudflare turn", r.status, await r.text()); return []; }
  const data = await r.json();
  const servers = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
  turnCache = { servers, expires: Date.now() + (TURN_TTL_SECONDS - 30 * 60) * 1000 };
  return servers;
}

// ---- SFU session API, forwarded as-is ----
const SESSION_ROUTE = /^\/sessions\/([A-Za-z0-9_-]{1,128})\/(tracks\/new|tracks\/update|tracks\/close|renegotiate)$/;
const METHODS: Record<string, string> = { "tracks/new": "POST", "tracks/update": "PUT", "tracks/close": "PUT", "renegotiate": "PUT" };

async function forward(path: string, method: string, body: string) {
  const r = await fetch(`${CF}/apps/${SFU_APP_ID}${path}`, {
    method,
    headers: { authorization: `Bearer ${SFU_APP_SECRET}`, "content-type": "application/json" },
    body: body && (method === "POST" || method === "PUT") ? body : undefined,
  });
  const text = await r.text();
  return { status: r.status, text };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ errorCode: "forbidden", errorDescription: "Origin not allowed" }, 403, headers);

  if (GATHER_PASSWORD && req.headers.get("x-gather-key") !== GATHER_PASSWORD) {
    return json({ errorCode: "unauthorized", errorDescription: "Wrong or missing password" }, 401, headers);
  }

  const url = new URL(req.url);
  // The function name is the first path segment; everything after it is ours.
  const path = url.pathname.replace(/^.*?\/gather-rtc/, "") || "/";

  try {
    if (path === "/ice" && req.method === "GET") {
      return json({ iceServers: await iceServers() }, 200, headers);
    }
    if (!SFU_APP_ID || !SFU_APP_SECRET) {
      return json({ errorCode: "not_configured", errorDescription: "Cloudflare SFU secrets are not set" }, 503, headers);
    }
    if (path === "/sessions/new" && req.method === "POST") {
      const r = await forward("/sessions/new", "POST", ""); // Cloudflare wants no body here
      return new Response(r.text, { status: r.status, headers: { ...headers, "content-type": "application/json" } });
    }
    const m = SESSION_ROUTE.exec(path);
    if (m && req.method === METHODS[m[2]]) {
      const body = await req.text();
      if (body.length > 512 * 1024) return json({ errorCode: "too_large", errorDescription: "Request too large" }, 413, headers);
      const r = await forward(path, req.method, body);
      return new Response(r.text, { status: r.status, headers: { ...headers, "content-type": "application/json" } });
    }
    return json({ errorCode: "not_found", errorDescription: "No such route" }, 404, headers);
  } catch (e) {
    console.error(e);
    return json({ errorCode: "upstream", errorDescription: String(e) }, 502, headers);
  }
});
