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
//   GET  /people                                everyone who has picked a name
//   POST /people                                pick a name (claims it, or finds it)
//   DELETE /people                              remove a name
//   POST /inbox/upload                          signed upload URL for a file to a person
//   GET  /inbox?me=                             files sent to me in the last 7 days
//   GET  /inbox/link?me=&path=                  short-lived download link
//   GET  /upload/limits                         biggest file allowed right now
//   POST /upload/complete, /upload/abort        finish or cancel a multipart upload to R2
//
// Big files (up to 20 GB) go to Cloudflare R2 once R2_ACCOUNT_ID, R2_ACCESS_KEY_ID
// and R2_SECRET_ACCESS_KEY are set (and optionally R2_BUCKET, default gather-files).
// Without them, files use Supabase Storage and are limited to 50 MB.
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
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
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
  // Capped so one sweep stays light; the rest are picked up on later sweeps or
  // whenever someone opens that room or inbox.
  const rooms = (await listPrefix("")).filter((o) => o && !o.id && ROOM_RE.test(o.name)).map((o) => o.name);
  for (const room of rooms.slice(0, 25)) await freshFiles(room).catch(() => {});
  const inboxes = (await listPrefix("_inbox/").catch(() => [])).filter((o) => o && !o.id && /^[0-9a-f]+$/.test(o.name)).map((o) => o.name);
  for (const key of inboxes.slice(0, 25)) await freshInbox(key).catch(() => {});
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
    const limit = R2_ON ? R2_MAX_BYTES : MAX_BYTES;
    if (size > limit) return json({ errorCode: "too_large", errorDescription: "Files can be up to " + (R2_ON ? "20 GB" : "50 MB") }, 413, headers);
    const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
    const name = trimName(String(b.name || "file"));
    const leaf = `${Date.now()}.${rand}.${toHex([...String(b.from || "")].slice(0, 30).join("")).slice(0, 240)}.${encodeName(name)}`;
    if (R2_ON) return json({ ...(await r2Start(`rooms/${room}/${leaf}`, size, String(b.type || ""))), path: `rooms/${room}/${leaf}`, name }, 200, headers);
    const key = `${room}/${leaf}`;
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
    return json({ files: R2_ON ? await r2List(`rooms/${room}/`, KEEP_MS) : await freshFiles(room) }, 200, headers);
  }

  if (path === "/files/link" && req.method === "GET") {
    const room = url.searchParams.get("room") || "";
    const key = url.searchParams.get("path") || "";
    const inR2 = key.startsWith(`rooms/${room}/`);
    if (!ROOM_RE.test(room) || !(inR2 || key.startsWith(room + "/")) || key.includes("..")) {
      return json({ errorCode: "bad_path", errorDescription: "Bad file" }, 400, headers);
    }
    const m = KEY_RE.exec(key.slice(key.lastIndexOf("/") + 1));
    if (!m || Date.now() - Number(m[1]) > KEEP_MS) return json({ errorCode: "gone", errorDescription: "That file has expired" }, 410, headers);
    if (inR2) return json({ url: await r2Link(key, decodeName(m[4])) }, 200, headers);
    const r = await storage(`/object/sign/${BUCKET}/${enc(key)}`, { method: "POST", body: JSON.stringify({ expiresIn: 3600 }) });
    if (!r.ok) return json({ errorCode: "gone", errorDescription: "That file is no longer available" }, 410, headers);
    const d = await r.json();
    const token = new URL(`${SUPA_URL}/storage/v1${d.signedURL || d.signedUrl}`).searchParams.get("token") || "";
    return json({ url: `${SUPA_URL}/storage/v1/object/sign/${BUCKET}/${enc(key)}?token=${encodeURIComponent(token)}&download=${encodeURIComponent(decodeName(m[4]))}` }, 200, headers);
  }
  return null;
}

// ---- People and direct files (sent to a person, not a room) ----
// A person is just a name, stored as an empty object _people/<key>.x<displayHex>,
// where <key> is the hex of the lower-cased name, so "Alex" and "alex" are one
// person and listing the folder gives everyone without reading any files.
// Direct files live under _inbox/<key>/ and are kept for 7 days.
const PEOPLE = "_people";
const INBOX = "_inbox";
const INBOX_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const PERSON_RE = /^([0-9a-f]{2,240})\.x((?:[0-9a-f]{2}){1,240})$/;

function cleanPersonName(n: string) {
  const s = String(n || "").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return [...s].slice(0, 30).join("");
}
const personKey = (name: string) => toHex(cleanPersonName(name).toLowerCase());

async function listPeople() {
  const seen = new Map<string, string>();
  for (const o of await listPrefix(PEOPLE + "/")) {
    if (!o || !o.id) continue;
    const m = PERSON_RE.exec(o.name);
    if (m && !seen.has(m[1])) seen.set(m[1], fromHex(m[2]));
  }
  return seen; // key -> display name
}

async function putEmpty(key: string) {
  const r = await storage(`/object/${BUCKET}/${enc(key)}`, { method: "POST", body: "1", headers: { "content-type": "text/plain", "x-upsert": "true" } });
  if (!r.ok) throw new Error("save: " + r.status + " " + (await r.text()).slice(0, 200));
}

// Files in one person's inbox from the last week, newest first; older ones are deleted.
async function freshInbox(key: string): Promise<FileRow[]> {
  const now = Date.now();
  const keep: FileRow[] = [];
  const old: string[] = [];
  for (const o of await listPrefix(`${INBOX}/${key}/`)) {
    if (!o || !o.id) continue;
    const m = KEY_RE.exec(o.name);
    if (!m) continue;
    const at = Number(m[1]);
    if (now - at > INBOX_KEEP_MS) { old.push(`${INBOX}/${key}/${o.name}`); continue; }
    keep.push({
      path: `${INBOX}/${key}/${o.name}`, name: decodeName(m[4]), from: fromHex(m[3]) || "Someone", at,
      size: (o.metadata && o.metadata.size) || 0, type: (o.metadata && o.metadata.mimetype) || "",
    });
  }
  await removeKeys(old);
  return keep;
}

async function handlePeople(path: string, req: Request, url: URL, headers: Record<string, string>): Promise<Response | null> {
  if (!SUPA_URL || !SERVICE_KEY) return json({ errorCode: "not_configured", errorDescription: "Storage is not available" }, 503, headers);
  await ensureBucket();

  if (path === "/people" && req.method === "GET") {
    const people = [...(await listPeople()).values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    return json({ people }, 200, headers);
  }

  // Claim a name. If it is already taken the existing spelling comes back with
  // created: false, and the page asks whether that is the same person.
  if (path === "/people" && req.method === "POST") {
    const b = await req.json().catch(() => ({} as Record<string, unknown>));
    const name = cleanPersonName(String(b.name || ""));
    if (!name) return json({ errorCode: "bad_name", errorDescription: "Please type your name" }, 400, headers);
    const key = personKey(name);
    const existing = (await listPeople()).get(key);
    if (existing) return json({ name: existing, created: false }, 200, headers);
    await putEmpty(`${PEOPLE}/${key}.x${toHex(name)}`);
    return json({ name, created: true }, 200, headers);
  }

  // Remove a name (a typo, or a test). Files already sent to it expire as normal.
  if (path === "/people" && req.method === "DELETE") {
    const b = await req.json().catch(() => ({} as Record<string, unknown>));
    const key = personKey(String(b.name || ""));
    const rows = (await listPrefix(PEOPLE + "/")).filter((o) => o && o.id && o.name.startsWith(key + ".x"));
    await removeKeys(rows.map((o) => `${PEOPLE}/${o.name}`));
    return json({ removed: rows.length }, 200, headers);
  }

  if (path === "/inbox/upload" && req.method === "POST") {
    const b = await req.json().catch(() => ({} as Record<string, unknown>));
    const size = Number(b.size || 0);
    const to = cleanPersonName(String(b.to || ""));
    const from = cleanPersonName(String(b.from || "")) || "Someone";
    if (!(size > 0)) return json({ errorCode: "empty", errorDescription: "That file is empty" }, 400, headers);
    if (size > (R2_ON ? R2_MAX_BYTES : MAX_BYTES)) return json({ errorCode: "too_large", errorDescription: "Files can be up to " + (R2_ON ? "20 GB" : "50 MB") }, 413, headers);
    const toKey = personKey(to);
    if (!to || !(await listPeople()).has(toKey)) return json({ errorCode: "no_person", errorDescription: "Nobody called " + to + " is on Gather" }, 404, headers);
    const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
    const name = trimName(String(b.name || "file"));
    const leaf = `${Date.now()}.${rand}.${toHex(from)}.${encodeName(name)}`;
    if (R2_ON) {
      const toName = (await listPeople()).get(toKey);
      return json({ ...(await r2Start(`inbox/${toKey}/${leaf}`, size, String(b.type || ""))), path: `inbox/${toKey}/${leaf}`, name, to: toName }, 200, headers);
    }
    const key = `${INBOX}/${toKey}/${leaf}`;
    const r = await storage(`/object/upload/sign/${BUCKET}/${enc(key)}`, { method: "POST", body: "{}" });
    if (!r.ok) return json({ errorCode: "sign_failed", errorDescription: (await r.text()).slice(0, 200) }, 502, headers);
    const d = await r.json();
    const token = new URL(`${SUPA_URL}/storage/v1${d.url}`).searchParams.get("token") || d.token || "";
    sweepAll().catch(() => {});
    return json({ path: key, name, to: (await listPeople()).get(toKey), uploadUrl: `${SUPA_URL}/storage/v1/object/upload/sign/${BUCKET}/${enc(key)}?token=${encodeURIComponent(token)}` }, 200, headers);
  }

  if (path === "/inbox" && req.method === "GET") {
    const me = cleanPersonName(url.searchParams.get("me") || "");
    if (!me) return json({ errorCode: "bad_name", errorDescription: "Who are you?" }, 400, headers);
    // While moving to R2, also show anything still waiting in the old storage.
    const key = personKey(me);
    const files = R2_ON ? [...(await r2List(`inbox/${key}/`, INBOX_KEEP_MS)), ...(await freshInbox(key).catch(() => []))].sort((a, b) => b.at - a.at) : await freshInbox(key);
    return json({ files }, 200, headers);
  }

  if (path === "/inbox/link" && req.method === "GET") {
    const me = cleanPersonName(url.searchParams.get("me") || "");
    const key = url.searchParams.get("path") || "";
    const r2prefix = `inbox/${personKey(me)}/`;
    const prefix = key.startsWith(r2prefix) ? r2prefix : `${INBOX}/${personKey(me)}/`;
    if (!me || !key.startsWith(prefix) || key.includes("..")) return json({ errorCode: "bad_path", errorDescription: "Bad file" }, 400, headers);
    const m = KEY_RE.exec(key.slice(prefix.length));
    if (!m || Date.now() - Number(m[1]) > INBOX_KEEP_MS) return json({ errorCode: "gone", errorDescription: "That file has expired" }, 410, headers);
    if (prefix === r2prefix) return json({ url: await r2Link(key, decodeName(m[4])) }, 200, headers);
    const r = await storage(`/object/sign/${BUCKET}/${enc(key)}`, { method: "POST", body: JSON.stringify({ expiresIn: 3600 }) });
    if (!r.ok) return json({ errorCode: "gone", errorDescription: "That file is no longer available" }, 410, headers);
    const d = await r.json();
    const token = new URL(`${SUPA_URL}/storage/v1${d.signedURL || d.signedUrl}`).searchParams.get("token") || "";
    return json({ url: `${SUPA_URL}/storage/v1/object/sign/${BUCKET}/${enc(key)}?token=${encodeURIComponent(token)}&download=${encodeURIComponent(decodeName(m[4]))}` }, 200, headers);
  }
  return null;
}

// ---- Cloudflare R2 for big files (S3-compatible, used once its keys are set) ----
// The browser uploads straight to R2 in parts, using links signed here, so files
// never pass through this function. Keys: rooms/<room>/<file> and inbox/<person>/<file>;
// R2 lifecycle rules delete rooms/ after a day and inbox/ after a week.
const R2_ACCOUNT = Deno.env.get("R2_ACCOUNT_ID") || "";
const R2_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") || "";
const R2_SECRET = Deno.env.get("R2_SECRET_ACCESS_KEY") || "";
const R2_BUCKET = Deno.env.get("R2_BUCKET") || "gather-files";
const R2_ON = !!(R2_ACCOUNT && R2_KEY_ID && R2_SECRET);
const R2_HOST = `${R2_ACCOUNT}.r2.cloudflarestorage.com`;
const R2_MAX_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB; R2 itself allows terabytes
const MAX_PARTS = 500;
const MIN_PART = 16 * 1024 * 1024;

const te = new TextEncoder();
const bytesHex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256hex(s: string) { return bytesHex(await crypto.subtle.digest("SHA-256", te.encode(s))); }
async function hmac(key: Uint8Array, msg: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(msg)));
}
// RFC 3986 encoding, the way S3 signatures expect it.
const s3enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// A pre-signed URL (AWS Signature V4, query-string form) for one R2 request.
async function r2url(method: string, key: string, query: Record<string, string>, expires: number) {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const q: Record<string, string> = {
    ...query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${R2_KEY_ID}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(q).sort().map((k) => `${s3enc(k)}=${s3enc(q[k])}`).join("&");
  const path = "/" + R2_BUCKET + (key ? "/" + key.split("/").map(s3enc).join("/") : "");
  const canonical = [method, path, canonicalQuery, `host:${R2_HOST}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256hex(canonical)].join("\n");
  let k = await hmac(te.encode("AWS4" + R2_SECRET), day);
  k = await hmac(k, "auto");
  k = await hmac(k, "s3");
  k = await hmac(k, "aws4_request");
  return `https://${R2_HOST}${path}?${canonicalQuery}&X-Amz-Signature=${bytesHex(await hmac(k, toSign))}`;
}
const xmlTag = (xml: string, tag: string) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml); return m ? m[1] : ""; };
const xmlText = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Proof that an upload id was handed out by us, so only our own uploads can be finished or cancelled.
async function uploadTicket(key: string, uploadId: string) {
  return bytesHex(await hmac(te.encode("gather-upload:" + (GATHER_PASSWORD || R2_SECRET)), key + "|" + uploadId));
}

async function r2Start(key: string, size: number, type: string) {
  const r = await fetch(await r2url("POST", key, { uploads: "" }, 300), { method: "POST", headers: type ? { "content-type": type } : {} });
  const body = await r.text();
  if (!r.ok) throw new Error("R2 would not start the upload: " + r.status + " " + body.slice(0, 200));
  const uploadId = xmlText(xmlTag(body, "UploadId"));
  const partSize = Math.max(MIN_PART, Math.ceil(size / MAX_PARTS / (1024 * 1024)) * 1024 * 1024);
  const count = Math.max(1, Math.ceil(size / partSize));
  const urls: string[] = [];
  for (let i = 1; i <= count; i++) urls.push(await r2url("PUT", key, { partNumber: String(i), uploadId }, 12 * 3600));
  return { mode: "multipart", key, uploadId, partSize, urls, ticket: await uploadTicket(key, uploadId) };
}

async function r2List(prefix: string, keepMs: number): Promise<FileRow[]> {
  const r = await fetch(await r2url("GET", "", { "list-type": "2", prefix, "max-keys": "1000" }, 300));
  const body = await r.text();
  if (!r.ok) throw new Error("R2 list: " + r.status + " " + body.slice(0, 200));
  const now = Date.now();
  const rows: FileRow[] = [];
  for (const block of body.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
    const key = xmlText(xmlTag(block, "Key"));
    const m = KEY_RE.exec(key.slice(prefix.length));
    if (!m || now - Number(m[1]) > keepMs) continue; // R2's lifecycle rule deletes these
    rows.push({ path: key, name: decodeName(m[4]), from: fromHex(m[3]) || "Someone", at: Number(m[1]), size: Number(xmlTag(block, "Size")) || 0, type: "" });
  }
  return rows.sort((a, b) => b.at - a.at);
}

async function r2Link(key: string, name: string) {
  return await r2url("GET", key, { "response-content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }, 3600);
}

async function handleUpload(path: string, req: Request, headers: Record<string, string>): Promise<Response | null> {
  if (path === "/upload/limits" && req.method === "GET") {
    return json({ maxBytes: R2_ON ? R2_MAX_BYTES : MAX_BYTES, big: R2_ON }, 200, headers);
  }
  if (!R2_ON) return json({ errorCode: "not_configured", errorDescription: "Big files are not set up" }, 503, headers);
  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  const key = String(b.key || ""), uploadId = String(b.uploadId || "");
  if (!/^(rooms|inbox)\//.test(key) || !uploadId || String(b.ticket || "") !== await uploadTicket(key, uploadId)) {
    return json({ errorCode: "bad_upload", errorDescription: "Unknown upload" }, 400, headers);
  }
  if (path === "/upload/complete" && req.method === "POST") {
    const parts = (Array.isArray(b.parts) ? b.parts : []) as { n: number; etag: string }[];
    if (!parts.length) return json({ errorCode: "bad_upload", errorDescription: "No parts" }, 400, headers);
    const xml = "<CompleteMultipartUpload>" + parts.slice().sort((x, y) => x.n - y.n)
      .map((p) => `<Part><PartNumber>${Number(p.n)}</PartNumber><ETag>${String(p.etag).replace(/[<>&]/g, "")}</ETag></Part>`).join("") + "</CompleteMultipartUpload>";
    const r = await fetch(await r2url("POST", key, { uploadId }, 300), { method: "POST", body: xml, headers: { "content-type": "application/xml" } });
    const body = await r.text();
    if (!r.ok || body.includes("<Error>")) return json({ errorCode: "complete_failed", errorDescription: "The file did not finish uploading: " + (xmlTag(body, "Message") || r.status) }, 502, headers);
    return json({ ok: true, path: key }, 200, headers);
  }
  if (path === "/upload/abort" && req.method === "POST") {
    await fetch(await r2url("DELETE", key, { uploadId }, 300), { method: "DELETE" }).catch(() => {});
    return json({ ok: true }, 200, headers);
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
    if (path.startsWith("/upload/")) {
      const res = await handleUpload(path, req, headers);
      if (res) return res;
      return json({ errorCode: "not_found", errorDescription: "No such route" }, 404, headers);
    }
    if (path === "/people" || path === "/inbox" || path.startsWith("/inbox/")) {
      const res = await handlePeople(path, req, url, headers);
      if (res) return res;
      return json({ errorCode: "not_found", errorDescription: "No such route" }, 404, headers);
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
