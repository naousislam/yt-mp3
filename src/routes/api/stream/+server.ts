import { error } from "@sveltejs/kit";
import { extractVideoId, MAX_DURATION_SECONDS } from "$lib/youtube";
import { toYtdlCookies, toCookieHeader, type Cookie } from "$lib/cookies";
import type { RequestHandler } from "./$types";

/**
 * Pick the best audio-only format. Mirrors the logic in /api/info so that
 * the format streamed here matches the metadata advertised to the client.
 *
 * Generic over the format shape so we don't need to import the ytdl-core
 * types at module top level (see comment in the handler below).
 */
function pickBestAudioFormat<
  F extends {
    hasAudio: boolean;
    hasVideo: boolean;
    url?: string;
    container?: string;
    audioBitrate?: number;
    bitrate?: number;
    mimeType?: string;
    itag?: number;
  },
>(formats: F[]): F | null {
  const audioOnly = formats.filter((f) => f.hasAudio && !f.hasVideo && f.url);
  if (audioOnly.length === 0) return null;

  const score = (f: F): number => {
    // Prefer mp4 (which is how ytdl-core labels m4a/AAC streams) since
    // browsers decode AAC reliably. Fall back to webm/opus otherwise.
    const containerScore =
      f.container === "mp4" ? 1000 : f.container === "webm" ? 500 : 0;
    const bitrate = f.audioBitrate ?? f.bitrate ?? 0;
    return containerScore + bitrate;
  };

  return audioOnly.reduce((best, current) =>
    score(current) > score(best) ? current : best,
  );
}

const YT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Read the request body and pull out the `url` and optional `cookies`.
 * Accepts JSON for POST (the canonical path) or query params for GET so
 * curl / address-bar testing still works during local development.
 *
 * Cookies are deliberately not accepted via query string — they should
 * never appear in URLs (server access logs, browser history, Referer
 * headers, etc.).
 */
async function parseRequest(
  request: Request,
  url: URL,
): Promise<{
  input: string | null;
  cookies: Cookie[];
}> {
  let input: string | null = null;
  let cookies: Cookie[] = [];

  if (request.method === "POST") {
    try {
      const body = (await request.json()) as {
        url?: unknown;
        cookies?: unknown;
      };
      if (typeof body?.url === "string") input = body.url;
      if (Array.isArray(body?.cookies)) {
        cookies = body.cookies.filter(
          (c): c is Cookie =>
            !!c &&
            typeof c === "object" &&
            typeof (c as Cookie).name === "string" &&
            typeof (c as Cookie).value === "string",
        );
      }
    } catch {
      // Empty / non-JSON body is fine — fall through to query params.
    }
  }

  if (!input) {
    input = url.searchParams.get("url") ?? url.searchParams.get("v");
  }

  return { input, cookies };
}

/**
 * Proxies the raw (compressed) audio bytes from googlevideo to the browser.
 *
 * This server hop is unavoidable: googlevideo URLs are signed, short-lived,
 * and do not send permissive CORS headers, so the browser cannot fetch them
 * directly. We resolve a fresh URL on every request (rather than trusting one
 * the client received from /api/info) because those URLs expire quickly.
 *
 * The actual MP3 transcoding happens entirely on the client.
 */
async function handleStream(request: Request, url: URL): Promise<Response> {
  const { input, cookies } = await parseRequest(request, url);

  if (!input) {
    error(400, "Missing `url` field");
  }

  const videoId = extractVideoId(input);
  if (!videoId) {
    error(400, "Could not parse a YouTube video ID from the input");
  }

  // Lazy-import ytdl-core so it isn't evaluated at module init time.
  // ytdl-core touches `undici.Agent.compose` on import, and some runtimes
  // (notably Bun's undici polyfill) don't implement that API yet — which
  // would otherwise crash the SSR build. Importing here defers it to
  // request time, where we're guaranteed to be on the Node serverless
  // runtime configured above.
  const ytdl = (await import("@distube/ytdl-core")).default;

  // If the user supplied cookies, build a ytdl agent backed by them so the
  // innertube call carries valid auth. The googlevideo download below also
  // gets the cookies attached as a `Cookie:` header.
  const agent =
    cookies.length > 0 ? ytdl.createAgent(toYtdlCookies(cookies)) : undefined;

  let info;
  try {
    info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`, {
      requestOptions: { headers: YT_HEADERS },
      agent,
      // Try non-WEB clients first. YouTube applies its strictest anti-bot
      // checks to the WEB player; the TV / iOS / Android clients are designed
      // for third-party device contexts and tend to keep working from cloud
      // IP ranges (Vercel, AWS, etc.) where WEB is blocked. ytdl-core walks
      // this list in order and uses the first client that returns a usable
      // response, so we keep WEB at the end as a final fallback. This list
      // must match the one in /api/info so the format selection stays in sync.
      playerClients: ["TV", "IOS", "ANDROID", "WEB_EMBEDDED", "WEB"],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    if (/sign in|confirm/i.test(message)) {
      error(
        401,
        cookies.length > 0
          ? "Your YouTube cookies were rejected. They may have expired — please reconnect."
          : "YouTube is blocking this server's IP. Connect your YouTube account to continue.",
      );
    }
    console.error("[api/stream] ytdl.getInfo failed:", message);
    error(502, `Failed to resolve video: ${message}`);
  }

  const details = info.videoDetails;

  if (details.isLiveContent) {
    error(400, "Live streams are not supported");
  }

  const durationSeconds = Number(details.lengthSeconds) || 0;
  if (durationSeconds > MAX_DURATION_SECONDS) {
    error(
      413,
      `Video is too long (${Math.ceil(durationSeconds / 60)} min). The maximum allowed length is ${MAX_DURATION_SECONDS / 60} minutes.`,
    );
  }

  const format = pickBestAudioFormat(info.formats);
  if (!format || !format.url) {
    error(502, "No suitable audio stream was found for this video");
  }

  // Forward Range header if present so the browser can resume / chunk if it wants.
  const range = request.headers.get("range");
  const upstreamHeaders: Record<string, string> = { ...YT_HEADERS };
  if (range) upstreamHeaders.range = range;
  if (cookies.length > 0) {
    // googlevideo doesn't strictly require cookies to serve already-signed
    // URLs, but attaching them keeps the request consistent with the
    // innertube call above and avoids edge cases where YouTube rotates the
    // signed URL based on session.
    upstreamHeaders.cookie = toCookieHeader(cookies);
  }

  let upstream: Response;
  try {
    upstream = await fetch(format.url, {
      headers: upstreamHeaders,
      // Don't follow redirects to a different origin without thinking about it,
      // but ytdl-core has already resolved a direct googlevideo URL.
      redirect: "follow",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[api/stream] upstream fetch failed:", message);
    error(502, `Failed to connect to the audio source: ${message}`);
  }

  if (!upstream.ok && upstream.status !== 206) {
    console.error("[api/stream] upstream returned", upstream.status);
    error(502, `Audio source returned status ${upstream.status}`);
  }

  if (!upstream.body) {
    error(502, "Audio source returned an empty response");
  }

  // Build response headers that pass useful info through but strip
  // anything that would leak googlevideo internals.
  const headers = new Headers();
  const passthrough = [
    "content-length",
    "content-type",
    "content-range",
    "accept-ranges",
    "last-modified",
  ];
  for (const name of passthrough) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", format.mimeType?.split(";")[0] ?? "audio/mp4");
  }

  headers.set("cache-control", "private, max-age=0, no-store");
  // Hint to the browser that this is downloadable raw audio (not an MP3 yet)
  headers.set("x-yt-mp3-container", format.container ?? "");
  headers.set("x-yt-mp3-itag", String(format.itag));

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

// POST is the canonical entry point — it lets the client send cookies in
// the body (avoiding URL-length and header-size limits) and keeps auth data
// out of server access logs.
export const POST: RequestHandler = ({ request, url }) =>
  handleStream(request, url);

// GET is kept for convenience during local dev / curl testing. It can't be
// used with cookies (we don't accept them in query params for security
// reasons), so it's only useful for unauthenticated requests.
export const GET: RequestHandler = ({ request, url }) =>
  handleStream(request, url);
