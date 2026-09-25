// gather-rtc – the browser's door to Cloudflare Realtime and to shared files.
//
// Everything here needs secrets that must not sit in the page:
//   GET  /ice                                   short-lived TURN credentials
//   POST /sessions/new                          }
//   POST /sessions/{id}/tracks/new              }  forwarded to the Cloudflare
//   PUT  /sessions/{id}/tracks/update           }  Realtime SFU session API
//   PUT  /sessions/{id}/tracks/close            }
//   PUT  /sessions/{id}/renegotiate             }
//   POST /files/upload                          signed upload URL for a file in a room
//   GET  /files?room=                           a room's files from the last 24 hours
//   GET  /files/link?room=&path=                short-lived download link
//
// Files live in the private Storage bucket gather-files (created on first use),
// as <room>/<epochMs>.<rand>.<senderHex>.x<nameHex>, and are deleted after 24 hours.
//
// Secrets (set with `npx.cmd supabase secrets set NAME="value"`):
//   CF_SFU_APP_ID, CF_SFU_APP_SECRET   Realtime → SFU → your application
//   CF_TURN_KEY_ID, CF_TURN_API_TOKEN  Realtime → TURN → your key (optional)
//   GATHER_PASSWORD                    the site password
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

// ---- Files shared in a call (Supabase Storage, private bucket) ----
const SUPA_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BUCKET = "gather-files";
const MAX_BYTES = 50 * 1024 * 1024; // Supabase free plan's per-file limit
const KEEP_MS = 24 * 60 * 60 * 1000;
const ROOM_RE = /^[a-z0-9-]{1,40}$/;
const KEY_RE = /^(\d{13})\.([a-z0-9]{6})\.([0-9a-f]{0,240})\.(.+)$/;

type FileRow = { path: string; name: string; from: string; at: number; size: number; type: string };

function storage(path: string, init: RequestInit = {}) {
  return fetch(`${SUPA_URL}/storage/v1${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", ...(init.headers || {}) },
  });
}
const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
const toHex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
function fromHex(h: string) {
  try { return new TextDecoder().decode(new Uint8Array((h.match(/../g) || []).map((b) => parseInt(b, 16)))); }
  catch { return ""; }
}
// Storage keys allow a limited character set, so names are stored hex-encoded
// with an "x" marker and come back exactly as sent (accents, dashes, emoji).
function trimName(n: string) {
  const clean = n.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim() || "file";
  const chars = [...clean];
  return chars.length > 80 ? chars.slice(0, 60).join("") + "…" + chars.slice(-19).join("") : clean;
}
const encodeName = (n: string) => "x" + toHex(n);
const decodeName = (s: string) => (/^x(?:[0-9a-f]{2})+$/.test(s) ? fromHex(s.slice(1)) : s) || "file";

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const r = await storage("/bucket", { method: "POST", body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: MAX_BYTES }) });
  if (!r.ok) {
    const t = await r.text();
    if (r.status !== 409 && !/already exists|duplicate/i.test(t)) throw new Error("bucket: " + r.status + " " + t.slice(0, 200));
  }
  bucketReady = true;
}

async function listPrefix(prefix: string) {
  const r = await storage(`/object/list/${BUCKET}`, {
    method: "POST",
    body: JSON.stringify({ prefix, limit: 200, offset: 0, sortBy: { column: "name", order: "desc" } }),
  });
  if (!r.ok) throw new Error("list: " + r.status + " " + (await r.text()).slice(0, 200));
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

async function removeKeys(keys: string[]) {
  if (!keys.length) return;
  await storage(`/object/${BUCKET}`, { method: "DELETE", body: JSON.stringify({ prefixes: keys }) }).catch(() => {});
}

// A room's files from the last day, newest first; older ones are deleted on the way.
async function freshFiles(room: string): Promise<FileRow[]> {
  const now = Date.now();
  const keep: FileRow[] = [];
  const old: string[] = [];
  for (const o of await listPrefix(room + "/")) {
    if (!o || !o.id) continue; // folders have no id
    const m = KEY_RE.exec(o.name);
    if (!m) continue;
    const at = Number(m[1]);
    if (now - at > KEEP_MS) { old.push(`${room}/${o.name}`); continue; }
    keep.push({
      path: `${room}/${o.name}`, name: decodeName(m[4]), from: fromHex(m[3]) || "Someone", at,
      size: (o.metadata && o.metadata.size) || 0, type: (o.metadata && o.metadata.mimetype) || "",
    });
  }
  await removeKeys(old);
  return keep;
}

// Rooms nobody reopens would keep their files forever, so now and then sweep them all.
let lastSweep = 0;
async function sweepAll() {
  if (Date.now() - lastSweep < 60 * 60 * 1000) return;
  lastSweep = Date.now();
  const rooms = (await listPrefix("")).filter((o) => o && !o.id && ROOM_RE.test(o.name)).map((o) => o.name);
  for (const room of rooms) await freshFiles(room).catch(() => {});
}

async function handleFiles(path: string, req: Request, url: URL, headers: Record<string, string>): Promise<Response | null> {
  if (!SUPA_URL || !SERVICE_KEY) return json({ errorCode: "not_configured", errorDescription: "Storage is not available" }, 503, headers);
  await ensureBucket();

  if (path === "/files/upload" && req.method === "POST") {
    const b = await req.json().catch(() => ({} as Record<string, unknown>));
    const room = String(b.room || "");
    const size = Number(b.size || 0);
    if (!ROOM_RE.test(room)) return json({ errorCode: "bad_room", errorDescription: "Bad room" }, 400, headers);
    if (!(size > 0)) return json({ errorCode: "empty", errorDescription: "That file is empty" }, 400, headers);
    if (size > MAX_BYTES) return json({ errorCode: "too_large", errorDescription: "Files can be up to 50 MB" }, 413, headers);
    const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
    const name = trimName(String(b.name || "file"));
    const key = `${room}/${Date.now()}.${rand}.${toHex([...String(b.from || "")].slice(0, 30).join("")).slice(0, 240)}.${encodeName(name)}`;
    const r = await storage(`/object/upload/sign/${BUCKET}/${enc(key)}`, { method: "POST", body: "{}" });
    if (!r.ok) return json({ errorCode: "sign_failed", errorDescription: (await r.text()).slice(0, 200) }, 502, headers);
    const d = await r.json();
    // Storage hands back the path unencoded (spaces and all); rebuild it encoded.
    const token = new URL(`${SUPA_URL}/storage/v1${d.url}`).searchParams.get("token") || d.token || "";
    sweepAll().catch(() => {});
    return json({ path: key, name, uploadUrl: `${SUPA_URL}/storage/v1/object/upload/sign/${BUCKET}/${enc(key)}?token=${encodeURIComponent(token)}` }, 200, headers);
  }

  if (path === "/files" && req.method === "GET") {
    const room = url.searchParams.get("room") || "";
    if (!ROOM_RE.test(room)) return json({ errorCode: "bad_room", errorDescription: "Bad room" }, 400, headers);
    return json({ files: await freshFiles(room) }, 200, headers);
  }

  if (path === "/files/link" && req.method === "GET") {
    const room = url.searchParams.get("room") || "";
    const key = url.searchParams.get("path") || "";
    if (!ROOM_RE.test(room) || !key.startsWith(room + "/") || key.includes("..")) {
      return json({ errorCode: "bad_path", errorDescription: "Bad file" }, 400, headers);
    }
    const m = KEY_RE.exec(key.slice(room.length + 1));
    if (!m || Date.now() - Number(m[1]) > KEEP_MS) return json({ errorCode: "gone", errorDescription: "That file has expired" }, 410, headers);
    const r = await storage(`/object/sign/${BUCKET}/${enc(key)}`, { method: "POST", body: JSON.stringify({ expiresIn: 3600 }) });
    if (!r.ok) return json({ errorCode: "gone", errorDescription: "That file is no longer available" }, 410, headers);
    const d = await r.json();
    const token = new URL(`${SUPA_URL}/storage/v1${d.signedURL || d.signedUrl}`).searchParams.get("token") || "";
    return json({ url: `${SUPA_URL}/storage/v1/object/sign/${BUCKET}/${enc(key)}?token=${encodeURIComponent(token)}&download=${encodeURIComponent(decodeName(m[4]))}` }, 200, headers);
  }
  return null;
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
    if (path === "/files" || path.startsWith("/files/")) {
      const res = await handleFiles(path, req, url, headers);
      if (res) return res;
      return json({ errorCode: "not_found", errorDescription: "No such route" }, 404, headers);
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
