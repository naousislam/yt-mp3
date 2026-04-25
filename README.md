# YT → MP3

A SvelteKit + Svelte 5 web app that converts YouTube videos to high-quality MP3
audio. The MP3 encoding happens **entirely in the user's browser** — the server's
only job is to resolve the video stream and proxy the compressed audio bytes
(which is unavoidable because of YouTube's CORS policy).

Built to deploy on Vercel. Tooling is set up for [Bun](https://bun.sh).

---

## How it works

```
 ┌──────────┐    1. /api/info       ┌──────────────────────┐
 │          │  ───────────────────▶ │ ytdl-core resolves   │
 │  Browser │                       │ video metadata       │
 │          │ ◀──────────────────── │                      │
 │          │    metadata + format  └──────────────────────┘
 │          │
 │          │    2. /api/stream     ┌──────────────────────┐
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

1. **YouTube signs its audio URLs.** The signature ciphers change frequently and
   only `ytdl-core` (Node-only) keeps up.
2. **CORS.** googlevideo.com refuses cross-origin browser requests, so even if
   we had the URL we couldn't `fetch` it from the page.

`ytdl-core` runs on the server, resolves a fresh URL on every request (they
expire quickly), and pipes the bytes back to the browser. Everything after the
download — decoding, resampling, encoding — happens in the browser using
[`@breezystack/lamejs`](https://www.npmjs.com/package/@breezystack/lamejs) and
the native `Web Audio API`.

---

## "Connect YouTube" — per-user cookie auth

YouTube blocks unauthenticated requests from datacenter IP ranges (Vercel,
AWS, etc.) with a **"sign in to confirm you're not a bot"** error. Almost
every `ytdl-core`-on-Vercel deployment hits this.

This app's workaround is **per-user cookie auth**: each user pastes their own
YouTube session cookies once, and the server forwards those cookies to
`ytdl-core` on every request. With a real session attached, YouTube treats
the request as a normal browser hit and serves the audio.

### How it works end-to-end

1. User clicks **Connect YouTube** in the header
2. They follow the in-app instructions to export cookies from a logged-in
   `youtube.com` tab using a browser extension
3. They paste the cookie blob into the textarea — we accept Netscape
   `cookies.txt`, JSON arrays, or `name=value; name=value` header strings
4. Cookies are parsed client-side, filtered down to the ~20 names YouTube
   actually uses for auth (everything else is dropped), and saved to
   `localStorage`
5. On every `/api/info` and `/api/stream` request, the cookies are sent in
   the **POST request body** (not the URL — never leak auth into logs)
6. The server builds a `ytdl.createAgent(cookies)` per request and uses it
   for both the metadata lookup and the googlevideo download

### Trust model — be honest with users

Cookies travel through our server to reach YouTube, so the operator of the
deployment can technically see them in transit. The app is engineered to
minimize this:

- **Nothing is persisted server-side.** Cookies are read from the request
  body, attached to one outbound `ytdl-core` call, and forgotten when the
  request ends.
- **Storage is client-only.** Cookies live in the user's `localStorage`,
  never in a database.
- **Filtered to auth cookies.** We drop everything that isn't a Google /
  YouTube session cookie before sending — no analytics, no ad cookies.
- **HTTPS-only in production.** Vercel terminates TLS for us.

That said, **session cookies grant full account access**. The app
deliberately tells users to sign in with a **throwaway Google account**, not
their main one. We surface that warning in the connect dialog every time.

### Files involved

| File                              | What it does                                                  |
| --------------------------------- | ------------------------------------------------------------- |
| `src/lib/cookies.ts`              | Parses 3 cookie formats, filters auth-only, localStorage I/O |
| `src/routes/api/info/+server.ts`  | Accepts `POST { url, cookies }`, builds `ytdl.createAgent()` |
| `src/routes/api/stream/+server.ts`| Same auth flow; also passes cookies to googlevideo            |
| `src/routes/+page.svelte`         | "Connect YouTube" dialog + auto-prompt on `401` errors        |

### Status codes you'll see

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| 401  | YouTube wants auth. Client auto-opens the connect dialog.                |
| 403  | Age-restricted video. Cookies don't help; this is enforced server-side.  |
| 404  | Video unavailable / private / region-blocked.                            |
| 413  | Video exceeds the 15-minute limit.                                       |
| 502  | YouTube returned an error or `ytdl-core` failed to parse a response.     |

### Cookie expiry

YouTube's session cookies typically last weeks to months. When they expire,
the server returns `401` with the message **"Your YouTube cookies were
rejected. They may have expired — please reconnect."** and the connect
dialog opens automatically. The user re-exports cookies and pastes again —
no code changes needed.

---

## Stack

| Layer        | Choice                                                      |
| ------------ | ----------------------------------------------------------- |
| Framework    | SvelteKit 2 + Svelte 5 (runes mode)                         |
| Styling      | Tailwind CSS v4 (via `@tailwindcss/vite`)                   |
| Adapter      | `@sveltejs/adapter-vercel` (Node 22 serverless functions)   |
| Server-side  | `@distube/ytdl-core` (actively maintained `ytdl-core` fork) |
| Client-side  | Web Audio API + `@breezystack/lamejs` (MP3 encoder in JS)   |
| Tooling      | Bun (install, dev, build)                                   |

---

## Project layout

```
src/
├── app.css                     Tailwind v4 entry + custom theme tokens
├── app.html                    Static HTML shell
├── lib/
│   ├── youtube.ts              URL parsing, formatting, sanitization
│   └── mp3.ts                  Client-side download → decode → encode pipeline
└── routes/
    ├── +layout.svelte          Imports global styles
    ├── +page.svelte            The whole UI lives here
    └── api/
        ├── info/+server.ts     Returns metadata + best audio format
        └── stream/+server.ts   Proxies raw audio bytes (CORS workaround)
```

---

## Local development with Bun

> Vercel does **not** support a Bun runtime for serverless functions yet. We use
> Bun for local development and dependency management; the deployed functions
> run on `nodejs22.x`. This is the standard "Bun + Vercel" workflow today.

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- A modern browser. The MP3 encoder uses standard Web Audio APIs supported in
  Chrome, Edge, Firefox, Safari (incl. iOS 14+).

### Get started

```sh
bun install
bun run dev
```

Then open <http://localhost:5173>.

### Available scripts

```sh
bun run dev          # vite dev server with HMR
bun run build        # production build (uses adapter-vercel output format)
bun run preview      # preview the production build locally
bun run check        # type-check the entire project
```

You can also use `bunx` to run any CLI tool from `package.json` without
installing globally — e.g. `bunx svelte-kit sync`.

---

## Deploying to Vercel

1. Push the repo to GitHub.
2. Import the repo in Vercel — no environment variables required.
3. Vercel auto-detects SvelteKit. Leave the framework preset as-is.

### Vercel configuration

The function configuration is set in `svelte.config.js`:

```js
adapter({
    runtime: 'nodejs22.x',
    memory: 1024,
    maxDuration: 60
})
```

- **`maxDuration: 60`** — Hobby plans cap out at 60s; this is intentional. The
  15-minute video limit was chosen partly so a typical encode + download fits
  comfortably inside that window. For Pro plans you can raise this to `300`.
- **`memory: 1024`** — `ytdl-core` is happy with the default 1 GB.

### Things that may break in production

- **YouTube blocking Vercel IPs.** YouTube actively rate-limits known
  serverless / datacenter IP ranges. If `/api/info` starts returning 502s, that
  is almost always why. Workarounds usually involve a residential proxy.
- **`ytdl-core` lagging behind a YouTube change.** Whenever YouTube tweaks
  their player JS, signatures temporarily break. Update `@distube/ytdl-core` to
  the latest version when this happens — that fork ships fixes within days.
- **Live streams / age-restricted videos** are explicitly refused. The error
  message from `/api/info` will tell you which it was.

### Building locally on Windows

`bun run build` (or `npm run build`) may fail at the very end with:

```
Error: EPERM: operation not permitted, symlink '![-]\0.func' -> '.vercel\output\functions\index.func'
```

This is a Windows-specific quirk: `@sveltejs/adapter-vercel` creates symlinks
inside `.vercel/output/`, and Windows blocks symlink creation for non-admin
users by default. **It does not affect deployments** — Vercel builds on Linux
where symlinks work normally, so `vercel deploy` and Git-triggered builds
both succeed.

To run a successful local build on Windows, pick one:

- Enable [Developer Mode](https://learn.microsoft.com/en-us/windows/apps/get-started/enable-your-device-for-development)
  (Settings → Privacy & security → For developers → Developer Mode), then run
  `bun run build` in a fresh terminal. This is the easiest fix.
- Run the build terminal **as Administrator**.
- Use WSL2 / Git Bash, where symlinks behave like on Linux.
- Skip the local production build entirely and rely on `bun run dev` plus
  Vercel's preview deployments.

---

## Limits & guardrails

| Limit                | Value     | Where enforced                          |
| -------------------- | --------- | --------------------------------------- |
| Max video length     | 15 min    | `MAX_DURATION_SECONDS` in `lib/youtube` |
| Function timeout     | 60 s      | `svelte.config.js`                      |
| Output bitrate range | 128–320   | `+page.svelte` quality picker           |
| Live streams         | rejected  | `/api/info` and `/api/stream`           |
| Age-restricted       | rejected  | `/api/info`                             |

Encoding speed depends on the user's device. As a rough guide, encoding a
10-minute video to 192 kbps MP3 on a mid-range laptop takes ~6–8 seconds; on a
phone it's closer to 20 s.

---

## Legal notice

Downloading content from YouTube generally violates
[YouTube's Terms of Service](https://www.youtube.com/t/terms) unless you own
the content, the content is in the public domain, or YouTube provides a
download button for it.

This project is intended for **educational and personal use** — for example,
downloading your own uploads, podcasts you have permission to redistribute, or
public-domain recordings. You are responsible for how you use it.

---

## License

MIT