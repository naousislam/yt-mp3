import { error, json } from "@sveltejs/kit";
import {
  extractVideoId,
  MAX_DURATION_SECONDS,
  sanitizeFilename,
} from "$lib/youtube";
import { toYtdlCookies, type Cookie } from "$lib/cookies";
import type { InfoResponse } from "$lib/api-types";
import type { RequestHandler } from "./$types";

const YT_HEADERS = {
  // A modern desktop UA helps avoid age-gate / consent walls.
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Pick the best audio-only format from a list of ytdl formats.
 *
 * We prefer the `mp4` container (which is how ytdl-core labels m4a / AAC
 * audio streams) because every browser's `decodeAudioData` handles AAC
 * reliably. WebM/Opus is used as a fallback when AAC isn't offered.
 */
function pickBestAudioFormat<
  F extends {
    hasAudio: boolean;
    hasVideo: boolean;
    url?: string;
    container?: string;
    audioBitrate?: number;
    bitrate?: number;
  },
>(formats: F[]): F | null {
  const audioOnly = formats.filter((f) => f.hasAudio && !f.hasVideo && f.url);
  if (audioOnly.length === 0) return null;

  const score = (f: F): number => {
    const containerScore =
      f.container === "mp4" ? 1000 : f.container === "webm" ? 500 : 0;
    const bitrate = f.audioBitrate ?? f.bitrate ?? 0;
    return containerScore + bitrate;
  };

  return audioOnly.reduce((best, current) =>
    score(current) > score(best) ? current : best,
  );
}

/**
 * Read the request body and pull out the `url` and optional `cookies`.
 * We accept either JSON (preferred) or a query parameter for `url` so
 * curl / browser address-bar testing still works during development.
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

async function handleInfo(request: Request, url: URL): Promise<Response> {
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
  // outbound googlevideo / innertube requests carry valid auth. Otherwise
  // fall through to the unauthenticated path, which usually fails on
  // Vercel IPs but is fine for local dev.
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
      // response, so we keep WEB at the end as a final fallback.
      playerClients: ["TV", "IOS", "ANDROID", "WEB_EMBEDDED", "WEB"],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    // Map common YouTube failure modes to clearer status codes.
    if (/age/i.test(message)) {
      error(403, "This video is age-restricted and cannot be processed");
    }
    if (/private|unavailable|removed|blocked/i.test(message)) {
      error(404, "This video is unavailable, private, or region-blocked");
    }
    if (/sign in|confirm/i.test(message)) {
      // Surface a custom code so the client can prompt the user to connect
      // their YouTube account, instead of just showing a generic error.
      error(
        401,
        cookies.length > 0
          ? "Your YouTube cookies were rejected. They may have expired — please reconnect."
          : "YouTube is blocking this server's IP. Connect your YouTube account to continue.",
      );
    }
    console.error("[api/info] ytdl.getInfo failed:", message);
    error(502, `Failed to fetch video info: ${message}`);
  }

  const details = info.videoDetails;

  if (details.isLiveContent) {
    error(400, "Live streams are not supported");
  }

  const durationSeconds = Number(details.lengthSeconds) || 0;
  if (durationSeconds <= 0) {
    error(400, "Could not determine the duration of this video");
  }
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

  const thumbnails = details.thumbnails ?? [];
  const thumbnail =
    thumbnails.length > 0
      ? thumbnails.reduce((best, t) =>
          (t.width ?? 0) > (best.width ?? 0) ? t : best,
        ).url
      : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const codec = (() => {
    const match = (format.mimeType ?? "").match(/codecs="([^"]+)"/);
    return match ? match[1] : "";
  })();

  const response: InfoResponse = {
    id: videoId,
    title: details.title,
    author: details.author?.name ?? "Unknown",
    durationSeconds,
    thumbnail,
    filename: sanitizeFilename(details.title),
    format: {
      itag: format.itag,
      mimeType: format.mimeType ?? "",
      container: format.container ?? "",
      codec,
      bitrate: format.audioBitrate ?? format.bitrate ?? 0,
      contentLength: format.contentLength ? Number(format.contentLength) : null,
    },
  };

  return json(response, {
    headers: {
      "cache-control": "private, max-age=0, no-store",
    },
  });
}

// POST is the canonical entry point — it lets the client send cookies in
// the body (avoiding URL-length and header-size limits) and keeps auth data
// out of server access logs.
export const POST: RequestHandler = ({ request, url }) =>
  handleInfo(request, url);

// GET is kept for convenience during local dev / curl testing. It can't be
// used with cookies (we don't accept them in query params for security
// reasons), so it's only useful for unauthenticated requests.
export const GET: RequestHandler = ({ request, url }) =>
  handleInfo(request, url);
