# YT → MP3

A self-hosted SvelteKit + Svelte 5 app that converts YouTube videos to
high-quality MP3 audio. The MP3 encoding happens **entirely in your
browser** — the server's only job is to resolve the audio stream from
YouTube and proxy the bytes back to the page.

Built to run **locally on your own machine**, on your own residential IP,
which is what keeps YouTube from rate-limiting you. Public deployments
to Vercel / cloud platforms get blocked almost immediately because
YouTube actively flags datacenter IP ranges — so this project is
deliberately set up as a personal tool, not a public web app.

---

## Download

Pre-built binaries are published on the
[GitHub releases page](https://github.com/naousislam/yt-mp3/releases/latest).
No Node, Python, terminal, or developer tools required — download the
file for your OS, double-click it, and the app opens in your browser.

| Platform              | File                       |
| --------------------- | -------------------------- |
| Windows (x64)         | `yt-mp3-windows-x64.exe`   |
| macOS (Apple Silicon) | `yt-mp3-macos-arm64`       |
| macOS (Intel)         | `yt-mp3-macos-x64`         |
| Linux (x64)           | `yt-mp3-linux-x64`         |

Each binary is ~80–110 MB. It bundles its own Node runtime and a
matching yt-dlp binary, so it has no external dependencies.

### First launch

- **Windows:** double-click the `.exe`. Windows SmartScreen will warn
  you the publisher is unrecognized (the binary is unsigned) — click
  **More info → Run anyway**. A console window opens, then your
  browser pops to the app.
- **macOS:** the binary is unsigned, so the first launch is blocked
  by Gatekeeper. Either:
  - Right-click → **Open** → **Open** in the dialog, or
  - Run `xattr -d com.apple.quarantine ~/Downloads/yt-mp3-macos-*`
    once in Terminal.

  After the first launch, double-click works normally.
- **Linux:** make it executable once with
  `chmod +x ~/Downloads/yt-mp3-linux-x64`, then run it. Some desktop
  environments need `xdg-open` installed for the browser-launch step.

### What you'll see

```
[yt-mp3] Starting YT → MP3…
[yt-mp3] First run: unpacking yt-dlp (this happens once)…
[yt-mp3] Server is listening at http://127.0.0.1:3000
[yt-mp3] Opening your browser…
[yt-mp3] Keep this window open while you use the app. Close it to quit.
```

The console window stays open while the app is running. Close it (or
Ctrl+C) to stop the server. Your browser tab to <http://localhost:3000>
will then 404 — that's the signal everything is shut down cleanly.

---

## Run from source (developers)

If you want to hack on the app, you can run it from a checkout instead
of the packaged binary. You'll need **Node.js 20+** at runtime; Bun is
optional but speeds up installs.

```sh
git clone https://github.com/naousislam/yt-mp3.git
cd yt-mp3
bun install         # or: npm install
bun run build       # or: npm run build
bun run start       # or: npm run start
```

Open <http://localhost:3000> and use the app the same way.

For development with hot-reload:

```sh
bun run dev         # or: npm run dev
# open http://localhost:5173
```

To rebuild the standalone binary for your platform:

```sh
bun run package:win        # → dist/yt-mp3.exe
bun run package:mac-arm64  # → dist/yt-mp3-macos-arm64
bun run package:mac-x64    # → dist/yt-mp3-macos-x64
bun run package:linux      # → dist/yt-mp3-linux
```

The `release` GitHub Actions workflow builds all four targets in
parallel on every `vX.Y.Z` git tag and attaches them to a new
GitHub Release.

---

## How it works

```
 ┌──────────┐    1. POST /api/info  ┌──────────────────────┐
 │          │  ───────────────────▶ │ ytdl-core resolves   │
 │  Browser │                       │ video metadata       │
 │          │ ◀──────────────────── │                      │
 │          │    metadata + format  └──────────────────────┘
 │          │
 │          │    2. POST /api/stream┌──────────────────────┐
 │          │  ───────────────────▶ │ ytdl-core re-resolves│
 │          │                       │ + proxies audio bytes│
 │          │ ◀──────────────────── │ from googlevideo     │
 │          │    raw m4a/webm       └──────────────────────┘
 │          │
 │          │ 3. Web Audio API decodes m4a/webm → PCM
 │          │ 4. lamejs encodes PCM → MP3
 │          │ 5. Blob URL triggers a download
 └──────────┘
```

### Why a server endpoint at all?

Two reasons it can't be 100% client-side:

1. **YouTube signs its audio URLs.** The signature ciphers change
   frequently and only `ytdl-core` (Node-only) keeps up.
2. **CORS.** googlevideo.com refuses cross-origin browser requests, so
   even if we had the URL we couldn't `fetch` it from the page.

`ytdl-core` runs on the server, resolves a fresh URL on every request
(they expire quickly), and pipes the bytes back to the browser.
Everything after the download — decoding, resampling, encoding —
happens in the browser using
[`@breezystack/lamejs`](https://www.npmjs.com/package/@breezystack/lamejs)
and the native `Web Audio API`.

---

## Why local, not cloud?

The short version: **YouTube blocks datacenter IPs**. Vercel, AWS,
Render, Cloudflare Workers — all of their public IP ranges are flagged
by YouTube's anti-bot system. As soon as you deploy this app to one of
them, you'll see this error on every fetch:

> YouTube is requiring sign-in for this video. Try a different video.

This is YouTube's "we think you're a bot" response, and it's
non-negotiable for unauthenticated requests from cloud IPs.

Running the same code from your **home network** sidesteps the problem
entirely. Your residential IP has years of legitimate YouTube traffic
attached to it; YouTube treats requests from it as normal browser
activity and serves the audio without complaint.

### What about the IP-ban risk?

For personal use (a handful of conversions a day), risk is essentially
zero. YouTube's rate-limiting on residential IPs is mild and temporary
— you might see a captcha if you go wild, but you won't get a
"permanent" anything. See the chat history of this repo's development
for a fuller breakdown.

If you bulk-convert hundreds of videos in quick succession, expect a
captcha on YouTube for a few hours. Don't do that.

---

## Stack

| Layer        | Choice                                                      |
| ------------ | ----------------------------------------------------------- |
| Framework    | SvelteKit 2 + Svelte 5 (runes mode)                         |
| Styling      | Tailwind CSS v4 (via `@tailwindcss/vite`)                   |
| Adapter      | `@sveltejs/adapter-node` (self-contained Node server)       |
| Server-side  | `@distube/ytdl-core` (actively maintained `ytdl-core` fork) |
| Client-side  | Web Audio API + `@breezystack/lamejs` (MP3 encoder in JS)   |
| Tooling      | Bun for installs / dev (Node for the production server)     |

---

## Project layout

```
src/
├── app.css                     Tailwind v4 entry + custom theme tokens
├── app.html                    Static HTML shell
├── lib/
│   ├── api-types.ts            Shared types for client ↔ server
│   ├── cookies.ts              (Inert) optional cookie auth — see below
│   ├── youtube.ts              URL parsing, formatting, sanitization
│   └── mp3.ts                  Client-side download → decode → encode
└── routes/
    ├── +layout.svelte          Imports global styles
    ├── +page.svelte            The whole UI lives here
    └── api/
        ├── info/+server.ts     Returns metadata + best audio format
        └── stream/+server.ts   Proxies raw audio bytes (CORS workaround)
```

---

## Why Node, not Bun

Bun is great for installing dependencies and running Vite during
development. But for the built server (`bun run build` →
`build/index.js`), you should run it with **Node**, not Bun.

The reason: `@distube/ytdl-core` calls
`undici.Agent.compose()` for cookie-jar / IPv6 handling. Bun ships its
own bundled `undici` polyfill that **doesn't implement
`Agent.compose()`** as of writing. Running the built server with `bun
./build/index.js` will crash at first request with:

```
TypeError: this.compose is not a function
```

Two options:

- **Run the built server with Node** (recommended): `node
  ./build/index.js` or `bun run start` (which calls `node` under the
  hood — check `package.json`).
- **Install plain `undici`** and import it explicitly in
  `src/routes/api/info/+server.ts` and `src/routes/api/stream/+server.ts`
  before calling `ytdl-core`. This works but is fragile because Bun
  aggressively intercepts `undici` imports.

The dev server (`bun run dev`) is fine on Bun — Vite's SSR module
loader doesn't trigger the broken codepath.

---

## API endpoints

Both endpoints accept `POST` with a JSON body:

```jsonc
// POST /api/info
{
  "url": "https://youtube.com/watch?v=…", // or a bare 11-char video ID
  "cookies": []                           // optional, see "Cookie auth"
}
```

```jsonc
// POST /api/stream
{
  "url": "…",
  "cookies": []
}
```

A `GET` variant is also exposed for `curl` / address-bar testing
during development. It accepts only `?url=` and cannot pass cookies.

### Status codes you'll see

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| 401  | YouTube wants auth. On a public deploy, this is the IP block.             |
| 403  | Age-restricted video. There is no workaround in this app.                 |
| 404  | Video unavailable / private / region-blocked.                             |
| 413  | Video exceeds the 15-minute limit.                                        |
| 502  | YouTube returned an error or `ytdl-core` failed to parse a response.      |

---

## Cookie auth (optional, advanced)

The server-side cookie support from earlier iterations of this project
is still in the code (`src/lib/cookies.ts`, plus the `cookies` field on
both API endpoints), but the UI for it has been removed because it was
too clunky and pushed users toward risky behavior (pasting their entire
Google session into a web form).

If you really want to run this on a cloud host where YouTube blocks the
IP, you can:

1. Sign in to youtube.com with a **throwaway Google account** (never
   your main one — session cookies grant full account access).
2. Export cookies using a browser extension like
   [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc).
3. Send them in the request body:

   ```sh
   curl -X POST http://your-server/api/info \
     -H 'Content-Type: application/json' \
     -d '{
       "url": "https://youtube.com/watch?v=…",
       "cookies": [
         {"name": "SID", "value": "…", "domain": ".youtube.com"},
         {"name": "__Secure-1PSID", "value": "…", "domain": ".youtube.com"}
       ]
     }'
   ```

The server will use those cookies via `ytdl.createAgent(cookies)` for
that single request and forget them afterward.

This path is unsupported / undocumented in the UI on purpose. If you
add a UI for it, please keep the throwaway-account warning prominent.

---

## Limits & guardrails

| Limit                | Value     | Where enforced                          |
| -------------------- | --------- | --------------------------------------- |
| Max video length     | 15 min    | `MAX_DURATION_SECONDS` in `lib/youtube` |
| Output bitrate range | 128–320   | `+page.svelte` quality picker           |
| Live streams         | rejected  | `/api/info` and `/api/stream`           |
| Age-restricted       | rejected  | `/api/info`                             |

Encoding speed depends on the user's device. As a rough guide, encoding
a 10-minute video to 192 kbps MP3 on a mid-range laptop takes ~6–8
seconds; on a phone it's closer to 20 s.

---

## Configuration

The Node adapter binds to `HOST` and `PORT` environment variables, both
optional:

```sh
PORT=8080 HOST=0.0.0.0 bun run start
```

By default the server listens on `0.0.0.0:3000`.

If you want to expose this to your home network so phones / tablets on
the same Wi-Fi can hit it, bind to `0.0.0.0` and visit
`http://YOUR_LAN_IP:3000` from the phone.

---

## Development scripts

```sh
bun run dev          # vite dev server with HMR (port 5173)
bun run build        # production build → ./build
bun run start        # node ./build/index.js (port 3000)
bun run preview      # vite's preview of the built app
bun run check        # svelte-check + tsc
```

Replace `bun run` with `npm run` if you prefer npm.

---

## Legal notice

Downloading content from YouTube generally violates
[YouTube's Terms of Service](https://www.youtube.com/t/terms) unless
you own the content, the content is in the public domain, or YouTube
provides a download button for it.

This project is intended for **educational and personal use** — for
example, downloading your own uploads, podcasts you have permission to
redistribute, or public-domain recordings. You are responsible for how
you use it.

---

## License

MIT