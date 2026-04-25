import { error, json } from "@sveltejs/kit";
import {
  extractVideoId,
  MAX_DURATION_SECONDS,
  sanitizeFilename,
} from "$lib/youtube";
import type { InfoResponse } from "$lib/api-types";
import type { RequestHandler } from "./$types";

export const config = {
  runtime: "nodejs22.x",
  maxDuration: 30,
};

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

export const GET: RequestHandler = async ({ url }) => {
  const input = url.searchParams.get("url") ?? url.searchParams.get("v");
  if (!input) {
    error(400, "Missing `url` query parameter");
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

  let info;
  try {
    info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`, {
      requestOptions: { headers: YT_HEADERS },
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
      error(
        403,
        "YouTube is requiring sign-in for this video. Try a different video.",
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
};
