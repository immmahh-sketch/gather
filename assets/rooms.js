/* Gather – room passwords (home page, owner side).
 *
 * The owner can give any call room its own password, so an outsider can be let
 * into just that room's call without the main site password. Only the password's
 * SHA-256 is stored on the server; the plain one is kept in this browser so the
 * owner can copy it again from this device.
 */
(() => {
  'use strict';
  const cfg = window.GATHER_CONFIG || {};
  const RTC = cfg.RTC_ENDPOINT || '';
  const $ = s => document.querySelector(s);
  const el = {
    section: $('#roomPw'), name: $('#rpName'), pass: $('#rpPass'), save: $('#rpSave'),
    share: $('#rpShare'), status: $('#rpStatus'), list: $('#rpList'), empty: $('#rpEmpty'), toast: $('#toast')
  };
  if (!el.section) return;
  const slug = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const base = location.origin + location.pathname.replace(/index\.html$/, '');
  const linkFor = room => base + '?room=' + encodeURIComponent(room);
  const title = s => s.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

  let toastT = null;
  const toast = m => { if (!el.toast) return; el.toast.textContent = m; el.toast.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.toast.classList.remove('show'), 2600); };

  async function api(path, method, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    let r;
    try {
      r = await fetch(RTC + path, {
        method,
        headers: { 'content-type': 'application/json', apikey: cfg.SUPABASE_KEY || '', 'x-gather-key': window.GATHER_KEY || '' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal
      });
    } catch (e) { throw new Error(e && e.name === 'AbortError' ? 'The server took too long' : 'No connection'); }
    finally { clearTimeout(timer); }
    let d = null; try { d = await r.json(); } catch {}
    if (!r.ok || !d || d.errorCode) throw new Error((d && d.errorDescription) || ('Something went wrong (' + r.status + ')'));
    return d;
  }

  // Plain room passwords, remembered on this device only.
  const vault = {
    all() { try { return JSON.parse(localStorage.getItem('gather.roompw') || '{}'); } catch { return {}; } },
    set(room, pw) { const v = this.all(); if (pw) v[room] = pw; else delete v[room]; try { localStorage.setItem('gather.roompw', JSON.stringify(v)); } catch {} },
    get(room) { return this.all()[room] || ''; }
  };

  async function copy(text, note) { if (window.GatherUI) return GatherUI.copy(text, note, toast); try { await navigator.clipboard.writeText(text); toast(note || 'Copied'); } catch {} }

  function showShare(room, pw) {
    const url = linkFor(room);
    el.share.classList.remove('hidden');
    el.share.innerHTML = '<span>Send them:</span> <code class="s-url"></code>' + (pw ? ' <span>Password</span> <code class="s-pw"></code>' : '') +
      ' <button class="btn s-copy" type="button">Copy link &amp; password</button>';
    el.share.querySelector('.s-url').textContent = url.replace(/^https?:\/\//, '');
    if (pw) el.share.querySelector('.s-pw').textContent = pw;
    el.share.querySelector('.s-copy').addEventListener('click', () => copy(url + (pw ? '\nPassword: ' + pw : ''), 'Copied'));
  }

  async function save() {
    const room = slug(el.name.value);
    if (!room) { el.status.textContent = 'Type a room name first.'; return; }
    const pw = el.pass.value.trim();
    el.save.disabled = true; el.status.textContent = pw ? 'Saving…' : 'Removing…';
    try {
      const d = await api('/room/pass', 'POST', { room, password: pw });
      vault.set(room, pw);
      el.status.textContent = d.has ? '✓ ' + title(room) + ' now has a password.' : '✓ Password removed from ' + title(room) + '.';
      if (d.has) showShare(room, pw); else el.share.classList.add('hidden');
      el.pass.value = '';
      await load();
    } catch (e) { el.status.textContent = 'Could not save: ' + e.message; }
    finally { el.save.disabled = false; }
  }

  function roomRow(room) {
    const li = document.createElement('li');
    li.className = 'rp-roomrow';
    const pw = vault.get(room);
    li.innerHTML = '<span class="rp-name"></span><button class="btn rp-copy" type="button">Copy link</button><button class="textbtn rp-del" type="button">Remove</button>';
    li.querySelector('.rp-name').textContent = title(room) + (pw ? '' : '  ·  password set on another device');
    li.querySelector('.rp-copy').addEventListener('click', () => copy(linkFor(room) + (pw ? '\nPassword: ' + pw : ''), 'Copied'));
    li.querySelector('.rp-del').addEventListener('click', async () => {
      if (!confirm('Remove the password from ' + title(room) + '? Anyone using it to join will be stopped. Family still get in with the site password.')) return;
      try { await api('/room/pass', 'POST', { room, password: '' }); vault.set(room, ''); li.remove(); refreshEmpty(); toast('Password removed'); }
      catch (e) { toast('Could not remove: ' + e.message); }
    });
    return li;
  }
  function refreshEmpty() { el.empty.classList.toggle('hidden', !!el.list.children.length); }

  async function load() {
    try {
      const { rooms } = await api('/room/list', 'GET');
      el.list.innerHTML = '';
      for (const r of rooms) el.list.appendChild(roomRow(r));
      refreshEmpty();
    } catch {}
  }

  el.save.addEventListener('click', save);
  el.pass.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });

  (window.GATHER_READY || Promise.resolve()).then(() => {
    if (!crypto.subtle) return;
    // The confirm/dialog needs the site password; a room-only guest never sees this page.
    if (window.GATHER_ROOM_ONLY || window.GATHER_PASS_ONLY) return;
    el.section.classList.remove('hidden');
    try { const perm = localStorage.getItem('gather.room'); if (perm && !el.name.value) el.name.value = perm; } catch {}
    load();
  });
})();
