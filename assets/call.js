/* Gather – call page.
 *
 * Media goes through Cloudflare's Realtime SFU. Each person sends one copy of
 * their camera, microphone and screen to Cloudflare and pulls everyone else's
 * from there, so a fifteen-person call costs each device one upload rather
 * than fourteen. Cameras are published as simulcast layers (f/h/q) and each
 * viewer pulls the layer that fits the tile size.
 *
 * Supabase Realtime is the meeting point: presence says who is in the room,
 * which Cloudflare session they hold and which tracks they publish.
 *
 * The gather-rtc edge function holds the Cloudflare secrets: it forwards the
 * session API calls and mints TURN credentials.
 */
(() => {
  'use strict';
  const cfg = window.GATHER_CONFIG || {};
  const $ = (s, el = document) => el.querySelector(s);

  // ---------- room ----------
  const slug = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const room = slug(new URLSearchParams(location.search).get('room'));
  if (!room) { location.replace('./'); return; }
  // Share links are the home page plus ?room=, which forwards here. Shorter to send.
  const roomLink = location.origin + location.pathname.replace(/call\.html$/, '') + '?room=' + encodeURIComponent(room);
  const roomTitle = room.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  document.title = roomTitle + ' · Gather';

  const myId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  const isTouch = matchMedia('(pointer: coarse)').matches;
  // TV mode (Fire Stick app): no camera or microphone, joins by itself, watches full screen.
  const tvMode = new URLSearchParams(location.search).get('tv') === '1';
  // Live screen capture only exists in desktop browsers. Every device can share
  // photos and videos instead, so the share button shows everywhere except TVs.
  const canScreen = !tvMode && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  const canShare = !tvMode;
  if (tvMode) document.body.classList.add('tv');

  const ICON = {
    micOff: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
  };

  // ---------- state ----------
  const local = { name: '', cam: new MediaStream(), audio: null, video: null, screen: null, screenName: null, shareKind: null, tvFull: true, liveCam: false, liveFacing: 'environment', facing: 'user', micOn: true, camOn: true, permissionError: null };
  try { local.tvFull = localStorage.getItem('gather.tvfull') !== '0'; } catch {}
  const peers = new Map();  // peerId -> peer
  const tiles = new Map();  // tileId -> tile
  const meters = new Map(); // tileId -> audio level meter
  let supa = null, channel = null, joined = false, everSubscribed = false, pinned = null, timerIv = null, actx = null;

  // ---------- elements ----------
  const el = {
    prejoin: $('#prejoin'), call: $('#call'), left: $('#left'),
    preview: $('#preview'), previewWrap: $('#previewWrap'), preAvatar: $('#preAvatar'), nameInput: $('#nameInput'), joinBtn: $('#joinBtn'),
    preMic: $('#preMic'), preCam: $('#preCam'), preStatus: $('#preStatus'),
    stage: $('#stage'), strip: $('#strip'), grid: $('#grid'),
    micBtn: $('#micBtn'), camBtn: $('#camBtn'), flipBtn: $('#flipBtn'), shareBtn: $('#shareBtn'), leaveBtn: $('#leaveBtn'), linkBtn: $('#linkBtn'), rejoinBtn: $('#rejoinBtn'),
    count: $('#count'), timer: $('#timer'), toast: $('#toast'), netStatus: $('#netStatus')
  };
  $('#roomName').textContent = roomTitle;
  $('#preRoom').textContent = roomTitle;
  el.nameInput.value = localStorage.getItem('gather.name') || '';

  // ---------- helpers ----------
  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg; el.toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2500);
  }
  function setNet(msg) { el.netStatus.textContent = msg || ''; }
  function colorFor(name) {
    let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return 'hsl(' + (h % 360) + ' 55% 45%)';
  }
  function initial(name) { return (String(name).trim()[0] || '?').toUpperCase(); }
  function videoLive(stream) {
    return !!stream && stream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- gather-rtc API (Cloudflare behind a Supabase edge function) ----------
  const RTC = cfg.RTC_ENDPOINT || '';
  const authHeaders = () => ({ 'content-type': 'application/json', apikey: cfg.SUPABASE_KEY, Authorization: 'Bearer ' + cfg.SUPABASE_KEY, 'x-gather-key': window.GATHER_KEY || '' });
  // Every request gives up after 12 seconds. Changes to the video sessions run
  // one at a time, so a request that never came back would otherwise freeze the
  // call (seen when someone's connection had died: Cloudflare can sit on a
  // renegotiation for a track that no longer sends).
  const API_TIMEOUT = 12000;
  async function api(path, method, body) {
    let r;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), API_TIMEOUT);
    try { r = await fetch(RTC + path, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined, signal: ctl.signal }); }
    catch (e) { throw new Error(e && e.name === 'AbortError' ? 'timed out' : 'unreachable'); }
    finally { clearTimeout(timer); }
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) {
      if (data && data.errorDescription) throw new Error(data.errorDescription);
      if (r.status === 404 || r.status === 503) throw new Error('notdeployed');
      throw new Error('server error ' + r.status);
    }
    if (!data) throw new Error('bad reply');
    if (data.errorCode) throw new Error(data.errorDescription || data.errorCode);
    return data;
  }
  function explain(e) {
    const m = String((e && e.message) || e);
    if (m === 'unreachable' || m === 'notdeployed') return 'The video server is not set up yet. Deploy the gather-rtc function (see the README in the gather repo).';
    return 'Could not connect to the video server: ' + m;
  }

  // STUN comes from config. TURN credentials come from the function; if that is
  // slow or missing the call goes ahead with STUN only.
  let iceServers = (cfg.ICE_SERVERS || []).slice();
  let rtcReachable = null;
  const icePromise = (async () => {
    if (!RTC) return;
    if (window.GATHER_READY) await window.GATHER_READY; // wait for the password gate
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(RTC + '/ice', { headers: authHeaders(), signal: ctl.signal });
      clearTimeout(timer);
      rtcReachable = r.ok;
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length) iceServers = iceServers.concat(data.iceServers);
    } catch (e) { if (e && e.name !== 'AbortError') rtcReachable = false; }
  })();

  // ---------- local media ----------
  const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const videoConstraints = () => isTouch
    ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 }, facingMode: local.facing }
    : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 }, facingMode: local.facing };
  // Simulcast layers. Names sort f < h < q so Cloudflare can fall back in order.
  const camEncodings = () => isTouch
    ? [{ rid: 'h', maxBitrate: 500000 }, { rid: 'q', scaleResolutionDownBy: 2, maxBitrate: 150000 }]
    : [{ rid: 'f', maxBitrate: 1200000 }, { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 400000 }, { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150000 }];

  async function getMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { local.permissionError = 'unsupported'; return; }
    const get = c => navigator.mediaDevices.getUserMedia(c);
    let stream = null;
    try { stream = await get({ audio: AUDIO, video: videoConstraints() }); }
    catch (e) {
      local.permissionError = e.name;
      const parts = [];
      try { parts.push(await get({ audio: AUDIO })); } catch {}
      try { parts.push(await get({ video: videoConstraints() })); } catch {}
      if (parts.length) { stream = new MediaStream(); parts.forEach(s => s.getTracks().forEach(t => stream.addTrack(t))); local.permissionError = null; }
    }
    if (!stream) return;
    for (const t of stream.getTracks()) {
      local.cam.addTrack(t);
      if (t.kind === 'audio') local.audio = t; else local.video = t;
    }
    if (local.video) local.video.contentHint = 'motion';
  }

  function applyMediaButtons() {
    for (const b of [el.micBtn, el.preMic]) { b.classList.toggle('off', !local.micOn || !local.audio); b.disabled = !local.audio; b.title = local.audio ? (local.micOn ? 'Mute (M)' : 'Unmute (M)') : 'No microphone'; }
    for (const b of [el.camBtn, el.preCam]) {
      b.classList.toggle('off', !local.camOn || !local.video || local.liveCam);
      b.disabled = !local.video || local.liveCam;
      b.title = local.liveCam ? 'Your camera is being shared live' : local.video ? (local.camOn ? 'Camera off (V)' : 'Camera on (V)') : 'No camera';
    }
    el.previewWrap.classList.toggle('no-video', !(local.video && local.camOn));
    el.shareBtn.classList.toggle('on', !!local.screen);
    el.shareBtn.title = local.screen ? 'Stop sharing' : 'Share';
    updateLocalTile();
  }

  function setMic(on) { local.micOn = on; if (local.audio) local.audio.enabled = on; applyMediaButtons(); updatePresence(); }
  function setCam(on) { local.camOn = on; if (local.video) local.video.enabled = on; applyMediaButtons(); updatePresence(); }

  async function setupPrejoin() {
    if (tvMode) {
      el.nameInput.value = new URLSearchParams(location.search).get('name') || 'TV';
      el.preStatus.textContent = 'Connecting to the room…';
      el.joinBtn.disabled = true;
      if (window.GATHER_READY) await window.GATHER_READY;
      join();
      return;
    }
    el.preAvatar.textContent = initial(el.nameInput.value || '?');
    el.preAvatar.style.setProperty('--c', colorFor(el.nameInput.value || 'x'));
    el.preview.srcObject = local.cam;
    await getMedia();
    el.preview.play().catch(() => {});
    if (!local.audio && !local.video) {
      el.preStatus.textContent = local.permissionError === 'NotAllowedError'
        ? 'Camera and microphone are blocked. Allow them in your browser settings, then reload. You can still join and watch.'
        : local.permissionError === 'unsupported'
          ? 'This browser cannot make video calls. Try Safari on iPhone, or Chrome or Edge elsewhere.'
          : 'No camera or microphone found. You can still join and watch.';
    } else if (!local.video) {
      el.preStatus.textContent = 'No camera found, so you will join with sound only.';
    } else if (!local.audio) {
      el.preStatus.textContent = 'No microphone found, so others will not hear you.';
    }
    applyMediaButtons();
    if (isTouch && local.video && navigator.mediaDevices.enumerateDevices) {
      try {
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
        if (cams.length > 1) el.flipBtn.classList.remove('hidden');
      } catch {}
    }
    if (canShare) el.shareBtn.classList.remove('hidden');
    icePromise.then(() => { if (rtcReachable === false) el.preStatus.textContent = explain(new Error('unreachable')); });
  }

  el.nameInput.addEventListener('input', () => {
    el.preAvatar.textContent = initial(el.nameInput.value || '?');
    el.preAvatar.style.setProperty('--c', colorFor(el.nameInput.value || 'x'));
  });
  el.nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
  el.preMic.addEventListener('click', () => setMic(!local.micOn));
  el.preCam.addEventListener('click', () => setCam(!local.camOn));
  el.joinBtn.addEventListener('click', join);

  // ---------- SFU sessions ----------
  // Two connections to Cloudflare. "push" sends this device's camera, mic and
  // share; "pull" receives everyone else. Keeping them apart means the receiving
  // side can be rebuilt on its own without anyone else noticing.
  //
  // Received slots are never renegotiated away. When a track goes away it is
  // force-closed on Cloudflare only, and the local slot sits idle. A slot closed
  // by renegotiation gets reused by Cloudflare for the next track with its RTP
  // header extensions renumbered, which Chrome rejects ("RTP extension ID
  // reassignment not supported"); a force-closed slot is never reused.
  const sfu = {
    push: { pc: null, sessionId: null },
    pull: { pc: null, sessionId: null },
    queue: Promise.resolve(),
    pulls: new Map(),      // key sessionId/trackName -> pull
    byMid: new Map(),      // pull-connection mid -> pull
    idle: 0,               // slots whose track has gone
    localMids: new Map(),  // local trackName -> push mid
    published: [],         // local track names others may pull
    screenSeq: 0, attempts: 0, reconnecting: false, reconnectTimer: null,
    retryTimer: null, retryCount: 0, pullTimer: null, pullFailures: 0,
    coolOff: new Map()     // publisher sessionId -> time until which we do not pull it
  };
  // Every change to the Cloudflare sessions goes through one queue, so neither
  // connection is ever asked to negotiate two things at once.
  function enqueue(fn) {
    const run = sfu.queue.then(fn, fn);
    sfu.queue = run.catch(() => {});
    return run;
  }

  function newPC(onState) {
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    pc.onconnectionstatechange = () => onState(pc);
    return pc;
  }

  function localOutgoing(pc) {
    const out = [];
    if (local.audio) out.push({ tr: pc.addTransceiver(local.audio, { direction: 'sendonly' }), name: 'mic' });
    if (local.video) out.push({ tr: pc.addTransceiver(local.video, { direction: 'sendonly', sendEncodings: camEncodings() }), name: 'cam' });
    if (local.screen) for (const t of local.screen.getTracks()) {
      out.push({ tr: pc.addTransceiver(t, Object.assign({ direction: 'sendonly' }, t.kind === 'video' ? { sendEncodings: [{ maxBitrate: 2500000 }] } : {})), name: t.kind === 'video' ? local.screenName : local.screenName + '-audio' });
    }
    return out;
  }

  // Opens the push session with whatever this device has to send. A device with
  // nothing to send (a TV, or no camera or mic) needs no push session at all.
  async function connectSFU() {
    sfu.localMids.clear(); sfu.published = [];
    const pc = newPC(onPushState);
    const outgoing = localOutgoing(pc);
    if (!outgoing.length) { pc.close(); sfu.push = { pc: null, sessionId: null }; sfu.attempts = 0; return; }
    sfu.push = { pc, sessionId: null };
    sfu.push.sessionId = (await api('/sessions/new', 'POST')).sessionId;
    await pushOffer(pc, outgoing);
    await waitConnected(pc, 12000);
    sfu.attempts = 0;
  }

  // Publish local transceivers: offer to Cloudflare, apply its answer. Mids only
  // exist after setLocalDescription, so the track list is built after it.
  async function pushOffer(pc, outgoing) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await api('/sessions/' + sfu.push.sessionId + '/tracks/new', 'POST', {
      sessionDescription: { type: 'offer', sdp: offer.sdp },
      tracks: outgoing.map(o => ({ location: 'local', mid: o.tr.mid, trackName: o.name }))
    });
    await pc.setRemoteDescription(res.sessionDescription);
    const failed = new Set((res.tracks || []).filter(t => t.errorCode).map(t => t.trackName));
    for (const o of outgoing) {
      if (failed.has(o.name)) { console.warn('publish failed', o.name); continue; }
      sfu.localMids.set(o.name, o.tr.mid);
      sfu.published.push(o.name);
    }
  }

  function waitConnected(pc, ms) {
    return new Promise((resolve, reject) => {
      if (pc.connectionState === 'connected') return resolve();
      const timer = setTimeout(() => { pc.removeEventListener('connectionstatechange', h); reject(new Error('timed out connecting to the video server')); }, ms);
      function h() {
        if (pc.connectionState === 'connected') { clearTimeout(timer); pc.removeEventListener('connectionstatechange', h); resolve(); }
        else if (pc.connectionState === 'failed') { clearTimeout(timer); pc.removeEventListener('connectionstatechange', h); reject(new Error('could not reach the video server')); }
      }
      pc.addEventListener('connectionstatechange', h);
    });
  }

  function resetPull() {
    const pc = sfu.pull.pc;
    if (pc) { pc.ontrack = null; pc.onconnectionstatechange = null; try { pc.close(); } catch {} }
    sfu.pull = { pc: null, sessionId: null };
    sfu.pulls.clear(); sfu.byMid.clear(); sfu.idle = 0;
    clearTimeout(sfu.pullTimer); sfu.pullTimer = null;
    for (const p of peers.values()) resetPeerStreams(p);
  }

  function teardownSFU() {
    const pc = sfu.push.pc;
    if (pc) { pc.onconnectionstatechange = null; try { pc.close(); } catch {} }
    sfu.push = { pc: null, sessionId: null };
    sfu.localMids.clear(); sfu.published = [];
    clearTimeout(sfu.reconnectTimer); sfu.reconnectTimer = null;
    clearTimeout(sfu.retryTimer); sfu.retryTimer = null;
    resetPull();
  }

  function pushLive() {
    return !!(sfu.push.pc && sfu.push.sessionId && sfu.push.pc.connectionState === 'connected');
  }

  function onPushState(pc) {
    if (pc !== sfu.push.pc) return;
    const s = pc.connectionState;
    if (s === 'connected' || s === 'disconnected' || s === 'failed') updatePresence();
    if (s === 'connected') { setNet(''); clearTimeout(sfu.reconnectTimer); sfu.reconnectTimer = null; }
    else if (s === 'failed') reconnectSFU();
    else if (s === 'disconnected') {
      setNet('Reconnecting…');
      if (!sfu.reconnectTimer) sfu.reconnectTimer = setTimeout(() => { sfu.reconnectTimer = null; if (sfu.push.pc === pc && pc.connectionState !== 'connected') reconnectSFU(); }, 8000);
    }
  }

  function onPullState(pc) {
    if (pc !== sfu.pull.pc) return;
    const s = pc.connectionState;
    if (s === 'connected') { clearTimeout(sfu.pullTimer); sfu.pullTimer = null; }
    else if (s === 'failed') onPullError(new Error('incoming video connection failed'));
    else if (s === 'disconnected' && !sfu.pullTimer) {
      sfu.pullTimer = setTimeout(() => { sfu.pullTimer = null; if (sfu.pull.pc === pc && pc.connectionState !== 'connected') onPullError(new Error('incoming video connection lost')); }, 8000);
    }
  }

  // Full reconnect: both sessions, used when the sending side drops.
  function reconnectSFU() {
    if (!joined || sfu.reconnecting) return;
    sfu.reconnecting = true;
    setNet('Reconnecting…');
    enqueue(async () => {
      teardownSFU();
      await sleep(Math.min(15000, 1000 * Math.pow(2, sfu.attempts++)));
      if (!joined) return;
      await connectSFU();
    }).then(() => {
      sfu.reconnecting = false;
      if (!joined) return;
      setNet('');
      updatePresence();
      syncPulls();
    }, e => {
      console.warn('reconnect', e);
      sfu.reconnecting = false;
      if (joined) reconnectSFU();
    });
  }

  // Receiving side went wrong (a failed negotiation, a dropped connection, a
  // server error): throw the pull session away and pull everything again.
  // Nobody else is affected, and this device's own video keeps flowing.
  function onPullError(e, tidy) {
    if (!joined || sfu.reconnecting) return;
    console.warn('rebuilding incoming video:', e && e.message);
    if (!tidy) sfu.pullFailures++;
    if (sfu.pullFailures > 1) setNet('Reconnecting…');
    const delay = Math.min(15000, 500 * Math.pow(2, sfu.pullFailures - 1));
    enqueue(async () => resetPull()).then(() => {
      render();
      clearTimeout(sfu.retryTimer);
      sfu.retryTimer = setTimeout(syncPulls, delay);
    });
  }

  // Stop push transceivers and tell Cloudflare, with a negotiated close first
  // and a forced close if that is refused.
  async function closeMids(pc, mids) {
    if (!mids.length || !sfu.push.sessionId) return;
    for (const mid of mids) {
      const tr = pc.getTransceivers().find(t => t.mid === mid);
      if (tr) { try { tr.stop(); } catch {} }
    }
    const path = '/sessions/' + sfu.push.sessionId + '/tracks/close';
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await api(path, 'PUT', { tracks: mids.map(mid => ({ mid })), sessionDescription: { type: 'offer', sdp: offer.sdp }, force: false });
      if (res.sessionDescription) await pc.setRemoteDescription(res.sessionDescription);
    } catch (e) {
      console.warn('negotiated close failed, forcing', e);
      if (pc.signalingState !== 'stable') { try { await pc.setLocalDescription({ type: 'rollback' }); } catch {} }
      await api(path, 'PUT', { tracks: mids.map(mid => ({ mid })), force: true }).catch(() => {});
    }
  }

  function publishLocal(entries) {
    return enqueue(async () => {
      if (!sfu.push.pc) {
        // First thing this device sends (e.g. a laptop with no camera sharing its screen).
        const pc = newPC(onPushState);
        sfu.push = { pc, sessionId: null };
        const outgoing = entries.map(e => ({ tr: pc.addTransceiver(e.track, Object.assign({ direction: 'sendonly' }, e.init || {})), name: e.name }));
        sfu.push.sessionId = (await api('/sessions/new', 'POST')).sessionId;
        await pushOffer(pc, outgoing);
        await waitConnected(pc, 12000);
      } else {
        const pc = sfu.push.pc;
        const outgoing = entries.map(e => ({ tr: pc.addTransceiver(e.track, Object.assign({ direction: 'sendonly' }, e.init || {})), name: e.name }));
        await pushOffer(pc, outgoing);
      }
      updatePresence();
    });
  }

  function unpublishLocal(names) {
    return enqueue(async () => {
      const pc = sfu.push.pc;
      const mids = names.map(n => sfu.localMids.get(n)).filter(Boolean);
      for (const n of names) sfu.localMids.delete(n);
      sfu.published = sfu.published.filter(n => !names.includes(n));
      updatePresence();
      if (pc) await closeMids(pc, mids);
    });
  }

  // ---------- pulling other people's tracks ----------
  function wantedPulls() {
    const wanted = new Map();
    const now = Date.now();
    for (const p of peers.values()) {
      const st = p.state;
      if (!st.sessionId) continue;
      if ((sfu.coolOff.get(st.sessionId) || 0) > now) continue;
      for (const name of st.tracks) {
        const key = st.sessionId + '/' + name;
        wanted.set(key, {
          key, peerId: p.id, sessionId: st.sessionId, trackName: name,
          kind: name.startsWith('screen') ? 'screen' : 'cam',
          media: (name === 'mic' || name.endsWith('-audio')) ? 'audio' : 'video'
        });
      }
    }
    return wanted;
  }

  function simulcastFor(w) {
    return w.media === 'video' && w.kind === 'cam'
      ? { simulcast: { preferredRid: desiredRid(w.peerId), priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' } }
      : {};
  }

  async function ensurePull() {
    if (sfu.pull.pc) return sfu.pull;
    const pc = newPC(onPullState);
    pc.ontrack = onTrack;
    const { sessionId } = await api('/sessions/new', 'POST');
    sfu.pull = { pc, sessionId };
    return sfu.pull;
  }

  function syncPulls() {
    if (!joined || sfu.reconnecting) return;
    enqueue(async () => {
      if (!joined || sfu.reconnecting) return;
      const wanted = wantedPulls();
      const gone = [...sfu.pulls.values()].filter(pl => !wanted.has(pl.key));
      if (gone.length) await releasePulls(gone);
      const missing = [...wanted.values()].filter(w => !sfu.pulls.has(w.key));
      if (!missing.length) return;
      const pull = await ensurePull();
      let failed;
      try { failed = await pullTracks(pull, missing); }
      catch (e) {
        // If it hung, someone in this batch probably has a dead connection. Skip
        // the batch for 15 seconds so the rebuild gets everyone else back first.
        if (e && e.message === 'timed out') {
          for (const w of missing) sfu.coolOff.set(w.sessionId, Date.now() + 15000);
          clearTimeout(sfu.coolTimer);
          sfu.coolTimer = setTimeout(syncPulls, 16000);
        }
        throw e;
      }
      sfu.pullFailures = 0;
      if (!sfu.reconnecting && (!sfu.push.pc || sfu.push.pc.connectionState === 'connected')) setNet('');
      if (failed) scheduleRetry(); else sfu.retryCount = 0;
    }).then(() => {
      // A long call with lots of comings and goings leaves many idle slots.
      // Past a point, start the receiving side afresh so it stays light.
      if (sfu.idle > 30 && joined) onPullError(new Error('tidying up idle slots'), true);
    }).catch(e => onPullError(e));
  }
  // A track can be listed before it carries any data (someone still starting
  // up). Retry, backing off so a track that never arrives costs little.
  function scheduleRetry() {
    clearTimeout(sfu.retryTimer);
    const delay = Math.min(30000, 2500 * Math.pow(2, sfu.retryCount++));
    sfu.retryTimer = setTimeout(syncPulls, delay);
  }

  function registerPull(w, mid, track) {
    const pl = Object.assign({}, w, { mid, rid: w.media === 'video' && w.kind === 'cam' ? desiredRid(w.peerId) : null, track: track || null });
    sfu.pulls.set(w.key, pl);
    sfu.byMid.set(mid, pl);
    if (pl.track) attachPull(pl);
    return pl;
  }

  // Tracks have gone: detach them from their people, tell Cloudflare to stop
  // sending them, and leave the local slots idle (see the note at the top).
  async function releasePulls(list) {
    for (const pl of list) {
      sfu.pulls.delete(pl.key);
      sfu.byMid.delete(pl.mid);
      sfu.idle++;
      const p = peers.get(pl.peerId);
      if (p && pl.track) { p.camStream.removeTrack(pl.track); p.screenStream.removeTrack(pl.track); refreshPeerTiles(p); }
    }
    if (!sfu.pull.sessionId) return;
    await api('/sessions/' + sfu.pull.sessionId + '/tracks/close', 'PUT', { tracks: list.map(pl => ({ mid: pl.mid })), force: true })
      .catch(e => console.warn('close idle slots', e && e.message)); // harmless if it fails
  }

  async function pullTracks(pull, list) {
    const res = await api('/sessions/' + pull.sessionId + '/tracks/new', 'POST', {
      tracks: list.map(w => Object.assign({ location: 'remote', sessionId: w.sessionId, trackName: w.trackName }, simulcastFor(w)))
    });
    let failed = false;
    (res.tracks || []).forEach((t, i) => {
      const w = list.find(x => x.trackName === t.trackName && (!t.sessionId || x.sessionId === t.sessionId)) || list[i];
      if (!w) return;
      if (t.errorCode || !t.mid) { console.warn('pull failed', w.trackName, t.errorDescription || t.errorCode); failed = true; return; }
      registerPull(w, t.mid, null);
    });
    if (res.requiresImmediateRenegotiation && res.sessionDescription) await applyOffer(pull, res.sessionDescription);
    for (const p of peers.values()) updatePeerTiles(p);
    return failed;
  }

  // Cloudflare offers, we answer. If the browser rejects the offer the caller's
  // catch rebuilds the pull session, so this never leaves things half-done.
  async function applyOffer(pull, offer) {
    const pc = pull.pc;
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await api('/sessions/' + pull.sessionId + '/renegotiate', 'PUT', { sessionDescription: { type: 'answer', sdp: answer.sdp } });
  }

  function attachPull(pl) {
    const p = peers.get(pl.peerId);
    const track = pl.track;
    if (!p || !track) return;
    const target = pl.kind === 'screen' ? p.screenStream : p.camStream;
    const other = pl.kind === 'screen' ? p.camStream : p.screenStream;
    if (other.getTracks().includes(track)) other.removeTrack(track);
    if (!target.getTracks().includes(track)) target.addTrack(track);
    if (!track._gather) {
      // A reused slot keeps the same track object, so these are wired once and
      // look up whoever owns the track now.
      track._gather = true;
      const owner = () => { for (const q of sfu.pulls.values()) if (q.track === track) return peers.get(q.peerId); return null; };
      track.addEventListener('mute', () => { const o = owner(); if (o) updatePeerTiles(o); });
      track.addEventListener('unmute', () => { const o = owner(); if (o) updatePeerTiles(o); });
    }
    refreshPeerTiles(p);
  }

  function onTrack(e) {
    const pl = sfu.byMid.get(e.transceiver.mid);
    if (!pl) return;
    pl.track = e.track;
    attachPull(pl);
  }

  // Which simulcast layer a peer's camera should arrive in, from where its tile sits.
  function desiredRid(peerId) {
    const t = tiles.get(peerId + ':cam');
    const where = t && t.el.parentNode ? t.el.parentNode.id : 'grid';
    if (where === 'stage') return 'f';
    if (where === 'strip') return 'q';
    const n = el.grid.children.length;
    if (isTouch) return n <= 2 ? 'f' : 'q';
    return n <= 2 ? 'f' : n <= 9 ? 'h' : 'q';
  }
  let ridTimer = null;
  function scheduleRidUpdate() { clearTimeout(ridTimer); ridTimer = setTimeout(updateRids, 500); }
  function updateRids() {
    if (!sfu.pull.pc || !sfu.pull.sessionId) return;
    const changes = [];
    for (const pl of sfu.pulls.values()) {
      if (pl.media !== 'video' || pl.kind !== 'cam') continue;
      const want = desiredRid(pl.peerId);
      if (want !== pl.rid) { pl.rid = want; changes.push(pl); }
    }
    if (!changes.length) return;
    enqueue(async () => {
      if (!sfu.pull.sessionId) return;
      await api('/sessions/' + sfu.pull.sessionId + '/tracks/update', 'PUT', {
        tracks: changes.map(pl => ({ location: 'remote', sessionId: pl.sessionId, trackName: pl.trackName, mid: pl.mid, simulcast: { preferredRid: pl.rid, priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' } }))
      });
    }).catch(e => console.warn('layer update', e));
  }

  // ---------- join / leave ----------
  function ensureAudioContext() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume().catch(() => {});
    } catch {}
  }

  async function join() {
    if (joined) return;
    local.name = el.nameInput.value.trim().slice(0, 30) || 'Guest';
    try { localStorage.setItem('gather.name', local.name); } catch {}
    joined = true;
    ensureAudioContext();
    el.joinBtn.disabled = true;
    el.joinBtn.textContent = 'Connecting…';
    el.preStatus.textContent = '';
    await icePromise;
    try { await enqueue(connectSFU); }
    catch (e) {
      console.warn('connect', e);
      teardownSFU();
      joined = false;
      el.joinBtn.disabled = false;
      el.joinBtn.textContent = 'Join call';
      el.preStatus.textContent = explain(e);
      if (tvMode) { el.preStatus.textContent += ' Trying again…'; setTimeout(join, 5000); }
      return;
    }
    el.prejoin.classList.add('hidden');
    el.call.classList.remove('hidden');
    if (!tvMode) addLocalTile(); // a TV has nothing to show of itself
    applyMediaButtons();
    startTimer();
    render();
    connect();
  }

  function leave() {
    if (!joined) return;
    joined = false;
    clearInterval(timerIv);
    if (channel) { channel.untrack().catch(() => {}); supa.removeChannel(channel); }
    channel = null;
    for (const id of [...peers.keys()]) removePeer(id, false);
    teardownSFU();
    if (local.screen) { local.screen.getTracks().forEach(t => t.stop()); local.screen = null; local.screenName = null; local.shareKind = null; }
    stopPresenter();
    keepAwake(false);
    if (standIn) { standIn.stop(); standIn = null; }
    local.liveCam = false;
    updatePresentBar();
    setFilesOpen(false);
    for (const t of local.cam.getTracks()) t.stop();
    el.call.classList.add('hidden');
    el.left.classList.remove('hidden');
  }

  function startTimer() {
    const t0 = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      const two = n => String(n).padStart(2, '0');
      el.timer.textContent = (h ? h + ':' : '') + two(m) + ':' + two(sec);
    };
    tick(); timerIv = setInterval(tick, 1000);
  }

  // ---------- presence (Supabase Realtime) ----------
  function presencePayload() {
    return {
      name: local.name,
      mic: !!(local.audio && local.micOn),
      cam: !!(local.video && local.camOn && !local.liveCam),
      // Advertise tracks only while the sending connection is up: pulling a dead
      // one makes Cloudflare stall, and anyone joining meanwhile would wait on it.
      sessionId: pushLive() ? sfu.push.sessionId : null,
      tracks: pushLive() ? sfu.published.slice() : [],
      screen: local.screenName || null,
      shareKind: local.shareKind,
      tv: tvMode, // TVs watch only, so nobody gives them a tile
      // Whether TVs should show this share edge to edge with nothing else on screen.
      tvFull: !!(local.screen && local.tvFull)
    };
  }
  function updatePresence() { if (channel && joined && everSubscribed) channel.track(presencePayload()).catch(() => {}); }

  function connect() {
    supa = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, { realtime: { params: { eventsPerSecond: 20 } } });
    channel = supa.channel('call-' + room, { config: { presence: { key: myId } } });
    channel
      .on('presence', { event: 'sync' }, onPresenceSync)
      .on('broadcast', { event: 'file' }, ({ payload }) => { if (!tvMode) addShared(payload, true); })
      .on('presence', { event: 'leave' }, ({ key, currentPresences }) => {
        if (key !== myId && !(currentPresences && currentPresences.length)) { removePeer(key, true); syncPulls(); }
      })
      .subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          everSubscribed = true;
          loadFiles();
          if (!sfu.reconnecting) setNet('');
          await channel.track(presencePayload());
        } else if (joined && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')) {
          setNet('Reconnecting…');
        }
      });
  }

  function onPresenceSync() {
    const state = channel.presenceState();
    for (const [id, metas] of Object.entries(state)) {
      if (id === myId) continue;
      const meta = metas[metas.length - 1] || {};
      let p = peers.get(id);
      if (!p) p = createPeer(id);
      const wasSeen = p.seen; p.seen = true;
      const prevSession = p.state.sessionId;
      p.state = {
        name: String(meta.name || 'Guest').slice(0, 30),
        mic: meta.mic !== false,
        cam: meta.cam !== false,
        sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : null,
        tracks: Array.isArray(meta.tracks) ? meta.tracks.filter(t => typeof t === 'string').slice(0, 8) : [],
        screen: typeof meta.screen === 'string' ? meta.screen : null,
        shareKind: meta.shareKind === 'media' || meta.shareKind === 'live' ? meta.shareKind : 'screen',
        tvFull: meta.tvFull === true
      };
      if (meta.tv === true && !p.tv) { p.tv = true; removeTile(id + ':cam'); }
      if (prevSession && prevSession !== p.state.sessionId) resetPeerStreams(p);
      if (!wasSeen) toast(p.tv ? 'A TV is watching' : p.state.name + ' joined');
      updatePeerTiles(p);
    }
    for (const [id, p] of peers) if (p.seen && !state[id]) removePeer(id, true);
    render();
    syncPulls();
  }

  // ---------- peers ----------
  function createPeer(id) {
    const p = {
      id, seen: false,
      state: { name: 'Guest', mic: true, cam: true, sessionId: null, tracks: [], screen: null, shareKind: 'screen', tvFull: false },
      camStream: new MediaStream(), screenStream: new MediaStream()
    };
    peers.set(id, p);
    setTileStream(id + ':cam', p.camStream, p, 'cam');
    return p;
  }
  function resetPeerStreams(p) {
    p.camStream = new MediaStream();
    p.screenStream = new MediaStream();
    refreshPeerTiles(p);
  }
  function refreshPeerTiles(p) {
    if (!p.tv) setTileStream(p.id + ':cam', p.camStream, p, 'cam');
    if (p.screenStream.getTracks().length) setTileStream(p.id + ':screen', p.screenStream, p, 'screen'); else removeTile(p.id + ':screen');
    updatePeerTiles(p);
    render();
  }
  function removePeer(id, announce) {
    const p = peers.get(id);
    if (!p) return;
    removeTile(id + ':cam');
    removeTile(id + ':screen');
    peers.delete(id);
    if (announce && p.seen && !p.tv) toast(p.state.name + ' left');
    render();
  }

  // ---------- tiles ----------
  function getTile(id, opts) {
    let t = tiles.get(id);
    if (t) return t;
    const wrap = document.createElement('div');
    wrap.className = 'tile';
    wrap.dataset.kind = opts.kind;
    wrap.innerHTML = '<video autoplay playsinline></video><div class="avatar"><span></span></div><div class="status">Connecting…</div>' +
      '<div class="badge"><span class="mic-off">' + ICON.micOff + '</span><span class="label"></span></div>' +
      '<button class="pin" type="button" title="Make this big">' + ICON.pin + '</button>';
    const video = wrap.querySelector('video');
    if (opts.self) { video.muted = true; video.setAttribute('muted', ''); }
    wrap.querySelector('.pin').addEventListener('click', ev => { ev.stopPropagation(); pinned = pinned === id ? null : id; render(); });
    t = { id, el: wrap, video, stream: null, peerId: opts.peerId, kind: opts.kind, self: !!opts.self };
    tiles.set(id, t);
    return t;
  }
  function setTileStream(id, stream, p, kind) {
    const t = getTile(id, { kind, peerId: p ? p.id : 'local', self: !p });
    if (t.stream !== stream) {
      t.stream = stream;
      t.video.srcObject = stream;
    }
    if (stream) { t.video.play().catch(() => {}); watchAudio(id, stream, t.el); }
    return t;
  }
  function removeTile(id) {
    const t = tiles.get(id);
    if (!t) return;
    t.video.srcObject = null;
    t.el.remove();
    tiles.delete(id);
    meters.delete(id);
    if (pinned === id) pinned = null;
  }
  function setTileInfo(t, info) {
    t.el.querySelector('.label').textContent = info.label;
    const av = t.el.querySelector('.avatar span');
    av.textContent = initial(info.name);
    av.style.setProperty('--c', colorFor(info.name));
    t.el.classList.toggle('muted', !!info.muted);
    t.el.classList.toggle('no-video', !!info.noVideo);
    t.el.classList.toggle('connecting', !!info.connecting);
    t.el.classList.toggle('mirror', !!info.mirror);
  }
  function updatePeerTiles(p) {
    const waiting = !!p.state.sessionId && p.state.tracks.length > 0 && p.camStream.getTracks().length === 0;
    const cam = tiles.get(p.id + ':cam');
    if (cam) setTileInfo(cam, { label: p.state.name, name: p.state.name, muted: !p.state.mic, noVideo: !(p.state.cam && videoLive(p.camStream)), connecting: waiting });
    const scr = tiles.get(p.id + ':screen');
    if (scr) setTileInfo(scr, { label: p.state.shareKind === 'media' ? p.state.name + ' is presenting' : p.state.shareKind === 'live' ? p.state.name + "'s live video" : p.state.name + "'s screen", name: p.state.name, muted: false, noVideo: !videoLive(p.screenStream), connecting: false });
  }
  function addLocalTile() {
    setTileStream('local:cam', local.cam, null, 'cam');
    updateLocalTile();
  }
  function updateLocalTile() {
    const t = tiles.get('local:cam');
    if (!t) return;
    setTileInfo(t, { label: 'You', name: local.name || el.nameInput.value || '?', muted: !(local.audio && local.micOn), noVideo: local.liveCam || !(local.video && local.camOn && videoLive(local.cam)), connecting: false, mirror: local.facing === 'user' });
    const s = tiles.get('local:screen');
    if (s) setTileInfo(s, { label: local.shareKind === 'media' ? "You're presenting" : local.shareKind === 'live' ? 'Your live video' : 'Your screen', name: local.name, muted: false, noVideo: !videoLive(s.stream), connecting: false });
  }

  function render() {
    const all = [...tiles.values()];
    let stageId = pinned && tiles.has(pinned) ? pinned : null;
    if (!stageId) {
      const shared = all.filter(t => t.kind === 'screen' && !t.self);
      if (shared.length) stageId = shared[shared.length - 1].id;
    }
    el.call.classList.toggle('has-stage', !!stageId);
    if (tvMode) {
      // The sharer decides whether TVs show their share edge to edge.
      const st = stageId ? tiles.get(stageId) : null;
      const owner = st && st.kind === 'screen' && !st.self ? peers.get(st.peerId) : null;
      document.body.classList.toggle('tv-full', !!(owner && owner.state.tvFull));
    }
    for (const t of all) {
      const target = t.id === stageId ? el.stage : (stageId ? el.strip : el.grid);
      if (t.el.parentNode !== target) { target.appendChild(t.el); if (t.stream) t.video.play().catch(() => {}); }
      t.el.classList.toggle('pinned', pinned === t.id);
    }
    const n = el.grid.children.length;
    const portrait = innerHeight > innerWidth;
    let cols;
    if (portrait) cols = n <= 2 ? 1 : n <= 6 ? 2 : 3;
    else cols = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 2 : n <= 6 ? 3 : n <= 12 ? 4 : n <= 20 ? 5 : 6;
    // On a phone, more than six tiles scroll rather than shrink to nothing.
    el.grid.classList.toggle('scroll', portrait && n > 6);
    el.grid.style.setProperty('--cols', cols);
    el.count.textContent = [...peers.values()].filter(q => !q.tv).length + (tvMode ? 0 : 1);
    scheduleRidUpdate();
  }
  window.addEventListener('resize', render);

  // ---------- who is speaking ----------
  function watchAudio(id, stream, tileEl) {
    if (!actx || !stream.getAudioTracks().length) return;
    const m = meters.get(id);
    if (m && m.stream === stream) return;
    try {
      const src = actx.createMediaStreamSource(stream);
      const an = actx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      meters.set(id, { stream, an, el: tileEl, buf: new Uint8Array(an.frequencyBinCount) });
    } catch {}
  }
  setInterval(() => {
    for (const [id, m] of meters) {
      if (!tiles.has(id)) { meters.delete(id); continue; }
      m.an.getByteTimeDomainData(m.buf);
      let sum = 0;
      for (let i = 0; i < m.buf.length; i++) { const d = (m.buf[i] - 128) / 128; sum += d * d; }
      m.el.classList.toggle('speaking', Math.sqrt(sum / m.buf.length) > 0.04);
    }
  }, 200);

  // ---------- controls ----------
  el.micBtn.addEventListener('click', () => setMic(!local.micOn));
  el.camBtn.addEventListener('click', () => setCam(!local.camOn));
  el.leaveBtn.addEventListener('click', leave);
  el.rejoinBtn.addEventListener('click', () => location.reload());
  el.linkBtn.addEventListener('click', shareLink);
  el.shareBtn.addEventListener('click', onShareClick);
  el.flipBtn.addEventListener('click', () => local.shareKind === 'live' ? flipLive() : flipCamera());
  document.addEventListener('keydown', e => {
    if (!joined || e.target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'm' || e.key === 'M') setMic(!local.micOn);
    if (e.key === 'v' || e.key === 'V') setCam(!local.camOn);
    if (presenter && e.key === 'ArrowLeft') presenterShow(presenter.index - 1);
    if (presenter && e.key === 'ArrowRight') presenterShow(presenter.index + 1);
  });

  async function shareLink() {
    if (navigator.share && isTouch) {
      try { await navigator.share({ title: 'Join my video call', text: 'Join my video call', url: roomLink }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(roomLink); toast('Link copied'); }
    catch { prompt('Copy this link', roomLink); }
  }

  // ---------- files ----------
  // Files go straight from this device into a private Storage bucket (the server
  // only hands out a one-off upload link), then a broadcast tells the room.
  // Download links are fetched ahead of time so a tap opens them directly: on
  // iPhones a link opened after a wait counts as a pop-up and gets blocked.
  const MAX_FILE = 50 * 1024 * 1024;
  const shared = { list: [], byPath: new Map(), unread: 0, open: false, loaded: false };
  const fl = {
    btn: $('#filesBtn'), badge: $('#filesBadge'), panel: $('#filesPanel'), list: $('#filesList'),
    empty: $('#filesEmpty'), pick: $('#filesPick'), close: $('#filesClose'), input: $('#fileInput'), drop: $('#dropHint')
  };
  const FILE_ICONS = {
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/>',
    file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>'
  };
  function fileKind(f) {
    const t = f.type || '', n = (f.name || '').toLowerCase();
    if (t.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif)$/.test(n)) return 'image';
    if (t.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/.test(n)) return 'video';
    if (t.startsWith('audio/') || /\.(mp3|m4a|wav|aac|ogg)$/.test(n)) return 'audio';
    if (/pdf|word|excel|spreadsheet|presentation|powerpoint|text/.test(t) || /\.(pdf|docx?|xlsx?|pptx?|txt|csv|rtf|odt|pages|numbers|key)$/.test(n)) return 'doc';
    return 'file';
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
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderBadge() {
    fl.badge.textContent = shared.unread > 9 ? '9+' : String(shared.unread);
    fl.badge.classList.toggle('hidden', !shared.unread);
    fl.btn.classList.toggle('on', shared.open);
  }

  function renderFiles() {
    fl.list.textContent = '';
    fl.empty.classList.toggle('hidden', shared.list.length > 0);
    for (const f of shared.list) {
      const li = document.createElement('li');
      li.className = 'fp-item';
      const ico = document.createElement('span');
      ico.className = 'fp-ico';
      ico.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + FILE_ICONS[fileKind(f)] + '</svg>';
      const meta = document.createElement('div');
      meta.className = 'fp-meta';
      const name = document.createElement('span');
      name.className = 'fp-name';
      name.textContent = f.name; // names come from other people: text only, never HTML
      name.title = f.name;
      const sub = document.createElement('span');
      sub.className = 'fp-sub';
      sub.textContent = [fmtSize(f.size || 0), f.from === local.name && f.mine ? 'You' : f.from, fmtWhen(f.at)].filter(Boolean).join(' · ');
      meta.append(name, sub);
      let action;
      if (f.uploading) {
        const bar = document.createElement('div');
        bar.className = 'fp-bar';
        bar.innerHTML = '<i></i>';
        bar.firstChild.style.width = Math.round((f.progress || 0) * 100) + '%';
        f.barEl = bar.firstChild;
        meta.append(bar);
        action = document.createElement('span');
        action.className = 'fp-state';
        action.textContent = 'Sending';
      } else if (f.failed) {
        action = document.createElement('span');
        action.className = 'fp-state bad';
        action.textContent = 'Not sent';
        action.title = f.failed;
      } else {
        action = document.createElement('a');
        action.className = 'fp-get' + (f.link ? '' : ' wait');
        action.textContent = f.link ? 'Download' : 'Preparing';
        action.target = '_blank'; // never replace the call page
        action.rel = 'noopener';
        if (f.link) { action.href = f.link; action.download = f.name; }
      }
      li.append(ico, meta, action);
      fl.list.append(li);
    }
  }

  function setFilesOpen(open) {
    shared.open = open;
    fl.panel.classList.toggle('hidden', !open);
    if (open) { shared.unread = 0; ensureLinks(); }
    renderBadge();
  }
  fl.btn.addEventListener('click', e => { e.stopPropagation(); setFilesOpen(!shared.open); });
  fl.close.addEventListener('click', () => setFilesOpen(false));
  fl.pick.addEventListener('click', () => { fl.input.value = ''; fl.input.click(); });
  fl.input.addEventListener('change', () => sendFiles([...fl.input.files]));

  function addShared(f, announce) {
    if (!f || !f.path || shared.byPath.has(f.path)) return;
    const item = { path: f.path, name: String(f.name || 'file').slice(0, 120), size: Number(f.size) || 0, type: String(f.type || ''), from: String(f.from || 'Someone').slice(0, 30), at: Number(f.at) || Date.now() };
    shared.byPath.set(item.path, item);
    shared.list.push(item);
    shared.list.sort((a, b) => (b.uploading ? 1 : 0) - (a.uploading ? 1 : 0) || b.at - a.at);
    if (announce) {
      toast(item.from + ' sent ' + item.name);
      if (!shared.open) shared.unread++;
      renderBadge();
    }
    if (shared.open) ensureLinks();
    renderFiles();
  }

  async function loadFiles() {
    if (tvMode || shared.loaded) return;
    shared.loaded = true;
    try {
      const d = await api('/files?room=' + encodeURIComponent(room), 'GET');
      for (const f of d.files || []) addShared(f, false);
    } catch (e) { shared.loaded = false; console.warn('files', e && e.message); }
    renderFiles();
  }

  // Fetch download links for anything that has none, or whose link is getting old.
  let linking = false;
  async function ensureLinks() {
    if (linking) return;
    linking = true;
    try {
      for (const f of shared.list) {
        if (f.uploading || f.failed || !f.path) continue;
        if (f.link && Date.now() - f.linkAt < 45 * 60 * 1000) continue;
        try {
          const d = await api('/files/link?room=' + encodeURIComponent(room) + '&path=' + encodeURIComponent(f.path), 'GET');
          f.link = d.url; f.linkAt = Date.now();
        } catch (e) {
          if (/expired|no longer/i.test(e.message)) { shared.list = shared.list.filter(x => x !== f); shared.byPath.delete(f.path); }
        }
        renderFiles();
      }
    } finally { linking = false; }
  }

  function uploadWithProgress(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      x.setRequestHeader('apikey', cfg.SUPABASE_KEY);
      x.setRequestHeader('x-upsert', 'false');
      x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => x.status < 300 ? resolve() : reject(new Error('upload failed (' + x.status + ')'));
      x.onerror = () => reject(new Error('connection lost'));
      const form = new FormData();
      form.append('cacheControl', '3600');
      form.append('', file, file.name);
      x.send(form);
    });
  }

  async function sendFiles(list) {
    if (!list.length) return;
    if (!shared.open) setFilesOpen(true);
    for (const file of list) {
      if (!file.size) { toast(file.name + ' is empty'); continue; }
      if (file.size > MAX_FILE) { toast(file.name + ' is over 50 MB'); continue; }
      const temp = { name: file.name, size: file.size, type: file.type, from: local.name, mine: true, at: Date.now(), uploading: true, progress: 0 };
      shared.list.unshift(temp);
      renderFiles();
      try {
        const up = await api('/files/upload', 'POST', { room, name: file.name, size: file.size, type: file.type, from: local.name });
        await uploadWithProgress(up.uploadUrl, file, p => { temp.progress = p; if (temp.barEl) temp.barEl.style.width = Math.round(p * 100) + '%'; });
        shared.list = shared.list.filter(x => x !== temp);
        const done = { path: up.path, name: up.name, size: file.size, type: file.type || '', from: local.name, at: Date.now() };
        addShared(done, false);
        const mine = shared.byPath.get(done.path);
        if (mine) mine.mine = true;
        if (channel) channel.send({ type: 'broadcast', event: 'file', payload: done }).catch(() => {});
        ensureLinks();
      } catch (e) {
        temp.uploading = false;
        temp.failed = (e && e.message) || 'failed';
        toast("Couldn't send " + file.name);
        renderFiles();
      }
    }
  }

  // Drag files anywhere onto the call to send them (computers).
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (!joined || tvMode || !hasFiles(e)) return; e.preventDefault(); dragDepth++; fl.drop.classList.remove('hidden'); });
  window.addEventListener('dragover', e => { if (!joined || tvMode || !hasFiles(e)) return; e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) fl.drop.classList.add('hidden'); });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    fl.drop.classList.add('hidden');
    if (joined && !tvMode) sendFiles([...e.dataTransfer.files]);
  });
  // Keep "5 min ago" honest while the panel is open.
  setInterval(() => { if (shared.open && !shared.list.some(f => f.uploading)) renderFiles(); }, 60000);

  // ---------- sharing: the screen, or photos and videos from this device ----------
  // Both go out the same way, as a "screen" track, so viewers and TVs treat them alike.
  const shareMenu = $('#shareMenu'), mediaInput = $('#mediaInput'), pool = $('#presenterPool');
  const pb = {
    bar: $('#presentBar'), label: $('#pbLabel'), media: $('#pbMedia'), count: $('#pbCount'),
    prev: $('#pbPrev'), next: $('#pbNext'), play: $('#pbPlay'), add: $('#pbAdd'), tv: $('#pbTv'), stop: $('#pbStop'),
    live: $('#pbLive'), flip: $('#pbFlip')
  };
  let presenter = null, mediaAppend = false, videoHintShown = false;

  function onShareClick(e) {
    e.stopPropagation();
    if (local.screen) { stopShare(); return; }
    shareMenu.classList.toggle('hidden');
    if (typeof setFilesOpen === 'function' && shared.open) setFilesOpen(false);
  }
  document.addEventListener('click', e => { if (!shareMenu.contains(e.target)) shareMenu.classList.add('hidden'); });
  $('#shareScreenOpt').addEventListener('click', () => { shareMenu.classList.add('hidden'); startScreenShare(); });
  $('#shareMediaOpt').addEventListener('click', () => { shareMenu.classList.add('hidden'); pickMedia(false); });
  $('#shareLiveOpt').addEventListener('click', () => { shareMenu.classList.add('hidden'); startLiveShare(); });
  if (!canScreen) $('#shareScreenOpt').classList.add('hidden');

  function pickMedia(append) {
    ensureAudioContext(); // inside the tap, so iPhones allow the sound later
    mediaAppend = append;
    mediaInput.value = '';
    mediaInput.click();
  }
  const VIDEO_EXT = /\.(mp4|mov|m4v|webm|3gp)$/i, IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i;
  mediaInput.addEventListener('change', () => {
    const files = [...mediaInput.files].filter(f => /^(image|video)\//.test(f.type) || VIDEO_EXT.test(f.name) || IMAGE_EXT.test(f.name));
    if (!files.length) return;
    if (mediaAppend && presenter) presenterAdd(files); else startMediaShare(files);
  });

  async function startScreenShare() {
    if (local.screen) return;
    let s;
    try { s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: true }); }
    catch (e) { if (e.name !== 'NotAllowedError') toast('Could not share your screen'); return; }
    const vt = s.getVideoTracks()[0];
    if (vt) { vt.contentHint = 'detail'; vt.addEventListener('ended', stopShare); }
    beginShare(s, 'screen');
  }

  function startMediaShare(files) {
    if (local.screen) return;
    presenter = presenterCreate();
    beginShare(presenter.stream, 'media');
    presenterAdd(files);
  }

  async function beginShare(s, kind) {
    local.screen = s;
    local.shareKind = kind;
    local.screenName = 'screen-' + (++sfu.screenSeq) + '-' + myId.slice(0, 4);
    setTileStream('local:screen', s, null, 'screen');
    applyMediaButtons();
    updatePresentBar();
    render();
    const entries = s.getTracks().map(t => ({
      track: t,
      name: t.kind === 'video' ? local.screenName : local.screenName + '-audio',
      init: t.kind === 'video' ? { sendEncodings: [{ maxBitrate: 2500000 }] } : {}
    }));
    try { await publishLocal(entries); }
    catch (e) { console.warn('share', e); toast('Could not start sharing'); stopShare(); }
  }

  function stopShare() {
    const s = local.screen;
    if (!s) return;
    const name = local.screenName;
    const kind = local.shareKind;
    local.screen = null; local.screenName = null; local.shareKind = null;
    s.getTracks().forEach(t => t.stop());
    stopPresenter();
    if (kind === 'live') endLive();
    removeTile('local:screen');
    applyMediaButtons();
    updatePresentBar();
    render();
    unpublishLocal([name, name + '-audio']).catch(e => console.warn('unshare', e));
  }

  // ---------- presenter bar ----------
  function updatePresentBar() {
    const sharing = !!local.screen;
    pb.bar.classList.toggle('hidden', !sharing);
    if (!sharing) return;
    const media = local.shareKind === 'media' && !!presenter;
    const live = local.shareKind === 'live';
    pb.media.classList.toggle('hidden', !media);
    pb.live.classList.toggle('hidden', !live);
    pb.label.textContent = media ? "You're presenting" : live ? "You're sharing live video" : "You're sharing your screen";
    pb.tv.classList.toggle('on', local.tvFull);
    pb.tv.setAttribute('aria-pressed', local.tvFull ? 'true' : 'false');
    if (!media) return;
    const it = presenter.items[presenter.index];
    pb.count.textContent = presenter.items.length ? (presenter.index + 1) + ' / ' + presenter.items.length : '';
    pb.prev.disabled = presenter.index <= 0;
    pb.next.disabled = presenter.index >= presenter.items.length - 1;
    const isVideo = !!it && it.kind === 'video';
    pb.play.classList.toggle('hidden', !isVideo);
    pb.play.classList.toggle('paused', isVideo && it.el.paused);
  }
  pb.prev.addEventListener('click', () => presenter && presenterShow(presenter.index - 1));
  pb.next.addEventListener('click', () => presenter && presenterShow(presenter.index + 1));
  pb.add.addEventListener('click', () => pickMedia(true));
  pb.stop.addEventListener('click', stopShare);
  pb.flip.addEventListener('click', flipLive);
  pb.play.addEventListener('click', () => {
    const it = presenter && presenter.items[presenter.index];
    if (!it || it.kind !== 'video') return;
    if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
    if (it.el.paused) { if (it.el.ended) it.el.currentTime = 0; it.el.play().catch(() => toast('Tap play again to start the video')); }
    else it.el.pause();
  });
  pb.tv.addEventListener('click', () => {
    local.tvFull = !local.tvFull;
    try { localStorage.setItem('gather.tvfull', local.tvFull ? '1' : '0'); } catch {}
    updatePresentBar();
    updatePresence();
    toast(local.tvFull ? 'TVs now show your share full screen' : 'TVs now show everyone beside your share');
  });

  // ---------- live video from this device's camera ----------
  // The camera goes out as the shared picture: big for everyone, full screen on
  // TVs. Phones can only run one camera at a time, and sending the same picture
  // twice would waste the phone's upload, so the face tile pauses meanwhile.
  const liveConstraints = facing => ({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } });
  let wakeLock = null, liveCamBefore = null, standIn = null;

  // A tiny black picture for the face-camera slot while the camera is shared live.
  // Sending nothing would get the track deleted by Cloudflare after 30 seconds.
  function blackTrack() {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 180;
    const x = c.getContext('2d');
    const paint = () => { x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); };
    paint();
    const track = c.captureStream(2).getVideoTracks()[0];
    const timer = setInterval(paint, 500);
    return { track, stop() { clearInterval(timer); track.stop(); } };
  }

  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && local.shareKind === 'live') keepAwake(true); });

  function camSender() {
    const mid = sfu.localMids.get('cam');
    const tr = sfu.push.pc && mid ? sfu.push.pc.getTransceivers().find(t => t.mid === mid) : null;
    return tr ? tr.sender : null;
  }

  function wireLiveTrack(t) {
    t.contentHint = 'motion';
    // The camera can be taken away (a phone call, another app): end the share cleanly.
    t.addEventListener('ended', () => { if (local.shareKind === 'live' && local.screen && local.screen.getVideoTracks()[0] === t) stopShare(); });
  }

  async function startLiveShare() {
    if (local.screen) return;
    // Release the face camera first: phones cannot open a second camera while one is running.
    liveCamBefore = { facing: local.facing, on: local.camOn };
    local.liveCam = true;
    const sender = camSender();
    if (sender) { standIn = blackTrack(); try { await sender.replaceTrack(standIn.track); } catch {} }
    if (local.video) { local.cam.removeTrack(local.video); local.video.stop(); local.video = null; }
    applyMediaButtons();
    updatePresence();
    let s = null;
    local.liveFacing = 'environment';
    try { s = await navigator.mediaDevices.getUserMedia(liveConstraints('environment')); }
    catch (e) {
      try { s = await navigator.mediaDevices.getUserMedia(liveConstraints('user')); local.liveFacing = 'user'; } catch {}
    }
    if (!s) { toast('Could not open the camera'); await endLive(); return; }
    const vt = s.getVideoTracks()[0];
    wireLiveTrack(vt);
    await beginShare(new MediaStream([vt]), 'live');
    keepAwake(true);
    if (isTouch && innerHeight > innerWidth) toast('Turn your phone sideways to fill the TV');
  }

  async function flipLive() {
    if (local.shareKind !== 'live' || !local.screen) return;
    const old = local.screen.getVideoTracks()[0];
    const want = local.liveFacing === 'environment' ? 'user' : 'environment';
    if (old) { local.screen.removeTrack(old); old.stop(); } // one camera at a time on phones
    let s = null, facing = want;
    try { s = await navigator.mediaDevices.getUserMedia(liveConstraints(want)); }
    catch {
      toast('Could not switch camera');
      facing = local.liveFacing;
      try { s = await navigator.mediaDevices.getUserMedia(liveConstraints(facing)); } catch {}
    }
    if (!s) { stopShare(); return; }
    const nt = s.getVideoTracks()[0];
    wireLiveTrack(nt);
    local.screen.addTrack(nt);
    local.liveFacing = facing;
    const mid = sfu.localMids.get(local.screenName);
    const tr = sfu.push.pc && mid ? sfu.push.pc.getTransceivers().find(t => t.mid === mid) : null;
    if (tr) { try { await tr.sender.replaceTrack(nt); } catch (e) { console.warn('flip live', e); } }
    setTileStream('local:screen', local.screen, null, 'screen');
  }

  // After a live share: bring the face camera back as it was.
  async function endLive() {
    keepAwake(false);
    const before = liveCamBefore || { facing: 'user', on: true };
    liveCamBefore = null;
    if (!local.liveCam) return;
    local.facing = before.facing;
    let s = null;
    try { s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() }); } catch {}
    local.liveCam = false;
    if (s) {
      const nt = s.getVideoTracks()[0];
      nt.contentHint = 'motion';
      nt.enabled = before.on;
      local.cam.addTrack(nt);
      local.video = nt;
      local.camOn = before.on;
      const sender = camSender();
      if (sender) { try { await sender.replaceTrack(nt); } catch (e) { console.warn('camera back', e); } }
      if (standIn) { standIn.stop(); standIn = null; }
    } else {
      toast('Could not turn your camera back on'); // the black stand-in keeps the slot alive meanwhile
    }
    applyMediaButtons();
    updatePresence();
  }

  // ---------- photo and video presenter ----------
  // Draws the chosen photo or video onto a 720p canvas and sends the canvas as
  // the shared screen. Video sound is routed to everyone else, not this device.
  const PW = 1280, PH = 720, FPS = 24;

  function presenterCreate() {
    const canvas = document.createElement('canvas');
    canvas.width = PW; canvas.height = PH;
    pool.appendChild(canvas); // some phones only capture canvases that are in the page
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, PW, PH);
    const stream = canvas.captureStream(FPS);
    // Video sound goes out on its own track, but only once audio is actually
    // running: a stalled track carries no data and viewers would keep retrying it.
    let dest = null;
    try {
      ensureAudioContext();
      if (actx && actx.state === 'running') { dest = actx.createMediaStreamDestination(); stream.addTrack(dest.stream.getAudioTracks()[0]); }
    } catch (e) { console.warn('presenter audio', e); }
    // An audio stream with nothing feeding it sends no packets at all, and Cloudflare
    // deletes a track that sends nothing for 30 seconds; pulling it after that stalls
    // the receiver's whole session. A silent source keeps packets flowing.
    let keep = null;
    if (dest) { try { keep = actx.createConstantSource(); keep.offset.value = 0; keep.connect(dest); keep.start(); } catch {} }
    const p = { canvas, ctx, stream, dest, keep, items: [], index: -1, tick: 0, last: null, timer: null };
    p.timer = setInterval(() => presenterDraw(p), 1000 / FPS);
    return p;
  }

  function presenterAdd(files) {
    const p = presenter;
    if (!p) return;
    const first = p.items.length;
    for (const f of files) {
      const url = URL.createObjectURL(f);
      const isVideo = (f.type || '').startsWith('video/') || (!f.type && VIDEO_EXT.test(f.name));
      const item = { kind: isVideo ? 'video' : 'image', url, el: null, frame: null, audio: null };
      if (isVideo) {
        const v = document.createElement('video');
        v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
        v.src = url;
        for (const ev of ['play', 'pause', 'ended']) v.addEventListener(ev, updatePresentBar);
        pool.appendChild(v); // iPhones only decode video that is in the page
        item.el = v;
      } else {
        const img = new Image();
        img.onload = () => { item.frame = fitFrame(img, img.naturalWidth, img.naturalHeight); };
        img.onerror = () => { item.failed = true; toast("That photo couldn't be opened"); };
        img.src = url;
        item.el = img;
      }
      p.items.push(item);
    }
    presenterShow(first);
  }

  function fitRect(sw, sh) {
    const s = Math.min(PW / sw, PH / sh), w = sw * s, h = sh * s;
    return [(PW - w) / 2, (PH - h) / 2, w, h];
  }
  // Photos are scaled once into a 720p frame, so each redraw is a cheap copy.
  function fitFrame(src, sw, sh) {
    const c = document.createElement('canvas');
    c.width = PW; c.height = PH;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, PW, PH);
    x.imageSmoothingQuality = 'high';
    const [dx, dy, dw, dh] = fitRect(sw, sh);
    x.drawImage(src, dx, dy, dw, dh);
    return c;
  }

  function presenterDraw(p) {
    const it = p.items[p.index];
    const ctx = p.ctx;
    p.tick++;
    if (!it || (it.kind === 'image' && !it.frame)) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, PW, PH); return; }
    if (it.kind === 'image') {
      // A still photo only needs a few frames a second, so newcomers get a picture.
      if (p.last === it && p.tick % 6) return;
      ctx.drawImage(it.frame, 0, 0);
    } else {
      const v = it.el;
      if (v.readyState < 2 || !v.videoWidth) return;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, PW, PH);
      const [dx, dy, dw, dh] = fitRect(v.videoWidth, v.videoHeight);
      ctx.drawImage(v, dx, dy, dw, dh);
    }
    p.last = it;
  }

  function presenterShow(i) {
    const p = presenter;
    if (!p || !p.items.length) return;
    i = Math.max(0, Math.min(p.items.length - 1, i));
    const prev = p.items[p.index];
    if (prev && prev.kind === 'video' && i !== p.index) prev.el.pause();
    p.index = i;
    p.last = null;
    const it = p.items[i];
    const vt = p.stream.getVideoTracks()[0];
    if (vt) vt.contentHint = it.kind === 'video' ? 'motion' : 'detail';
    if (it.kind === 'video') {
      if (!it.audio && actx && p.dest) {
        try { it.audio = actx.createMediaElementSource(it.el); it.audio.connect(p.dest); }
        catch (e) { console.warn('video sound', e); }
      }
      if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
      it.el.play().catch(() => updatePresentBar());
      if (!videoHintShown && it.audio) { videoHintShown = true; toast('Video sound plays for everyone else'); }
    }
    updatePresentBar();
  }

  function stopPresenter() {
    const p = presenter;
    if (!p) return;
    presenter = null;
    clearInterval(p.timer);
    for (const it of p.items) {
      if (it.kind === 'video') {
        it.el.pause();
        try { if (it.audio) it.audio.disconnect(); } catch {}
        it.el.removeAttribute('src');
        it.el.load();
        it.el.remove();
      }
      URL.revokeObjectURL(it.url);
    }
    try { if (p.keep) { p.keep.stop(); p.keep.disconnect(); } } catch {}
    try { if (p.dest) p.dest.disconnect(); } catch {}
    p.canvas.remove();
  }

  async function flipCamera() {
    const facing = local.facing === 'user' ? 'environment' : 'user';
    let s;
    try { s = await navigator.mediaDevices.getUserMedia({ video: Object.assign(videoConstraints(), { facingMode: facing }) }); }
    catch { toast('Could not switch camera'); return; }
    const nt = s.getVideoTracks()[0];
    const old = local.video;
    nt.enabled = local.camOn;
    nt.contentHint = 'motion';
    const mid = sfu.localMids.get('cam');
    const tr = sfu.push.pc && mid ? sfu.push.pc.getTransceivers().find(t => t.mid === mid) : null;
    if (tr) { try { await tr.sender.replaceTrack(nt); } catch (e) { console.warn('flip', e); } }
    if (old) { local.cam.removeTrack(old); old.stop(); }
    local.cam.addTrack(nt);
    local.video = nt;
    local.facing = facing;
    updateLocalTile();
  }

  window.addEventListener('pagehide', () => { if (channel) { try { channel.untrack(); } catch {} } });

  setupPrejoin();
})();
