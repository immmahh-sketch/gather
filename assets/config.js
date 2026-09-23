// Gather – shared configuration.
// Supabase Realtime is only used as the signalling channel (who is in the room,
// and passing WebRTC offers/answers between browsers). No call data goes through it.
window.GATHER_CONFIG = {
  SUPABASE_URL: 'https://safcrtrfdzsnftghibot.supabase.co',
  SUPABASE_KEY: 'sb_publishable_RGaIB8W145BFCWzOxamQvA_7VIkTHMU',

  // STUN finds a direct route between devices. TURN relays the call when a
  // direct route is impossible (some mobile networks, strict office firewalls).
  ICE_SERVERS: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};
