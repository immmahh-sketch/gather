/* Gather – call page.
 *
 * Every participant connects directly to every other participant (a WebRTC mesh).
 * Supabase Realtime is only the meeting point: presence says who is in the room,
 * and broadcast carries the offers, answers and ICE candidates between browsers.
 * Nothing about the call itself passes through Supabase.
 */
(() => {
  'use strict';
  const cfg = window.GATHER_CONFIG || {};
  const $ = (s, el = document) => el.querySelector(s);

  // ---------- room ----------
  const slug = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const room = slug(new URLSearchParams(location.search).get('room'));
  if (!room) { location.replace('./'); return; }
  const roomLink = location.origin + location.pathname + '?room=' + encodeURIComponent(room);
  document.title = room + ' · Gather';

  const myId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  const isTouch = matchMedia('(pointer: coarse)').matches;
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  const ICON = {
    micOff: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
  };

  // ---------- state ----------
  const local = { name: '', cam: new MediaStream(), audio: null, video: null, screen: null, facing: 'user', micOn: true, camOn: true, permissionError: null };
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
  $('#roomName').textContent = room;
  $('#preRoom').textContent = room;
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

  // ---------- local media ----------
  const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const videoConstraints = () => ({ width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: local.facing });

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
    for (const b of [el.camBtn, el.preCam]) { b.classList.toggle('off', !local.camOn || !local.video); b.disabled = !local.video; b.title = local.video ? (local.camOn ? 'Camera off (V)' : 'Camera on (V)') : 'No camera'; }
    el.previewWrap.classList.toggle('no-video', !(local.video && local.camOn));
    el.shareBtn.classList.toggle('on', !!local.screen);
    el.shareBtn.title = local.screen ? 'Stop sharing' : 'Share your screen';
    updateLocalTile();
  }

  function setMic(on) { local.micOn = on; if (local.audio) local.audio.enabled = on; applyMediaButtons(); updatePresence(); }
  function setCam(on) { local.camOn = on; if (local.video) local.video.enabled = on; applyMediaButtons(); updatePresence(); }

  async function setupPrejoin() {
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
  }

  el.nameInput.addEventListener('input', () => {
    el.preAvatar.textContent = initial(el.nameInput.value || '?');
    el.preAvatar.style.setProperty('--c', colorFor(el.nameInput.value || 'x'));
  });
  el.nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
  el.preMic.addEventListener('click', () => setMic(!local.micOn));
  el.preCam.addEventListener('click', () => setCam(!local.camOn));
  el.joinBtn.addEventListener('click', join);

  // ---------- join / leave ----------
  function ensureAudioContext() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume().catch(() => {});
    } catch {}
  }

  function join() {
    if (joined) return;
    local.name = el.nameInput.value.trim().slice(0, 30) || 'Guest';
    try { localStorage.setItem('gather.name', local.name); } catch {}
    joined = true;
    ensureAudioContext();
    el.prejoin.classList.add('hidden');
    el.call.classList.remove('hidden');
    addLocalTile();
    applyMediaButtons();
    startTimer();
    render();
    connect();
  }

  function leave() {
    if (!joined) return;
    joined = false;
    clearInterval(timerIv);
    for (const id of [...peers.keys()]) removePeer(id, false);
    stopShare();
    for (const t of local.cam.getTracks()) t.stop();
    if (channel) { channel.untrack().catch(() => {}); supa.removeChannel(channel); }
    channel = null;
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

  // ---------- signalling (Supabase Realtime) ----------
  function presencePayload() {
    return {
      name: local.name,
      mic: !!(local.audio && local.micOn),
      cam: !!(local.video && local.camOn),
      screen: local.screen ? local.screen.id : null
    };
  }
  function updatePresence() { if (channel && joined && everSubscribed) channel.track(presencePayload()).catch(() => {}); }

  function connect() {
    supa = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, { realtime: { params: { eventsPerSecond: 50 } } });
    channel = supa.channel('call-' + room, { config: { presence: { key: myId }, broadcast: { self: false } } });
    channel
      .on('presence', { event: 'sync' }, onPresenceSync)
      .on('presence', { event: 'leave' }, ({ key, currentPresences }) => {
        if (key !== myId && !(currentPresences && currentPresences.length)) removePeer(key, true);
      })
      .on('broadcast', { event: 'signal' }, ({ payload }) => {
        if (payload && payload.to === myId && payload.from) onSignal(payload).catch(e => console.warn('signal', e));
      })
      .subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          if (everSubscribed) for (const id of [...peers.keys()]) removePeer(id, false); // rebuild after a reconnect
          everSubscribed = true;
          setNet('');
          await channel.track(presencePayload());
        } else if (joined && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')) {
          setNet('Reconnecting…');
        }
      });
  }

  function send(to, data) {
    if (!channel) return;
    channel.send({ type: 'broadcast', event: 'signal', payload: Object.assign({ from: myId, to }, data) }).catch(() => {});
  }

  function onPresenceSync() {
    const state = channel.presenceState();
    for (const [id, metas] of Object.entries(state)) {
      if (id === myId) continue;
      const meta = metas[metas.length - 1] || {};
      let p = peers.get(id);
      if (!p) p = createPeer(id);
      const wasSeen = p.seen; p.seen = true;
      p.state = { name: String(meta.name || 'Guest').slice(0, 30), mic: meta.mic !== false, cam: meta.cam !== false, screen: meta.screen || null };
      if (p.state.screen) p.screenIds.add(p.state.screen);
      // The peer with the larger id makes the first offer; the other waits for it.
      if (!p.pc && myId > id) createPC(p, true);
      if (!wasSeen) toast(p.state.name + ' joined');
      classify(p);
    }
    for (const [id, p] of peers) if (p.seen && !state[id]) removePeer(id, true);
    render();
  }

  // ---------- peers ----------
  function createPeer(id) {
    const p = {
      id, pc: null, polite: myId < id, makingOffer: false, ignoreOffer: false, seen: false, addedLocal: false,
      state: { name: 'Guest', mic: true, cam: true, screen: null },
      streams: new Map(), screenIds: new Set(), cands: [], candTimer: null, pending: [], failTimer: null
    };
    peers.set(id, p);
    setTileStream(id + ':cam', null, p, 'cam');
    return p;
  }

  function createPC(p, initiator) {
    const pc = new RTCPeerConnection({ iceServers: cfg.ICE_SERVERS || [] });
    p.pc = pc;
    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        send(p.id, { description: pc.localDescription });
      } catch (e) { console.warn('offer', e); }
      finally { p.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) queueCandidate(p, candidate.toJSON()); else flushCandidates(p); };
    pc.ontrack = e => onTrack(p, e);
    pc.onconnectionstatechange = () => onConnState(p);
    if (initiator) {
      pc.addTransceiver(local.audio || 'audio', { direction: 'sendrecv', streams: [local.cam] });
      pc.addTransceiver(local.video || 'video', { direction: 'sendrecv', streams: [local.cam], sendEncodings: [{ maxBitrate: 1200000 }] });
      if (local.screen) for (const t of local.screen.getTracks()) pc.addTrack(t, local.screen);
      p.addedLocal = true;
    }
    updatePeerTiles(p);
  }

  // Called by the answering side once the first offer has arrived: addTrack reuses
  // the transceivers the offer created, so no extra renegotiation is needed.
  function addLocalTracks(p) {
    if (p.addedLocal || !p.pc) return;
    p.addedLocal = true;
    for (const t of local.cam.getTracks()) p.pc.addTrack(t, local.cam);
    if (local.screen) for (const t of local.screen.getTracks()) p.pc.addTrack(t, local.screen);
  }

  function closePC(p) {
    if (p.pc) {
      p.pc.onnegotiationneeded = p.pc.onicecandidate = p.pc.ontrack = p.pc.onconnectionstatechange = null;
      try { p.pc.close(); } catch {}
      p.pc = null;
    }
    p.addedLocal = false; p.makingOffer = false; p.ignoreOffer = false;
    p.streams.clear(); p.pending = []; p.cands = [];
    clearTimeout(p.candTimer); p.candTimer = null;
    clearTimeout(p.failTimer); p.failTimer = null;
    removeTile(p.id + ':screen');
    setTileStream(p.id + ':cam', null, p, 'cam');
  }

  function removePeer(id, announce) {
    const p = peers.get(id);
    if (!p) return;
    closePC(p);
    removeTile(id + ':cam');
    removeTile(id + ':screen');
    peers.delete(id);
    if (announce && p.seen) toast(p.state.name + ' left');
    render();
  }

  function onConnState(p) {
    if (!p.pc) return;
    const s = p.pc.connectionState;
    updatePeerTiles(p);
    if (s === 'connected') { clearTimeout(p.failTimer); p.failTimer = null; tuneSenders(p); }
    if (s === 'failed') {
      try { p.pc.restartIce(); } catch {}
      clearTimeout(p.failTimer);
      p.failTimer = setTimeout(() => {
        if (p.pc && p.pc.connectionState !== 'connected' && myId > p.id) { closePC(p); createPC(p, true); }
      }, 8000);
    }
  }

  function tuneSenders(p) {
    if (!p.pc) return;
    for (const s of p.pc.getSenders()) {
      if (!s.track || s.track.kind !== 'video') continue;
      const isScreen = local.screen && local.screen.getTracks().includes(s.track);
      setMaxBitrate(s, isScreen ? 2500000 : 1200000);
    }
  }
  function setMaxBitrate(sender, bps) {
    try {
      const prm = sender.getParameters();
      if (!prm.encodings || !prm.encodings.length) return;
      if (prm.encodings[0].maxBitrate === bps) return;
      prm.encodings[0].maxBitrate = bps;
      sender.setParameters(prm).catch(() => {});
    } catch {}
  }

  // Perfect negotiation (https://w3c.github.io/webrtc-pc/#perfect-negotiation-example)
  async function onSignal(msg) {
    let p = peers.get(msg.from);
    if (!p) p = createPeer(msg.from);
    if (msg.description) {
      const d = msg.description;
      if (!p.pc) { if (d.type !== 'offer') return; createPC(p, false); }
      const pc = p.pc;
      const collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(d);
      for (const c of p.pending.splice(0)) await addCand(p, c);
      if (d.type === 'offer') {
        addLocalTracks(p);
        await pc.setLocalDescription();
        send(p.id, { description: pc.localDescription });
        tuneSenders(p);
      }
    }
    if (msg.candidates) {
      for (const c of msg.candidates) {
        if (p.pc && p.pc.remoteDescription) await addCand(p, c); else p.pending.push(c);
      }
    }
  }
  async function addCand(p, c) {
    try { await p.pc.addIceCandidate(c); } catch (e) { if (!p.ignoreOffer) console.warn('ice', e); }
  }
  function queueCandidate(p, c) {
    p.cands.push(c);
    if (!p.candTimer) p.candTimer = setTimeout(() => flushCandidates(p), 120);
  }
  function flushCandidates(p) {
    clearTimeout(p.candTimer); p.candTimer = null;
    if (p.cands.length) send(p.id, { candidates: p.cands.splice(0) });
  }

  // ---------- incoming media ----------
  function onTrack(p, e) {
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (!p.streams.has(stream.id)) {
      p.streams.set(stream.id, stream);
      stream.addEventListener('removetrack', () => {
        if (!stream.getTracks().length) { p.streams.delete(stream.id); classify(p); }
      });
    }
    e.track.addEventListener('mute', () => updatePeerTiles(p));
    e.track.addEventListener('unmute', () => updatePeerTiles(p));
    e.track.addEventListener('ended', () => classify(p));
    classify(p);
  }

  // Decide which of a peer's streams is the camera and which is a shared screen.
  function classify(p) {
    const screenId = p.state.screen;
    let cam = null, screen = null;
    for (const s of p.streams.values()) {
      if (screenId && s.id === screenId) { screen = s; p.screenIds.add(s.id); }
      else if (p.screenIds.has(s.id)) continue;
      else if (!cam) cam = s;
    }
    setTileStream(p.id + ':cam', cam, p, 'cam');
    if (screen) setTileStream(p.id + ':screen', screen, p, 'screen'); else removeTile(p.id + ':screen');
    updatePeerTiles(p);
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
      if (stream) t.video.play().catch(() => {});
    }
    if (stream) watchAudio(id, stream, t.el);
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
    const connected = !!p.pc && (p.pc.connectionState === 'connected' || p.pc.connectionState === 'completed');
    const cam = tiles.get(p.id + ':cam');
    if (cam) setTileInfo(cam, { label: p.state.name, name: p.state.name, muted: !p.state.mic, noVideo: !(p.state.cam && videoLive(cam.stream)), connecting: !connected });
    const scr = tiles.get(p.id + ':screen');
    if (scr) setTileInfo(scr, { label: p.state.name + "'s screen", name: p.state.name, muted: false, noVideo: !videoLive(scr.stream), connecting: false });
  }
  function addLocalTile() {
    setTileStream('local:cam', local.cam, null, 'cam');
    updateLocalTile();
  }
  function updateLocalTile() {
    const t = tiles.get('local:cam');
    if (!t) return;
    setTileInfo(t, { label: 'You', name: local.name || el.nameInput.value || '?', muted: !(local.audio && local.micOn), noVideo: !(local.video && local.camOn && videoLive(local.cam)), connecting: false, mirror: local.facing === 'user' });
    const s = tiles.get('local:screen');
    if (s) setTileInfo(s, { label: 'Your screen', name: local.name, muted: false, noVideo: !videoLive(s.stream), connecting: false });
  }

  function render() {
    const all = [...tiles.values()];
    let stageId = pinned && tiles.has(pinned) ? pinned : null;
    if (!stageId) {
      const shared = all.filter(t => t.kind === 'screen' && !t.self);
      if (shared.length) stageId = shared[shared.length - 1].id;
    }
    el.call.classList.toggle('has-stage', !!stageId);
    for (const t of all) {
      const target = t.id === stageId ? el.stage : (stageId ? el.strip : el.grid);
      if (t.el.parentNode !== target) { target.appendChild(t.el); if (t.stream) t.video.play().catch(() => {}); }
      t.el.classList.toggle('pinned', pinned === t.id);
    }
    const n = el.grid.children.length;
    const portrait = innerHeight > innerWidth;
    const cols = n <= 1 ? 1 : n <= 2 ? (portrait ? 1 : 2) : n <= 4 ? 2 : n <= 6 ? (portrait ? 2 : 3) : n <= 9 ? 3 : 4;
    el.grid.style.setProperty('--cols', cols);
    el.count.textContent = peers.size + 1;
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
  el.shareBtn.addEventListener('click', () => local.screen ? stopShare() : startShare());
  el.flipBtn.addEventListener('click', flipCamera);
  document.addEventListener('keydown', e => {
    if (!joined || e.target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'm' || e.key === 'M') setMic(!local.micOn);
    if (e.key === 'v' || e.key === 'V') setCam(!local.camOn);
  });

  async function shareLink() {
    if (navigator.share && isTouch) {
      try { await navigator.share({ title: 'Join my video call', text: 'Join my video call', url: roomLink }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(roomLink); toast('Link copied'); }
    catch { prompt('Copy this link', roomLink); }
  }

  async function startShare() {
    if (local.screen) return;
    let s;
    try { s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: true }); }
    catch (e) { if (e.name !== 'NotAllowedError') toast('Could not share your screen'); return; }
    local.screen = s;
    const vt = s.getVideoTracks()[0];
    if (vt) { vt.contentHint = 'detail'; vt.addEventListener('ended', stopShare); }
    updatePresence(); // tell everyone which stream id is the screen before the tracks arrive
    for (const p of peers.values()) {
      if (!p.pc) continue;
      for (const t of s.getTracks()) p.pc.addTrack(t, s);
    }
    setTileStream('local:screen', s, null, 'screen');
    applyMediaButtons();
    render();
  }

  function stopShare() {
    const s = local.screen;
    if (!s) return;
    local.screen = null;
    for (const p of peers.values()) {
      if (!p.pc) continue;
      for (const sender of p.pc.getSenders()) {
        if (sender.track && s.getTracks().includes(sender.track)) { try { p.pc.removeTrack(sender); } catch {} }
      }
    }
    s.getTracks().forEach(t => t.stop());
    removeTile('local:screen');
    updatePresence();
    applyMediaButtons();
    render();
  }

  async function flipCamera() {
    const facing = local.facing === 'user' ? 'environment' : 'user';
    let s;
    try { s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } }); }
    catch { toast('Could not switch camera'); return; }
    const nt = s.getVideoTracks()[0];
    const old = local.video;
    nt.enabled = local.camOn;
    nt.contentHint = 'motion';
    for (const p of peers.values()) {
      if (!p.pc) continue;
      const sender = p.pc.getSenders().find(x => x.track === old);
      if (sender) { try { await sender.replaceTrack(nt); } catch {} }
    }
    if (old) { local.cam.removeTrack(old); old.stop(); }
    local.cam.addTrack(nt);
    local.video = nt;
    local.facing = facing;
    updateLocalTile();
  }

  window.addEventListener('pagehide', () => { if (channel) { try { channel.untrack(); } catch {} } });

  setupPrejoin();
})();
