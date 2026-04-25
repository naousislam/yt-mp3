import { error } from "@sveltejs/kit";
import { extractVideoId, MAX_DURATION_SECONDS } from "$lib/youtube";
import { getInnertube } from "$lib/innertube";
import type { RequestHandler } from "./$types";

/**
 * Pick the best audio-only format from a youtubei.js VideoInfo's
 * `adaptive_formats` list. Mirrors the logic in /api/info so the
 * streamed bytes match the metadata we advertised to the client.
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
    // Prefer mp4a (AAC) over opus to match /api/info; both decode in
    // modern browsers but AAC has slightly broader support and tends
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

/**
 * Proxies the raw (compressed) audio bytes from googlevideo to the
 * browser.
 *
 * This server hop is unavoidable: googlevideo URLs are signed,
 * short-lived, and do not send permissive CORS headers, so the browser
 * cannot fetch them directly. We resolve a fresh URL on every request
 * (rather than trusting one the client received from /api/info)
 * because those URLs expire quickly.
 *
 * youtubei.js's `MediaInfo.download()` handles signature deciphering
 * and the `n` parameter transformation internally, then returns a
 * `ReadableStream<Uint8Array>` we can pipe straight back to the
 * browser. The actual MP3 transcoding happens entirely on the client.
 */
async function handleStream(request: Request, url: URL): Promise<Response> {
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
    console.error("[api/stream] Innertube.create failed:", message);
    error(502, `Failed to initialize YouTube client: ${message}`);
  }

  let info: import("youtubei.js").YT.VideoInfo;
  try {
    // Client fallback list for streaming.
    //
    // YouTube exposes multiple "Innertube clients" (WEB, IOS, ANDROID,
    // TV, WEB_EMBEDDED, ...) and each one returns slightly different
    // streaming_data. Which clients actually work shifts every few
    // weeks as YouTube tightens its anti-bot heuristics, so rather
    // than hard-coding a single client we walk a short list and use
    // the first one that returns at least one audio-only format with
    // a usable URL.
    //
    // The order below was chosen by trial against the current
    // (April 2026) YouTube backend:
    //
    //   - TV: the smart-TV / embedded-device client. Widest format
    //     coverage and the hardest for YouTube to fingerprint as a
    //     bot, since real TVs and Node processes look similar over
    //     the wire. Tends to keep working when WEB starts failing.
    //
    //   - WEB_EMBEDDED: the iframe-embed player client. Secondary
    //     fallback. Its formats currently decipher cleanly through
    //     youtubei.js's `Player.decipher` while plain WEB does not.
    //
    //   - ANDROID: last-resort fallback for videos that TV and
    //     WEB_EMBEDDED refuse with "video is unavailable" or that
    //     trigger parser errors on auth-required responses.
    //
    // Clients we deliberately do NOT include:
    //
    //   - WEB: `Player.decipher` currently throws "No valid URL to
    //     decipher" for many videos because of a pending mismatch
    //     between youtubei.js's player parser and YouTube's latest
    //     player JS revision.
    //
    //   - IOS: `getInfo` works and returns formats with already-
    //     resolved `url` fields, but those URLs 403 from a plain
    //     Node `fetch()` even when we exactly match youtubei.js's
    //     own `STREAM_HEADERS`. Routing the same URLs through
    //     `info.download()` doesn't help either — that helper
    //     unconditionally calls `format.decipher(player)`, and
    //     `Player.decipher()` mishandles IOS-shaped formats. So
    //     IOS is useful for metadata-only paths but not here.
    //
    // If every client in the list fails, we re-throw the last error
    // so the outer catch can map it to a nice user-facing message
    // (401 for "sign in required", 404 for "unavailable", etc.)
    // instead of leaking the raw youtubei.js stack trace.
    const clientFallback = ["TV", "WEB_EMBEDDED", "ANDROID"] as const;
    let lastError: unknown = null;
    let chosen: import("youtubei.js").YT.VideoInfo | null = null;
    for (const client of clientFallback) {
      try {
        chosen = await yt.getInfo(videoId, { client });
        // If we got streaming data with at least one audio-only
        // format, that's a working result; stop trying other clients.
        const audio = chosen.streaming_data?.adaptive_formats?.filter(
          (f) => f.has_audio && !f.has_video,
        );
        if (audio && audio.length > 0) break;
        // No usable formats — keep trying. Reset `chosen` so we don't
        // accidentally fall through with empty streaming_data.
        chosen = null;
      } catch (e) {
        lastError = e;
        // Swallow and try the next client. We surface a single
        // aggregated error after the loop if everything fails.
      }
    }
    if (!chosen) {
      throw lastError ?? new Error("All YouTube clients refused the request");
    }
    info = chosen;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    if (/sign in|confirm|bot/i.test(message)) {
      error(
        401,
        "YouTube is blocking this server's IP. Run the app locally on your home network instead.",
      );
    }
    console.error("[api/stream] getInfo failed:", message);
    error(502, `Failed to resolve video: ${message}`);
  }

  const basic = info.basic_info;

  if (basic.is_live) {
    error(400, "Live streams are not supported");
  }

  const durationSeconds = basic.duration ?? 0;
  if (durationSeconds > MAX_DURATION_SECONDS) {
    error(
      413,
      `Video is too long (${Math.ceil(durationSeconds / 60)} min). The maximum allowed length is ${MAX_DURATION_SECONDS / 60} minutes.`,
    );
  }

  const adaptive = info.streaming_data?.adaptive_formats ?? [];
  const format = pickBestAudioFormat(adaptive);
  if (!format) {
    error(502, "No suitable audio stream was found for this video");
  }

  // Let youtubei.js do the streaming. Its `info.download()` helper:
  //   1. Calls `format.decipher(player)` to resolve the signed URL.
  //      WEB_EMBEDDED formats decipher cleanly today — the IOS path
  //      we tried earlier returned URLs that 403'd from raw fetches,
  //      and the WEB path is currently broken on YouTube's latest
  //      player JS rev.
  //   2. Appends the session's CPN to the URL.
  //   3. Sends the exact set of headers googlevideo expects (see
  //      `STREAM_HEADERS` in youtubei.js's Constants.js).
  //   4. For audio-only requests, does a single fetch and hands back
  //      the upstream `ReadableStream` body directly.
  //
  // We pin `itag` so the bytes match the metadata that /api/info
  // advertised to the client; otherwise youtubei.js would re-run its
  // own format chooser and might pick a different stream than the one
  // the UI is showing duration / size for.
  let audioStream: ReadableStream<Uint8Array>;
  try {
    audioStream = await info.download({
      type: "audio",
      itag: format.itag,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    if (/sign in|confirm|bot/i.test(message)) {
      error(
        401,
        "YouTube is blocking this server's IP. Run the app locally on your home network instead.",
      );
    }
    if (/login required|UNPLAYABLE/i.test(message)) {
      error(403, "This video is not playable without an account.");
    }
    console.error("[api/stream] download() failed:", message);
    error(502, `Failed to fetch audio stream: ${message}`);
  }

  // Build the response headers from the format metadata. We don't
  // get to inspect the upstream `Response` object (youtubei.js hides
  // it) so content-length / -type come from the format we picked.
  const headers = new Headers();
  if (typeof format.content_length === "number") {
    headers.set("content-length", String(format.content_length));
  }
  // Strip "; codecs=..." — only the bare content type matters to the
  // browser when receiving raw bytes.
  const baseMime = (format.mime_type ?? "audio/mp4").split(";")[0].trim();
  headers.set("content-type", baseMime);
  headers.set("cache-control", "private, max-age=0, no-store");
  headers.set("x-yt-mp3-itag", String(format.itag));
  if (format.mime_type) {
    headers.set("x-yt-mp3-mime", format.mime_type);
  }

  // Cancel the upstream googlevideo connection if the browser
  // disconnects mid-download. SvelteKit/Node won't do this
  // automatically — without it, an aborted request keeps the
  // upstream socket open until completion, wasting bandwidth.
  request.signal.addEventListener("abort", () => {
    audioStream.cancel().catch(() => {
      /* already done — ignore */
    });
  });

  return new Response(audioStream, {
    status: 200,
    headers,
  });
}

// POST is the canonical entry point.
export const POST: RequestHandler = ({ request, url }) =>
  handleStream(request, url);

// GET is kept for convenience during local dev / curl testing.
export const GET: RequestHandler = ({ request, url }) =>
  handleStream(request, url);
