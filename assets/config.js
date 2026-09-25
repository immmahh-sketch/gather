// Gather – shared configuration.
window.GATHER_CONFIG = {
  // Supabase Realtime is the meeting point: presence says who is in a room and
  // which Cloudflare session they hold. No call data goes through it.
  SUPABASE_URL: 'https://safcrtrfdzsnftghibot.supabase.co',
  SUPABASE_KEY: 'sb_publishable_RGaIB8W145BFCWzOxamQvA_7VIkTHMU',

  // The gather-rtc edge function fronts Cloudflare Realtime: it forwards the
  // SFU session API and hands out TURN credentials. See the README to set it up.
  RTC_ENDPOINT: 'https://safcrtrfdzsnftghibot.supabase.co/functions/v1/gather-rtc',

  // SHA-256 of the site password. The pages check it to let you in; the call
  // server checks the password itself, so this hash alone opens nothing.
  PASSWORD_HASH: '37a93333f5e00c951a2d37baf6a5b480d44b3c2db300f117eb36669a8f2cef4f',
  // SHA-256 of the quiz night password. It opens the quiz page (calls only);
  // the site password works there too.
  QUIZ_PASSWORD_HASH: '252721522b1bc367143955a6dc7efe9f776ba008b4352477fa6f3d219bdb2450',

  // STUN lets a device learn its public address. Free and public.
  ICE_SERVERS: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ]
};
