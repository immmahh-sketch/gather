/* Gather – names and direct files, on the home page.
 *
 * The first time someone opens Gather they pick a name. Anyone can then send
 * files to anyone else by name, without being in a call. Files go straight
 * from the sender's device into private storage (the server only hands out a
 * one-off upload link) and are kept for 7 days. If the recipient has Gather
 * open, a broadcast on their own channel pops a notice immediately.
 */
(() => {
  'use strict';
  const cfg = window.GATHER_CONFIG || {};
  const $ = s => document.querySelector(s);
  const RTC = cfg.RTC_ENDPOINT || '';
  const MAX_FILE = 50 * 1024 * 1024;

  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }
  };

  // ---------- server ----------
  async function api(path, method, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    let r;
    try {
      r = await fetch(RTC + path, {
        method,
        headers: { 'content-type': 'application/json', apikey: cfg.SUPABASE_KEY, 'x-gather-key': window.GATHER_KEY || '' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal
      });
    } catch (e) { throw new Error(e && e.name === 'AbortError' ? 'The server took too long to answer' : 'No connection'); }
    finally { clearTimeout(timer); }
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok || !data || data.errorCode) throw new Error((data && data.errorDescription) || 'Something went wrong (' + r.status + ')');
    return data;
  }

  // Must match the server's cleanPersonName/personKey.
  function cleanName(n) {
    const s = String(n || '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    return [...s].slice(0, 30).join('');
  }
  function personKey(n) {
    return [...new TextEncoder().encode(cleanName(n).toLowerCase())].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const channelFor = name => 'inbox-' + personKey(name).slice(0, 120);

  // ---------- small helpers ----------
  const el = {
    chip: $('#meChip'), chipName: $('#meName'), chipInitial: $('#meInitial'),
    section: $('#directFiles'), to: $('#dmTo'), nobody: $('#dmNobody'), file: $('#dmFile'), drop: $('#dmDrop'),
    picked: $('#dmPicked'), progress: $('#dmProgress'), send: $('#dmSend'), status: $('#dmStatus'),
    list: $('#inboxList'), empty: $('#inboxEmpty'), count: $('#inboxCount'), refresh: $('#inboxRefresh'),
    gate: $('#nameGate'), form: $('#nameForm'), title: $('#nameTitle'), sub: $('#nameSub'), field: $('#nameField'),
    err: $('#nameErr'), ask: $('#nameAsk'), confirm: $('#nameConfirm'), yes: $('#nameYes'), no: $('#nameNo'),
    cancel: $('#nameCancel'), toast: $('#toast')
  };
  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3500);
  }
  function fmtSize(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' bytes';
  }
  function fmtWhen(at) {
    const mins = Math.round((Date.now() - at) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const d = new Date(at), today = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return time;
    const y = new Date(today); y.setDate(today.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'yesterday ' + time;
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  }
  const ICONS = {
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/>',
    file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>'
  };
  function kind(f) {
    const t = f.type || '', n = (f.name || '').toLowerCase();
    if (t.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif)$/.test(n)) return 'image';
    if (t.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/.test(n)) return 'video';
    if (t.startsWith('audio/') || /\.(mp3|m4a|wav|aac|ogg)$/.test(n)) return 'audio';
    if (/pdf|word|excel|spreadsheet|presentation|powerpoint|text/.test(t) || /\.(pdf|docx?|xlsx?|pptx?|txt|csv|rtf|odt|pages|numbers|key)$/.test(n)) return 'doc';
    return 'file';
  }

  // ---------- who am I ----------
  let me = cleanName(store.get('gather.me') || '');
  let pendingName = '';

  function showNameGate(changing) {
    el.gate.classList.remove('hidden');
    document.body.classList.add('naming');
    el.title.textContent = changing ? 'Change your name' : "What's your name?";
    el.sub.textContent = changing ? 'Files sent to your old name stay under that name.' : "So family can send you files, and so you're named in calls.";
    el.field.value = changing ? me : cleanName(store.get('gather.name') || '');
    el.err.textContent = '';
    el.ask.classList.remove('hidden');
    el.confirm.classList.add('hidden');
    el.cancel.classList.toggle('hidden', !changing);
    setTimeout(() => el.field.focus(), 50);
  }
  function hideNameGate() {
    el.gate.classList.add('hidden');
    document.body.classList.remove('naming');
  }

  el.form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = cleanName(el.field.value);
    if (!name) { el.err.textContent = 'Please type your name.'; return; }
    if (me && name.toLowerCase() === me.toLowerCase()) { hideNameGate(); return; }
    const go = $('#nameGo');
    go.disabled = true;
    el.err.textContent = '';
    try {
      const d = await api('/people', 'POST', { name });
      if (d.created) { setMe(d.name); return; }
      // Someone already uses this name: most likely the same person on another device.
      pendingName = d.name;
      el.title.textContent = d.name + ' is already on Gather';
      el.sub.textContent = 'Is that you on another phone or computer? If so, carry on and files sent to ' + d.name + ' will show here too.';
      el.ask.classList.add('hidden');
      el.confirm.classList.remove('hidden');
    } catch (err) {
      el.err.textContent = err.message;
    } finally { go.disabled = false; }
  });
  el.yes.addEventListener('click', () => setMe(pendingName));
  el.no.addEventListener('click', () => {
    el.title.textContent = "What's your name?";
    el.sub.textContent = 'Try adding a surname or a nickname, so family can tell you apart.';
    el.ask.classList.remove('hidden');
    el.confirm.classList.add('hidden');
    el.field.select();
  });
  el.cancel.addEventListener('click', hideNameGate);
  el.chip.addEventListener('click', () => showNameGate(true));

  function setMe(name) {
    me = cleanName(name);
    store.set('gather.me', me);
    store.set('gather.name', me); // calls start with this name too
    hideNameGate();
    renderMe();
    inbox.items = []; inbox.byPath.clear(); renderInbox();
    loadPeople(true);
    loadInbox();
    listen();
  }
  function renderMe() {
    el.chip.classList.toggle('hidden', !me);
    el.chipName.textContent = me;
    el.chipInitial.textContent = (me[0] || '?').toUpperCase();
    el.section.classList.toggle('hidden', !me);
  }

  // ---------- people ----------
  let people = [], peopleAt = 0;
  async function loadPeople(force) {
    if (!force && Date.now() - peopleAt < 30000) return;
    peopleAt = Date.now();
    try {
      const d = await api('/people', 'GET');
      people = (d.people || []).filter(p => p.toLowerCase() !== me.toLowerCase());
    } catch (e) { console.warn('people', e.message); }
    renderPeople();
  }
  function renderPeople() {
    const current = el.to.value || store.get('gather.lastTo') || '';
    el.to.textContent = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = people.length ? 'Choose a person' : 'Nobody yet';
    el.to.append(first);
    for (const p of people) {
      const o = document.createElement('option');
      o.value = p; o.textContent = p; // names are text, never HTML
      el.to.append(o);
    }
    if (people.some(p => p === current)) el.to.value = current;
    el.to.disabled = !people.length;
    el.nobody.classList.toggle('hidden', people.length > 0);
    updateSend();
  }
  // Someone new may have picked a name since the page opened.
  el.to.addEventListener('focus', () => loadPeople(false));
  el.to.addEventListener('pointerdown', () => loadPeople(false));
  el.to.addEventListener('change', () => { store.set('gather.lastTo', el.to.value); updateSend(); });

  // ---------- sending ----------
  let chosen = [], sending = false;
  function setChosen(files) {
    chosen = files.filter(f => f && f.size >= 0);
    const big = chosen.filter(f => f.size > MAX_FILE);
    if (big.length) toast(big.map(f => f.name).join(', ') + (big.length > 1 ? ' are' : ' is') + ' over 50 MB');
    chosen = chosen.filter(f => f.size > 0 && f.size <= MAX_FILE);
    const total = chosen.reduce((n, f) => n + f.size, 0);
    el.picked.textContent = !chosen.length ? 'Choose files, or drop them here'
      : chosen.length === 1 ? chosen[0].name + ' · ' + fmtSize(total)
      : chosen.length + ' files · ' + fmtSize(total);
    el.drop.classList.toggle('has', chosen.length > 0);
    el.status.textContent = '';
    el.status.className = 'dstatus';
    updateSend();
  }
  function updateSend() {
    el.send.disabled = sending || !chosen.length || !el.to.value;
    el.send.textContent = sending ? 'Sending…' : el.to.value ? 'Send to ' + el.to.value : 'Send';
  }
  el.file.addEventListener('change', () => setChosen([...el.file.files]));
  for (const ev of ['dragenter', 'dragover']) el.drop.addEventListener(ev, e => { e.preventDefault(); el.drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) el.drop.addEventListener(ev, () => el.drop.classList.remove('over'));
  el.drop.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) setChosen([...e.dataTransfer.files]); });

  function upload(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      x.setRequestHeader('apikey', cfg.SUPABASE_KEY);
      x.setRequestHeader('x-upsert', 'false');
      x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => x.status < 300 ? resolve() : reject(new Error('Upload failed (' + x.status + ')'));
      x.onerror = () => reject(new Error('Connection lost while sending'));
      const form = new FormData();
      form.append('cacheControl', '3600');
      form.append('', file, file.name);
      x.send(form);
    });
  }

  el.send.addEventListener('click', async () => {
    const to = el.to.value;
    if (!to || !chosen.length || sending) return;
    sending = true;
    updateSend();
    const files = chosen.slice();
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    let doneBytes = 0, sent = 0;
    const bar = el.progress.firstElementChild;
    el.progress.classList.remove('hidden');
    bar.style.width = '0%';
    el.status.className = 'dstatus';
    try {
      for (const file of files) {
        el.status.textContent = 'Sending ' + file.name + '…';
        const up = await api('/inbox/upload', 'POST', { to, from: me, name: file.name, size: file.size, type: file.type });
        await upload(up.uploadUrl, file, p => { bar.style.width = Math.round(((doneBytes + p * file.size) / totalBytes) * 100) + '%'; });
        doneBytes += file.size;
        sent++;
        notify(to, { path: up.path, name: up.name, size: file.size, type: file.type || '', from: me, at: Date.now() });
      }
      el.status.textContent = 'Sent to ' + to + ' ✓';
      el.status.className = 'dstatus ok';
      chosen = []; el.file.value = '';
      el.picked.textContent = 'Choose files, or drop them here';
      el.drop.classList.remove('has');
    } catch (e) {
      el.status.textContent = (sent ? sent + ' sent, then: ' : "Couldn't send: ") + e.message;
      el.status.className = 'dstatus bad';
    } finally {
      sending = false;
      setTimeout(() => el.progress.classList.add('hidden'), 800);
      updateSend();
    }
  });

  // ---------- live notices ----------
  let supa = null, myChannel = null;
  function client() {
    if (!supa && window.supabase) supa = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
    return supa;
  }
  // Tell the recipient, if they have Gather open. Best effort: the file is safely
  // stored either way and shows up next time they look.
  function notify(to, payload) {
    const c = client();
    if (!c) return;
    const ch = c.channel(channelFor(to));
    const done = () => { try { c.removeChannel(ch); } catch {} };
    const timer = setTimeout(done, 8000);
    ch.subscribe(status => {
      if (status !== 'SUBSCRIBED') return;
      ch.send({ type: 'broadcast', event: 'file', payload }).finally(() => { clearTimeout(timer); done(); });
    });
  }
  function listen() {
    const c = client();
    if (!c || !me) return;
    if (myChannel) { try { c.removeChannel(myChannel); } catch {} }
    myChannel = c.channel(channelFor(me));
    myChannel.on('broadcast', { event: 'file' }, ({ payload }) => {
      if (!payload || !payload.path || inbox.byPath.has(payload.path)) return;
      addInbox(payload, true);
      toast((payload.from || 'Someone') + ' sent you ' + (payload.name || 'a file'));
    }).subscribe();
  }

  // ---------- files for you ----------
  const inbox = { items: [], byPath: new Map(), seen: Number(store.get('gather.inboxSeen') || 0) };
  function addInbox(f, fresh) {
    const item = {
      path: String(f.path), name: String(f.name || 'file').slice(0, 120), from: String(f.from || 'Someone').slice(0, 30),
      size: Number(f.size) || 0, type: String(f.type || ''), at: Number(f.at) || Date.now(), link: null, linkAt: 0, fresh: !!fresh
    };
    inbox.byPath.set(item.path, item);
    inbox.items.push(item);
    inbox.items.sort((a, b) => b.at - a.at);
    renderInbox();
    fetchLinks();
  }
  async function loadInbox() {
    if (!me) return;
    el.refresh.disabled = true;
    try {
      const d = await api('/inbox?me=' + encodeURIComponent(me), 'GET');
      inbox.items = []; inbox.byPath.clear();
      for (const f of d.files || []) addInbox(f, f.at > inbox.seen);
    } catch (e) { console.warn('inbox', e.message); }
    finally { el.refresh.disabled = false; }
    renderInbox();
    fetchLinks();
    // Whatever was new has now been shown once.
    const newest = inbox.items.reduce((m, f) => Math.max(m, f.at), inbox.seen);
    inbox.seen = newest;
    store.set('gather.inboxSeen', String(newest));
  }
  el.refresh.addEventListener('click', loadInbox);

  let linking = false;
  async function fetchLinks() {
    if (linking || !me) return;
    linking = true;
    try {
      for (const f of inbox.items) {
        if (f.link && Date.now() - f.linkAt < 45 * 60 * 1000) continue;
        try {
          const d = await api('/inbox/link?me=' + encodeURIComponent(me) + '&path=' + encodeURIComponent(f.path), 'GET');
          f.link = d.url; f.linkAt = Date.now();
        } catch (e) {
          if (/expired|no longer/i.test(e.message)) { inbox.items = inbox.items.filter(x => x !== f); inbox.byPath.delete(f.path); }
        }
        renderInbox();
      }
    } finally { linking = false; }
  }

  function renderInbox() {
    el.list.textContent = '';
    el.empty.classList.toggle('hidden', inbox.items.length > 0);
    const fresh = inbox.items.filter(f => f.fresh).length;
    el.count.textContent = fresh ? fresh + ' new' : '';
    el.count.classList.toggle('hidden', !fresh);
    for (const f of inbox.items) {
      const li = document.createElement('li');
      li.className = 'ditem' + (f.fresh ? ' fresh' : '');
      const ico = document.createElement('span');
      ico.className = 'dico';
      ico.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[kind(f)] + '</svg>';
      const meta = document.createElement('div');
      meta.className = 'dmeta';
      const name = document.createElement('span');
      name.className = 'dname';
      name.textContent = f.name;
      name.title = f.name;
      const sub = document.createElement('span');
      sub.className = 'dsub';
      sub.textContent = 'From ' + f.from + ' · ' + fmtSize(f.size) + ' · ' + fmtWhen(f.at);
      meta.append(name, sub);
      const a = document.createElement('a');
      a.className = 'btn dget' + (f.link ? '' : ' wait');
      a.textContent = f.link ? 'Download' : 'Preparing';
      a.target = '_blank';
      a.rel = 'noopener';
      if (f.link) { a.href = f.link; a.download = f.name; }
      a.addEventListener('click', () => { if (f.fresh) { f.fresh = false; renderInbox(); } });
      li.append(ico, meta, a);
      el.list.append(li);
    }
  }
  setInterval(() => { if (inbox.items.length) renderInbox(); }, 60000);
  // Coming back to the page later: pick up anything sent while it was in the background.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && me) { loadInbox(); loadPeople(false); } });

  // ---------- start ----------
  (window.GATHER_READY || Promise.resolve()).then(() => {
    renderMe();
    if (!me) { showNameGate(false); return; }
    loadPeople(true);
    loadInbox();
    listen();
  });
})();
