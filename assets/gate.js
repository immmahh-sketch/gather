/* Gather – password gate.
 * Every page loads this first. The password is asked for once per device and
 * kept in localStorage; the call server checks the same password on every
 * request, so the pages alone are not the lock.
 */
(() => {
  'use strict';
  const cfg = window.GATHER_CONFIG || {};
  // The quiz night page (join-only) has its own password, kept under its own
  // name so it never replaces the site password on a device that has both.
  // The site password opens the quiz page as well.
  const quiz = !!window.GATHER_JOIN;
  const KEY = quiz ? 'gather.quizkey' : 'gather.key';
  const HASHES = (quiz ? [cfg.QUIZ_PASSWORD_HASH, cfg.PASSWORD_HASH] : [cfg.PASSWORD_HASH]).filter(Boolean);
  const read = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const saved = () => read(KEY);
  window.GATHER_KEY = saved();
  // The quizmaster's call window, opened by Let's Quiz's host screen, brings its own call pass in the address
  // (#pass=qt.<expiry>.<signature>, signed with the quiz host password; gather-rtc quizPassOk). It opens calls only,
  // so that window needs no password and offers no files (GATHER_PASS_ONLY). Taken out of the address at once.
  // The pass is also kept for this tab only (sessionStorage), so a reload - Rejoin after leaving - still works; it dies with the tab.
  const PASS = (() => {
    const ok = v => /^qt\.\d{13}\.[0-9a-f]{64}$/.test(v) && +v.split('.')[1] > Date.now();
    try {
      const fromAddress = new URLSearchParams(location.hash.slice(1)).get('pass') || '';
      if (ok(fromAddress)) { try { sessionStorage.setItem('gather.pass', fromAddress); } catch {} return fromAddress; }
      const kept = sessionStorage.getItem('gather.pass') || '';
      return ok(kept) ? kept : '';
    } catch { return ''; }
  })();
  if (PASS) { window.GATHER_KEY = PASS; window.GATHER_PASS_ONLY = true; try { history.replaceState(null, '', location.pathname + location.search); } catch {} }

  async function sha256(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // The site password can be changed from the app, so the valid hash is not only
  // the one shipped in config.js. We remember the last one we saw and, when a
  // saved or typed password is not recognised, ask the server for the current
  // one (GET /auth/hash — the hash has always been public). Falls back to the
  // shipped hash if the server can't be reached.
  async function liveSiteHash() {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch((cfg.RTC_ENDPOINT || '') + '/auth/hash', { headers: { apikey: cfg.SUPABASE_KEY || '' }, signal: ctl.signal });
      clearTimeout(timer);
      const d = await r.json();
      if (d && /^[0-9a-f]{64}$/.test(d.hash || '')) { try { localStorage.setItem('gather.sitehash', d.hash); } catch {} return d.hash; }
    } catch {}
    return '';
  }
  function knownHashes() {
    const extra = read('gather.sitehash');
    return extra && !HASHES.includes(extra) ? HASHES.concat(extra) : HASHES.slice();
  }
  const matchesAny = async (value, hashes) => hashes.includes(await sha256(value));

  // A call for one room (call.html?room=R) may have its own password, so an
  // outsider can be let into just that room without the site password. We fetch
  // that room's password hash and accept it too; a room password is kept under
  // its own name and marks the person as room-only (no files, no other rooms).
  const ROOM = (!quiz && !PASS) ? String(new URLSearchParams(location.search).get('room') || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) : '';
  const roomKeyName = 'gather.roomkey.' + ROOM;
  let roomHashCache = null;
  async function roomHash() {
    if (!ROOM) return '';
    if (roomHashCache !== null) return roomHashCache;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch((cfg.RTC_ENDPOINT || '') + '/room/pass?room=' + encodeURIComponent(ROOM), { headers: { apikey: cfg.SUPABASE_KEY || '' }, signal: ctl.signal });
      clearTimeout(timer);
      const d = await r.json();
      roomHashCache = /^[0-9a-f]{64}$/.test(d && d.hash || '') ? d.hash : '';
      try { if (roomHashCache) localStorage.setItem('gather.roomhash.' + ROOM, roomHashCache); } catch {}
    } catch { roomHashCache = read('gather.roomhash.' + ROOM) || ''; }
    return roomHashCache;
  }

  const ready = new Promise(resolve => {
    const done = key => { window.GATHER_KEY = key; try { localStorage.setItem(KEY, key); } catch {} resolve(key); };
    const roomDone = key => { window.GATHER_KEY = key; window.GATHER_ROOM_ONLY = true; try { localStorage.setItem(roomKeyName, key); } catch {} document.body.classList.add('room-only'); resolve(key); };
    const start = async () => {
      if (PASS) return resolve(PASS);
      if (!HASHES.length || !crypto.subtle) return resolve(window.GATHER_KEY);
      // A link with the password in it (page#key=...) signs the person in: the part after # never goes to a server,
      // and it is taken out of the address at once. Only the quiz page's own password is accepted this way.
      const fromLink = quiz ? new URLSearchParams(location.hash.slice(1)).get('key') || '' : '';
      if (fromLink) {
        try { history.replaceState(null, '', location.pathname + location.search); } catch {}
        if (await matchesAny(fromLink, knownHashes())) return done(fromLink);
      }
      const candidates = quiz ? [saved(), read('gather.key')] : [saved()];
      // Fast path: a saved password we already recognise (no network needed).
      for (const have of candidates) {
        if (have && await matchesAny(have, knownHashes())) { liveSiteHash(); window.GATHER_KEY = have; return resolve(have); }
      }
      // A saved room password for this room's call page.
      const rh = await roomHash();
      if (rh) {
        const savedRoom = read(roomKeyName);
        if (savedRoom && await sha256(savedRoom) === rh) return roomDone(savedRoom);
      }
      // Not recognised — the site password may have been changed elsewhere. Ask
      // the server for the current hash and try once more before prompting.
      const live = await liveSiteHash();
      if (live) for (const have of candidates) {
        if (have && await sha256(have) === live) { window.GATHER_KEY = have; return resolve(have); }
      }
      showGate(done, roomDone, rh);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  });
  window.GATHER_READY = ready;

  function showGate(done, roomDone, roomHashValue) {
    const wrap = document.createElement('div');
    wrap.id = 'gate';
    const join = window.GATHER_JOIN || {};
    if (join.theme) wrap.classList.add(join.theme);
    wrap.innerHTML =
      '<form class="gate-card" autocomplete="off">' +
      (join.theme && join.logo
        ? '<img class="mark" src="' + join.logo + '" alt="">'
        : '<svg class="mark" viewBox="0 0 64 64"><defs><linearGradient id="gateg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e9e70"/><stop offset="1" stop-color="#0a6448"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#gateg)"/><g fill="#fff" stroke="url(#gateg)" stroke-width="6.4" paint-order="stroke"><circle cx="32" cy="25" r="11"/><circle cx="22" cy="42" r="11"/><circle cx="42" cy="42" r="11"/></g></svg>') +
      '<h1>' + (quiz ? (join.gateTitle || 'Quiz night') : 'Gather') + '</h1>' +
      '<p>' + (quiz ? 'Enter the quiz password you were given.' : 'This is a private site. Enter the password you were given.') + '</p>' +
      '<input type="password" id="gatePw" placeholder="Password" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">' +
      '<div class="gate-err" id="gateErr"></div>' +
      '<button type="submit" id="gateGo">Continue</button>' +
      '</form>';
    document.body.appendChild(wrap);
    document.body.classList.add('gated');
    const pw = wrap.querySelector('#gatePw'), err = wrap.querySelector('#gateErr'), go = wrap.querySelector('#gateGo');
    setTimeout(() => pw.focus(), 50);
    wrap.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const v = pw.value;
      if (!v) return;
      go.disabled = true;
      const hashes = knownHashes();
      const live = await liveSiteHash();
      if (live && !hashes.includes(live)) hashes.push(live);
      const vh = await sha256(v);
      const rh = roomHashValue || (roomDone ? await roomHash() : '');
      if (hashes.includes(vh)) {
        wrap.remove();
        document.body.classList.remove('gated');
        done(v);
      } else if (rh && vh === rh && roomDone) {
        wrap.remove();
        document.body.classList.remove('gated');
        roomDone(v);
      } else {
        err.textContent = 'That password is not right.';
        pw.select();
        go.disabled = false;
      }
    });
  }
})();
