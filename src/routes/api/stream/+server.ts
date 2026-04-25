import { error } from "@sveltejs/kit";
import { extractVideoId, MAX_DURATION_SECONDS } from "$lib/youtube";
import {
  getVideoInfo,
  pickBestAudioFormat,
  streamAudio,
  YtDlpError,
  type YtDlpInfo,
} from "$lib/yt-dlp";
import type { RequestHandler } from "./$types";

/**
 * GET / POST /api/stream
 *
 * Spawns the bundled yt-dlp binary with `-o -` so its stdout is the
 * raw compressed audio bytes for the requested video, and pipes that
 * stream straight back to the browser as the response body. The
 * client then runs the bytes through the Web Audio API and the
 * lamejs encoder to produce an MP3 — see `src/lib/mp3.ts`.
 *
 * Why a server hop is unavoidable:
 *
 *   1. The googlevideo URLs that actually serve the audio are signed
 *      and short-lived. They also don't send permissive CORS headers,
 *      so the browser can't `fetch()` them directly even if it had
 *      the URL.
 *   2. yt-dlp resolves a fresh signed URL on every invocation, so we
 *      can't cache one and hand it to the client.
 *
 * The MP3 transcode itself still happens entirely in the browser —
 * this endpoint is a thin proxy, nothing more.
 *
 * We do a quick `getVideoInfo()` call before kicking off the stream
 * for two reasons:
 *
 *   - It catches duration / live-stream / age-gate violations
 *     cheaply, before we commit to a multi-megabyte download.
 *   - It surfaces a clean HTTP status code to the client. Once the
 *     stream is in flight, all we can do if yt-dlp fails is close
 *     the connection — there's no good way to retroactively change
 *     a 200 into a 502 once headers have been sent.
 */

/**
 * Read `url` from the request body (canonical) or query string
 * (convenient for curl). Mirrors the helper in /api/info.
 */
async function readInput(request: Request, url: URL): Promise<string | null> {
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as { url?: unknown };
      if (typeof body?.url === "string" && body.url.length > 0) {
        return body.url;
      }
    } catch {
      // Empty / non-JSON body — fall through to query string.
    }
  }
  return url.searchParams.get("url") ?? url.searchParams.get("v");
}

/**
 * Translate a yt-dlp stderr blob into an HTTP error. Same mapping
 * table as /api/info — kept in sync so that both endpoints surface
 * the same status code for the same underlying YouTube failure.
 */
function reportYtDlpFailure(stderr: string): never {
  const text = stderr.toLowerCase();

  if (
    text.includes("sign in to confirm") ||
    text.includes("confirm you're not a bot")
  ) {
    error(
      401,
      "YouTube is asking this server to sign in to confirm it isn't a bot. " +
        "Try again in a few minutes, or run the app on a different network.",
    );
  }
  if (text.includes("age") && text.includes("restricted")) {
    error(403, "This video is age-restricted and cannot be processed.");
  }
  if (
    text.includes("private video") ||
    text.includes("login required") ||
    text.includes("members-only")
  ) {
    error(403, "This video requires a logged-in YouTube account.");
  }
  if (
    text.includes("video unavailable") ||
    text.includes("not available") ||
    text.includes("removed by") ||
    text.includes("terminated")
  ) {
    error(404, "This video is unavailable, private, or has been removed.");
  }
  if (
    text.includes("blocked it on copyright") ||
    text.includes("blocked it in your country") ||
    text.includes("not available in your country")
  ) {
    error(404, "This video is region-blocked.");
  }
  if (text.includes("live event")) {
    error(400, "Live streams and premieres are not supported.");
  }

  console.error("[api/stream] yt-dlp failed:", stderr.trim());
  error(
    502,
    `yt-dlp failed: ${stderr.trim().split("\n").pop() ?? "unknown error"}`,
  );
}

async function handleStream(request: Request, url: URL): Promise<Response> {
  const input = await readInput(request, url);
  if (!input) {
    error(400, "Missing `url` field");
  }

  const videoId = extractVideoId(input);
  if (!videoId) {
    error(400, "Could not parse a YouTube video ID from the input");
  }

  // Always rebuild a canonical `watch?v=ID` URL rather than passing
  // user input through. This keeps yt-dlp on a single extractor path
  // and prevents playlist params from leaking into the request.
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Pre-flight: fetch metadata first so we can validate duration /
  // playability / etc. before opening the much heavier streaming
  // download. Costs us one extra yt-dlp invocation (~500ms) but
  // means a 15-minute-violation video fails fast with a clean error
  // instead of streaming bytes the client would then reject.
  let info: YtDlpInfo;
  try {
    info = await getVideoInfo(canonicalUrl, request.signal);
  } catch (err) {
    if (err instanceof YtDlpError) {
      reportYtDlpFailure(err.stderr);
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      // Client cancelled before we even started downloading — just
      // bail out with no body. The 499 status code (`Client Closed
      // Request`) is non-standard but widely understood; SvelteKit's
      // `error()` only accepts 400-599, so we use 499 directly via
      // a Response.
      return new Response(null, { status: 499 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[api/stream] preflight getVideoInfo threw:", message);
    error(502, `Failed to fetch video info: ${message}`);
  }

  if (info.is_live || info.live_status === "is_live") {
    error(400, "Live streams are not supported");
  }
  if (info.live_status === "is_upcoming") {
    error(400, "This video hasn't started yet — it's a scheduled premiere.");
  }
  if (typeof info.age_limit === "number" && info.age_limit > 0) {
    error(403, "This video is age-restricted and cannot be processed");
  }

  const durationSeconds = typeof info.duration === "number" ? info.duration : 0;
  if (durationSeconds <= 0) {
    error(400, "Could not determine the duration of this video");
  }
  if (durationSeconds > MAX_DURATION_SECONDS) {
    error(
      413,
      `Video is too long (${Math.ceil(durationSeconds / 60)} min). The maximum allowed length is ${MAX_DURATION_SECONDS / 60} minutes.`,
    );
  }

  // Pick the same format /api/info advertised to the client. This
  // matters because the client renders the file size, bitrate, and
  // duration up front — if we streamed a different format here, the
  // numbers would mismatch and the progress bar would be wrong.
  const format = pickBestAudioFormat(info);
  if (!format) {
    error(502, "No suitable audio stream was found for this video");
  }

  // Spawn yt-dlp in pipe-to-stdout mode and grab the raw audio
  // ReadableStream. yt-dlp handles the signature dance, n-param
  // transformation, and the actual googlevideo HTTPS request — all
  // the bits that broke under the JS-only YouTube clients.
  const { stream, stderr, exitCode } = streamAudio(
    canonicalUrl,
    request.signal,
  );

  // Hook up an error path: if yt-dlp exits with a non-zero code,
  // surface the stderr text in the server log. We can't change the
  // HTTP status at this point (headers have already been sent the
  // moment we returned the Response below), so the client will
  // receive a truncated body. The /api/info preflight above is what
  // protects us from the common failure modes; this branch only
  // catches mid-stream surprises (network blip, signature rotation
  // between preflight and stream, etc.).
  void Promise.all([stderr, exitCode]).then(([stderrText, code]) => {
    if (code !== 0) {
      console.error(
        `[api/stream] yt-dlp exited ${code} mid-stream: ${stderrText.trim()}`,
      );
    }
  });

  // Build response headers from the format metadata. yt-dlp doesn't
  // expose the upstream `Response` object so we can't pass through
  // googlevideo's headers directly — we synthesize them from the
  // format we already picked.
  const headers = new Headers();

  // Content-Length lets the browser render an accurate progress
  // bar. Use the exact `filesize` when yt-dlp got one from YouTube;
  // fall back to `filesize_approx` (still useful), or omit the
  // header entirely if neither is available.
  if (typeof format.filesize === "number") {
    headers.set("content-length", String(format.filesize));
  } else if (typeof format.filesize_approx === "number") {
    // The approx size is sometimes a few hundred KB off; we still
    // set it so the progress bar isn't completely indeterminate,
    // but without `content-length` semantics that imply exactness.
    headers.set(
      "x-yt-mp3-approx-content-length",
      String(format.filesize_approx),
    );
  }

  // Strip "; codecs=..." — only the bare content type matters to
  // the browser. The Web Audio API dispatches on byte signature,
  // not the Content-Type header.
  const baseMime = format.mime_type
    ? format.mime_type.split(";")[0].trim()
    : format.ext === "webm"
      ? "audio/webm"
      : "audio/mp4";
  headers.set("content-type", baseMime);
  headers.set("cache-control", "private, max-age=0, no-store");

  // Surface the format we picked so DevTools / curl users can see
  // exactly what got served. Useful when debugging "why does this
  // video sound weird" reports — sometimes YouTube degrades us to
  // a low-bitrate fallback and these headers are the easiest way
  // to confirm that's what happened.
  headers.set("x-yt-mp3-format-id", format.format_id);
  headers.set("x-yt-mp3-ext", format.ext);
  if (format.acodec) headers.set("x-yt-mp3-acodec", format.acodec);
  if (typeof format.abr === "number") {
    headers.set("x-yt-mp3-abr-kbps", String(format.abr));
  }

  return new Response(stream, {
    status: 200,
    headers,
  });
}

// POST is the canonical entry point.
export const POST: RequestHandler = ({ request, url }) =>
  handleStream(request, url);

// GET is kept around for convenience during local dev / curl testing.
export const GET: RequestHandler = ({ request, url }) =>
  handleStream(request, url);
