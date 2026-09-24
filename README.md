# Gather

Video calls for friends and family. No accounts, nothing to install, works on phones and computers, comfortable with fifteen or more people on a call.

Live at https://immmahh-sketch.github.io/gather/

## How it works

- `index.html` – home: start a new call, your permanent room link, or join with a link.
- `call.html?room=<name>` – the call itself. Any room name works; a permanent link is just a room name you keep using.
- Media runs through **Cloudflare Realtime's SFU**: each person uploads one copy of their camera, mic and screen, and pulls everyone else's from Cloudflare. Cameras are sent as three simulcast layers and each viewer pulls the size that fits the tile, so a big call stays light on phones. Cloudflare's SFU is free for the first 1,000 GB a month, then about 5p per GB.
- **Supabase Realtime** is only the meeting point: presence on channel `call-<room>` says who is in the room, which Cloudflare session they hold and which tracks they publish. No tables, nothing stored.
- The **`gather-rtc` edge function** (`supabase/functions/gather-rtc`) holds the Cloudflare secrets. It forwards the SFU session API and mints short-lived TURN credentials for people on awkward networks.

## Features

- Camera, microphone, mute and camera-off, front/back camera switch on phones.
- Screen sharing from desktop browsers and Android Chrome. Shared screens go full-size for everyone else; pin any tile to make it big.
- Who-is-speaking highlight, join/leave notices, call timer, invite button (native share sheet on phones, copies the link elsewhere).
- Keyboard: `M` mute, `V` camera.

## One-time setup: Cloudflare

The site is static, but calls need the `gather-rtc` function deployed with Cloudflare secrets. Until then the join screen says the video server is not set up.

1. Create a free Cloudflare account at https://dash.cloudflare.com if you do not have one.
2. **SFU app.** In the dashboard open **Realtime → SFU → Create application** (any name). Note the **App ID** and the **App Secret** (the secret is only shown once).
3. **TURN key.** Open **Realtime → TURN → Create** (any name). Note the **Turn Token ID** and the **API Token**.
4. In a terminal, from this folder, run these one at a time:

```powershell
npx.cmd supabase login
```
```powershell
npx.cmd supabase link --project-ref safcrtrfdzsnftghibot
```
```powershell
npx.cmd supabase secrets set CF_SFU_APP_ID="<App ID>" CF_SFU_APP_SECRET="<App Secret>" CF_TURN_KEY_ID="<Turn Token ID>" CF_TURN_API_TOKEN="<API Token>"
```
```powershell
npx.cmd supabase functions deploy gather-rtc --no-verify-jwt
```

5. Check https://safcrtrfdzsnftghibot.supabase.co/functions/v1/gather-rtc/ice in a browser: it should list `turn.cloudflare.com` servers. Then open a room from two devices.

The function only answers requests from `https://immmahh-sketch.github.io` (and `localhost:8765` for local testing). Anyone with a room link can join a call, so treat links like a phone number.

## Deploy the site

Plain static files. Push to `main` and GitHub Pages publishes it. For local testing serve the folder on port 8765, e.g. `python -m http.server 8765`.

## Look and feel

- Logo and icons are drawn by `tools/make-icons.py` (run `python tools/make-icons.py` after changing it). It writes the favicon, the home-screen icons, the maskable Android icon and `social.png`, the picture shown when a link is pasted into WhatsApp or iMessage.
- `manifest.webmanifest` plus the Apple meta tags make the site installable: on a phone, Share → Add to Home Screen gives a Gather icon that opens without browser chrome.
- Share links are `https://immmahh-sketch.github.io/gather/?room=<name>`; the home page forwards them to the call. Short link: https://tinyurl.com/gathercalls

## Putting it on your own domain

1. Buy the domain (Cloudflare Registrar sells `.uk` and `.co.uk` at cost, about £5 a year, and you already have the account).
2. In Cloudflare DNS for the domain add a `CNAME` record: name `@` (or `www`), target `immmahh-sketch.github.io`, proxy **off** (grey cloud).
3. In this repo add a file called `CNAME` containing just the domain, e.g. `gathercall.uk`, and push. GitHub Pages then serves the site there; enable **Enforce HTTPS** in the repo's Pages settings once the certificate appears.
4. Add `https://<domain>` to `ALLOWED_ORIGINS` in `supabase/functions/gather-rtc/index.ts` and redeploy the function.
5. Update the `og:image` URLs in `index.html` and `call.html` to the new domain.
