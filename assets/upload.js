/* Gather – file uploads, shared by the call page and the home page.
 *
 * GatherUpload.send(plan, file, onProgress, api) takes the server's answer to
 * /files/upload or /inbox/upload and does the upload:
 *   - mode "multipart" (Cloudflare R2, big files): the file is cut into parts
 *     and sent straight to R2, four parts at a time, each part retried a few
 *     times if the connection drops; then the server stitches them together.
 *   - otherwise (Supabase Storage, up to 50 MB): one upload to a signed link.
 * The file never passes through our server either way.
 */
(() => {
  'use strict';
  const cfg = window.GATHER_CONFIG || {};
  let active = 0;

  // Leaving the page mid-upload would throw the upload away, so ask first.
  window.addEventListener('beforeunload', e => {
    if (!active) return;
    e.preventDefault();
    e.returnValue = '';
  });

  function put(url, body, headers, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      for (const [k, v] of Object.entries(headers || {})) x.setRequestHeader(k, v);
      x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded); };
      x.onload = () => x.status < 300 ? resolve(x) : reject(new Error('upload failed (' + x.status + ')'));
      x.onerror = () => reject(new Error('connection lost'));
      x.ontimeout = () => reject(new Error('timed out'));
      x.send(body);
    });
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));

  async function multipart(plan, file, onProgress, api) {
    const size = file.size;
    const count = plan.urls.length;
    const sent = new Array(count).fill(0); // bytes confirmed or in flight, per part
    const parts = [];
    const report = () => onProgress(Math.min(1, sent.reduce((a, b) => a + b, 0) / size));
    let next = 0, failed = null;

    async function sendPart(i) {
      const start = i * plan.partSize;
      const blob = file.slice(start, Math.min(size, start + plan.partSize));
      for (let attempt = 1; ; attempt++) {
        try {
          const x = await put(plan.urls[i], blob, {}, loaded => { sent[i] = loaded; report(); });
          const etag = x.getResponseHeader('ETag');
          if (!etag) throw new Error('storage did not confirm the part');
          sent[i] = blob.size; report();
          parts.push({ n: i + 1, etag });
          return;
        } catch (e) {
          sent[i] = 0; report();
          if (attempt >= 5) throw e;
          await wait(1000 * attempt * attempt); // 1s, 4s, 9s, 16s
        }
      }
    }
    async function worker() {
      while (!failed && next < count) {
        const i = next++;
        try { await sendPart(i); } catch (e) { failed = e; }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (failed) {
      api('/upload/abort', 'POST', { key: plan.key, uploadId: plan.uploadId, ticket: plan.ticket }).catch(() => {});
      throw failed;
    }
    await api('/upload/complete', 'POST', { key: plan.key, uploadId: plan.uploadId, ticket: plan.ticket, parts }, 60000);
  }

  function single(plan, file, onProgress) {
    const form = new FormData();
    form.append('cacheControl', '3600');
    form.append('', file, file.name);
    return put(plan.uploadUrl, form, { apikey: cfg.SUPABASE_KEY, 'x-upsert': 'false' }, loaded => onProgress(Math.min(1, loaded / file.size)));
  }

  async function send(plan, file, onProgress, api) {
    active++;
    try {
      if (plan.mode === 'multipart') await multipart(plan, file, onProgress, api);
      else await single(plan, file, onProgress);
      onProgress(1);
    } finally { active--; }
  }

  // How big a file can be right now (20 GB with R2, 50 MB without). Only a real
  // answer is remembered; after a blip (say, just after a password change) the
  // next call asks again instead of sticking at the fallback.
  let limits = null;
  async function maxBytes(api) {
    if (limits) return limits.maxBytes;
    try { limits = await api('/upload/limits', 'GET'); return limits.maxBytes; }
    catch { return 50 * 1024 * 1024; }
  }
  function sizeLabel(n) {
    return n >= 1024 * 1024 * 1024 ? Math.round(n / 1024 / 1024 / 1024) + ' GB' : Math.round(n / 1024 / 1024) + ' MB';
  }

  window.GatherUpload = { send, maxBytes, sizeLabel };
})();
