import lamejs from "@breezystack/lamejs";

export type EncodeProgress = {
  stage: "downloading" | "decoding" | "encoding" | "finalizing";
  /** A value between 0 and 1, or null if indeterminate. */
  progress: number | null;
  /** A human-readable status message. */
  message: string;
};

export type EncodeOptions = {
  /** YouTube URL or 11-character video ID to convert. */
  input: string;
  /**
   * Optional cookies to forward to the server so YouTube treats the
   * outbound request as authenticated. Required in production whenever
   * YouTube is blocking the server's IP. Each entry is forwarded verbatim
   * to /api/stream in the request body.
   */
  cookies?: Array<{ name: string; value: string; domain?: string }>;
  /** Optional content length hint (in bytes) for accurate download progress. */
  contentLength?: number | null;
  /** Target MP3 bitrate in kbps. Defaults to 192. */
  bitrate?: 128 | 160 | 192 | 256 | 320;
  /** Called with progress updates as the pipeline runs. */
  onProgress?: (progress: EncodeProgress) => void;
  /** Optional AbortSignal to cancel the operation. */
  signal?: AbortSignal;
};

export type EncodeResult = {
  /** A Blob containing the final MP3 audio. */
  blob: Blob;
  /** The duration of the encoded audio in seconds. */
  durationSeconds: number;
  /** The sample rate of the encoded MP3. */
  sampleRate: number;
  /** The number of channels in the encoded MP3 (1 = mono, 2 = stereo). */
  channels: 1 | 2;
  /** The bitrate the MP3 was encoded at, in kbps. */
  bitrate: number;
};

const DEFAULT_BITRATE = 192;

/** Lamejs supports a fixed set of sample rates. We pick the closest valid one. */
const SUPPORTED_SAMPLE_RATES = [
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000,
];

function nearestSupportedSampleRate(sampleRate: number): number {
  let best = SUPPORTED_SAMPLE_RATES[0];
  let bestDiff = Math.abs(sampleRate - best);
  for (const rate of SUPPORTED_SAMPLE_RATES) {
    const diff = Math.abs(sampleRate - rate);
    if (diff < bestDiff) {
      best = rate;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * Resample a Float32Array of PCM samples from one rate to another using
 * simple linear interpolation. This is good enough for music encoding
 * destined for a lossy MP3 — we'd hear no meaningful difference vs. a
 * polyphase filter at typical bitrates.
 */
function resample(
  samples: Float32Array<ArrayBufferLike>,
  fromRate: number,
  toRate: number,
): Float32Array<ArrayBufferLike> {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const newLength = Math.floor(samples.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const left = Math.floor(srcIndex);
    const right = Math.min(left + 1, samples.length - 1);
    const t = srcIndex - left;
    result[i] = samples[left] * (1 - t) + samples[right] * t;
  }
  return result;
}

/** Convert a Float32Array of normalized PCM (-1..1) to Int16Array (-32768..32767). */
function floatToInt16(input: Float32Array<ArrayBufferLike>): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Operation aborted", "AbortError");
  }
}

/**
 * POST to /api/stream and stream the audio bytes back into a single
 * ArrayBuffer while reporting download progress.
 *
 * We POST (rather than GET) so the user's YouTube cookies travel in the
 * request body — they don't belong in URLs (which leak through server
 * access logs, browser history, and Referer headers). The server handler
 * accepts the same JSON shape as /api/info, plus an optional `cookies`
 * array.
 *
 * We can't lean on the native `Response.body` progress because we need a
 * single contiguous buffer to feed into `decodeAudioData`.
 */
async function downloadWithProgress(
  input: string,
  cookies: EncodeOptions["cookies"],
  contentLength: number | null,
  onProgress: ((p: EncodeProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer> {
  const response = await fetch("/api/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: input, cookies: cookies ?? [] }),
    signal,
  });

  if (!response.ok) {
    // Try to surface a useful error message from the JSON error body
    // SvelteKit's `error()` helper produces.
    let detail = "";
    try {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.message ?? text;
      } catch {
        detail = text;
      }
    } catch {
      /* ignore */
    }
    throw new Error(
      detail || `Failed to download audio (HTTP ${response.status})`,
    );
  }

  if (!response.body) {
    throw new Error("Audio stream returned an empty body");
  }

  const total =
    contentLength ??
    (response.headers.get("content-length")
      ? Number(response.headers.get("content-length"))
      : null);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    ensureNotAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress?.({
        stage: "downloading",
        progress: total && total > 0 ? Math.min(received / total, 1) : null,
        message: total
          ? `Downloading audio… ${Math.round((received / total) * 100)}%`
          : `Downloading audio… ${(received / 1024 / 1024).toFixed(1)} MB`,
      });
    }
  }

  // Concatenate into a single ArrayBuffer (decodeAudioData wants one buffer).
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

/**
 * Decode compressed audio bytes (m4a/AAC, webm/opus, etc.) into a raw
 * AudioBuffer using the browser's native decoder.
 *
 * We use a short-lived `AudioContext` rather than `OfflineAudioContext`
 * because we don't actually want to render anything — we just want the
 * decoded PCM samples. The context is closed immediately after decoding.
 */
async function decodeAudio(
  bytes: ArrayBuffer,
  onProgress: ((p: EncodeProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<AudioBuffer> {
  ensureNotAborted(signal);
  onProgress?.({
    stage: "decoding",
    progress: null,
    message: "Decoding audio…",
  });

  // Some browsers (older Safari) only expose AudioContext on `webkitAudioContext`.
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) {
    throw new Error("Web Audio API is not supported in this browser");
  }

  const ctx = new Ctor();
  try {
    // `decodeAudioData` may mutate the buffer; pass a copy to be safe.
    const copy = bytes.slice(0);
    const buffer = await ctx.decodeAudioData(copy);
    return buffer;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not decode the audio stream${message ? `: ${message}` : ""}. ` +
        "Your browser may not support this audio codec.",
    );
  } finally {
    // Best-effort close; not all environments support `.close()`.
    try {
      await ctx.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Encode an AudioBuffer to an MP3 Blob using lamejs. Runs synchronously in
 * chunks but yields back to the event loop periodically so the UI stays
 * responsive and we can report progress.
 */
async function encodeMp3(
  audio: AudioBuffer,
  bitrate: number,
  onProgress: ((p: EncodeProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<{ blob: Blob; channels: 1 | 2; sampleRate: number }> {
  const sourceRate = audio.sampleRate;
  const targetRate = nearestSupportedSampleRate(sourceRate);
  // Lamejs only supports mono and stereo; collapse anything else to stereo.
  const channels: 1 | 2 = audio.numberOfChannels >= 2 ? 2 : 1;

  // Pull PCM data out of the AudioBuffer and resample if needed.
  // Explicitly widen the typed-array generic to `ArrayBufferLike` so that
  // the values returned by `resample` (and reassigned `new Float32Array(0)`)
  // are assignable back into these locals under TS 5.7+'s stricter rules.
  let leftFloat: Float32Array<ArrayBufferLike> = audio.getChannelData(0);
  let rightFloat: Float32Array<ArrayBufferLike> =
    channels === 2 ? audio.getChannelData(1) : leftFloat;

  if (sourceRate !== targetRate) {
    leftFloat = resample(leftFloat, sourceRate, targetRate);
    if (channels === 2) {
      rightFloat = resample(rightFloat, sourceRate, targetRate);
    } else {
      rightFloat = leftFloat;
    }
  }

  const left = floatToInt16(leftFloat);
  const right = channels === 2 ? floatToInt16(rightFloat) : left;

  // Free the float buffers as we go — these can be huge for long videos.
  leftFloat = new Float32Array(0);
  rightFloat = new Float32Array(0);

  const encoder = new lamejs.Mp3Encoder(channels, targetRate, bitrate);
  const SAMPLES_PER_FRAME = 1152; // lamejs's preferred chunk size
  const totalSamples = left.length;
  const mp3Data: Uint8Array[] = [];

  let lastYield = performance.now();
  for (let i = 0; i < totalSamples; i += SAMPLES_PER_FRAME) {
    const end = Math.min(i + SAMPLES_PER_FRAME, totalSamples);
    const leftChunk = left.subarray(i, end);
    const buf =
      channels === 2
        ? encoder.encodeBuffer(leftChunk, right.subarray(i, end))
        : encoder.encodeBuffer(leftChunk);
    if (buf.length > 0) {
      mp3Data.push(buf);
    }

    // Yield every ~16ms so the UI thread can paint progress and we can
    // honor cancellation requests.
    const now = performance.now();
    if (now - lastYield > 16) {
      ensureNotAborted(signal);
      onProgress?.({
        stage: "encoding",
        progress: Math.min(i / totalSamples, 1),
        message: `Encoding MP3… ${Math.round((i / totalSamples) * 100)}%`,
      });
      lastYield = now;
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  ensureNotAborted(signal);
  const tail = encoder.flush();
  if (tail.length > 0) mp3Data.push(tail);

  onProgress?.({
    stage: "finalizing",
    progress: 1,
    message: "Finalizing MP3…",
  });

  // Cast to BlobPart[] — TS 5.7+ distinguishes ArrayBuffer from
  // SharedArrayBuffer in typed-array generics, but Blob accepts both.
  const blob = new Blob(mp3Data as BlobPart[], { type: "audio/mpeg" });
  return { blob, channels, sampleRate: targetRate };
}

/**
 * Run the full pipeline: download → decode → encode. Reports progress at
 * every stage and supports cancellation via AbortSignal.
 */
export async function downloadAndEncodeMp3(
  options: EncodeOptions,
): Promise<EncodeResult> {
  const { input, cookies, contentLength, onProgress, signal } = options;
  const bitrate = options.bitrate ?? DEFAULT_BITRATE;

  ensureNotAborted(signal);

  const bytes = await downloadWithProgress(
    input,
    cookies,
    contentLength ?? null,
    onProgress,
    signal,
  );
  ensureNotAborted(signal);

  const audio = await decodeAudio(bytes, onProgress, signal);
  ensureNotAborted(signal);

  const { blob, channels, sampleRate } = await encodeMp3(
    audio,
    bitrate,
    onProgress,
    signal,
  );

  return {
    blob,
    durationSeconds: audio.duration,
    sampleRate,
    channels,
    bitrate,
  };
}

/**
 * Trigger a browser download for the given Blob with the given filename.
 * Uses a temporary `<a download>` link, which works on all modern browsers
 * including iOS Safari 13+.
 */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".mp3") ? filename : `${filename}.mp3`;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Defer revoke so the browser has time to start the download.
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}
