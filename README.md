# Gather

Video calls for friends and family. No accounts, nothing to install, works on phones and computers, comfortable with fifteen or more people on a call.

Live at https://gathercall.uk (GitHub Pages, custom domain via the `CNAME` file; the old https://immmahh-sketch.github.io/gather/ address redirects there)

## How it works

- `index.html` – home: start a new call, your permanent room link, or join with a link.
- `call.html?room=<name>` – the call itself. Any room name works; a permanent link is just a room name you keep using.
- Media runs through **Cloudflare Realtime's SFU**. Each device keeps two connections to Cloudflare: *push* sends its own camera, mic and share, and *pull* receives everyone else. Cameras go up as three simulcast layers and each viewer pulls the size that fits the tile, so a big call stays light on phones. Cloudflare's SFU is free for the first 1,000 GB a month, then about 5p per GB.
- Received tracks that go away are force-closed on Cloudflare and their slots left idle, never renegotiated away. A renegotiated slot gets reused by Cloudflare with its RTP header extensions renumbered, which Chrome rejects ("RTP extension ID reassignment not supported"). If the receiving side ever does fail, it rebuilds itself and pulls everything again; nobody else notices.
- Every published track must keep sending packets: Cloudflare deletes a track that sends nothing for 30 seconds, and pulling a deleted track stalls the receiver's session. So presentation sound is fed a silent source, and during a live camera share the face-camera slot sends a small black picture. Devices only advertise their tracks while their sending connection is up, every request to the server gives up after 12 seconds, and a stalled pull rebuilds the receiving side.
- **Supabase Realtime** is only the meeting point: presence on channel `call-<room>` says who is in the room, which Cloudflare session they send on, which tracks they publish, and whether they are a TV. No tables, nothing stored.
- The **`gather-rtc` edge function** (`supabase/functions/gather-rtc`) holds the Cloudflare secrets. It forwards the SFU session API and mints short-lived TURN credentials for people on awkward networks.

## Features

- Camera, microphone, mute and camera-off, front/back camera switch on phones.
- **Share your screen** from a laptop or desktop browser. Shared screens go full-size for everyone else; pin any tile to make it big.
- **Share live video** from any device with a camera: the back camera goes out as the shared picture, big for everyone and full screen on TVs, with a flip button for the front camera. The face tile pauses meanwhile (phones run one camera at a time, and it saves the phone's upload) and comes back when the share stops. The screen is kept awake while sharing.
- **Share photos or videos** from any device, phones included: pick them from the camera roll and step through them with the arrows; videos play with sound for everyone else. No phone browser (Safari, Chrome or Firefox) allows a web page to capture the phone's own screen, so this is the phone equivalent.
- **Full screen on TVs**: while sharing, the sharer's bar has a switch (on by default) that makes Fire Sticks show the share edge to edge with nothing else on screen. Off, TVs show the share with everyone's faces beside it.
- TVs are viewers only: they get no tile and are not counted as people.
- **Your name and direct files**: the first time someone opens Gather it asks their name (and uses it in calls too). The home page then has *Send a file*: pick a person from the dropdown, choose files (or drop them), Send. Each person's *Files for you* list shows what they've been sent, kept for 7 days; if they have Gather open they get a notice straight away. Names are claimed on the server as empty objects under `_people/` in the `gather-files` bucket, and files go to `_inbox/<person>/` (routes `/people`, `/inbox/upload`, `/inbox`, `/inbox/link` on `gather-rtc`; live notices are Realtime broadcasts on `inbox-<hex of name>`). Typing a name that is already taken asks whether it's the same person on another device. Names are not secret: anyone with the site password who types your name sees your files. To remove a name: `DELETE /people` with `{"name": "..."}`.
- **Send files**: the paperclip in the call's top bar opens the Files panel. Send a file (or drag it onto the call on a computer) and everyone in the room gets a notice and can download it for 24 hours; people who join later see it too. Up to 50 MB per file (Supabase's free-plan limit). Files go straight from the sender's device into the private Storage bucket `gather-files` using a one-off upload link from `gather-rtc`; downloads use short-lived signed links. Nothing is kept after 24 hours.
- Who-is-speaking highlight, join/leave notices, call timer, invite button (native share sheet on phones, copies the link elsewhere).
- Keyboard: `M` mute, `V` camera, `←`/`→` previous/next photo when presenting.

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
- Share links are `https://gathercall.uk/?room=<name>`; the home page forwards them to the call. Short link: https://tinyurl.com/gathercalls

## Putting it on your own domain

1. Buy the domain (Cloudflare Registrar sells `.uk` and `.co.uk` at cost, about £5 a year, and you already have the account).
2. In Cloudflare DNS for the domain add a `CNAME` record: name `@` (or `www`), target `immmahh-sketch.github.io`, proxy **off** (grey cloud).
3. In this repo add a file called `CNAME` containing just the domain, e.g. `gathercall.uk`, and push. GitHub Pages then serves the site there; enable **Enforce HTTPS** in the repo's Pages settings once the certificate appears.
4. Add `https://<domain>` to `ALLOWED_ORIGINS` in `supabase/functions/gather-rtc/index.ts` and redeploy the function.
5. Update the `og:image` URLs in `index.html` and `call.html` to the new domain.

## Password

The site is private. Every page asks for the password once per device (`assets/gate.js`, checked against the SHA-256 hash in `assets/config.js`), and the call server checks the real password on every request (secret `GATHER_PASSWORD` on `gather-rtc`). To change it: set the new secret, redeploy the function, and put the new hash in `config.js` (`python -c "import hashlib;print(hashlib.sha256(b'NEW').hexdigest())"`).

## Fire Stick / Android TV app

`tv.html` is a remote-friendly room picker; it opens `call.html?room=<name>&tv=1`, which joins with no camera or microphone, hides the controls and fills the screen with whatever is shared. The remote's Back button leaves the room.

`android/` is a tiny WebView wrapper around that page. GitHub Actions (`.github/workflows/android.yml`) builds and signs it on every push that touches `android/` and publishes it as the `tv-latest` release:

    https://github.com/immmahh-sketch/gather/releases/download/tv-latest/gather-tv.apk

Signing key: the PKCS12 keystore and its password live in the repo's Actions secrets, with a private copy at `C:\Users\GM\Documents\gather-tv-signing.p12` and `gather-tv-signing-PASSWORD.txt`. Updates must be signed with the same key or the Fire Stick refuses to install over the old version.

To sideload: on the Fire Stick enable *Apps from unknown sources* (Settings → My Fire TV → Developer options), install the *Downloader* app from the Amazon store, and enter the short link. Older sticks on Fire OS 5 have a dated browser engine and may not play the video; Fire OS 6 and 7 sticks (4K, Lite, 3rd gen) are fine.

## Big files (Cloudflare R2)

Files up to 20 GB go to the Cloudflare R2 bucket `gather-files` (Western Europe, private). The browser uploads straight to R2 in 16 MB+ parts, four at a time, each part retried with backoff, using links pre-signed by `gather-rtc`; the function then completes the multipart upload (a signed ticket stops anyone completing or cancelling uploads it did not start). Downloads are pre-signed links that save under the original name. Call files live under `rooms/<room>/`, direct files under `inbox/<person>/`.

Set up on 25 Sept 2026:
- R2 subscription on the Cloudflare account ($0/month; free tier is 10 GB-month storage, 1M Class A and 10M Class B operations; downloads are free).
- Bucket CORS: GET/PUT/HEAD from gathercall.uk, www.gathercall.uk, the github.io address and localhost:8765, exposing `ETag`.
- Lifecycle rules: `rooms/` deleted after 1 day, `inbox/` after 7 days, unfinished uploads aborted after 7 days.
- Account API token "gather-rtc (Gather file uploads)": Object Read & Write on `gather-files` only.
- Supabase secrets on `gather-rtc`: `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.

Without the R2 secrets the function falls back to Supabase Storage with a 50 MB limit. To rotate the key: Cloudflare → R2 → Manage API tokens → the token's menu → Roll, then set the two key secrets again.
