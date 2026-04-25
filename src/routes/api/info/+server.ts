import { error, json } from "@sveltejs/kit";
import {
  extractVideoId,
  MAX_DURATION_SECONDS,
  sanitizeFilename,
} from "$lib/youtube";
import type { InfoResponse } from "$lib/api-types";
import type { RequestHandler } from "./$types";

import { getInnertube } from "$lib/innertube";

/**
 * Pick the best audio-only format from a youtubei.js VideoInfo.
 *
 * youtubei.js exposes a `chooseFormat({ type: 'audio', quality: 'best' })`
 * helper, but its scoring sometimes picks Opus over AAC even when both
 * are present at the same bitrate. We do our own selection so we can
 * mirror /api/info's preference for AAC (which every browser's Web
 * Audio API decodes natively).
 */
function pickBestAudioFormat<
  F extends {
    has_audio: boolean;
    has_video: boolean;
    mime_type?: string;
    bitrate?: number;
  },
>(formats: F[]): F | null {
  const audioOnly = formats.filter((f) => f.has_audio && !f.has_video);
  if (audioOnly.length === 0) return null;

  const score = (f: F): number => {
    // Prefer mp4a (AAC) over opus. Both decode in modern browsers, but
    // AAC has slightly better support in older Safari versions and tends
    // to produce smaller intermediate buffers during decode.
    const mime = f.mime_type ?? "";
    const containerScore = /mp4a/i.test(mime)
      ? 1000
      : /opus/i.test(mime)
        ? 500
        : 0;
    const bitrate = f.bitrate ?? 0;
    return containerScore + bitrate;
  };

  return audioOnly.reduce((best, current) =>
    score(current) > score(best) ? current : best,
  );
}

async function handleInfo(request: Request, url: URL): Promise<Response> {
  // Accept JSON body (canonical) or `?url=` query (convenient for curl).
  let input: string | null = null;
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as { url?: unknown };
      if (typeof body?.url === "string") input = body.url;
    } catch {
      // Empty / non-JSON body — fall through to query string.
    }
  }
  if (!input) {
    input = url.searchParams.get("url") ?? url.searchParams.get("v");
  }

  if (!input) {
    error(400, "Missing `url` field");
  }

  const videoId = extractVideoId(input);
  if (!videoId) {
    error(400, "Could not parse a YouTube video ID from the input");
  }

  let yt: import("youtubei.js").Innertube;
  try {
    yt = await getInnertube();
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[api/info] Innertube.create failed:", message);
    error(502, `Failed to initialize YouTube client: ${message}`);
  }

  let info: import("youtubei.js").YT.VideoInfo;
  try {
    info = await yt.getInfo(videoId);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    if (/age/i.test(message)) {
      error(403, "This video is age-restricted and cannot be processed");
    }
    if (/private|unavailable|removed|blocked|region/i.test(message)) {
      error(404, "This video is unavailable, private, or region-blocked");
    }
    if (/sign in|confirm|bot/i.test(message)) {
      error(
        401,
        "YouTube is blocking this server's IP. Run the app locally on your home network instead.",
      );
    }
    console.error("[api/info] getInfo failed:", message);
    error(502, `Failed to fetch video info: ${message}`);
  }

  const basic = info.basic_info;

  // Playability status surfaces age-gates, geographic blocks, and the
  // generic "this video is not available" wall before we even look at
  // the streaming data.
  const playability = info.playability_status;
  if (playability && playability.status !== "OK") {
    const reason =
      playability.reason ??
      playability.error_screen?.toString?.() ??
      playability.status;
    if (/age/i.test(String(reason))) {
      error(403, "This video is age-restricted and cannot be processed");
    }
    if (/private|unavailable|region|country/i.test(String(reason))) {
      error(404, `This video is not playable: ${reason}`);
    }
    if (/sign in|confirm|bot/i.test(String(reason))) {
      error(
        401,
        "YouTube is blocking this server's IP. Run the app locally on your home network instead.",
      );
    }
    error(400, `Video is not playable: ${reason}`);
  }

  if (basic.is_live) {
    error(400, "Live streams are not supported");
  }

  const durationSeconds = basic.duration ?? 0;
  if (durationSeconds <= 0) {
    error(400, "Could not determine the duration of this video");
  }
  if (durationSeconds > MAX_DURATION_SECONDS) {
    error(
      413,
      `Video is too long (${Math.ceil(durationSeconds / 60)} min). The maximum allowed length is ${MAX_DURATION_SECONDS / 60} minutes.`,
    );
  }

  // youtubei.js splits formats into `formats` (combined) and
  // `adaptive_formats` (per-stream). Audio-only streams live in
  // `adaptive_formats`.
  const formats = info.streaming_data?.adaptive_formats ?? [];
  const format = pickBestAudioFormat(formats);
  if (!format) {
    error(502, "No suitable audio stream was found for this video");
  }

  const thumbnails = basic.thumbnail ?? [];
  const thumbnail =
    thumbnails.length > 0
      ? thumbnails.reduce((best, t) =>
          (t.width ?? 0) > (best.width ?? 0) ? t : best,
        ).url
      : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const mimeType = format.mime_type ?? "";
  const codecMatch = mimeType.match(/codecs="([^"]+)"/);
  const codec = codecMatch ? codecMatch[1] : "";
  // Container portion of "audio/mp4; codecs=…" → "mp4".
  const containerMatch = mimeType.match(/^audio\/(\w+)/i);
  const container = containerMatch ? containerMatch[1].toLowerCase() : "";

  const response: InfoResponse = {
    id: videoId,
    title: basic.title ?? "Untitled",
    author: basic.author ?? basic.channel?.name ?? "Unknown",
    durationSeconds,
    thumbnail,
    filename: sanitizeFilename(basic.title ?? "audio"),
    format: {
      itag: format.itag,
      mimeType,
      container,
      codec,
      // youtubei.js reports the source bitrate in bits per second,
      // while ytdl-core reported kbps. Normalize to kbps for the UI.
      bitrate:
        typeof format.bitrate === "number"
          ? Math.round(format.bitrate / 1000)
          : 0,
      contentLength:
        typeof format.content_length === "number"
          ? format.content_length
          : null,
    },
  };

  return json(response, {
    headers: {
      "cache-control": "private, max-age=0, no-store",
    },
  });
}

// POST is the canonical entry point — keeps auth-style data (if ever
// added later) out of URL query strings and server access logs.
export const POST: RequestHandler = ({ request, url }) =>
  handleInfo(request, url);

// GET is kept for convenience during local dev / curl testing.
export const GET: RequestHandler = ({ request, url }) =>
  handleInfo(request, url);
