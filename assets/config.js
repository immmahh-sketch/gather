// Gather – shared configuration.
// Supabase Realtime is only used as the signalling channel (who is in the room,
// and passing WebRTC offers/answers between browsers). No call data goes through it.
window.GATHER_CONFIG = {
  SUPABASE_URL: 'https://safcrtrfdzsnftghibot.supabase.co',
  SUPABASE_KEY: 'sb_publishable_RGaIB8W145BFCWzOxamQvA_7VIkTHMU',

  // STUN lets two devices find a direct route to each other. Free and public.
  ICE_SERVERS: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ],

  // TURN relays the call when no direct route exists (some mobile networks and
  // strict firewalls). Credentials come from the gather-turn edge function, which
  // mints them from Cloudflare. If it is not deployed yet the app carries on with
  // STUN only, which works for most home connections.
  TURN_ENDPOINT: 'https://safcrtrfdzsnftghibot.supabase.co/functions/v1/gather-turn'
};
