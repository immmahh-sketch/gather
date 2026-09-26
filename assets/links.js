/* Gather – private file links (home page, owner side).
 *
 * The owner makes a one-off link with its own password for someone outside
 * Gather. Two kinds:
 *   in  – the other person sends the owner a file (they upload, owner collects)
 *   out – the owner leaves a file for the other person (owner uploads, they get it)
 *
 * Only the password's SHA-256 is stored on the server, so it can't be read back.
 * The plain password is kept in this browser's localStorage as a convenience so
 * the owner can copy it again from this device; it is never sent anywhere.
 */
(() => {
  'use strict';
  const cfg = window.GATHER_CONFIG || {};
  const RTC = cfg.RTC_ENDPOINT || '';
  const $ = s => document.querySelector(s);
  const el = {
    section: $('#shareLinks'), list: $('#linkList'), empty: $('#linksEmpty'),
    makeIn: $('#makeIn'), makeOut: $('#makeOut'), toast: $('#toast')
  };
  if (!el.section) return;
  const base = location.origin + location.pathname.replace(/index\.html$/, '');

  let toastT = null;
  function toast(m) { if (!el.toast) return; el.toast.textContent = m; el.toast.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.toast.classList.remove('show'), 2600); }

  async function api(path, method, body, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 20000);
    let r;
    try {
      r = await fetch(RTC + path, {
        method,
        headers: { 'content-type': 'application/json', apikey: cfg.SUPABASE_KEY, 'x-gather-key': window.GATHER_KEY || '' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal
      });
    } catch (e) { throw new Error(e && e.name === 'AbortError' ? 'The server took too long' : 'No connection'); }
    finally { clearTimeout(timer); }
    let data = null; try { data = await r.json(); } catch {}
    if (!r.ok || !data || data.errorCode) throw new Error((data && data.errorDescription) || ('Something went wrong (' + r.status + ')'));
    return data;
  }

  async function sha256hex(s) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  const rand = n => { const a = 'abcdefghijkmnpqrstuvwxyz23456789'; let s = ''; const r = crypto.getRandomValues(new Uint8Array(n)); for (let i = 0; i < n; i++) s += a[r[i] % a.length]; return s; };
  const A = ['sunny', 'cosy', 'happy', 'bright', 'merry', 'jolly', 'calm', 'lucky', 'gentle', 'breezy', 'golden', 'rosy', 'quiet', 'warm', 'clever', 'snug', 'brave', 'kind'];
  const B = ['otter', 'robin', 'maple', 'harbour', 'meadow', 'pebble', 'teapot', 'willow', 'clover', 'biscuit', 'kettle', 'heron', 'orchard', 'puffin', 'badger', 'wren'];
  const pick = a => a[crypto.getRandomValues(new Uint32Array(1))[0] % a.length];
  const newPassword = () => pick(A) + '-' + pick(B) + '-' + (100 + crypto.getRandomValues(new Uint16Array(1))[0] % 900);

  // Plain passwords, remembered on this device only.
  const vault = {
    all() { try { return JSON.parse(localStorage.getItem('gather.linkpw') || '{}'); } catch { return {}; } },
    set(id, pw) { const v = this.all(); v[id] = pw; try { localStorage.setItem('gather.linkpw', JSON.stringify(v)); } catch {} },
    get(id) { return this.all()[id] || ''; },
    del(id) { const v = this.all(); delete v[id]; try { localStorage.setItem('gather.linkpw', JSON.stringify(v)); } catch {} }
  };

  // The desktop app (Electron) has no window.prompt/confirm, so we use our own.
  function dialog({ title, sub, input, placeholder, ok, cancel }) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'lkdlg';
      wrap.innerHTML =
        '<div class="lkdlg-card">' +
        '<h3></h3>' + (sub ? '<p></p>' : '') +
        (input ? '<input type="text" maxlength="30" autocomplete="off">' : '') +
        '<div class="lkdlg-row"><button type="button" class="btn lkdlg-cancel"></button><button type="button" class="btn primary lkdlg-ok"></button></div>' +
        '</div>';
      wrap.querySelector('h3').textContent = title;
      if (sub) wrap.querySelector('p').textContent = sub;
      const field = wrap.querySelector('input');
      if (field) field.placeholder = placeholder || '';
      wrap.querySelector('.lkdlg-ok').textContent = ok || 'OK';
      wrap.querySelector('.lkdlg-cancel').textContent = cancel || 'Cancel';
      document.body.appendChild(wrap);
      const close = val => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
      const onKey = e => { if (e.key === 'Escape') close(null); if (e.key === 'Enter' && field) { e.preventDefault(); close(field ? field.value : true); } };
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(null); });
      wrap.querySelector('.lkdlg-cancel').addEventListener('click', () => close(null));
      wrap.querySelector('.lkdlg-ok').addEventListener('click', () => close(field ? field.value : true));
      setTimeout(() => (field || wrap.querySelector('.lkdlg-ok')).focus(), 30);
    });
  }
  const askText = (title, sub, placeholder, ok) => dialog({ title, sub, input: true, placeholder, ok: ok || 'Create' });
  const askConfirm = (title, sub, ok) => dialog({ title, sub, input: false, ok: ok || 'Delete', cancel: 'Keep it' });

  const urlFor = id => base + 'f/#' + id;
  const fmtSize = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? Math.round(n / 1048576) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : (n || 0) + ' B';
  const fmtWhen = at => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : new Date(at).toLocaleDateString(); };
  async function copy(text, note) {
    try { await navigator.clipboard.writeText(text); toast(note || 'Copied'); return; } catch {}
    // Clipboard blocked: show the text so it can be copied by hand.
    const wrap = document.createElement('div');
    wrap.className = 'lkdlg';
    wrap.innerHTML = '<div class="lkdlg-card"><h3>Copy this</h3><textarea rows="3" readonly></textarea><div class="lkdlg-row"><button type="button" class="btn primary">Done</button></div></div>';
    wrap.querySelector('textarea').value = text;
    document.body.appendChild(wrap);
    const ta = wrap.querySelector('textarea');
    ta.focus(); ta.select();
    const close = () => wrap.remove();
    wrap.querySelector('button').addEventListener('click', close);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
  }

  async function makeLink(kind) {
    const who = await askText(
      kind === 'in' ? 'Let someone send me a file' : 'Send a file to someone',
      kind === 'in' ? 'Give it a name so you can tell your links apart — for example who it\'s for.' : 'Who is this for? Just a name so you can tell your links apart.',
      'e.g. Auntie Sue');
    if (who === null) return;
    const label = who.trim().slice(0, 30);
    const id = rand(10);
    const password = newPassword();
    try {
      await api('/link/new', 'POST', { id, kind, passHash: await sha256hex(password), label });
      vault.set(id, password);
      toast('Link created');
      await load();
      const card = el.list.querySelector('[data-id="' + id + '"]');
      if (card) { card.classList.add('fresh'); card.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    } catch (e) { toast('Could not create the link: ' + e.message); }
  }

  function card(link) {
    const li = document.createElement('li');
    li.className = 'linkcard';
    li.dataset.id = link.id;
    const pw = vault.get(link.id);
    const url = urlFor(link.id);
    const inbound = link.kind === 'in';
    li.innerHTML =
      '<div class="lc-top">' +
        '<span class="lc-kind ' + link.kind + '">' + (inbound ? 'They send me' : 'I send them') + '</span>' +
        '<strong class="lc-label"></strong>' +
        '<button class="textbtn lc-del" type="button">Delete</button>' +
      '</div>' +
      '<div class="lc-row"><span class="lc-k">Link</span><code class="lc-url"></code><button class="btn lc-copy" type="button">Copy</button></div>' +
      '<div class="lc-row"><span class="lc-k">Password</span><code class="lc-pw"></code><button class="btn lc-copypw" type="button">Copy</button></div>' +
      '<button class="btn primary lc-both" type="button">Copy link &amp; password to send</button>' +
      '<div class="lc-manage"></div>';
    li.querySelector('.lc-label').textContent = link.label || (inbound ? 'A sender' : 'Someone');
    li.querySelector('.lc-url').textContent = url.replace(/^https?:\/\//, '');
    const pwEl = li.querySelector('.lc-pw');
    pwEl.textContent = pw || '(only shown on the device that made it)';
    if (!pw) pwEl.classList.add('lc-missing');
    li.querySelector('.lc-copy').addEventListener('click', () => copy(url, 'Link copied'));
    const copyPw = li.querySelector('.lc-copypw');
    if (pw) copyPw.addEventListener('click', () => copy(pw, 'Password copied')); else copyPw.disabled = true;
    const both = li.querySelector('.lc-both');
    if (pw) both.addEventListener('click', () => copy((inbound ? 'Send me a file here:\n' : 'A file for you here:\n') + url + '\nPassword: ' + pw, 'Link and password copied'));
    else both.disabled = true;
    li.querySelector('.lc-del').addEventListener('click', async () => {
      if (!(await askConfirm('Delete this link?', 'Anyone holding it will no longer be able to use it.'))) return;
      try { await api('/link/delete', 'POST', { id: link.id }); vault.del(link.id); li.remove(); refreshEmpty(); toast('Link deleted'); }
      catch (e) { toast('Could not delete: ' + e.message); }
    });
    buildManage(li.querySelector('.lc-manage'), link);
    return li;
  }

  function buildManage(box, link) {
    if (link.kind === 'out') {
      box.innerHTML = '<label class="lc-drop"><input type="file" multiple hidden><span>Add a file for them — choose or drop here</span></label><div class="lc-status"></div><ul class="lc-files"></ul>';
      const input = box.querySelector('input'), drop = box.querySelector('.lc-drop'), status = box.querySelector('.lc-status');
      const send = async list => {
        for (const f of list) {
          try {
            status.textContent = 'Adding ' + f.name + '…';
            const plan = await api('/link/upload', 'POST', { id: link.id, name: f.name, size: f.size, type: f.type });
            await window.GatherUpload.send(plan, f, p => { status.textContent = 'Adding ' + f.name + '… ' + Math.round(p * 100) + '%'; }, api);
          } catch (e) { status.textContent = 'Could not add ' + f.name + ': ' + e.message; return; }
        }
        status.textContent = list.length ? '✓ Added' : '';
        loadFiles(box, link);
      };
      input.addEventListener('change', () => send([...input.files]));
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); send([...e.dataTransfer.files]); });
    } else {
      box.innerHTML = '<div class="lc-status"></div><ul class="lc-files"></ul><p class="lc-none hidden">Nothing sent yet.</p>';
    }
    loadFiles(box, link);
  }

  async function loadFiles(box, link) {
    const ul = box.querySelector('.lc-files');
    const none = box.querySelector('.lc-none');
    try {
      const { files } = await api('/link/files?id=' + encodeURIComponent(link.id), 'GET');
      ul.innerHTML = '';
      if (none) none.classList.toggle('hidden', !!files.length);
      for (const f of files) {
        const li = document.createElement('li');
        li.innerHTML = '<span class="lc-fn"></span><span class="lc-fs"></span><a class="btn lc-get" target="_blank" rel="noopener">Get</a>';
        li.querySelector('.lc-fn').textContent = f.name;
        li.querySelector('.lc-fs').textContent = fmtSize(f.size) + (link.kind === 'in' ? ' · from ' + (f.from || 'Someone') : '') + ' · ' + fmtWhen(f.at);
        const a = li.querySelector('.lc-get');
        a.addEventListener('click', async e => {
          if (a.dataset.url) return;
          e.preventDefault(); a.textContent = '…';
          try { const { url } = await api('/link/file?id=' + encodeURIComponent(link.id) + '&path=' + encodeURIComponent(f.path), 'GET'); a.href = url; a.dataset.url = '1'; a.textContent = 'Get'; window.open(url, '_blank', 'noopener'); }
          catch { a.textContent = 'Get'; toast('Could not open that file'); }
        });
        ul.appendChild(li);
      }
    } catch { /* leave as is */ }
  }

  function refreshEmpty() { el.empty.classList.toggle('hidden', !!el.list.children.length); }

  async function load() {
    try {
      const { links } = await api('/link/list', 'GET');
      el.list.innerHTML = '';
      for (const l of links) el.list.appendChild(card(l));
      refreshEmpty();
    } catch (e) { /* offline: keep whatever is shown */ }
  }

  el.makeIn.addEventListener('click', () => makeLink('in'));
  el.makeOut.addEventListener('click', () => makeLink('out'));

  (window.GATHER_READY || Promise.resolve()).then(() => {
    if (!crypto.subtle) return; // needs HTTPS
    el.section.classList.remove('hidden');
    load();
  });
})();
