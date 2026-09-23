# Gather

Video calls for friends and family. No accounts, nothing to install, works on phones and computers.

Live at https://immmahh-sketch.github.io/gather/

## How it works

- `index.html` – home: start a new call, your permanent room link, or join with a link.
- `call.html?room=<name>` – the call itself. Any room name works; a permanent link is just a room name you keep using.
- Calls are WebRTC, device to device (a mesh, so every person connects to every other person). Fine for up to about six people.
- Supabase Realtime is only the signalling channel (presence for who is in the room, broadcast for offers/answers/ICE). No call data passes through it and nothing is stored. Shares the Supabase project used by the other apps; channel names are `call-<room>`.

## Features

- Camera, microphone, mute and camera-off, front/back camera switch on phones.
- Screen sharing from desktop browsers and Android Chrome. Shared screens go full-size for everyone else; pin any tile to make it big.
- Who-is-speaking highlight, join/leave notices, call timer, invite button (native share sheet on phones, copies the link elsewhere).
- Keyboard: `M` mute, `V` camera.

## Connectivity: STUN and TURN

STUN (Google and Cloudflare, free, already configured in `assets/config.js`) lets two devices find a direct route. That works for most home broadband and wifi.

TURN relays the call when a direct route is impossible, which happens on some mobile networks and strict office firewalls. The free public relays that used to exist have shut down, so the app is set up to fetch TURN credentials from a small Supabase edge function (`supabase/functions/gather-turn`) that mints them from Cloudflare. Cloudflare's TURN service is free for the first 1,000 GB a month, which is far more than a family will use. Until the function is deployed the app quietly carries on with STUN only.

To switch TURN on:

1. Create a free Cloudflare account at https://dash.cloudflare.com if you do not have one.
2. In the dashboard go to **Realtime → TURN Server → Create** (any name). Note the **Turn Token ID** and the **API Token** it shows you.
3. In a terminal, from this folder, set the two secrets and deploy the function (one command per line):

```powershell
npx.cmd supabase login
```
```powershell
npx.cmd supabase link --project-ref safcrtrfdzsnftghibot
```
```powershell
npx.cmd supabase secrets set CF_TURN_KEY_ID="<Turn Token ID>" CF_TURN_API_TOKEN="<API Token>"
```
```powershell
npx.cmd supabase functions deploy gather-turn --no-verify-jwt
```

4. Check https://safcrtrfdzsnftghibot.supabase.co/functions/v1/gather-turn in a browser: it should list `turn.cloudflare.com` servers.

## Deploy the site

Plain static files. Push to `main` and GitHub Pages publishes it.
