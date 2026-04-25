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
    info = await yt.getInfo(videoId);
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

  const formats = info.streaming_data?.adaptive_formats ?? [];
  const format = pickBestAudioFormat(formats);
  if (!format) {
    error(502, "No suitable audio stream was found for this video");
  }

  // youtubei.js's `download()` resolves the signed URL, deciphers it,
  // makes the actual googlevideo request, and gives us back a
  // ReadableStream of the response body. We pin it to the same itag we
  // selected above so the bytes match the metadata advertised by
  // /api/info — youtubei.js would otherwise re-run its own format
  // chooser on each call.
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
    console.error("[api/stream] download() failed:", message);
    error(502, `Failed to fetch audio stream: ${message}`);
  }

  // Build response headers. Content-Length comes from the format
  // metadata so the client can render an accurate progress bar; we
  // can't pull it from the upstream response because youtubei.js
  // hides the underlying fetch.
  const headers = new Headers();
  if (typeof format.content_length === "number") {
    headers.set("content-length", String(format.content_length));
  }
  // Strip the "; codecs=..." parameter — only the bare content type
  // matters to the browser when receiving raw bytes.
  const baseMime = (format.mime_type ?? "audio/mp4").split(";")[0].trim();
  headers.set("content-type", baseMime);
  headers.set("cache-control", "private, max-age=0, no-store");
  // Helpful for debugging in DevTools — surface which format we picked.
  headers.set("x-yt-mp3-itag", String(format.itag));
  if (format.mime_type) {
    headers.set("x-yt-mp3-mime", format.mime_type);
  }

  // Cancel the upstream stream if the client disconnects mid-download.
  // SvelteKit/Node won't do this automatically — without it, an
  // aborted browser request keeps the googlevideo connection open
  // until completion, which wastes bandwidth and a serverless invocation.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => {
    abort.abort();
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
