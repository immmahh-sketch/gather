# Gather

Video calls for friends and family. No accounts, nothing to install, works on phones and computers.

Live at https://immmahh-sketch.github.io/gather/

## How it works

- `index.html` – home: start a new call, your permanent room link, or join with a link.
- `call.html?room=<name>` – the call itself. Any room name works; a permanent link is just a room name you keep using.
- Calls are WebRTC, device to device (a mesh, so every person connects to every other person). Fine for up to about six people.
- Supabase Realtime is only the signalling channel (presence for who is in the room, broadcast for offers/answers/ICE). No call data passes through it and nothing is stored. Shares the Supabase project used by the other apps; channel names are `call-<room>`.
- STUN via Google, TURN via the Open Relay Project so calls still connect on awkward mobile networks. Both are set in `assets/config.js`.

## Features

- Camera, microphone, mute and camera-off, front/back camera switch on phones.
- Screen sharing from desktop browsers and Android Chrome. Shared screens go full-size for everyone else; pin any tile to make it big.
- Who-is-speaking highlight, join/leave notices, call timer, invite button (native share sheet on phones, copies the link elsewhere).
- Keyboard: `M` mute, `V` camera.

## Deploy

Plain static files. Push to `main` and GitHub Pages publishes it.
