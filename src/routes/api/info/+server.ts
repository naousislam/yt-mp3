import { error, json } from "@sveltejs/kit";
import {
  extractVideoId,
  MAX_DURATION_SECONDS,
  sanitizeFilename,
} from "$lib/youtube";
import {
  getVideoInfo,
  pickBestAudioFormat,
  YtDlpError,
  type YtDlpInfo,
} from "$lib/yt-dlp";
import type { InfoResponse } from "$lib/api-types";
import type { RequestHandler } from "./$types";

/**
 * GET / POST /api/info
 *
 * Resolves video metadata and the best available audio format using
 * the bundled yt-dlp binary (see `src/lib/yt-dlp.ts`). Returns the
 * `InfoResponse` shape consumed by the client to render the preview
 * card before the user kicks off the actual conversion.
 *
 * yt-dlp's CLI is intentionally stable — fields like `id`, `title`,
 * `duration`, and `formats` have been the same shape for years —
 * so we don't expect this handler to need adjustment when YouTube
 * changes things on the wire. Any breakage will instead show up as
 * `yt-dlp` itself returning an error, which we catch and translate
 * to a clean HTTP status below.
 */

/**
 * Pull `url` out of the request. We accept it via JSON body (the
 * canonical path used by the SvelteKit page) or via `?url=` /
 * `?v=` query parameters (convenient for `curl` testing during
 * local development).
 */
async function readInput(request: Request, url: URL): Promise<string | null> {
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as { url?: unknown };
      if (typeof body?.url === "string" && body.url.length > 0) {
        return body.url;
      }
    } catch {
      // Empty / non-JSON body — fall through to the query string.
    }
  }
  return url.searchParams.get("url") ?? url.searchParams.get("v");
}

/**
 * Inspect a yt-dlp stderr blob and surface a meaningful HTTP error
 * for known failure modes. We map roughly to the same status codes
 * the previous Innertube-based implementation used so the UI's
 * error-handling logic doesn't have to change.
 */
function reportYtDlpFailure(stderr: string): never {
  const text = stderr.toLowerCase();

  if (
    text.includes("sign in to confirm") ||
    text.includes("confirm you're not a bot") ||
    text.includes("sign in to confirm you're not a bot")
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

  // Fall through: surface the stderr text directly so the user has
  // some hope of diagnosing whatever yt-dlp ran into.
  console.error("[api/info] yt-dlp failed:", stderr.trim());
  error(
    502,
    `yt-dlp failed: ${stderr.trim().split("\n").pop() ?? "unknown error"}`,
  );
}

async function handleInfo(request: Request, url: URL): Promise<Response> {
  const input = await readInput(request, url);
  if (!input) {
    error(400, "Missing `url` field");
  }

  // Validate up front that we recognize the input as a YouTube URL
  // or bare video ID. yt-dlp can technically fetch from many sites,
  // but we want this app's behaviour bounded to YouTube — both for
  // legal/UX reasons and because the 15-minute limit and other
  // assumptions don't necessarily port to other extractors.
  const videoId = extractVideoId(input);
  if (!videoId) {
    error(400, "Could not parse a YouTube video ID from the input");
  }

  // Always rebuild a canonical `watch?v=ID` URL rather than passing
  // user input through. This sidesteps any extractor-routing oddity
  // (Shorts URLs occasionally trigger a different code path in
  // yt-dlp) and means we never accidentally leak playlist params
  // into the request.
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  let info: YtDlpInfo;
  try {
    info = await getVideoInfo(canonicalUrl);
  } catch (err) {
    if (err instanceof YtDlpError) {
      reportYtDlpFailure(err.stderr);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[api/info] getVideoInfo threw:", message);
    error(502, `Failed to fetch video info: ${message}`);
  }

  // Reject live streams up front. yt-dlp would happily try to
  // download them as a multi-segment HLS stream, but we cap at 15
  // minutes and need a finite-length file for the browser-side
  // MP3 encoder.
  if (info.is_live || info.live_status === "is_live") {
    error(400, "Live streams are not supported");
  }
  if (info.live_status === "is_upcoming") {
    error(400, "This video hasn't started yet — it's a scheduled premiere.");
  }

  // age_limit > 0 means YouTube reported an age gate. yt-dlp can
  // sometimes get past this with cookies, but we don't ship a
  // cookie path any more, so refuse cleanly.
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

  const format = pickBestAudioFormat(info);
  if (!format) {
    error(502, "No suitable audio stream was found for this video");
  }

  // Title shouldn't normally be empty, but guard against it so we
  // always have a usable filename downstream.
  const title = info.title?.trim() || `youtube-${videoId}`;
  const author =
    info.uploader?.trim() || info.channel?.trim() || "Unknown channel";

  // Pick the largest thumbnail we have a URL for. yt-dlp usually
  // populates `thumbnails` (sorted small→large) plus a top-level
  // `thumbnail` shortcut. Either is fine for the preview card.
  const thumbnails = info.thumbnails ?? [];
  const thumbnail =
    thumbnails.length > 0
      ? thumbnails.reduce((best, t) =>
          (t.width ?? 0) > (best.width ?? 0) ? t : best,
        ).url
      : (info.thumbnail ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);

  // Normalize codec / container fields. yt-dlp's `ext` is the
  // container (`m4a`, `webm`, ...). Codec lives in `acodec`.
  const container = (format.ext ?? "").toLowerCase();
  const codec = (format.acodec ?? "").trim();
  const mimeType =
    format.mime_type ??
    // Fabricate a minimally-correct MIME from container + codec when
    // yt-dlp didn't surface one. The browser only uses this for
    // display — the actual decode dispatches off the byte signature.
    (container && codec
      ? `audio/${container === "m4a" ? "mp4" : container}; codecs="${codec}"`
      : "audio/mpeg");

  // Bitrate to display in the preview card. yt-dlp reports kbps
  // already, so no unit conversion needed. Round so we don't show
  // weird floating-point trailing decimals like "129.7 kbps".
  const reportedBitrate = format.abr ?? format.tbr ?? 0;
  const bitrate =
    typeof reportedBitrate === "number" ? Math.round(reportedBitrate) : 0;

  // Either field can be missing depending on whether yt-dlp got an
  // exact or estimated size from YouTube. Prefer the exact one.
  const contentLength =
    typeof format.filesize === "number"
      ? format.filesize
      : typeof format.filesize_approx === "number"
        ? format.filesize_approx
        : null;

  const response: InfoResponse = {
    id: videoId,
    title,
    author,
    durationSeconds,
    thumbnail,
    filename: sanitizeFilename(title),
    format: {
      // yt-dlp's `format_id` is a string (and sometimes alphanumeric,
      // e.g. "140-drc"). Coerce to a number when possible so the
      // existing `InfoResponse.format.itag` field stays a number;
      // fall back to 0 for non-numeric IDs since the client only
      // surfaces this for diagnostics.
      itag: Number.isFinite(Number(format.format_id))
        ? Number(format.format_id)
        : 0,
      mimeType,
      container,
      codec,
      bitrate,
      contentLength,
    },
  };

  return json(response, {
    headers: {
      "cache-control": "private, max-age=0, no-store",
    },
  });
}

// POST is the canonical entry point — it keeps the URL out of
// server access logs and the browser's referrer headers, which
// matters less now (no auth tokens involved) but is still good
// hygiene.
export const POST: RequestHandler = ({ request, url }) =>
  handleInfo(request, url);

// GET is kept around for convenience during local dev and curl
// testing. It accepts `?url=` or `?v=` query parameters.
export const GET: RequestHandler = ({ request, url }) =>
  handleInfo(request, url);
