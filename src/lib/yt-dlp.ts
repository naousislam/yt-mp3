import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { platform } from "node:process";

/**
 * Wrapper around the bundled yt-dlp binary in ./bin.
 *
 * We shell out to yt-dlp instead of using a JavaScript YouTube client
 * (ytdl-core, youtubei.js, ...) because YouTube's anti-bot heuristics
 * and signature-cipher updates have made every JS client unreliable
 * for actual stream downloads. yt-dlp is the gold-standard tool in
 * this space — updated within hours of every YouTube change, used by
 * millions, and battle-tested against every edge case (DRM, geo-
 * blocks, age gates, signature rotations, etc.) that we'd otherwise
 * have to chase ourselves.
 *
 * The trade-off is that we depend on a native binary at runtime,
 * which `scripts/install-yt-dlp.mjs` downloads on `postinstall`. The
 * binary lives at `./bin/yt-dlp` (or `yt-dlp.exe` on Windows) and is
 * fully self-contained — no Python or other runtime is required.
 *
 * This module exposes two operations used by the API endpoints:
 *
 *   - `getVideoInfo(url)`: returns parsed metadata + the best audio
 *     format yt-dlp can locate. Used by /api/info to render the
 *     preview card before the user hits "Convert to MP3".
 *
 *   - `streamAudio(url, signal)`: spawns yt-dlp in pipe-to-stdout
 *     mode and returns a Web `ReadableStream<Uint8Array>` of the
 *     compressed audio bytes. Used by /api/stream to feed the
 *     browser's MP3 encoder.
 */

/** Platform-specific name of the yt-dlp executable. */
const BINARY_NAME = platform === "win32" ? "yt-dlp.exe" : "yt-dlp";

/**
 * Resolve the path to the bundled yt-dlp binary. We look in `./bin`
 * relative to the project root (process.cwd()) so the lookup works
 * both during `bun run dev` and against the built server in
 * `./build`. If the binary is missing, callers see a clear error
 * pointing at the install script.
 */
function resolveBinaryPath(): string {
	const candidate = join(process.cwd(), "bin", BINARY_NAME);
	if (!existsSync(candidate)) {
		throw new Error(
			`yt-dlp binary not found at ${candidate}. ` +
				`Run \`bun run yt-dlp:update\` (or \`npm run yt-dlp:update\`) ` +
				`to download it.`,
		);
	}
	return candidate;
}

/**
 * Shape of the JSON yt-dlp emits with `--dump-single-json`. Only the
 * fields we actually consume are typed here — yt-dlp's output is huge
 * and most of it isn't relevant for converting a video to MP3.
 *
 * Field names mirror yt-dlp's output exactly (snake_case as it ships
 * them) so we can pick them up without an intermediate transform.
 */
export type YtDlpFormat = {
	/** yt-dlp's internal format identifier (numeric or string). */
	format_id: string;
	/** Container extension: `m4a`, `webm`, `mp3`, ... */
	ext: string;
	/** Bitrate in kbps as reported by YouTube. May be missing. */
	abr?: number | null;
	/** Total bitrate in kbps; falls back to `abr` when audio-only. */
	tbr?: number | null;
	/** Audio codec name: `mp4a.40.2`, `opus`, `aac`, ... */
	acodec?: string | null;
	/** Video codec; `'none'` for audio-only formats. */
	vcodec?: string | null;
	/** Audio sample rate in Hz, e.g. 44100. */
	asr?: number | null;
	/** Number of audio channels. */
	audio_channels?: number | null;
	/** Direct googlevideo URL. Useful for debugging only — we don't fetch it. */
	url?: string | null;
	/** Reported file size in bytes (sometimes only an estimate is available). */
	filesize?: number | null;
	filesize_approx?: number | null;
	/** Full mime type when present, e.g. `audio/mp4; codecs="mp4a.40.2"`. */
	mime_type?: string | null;
};

export type YtDlpThumbnail = {
	url: string;
	width?: number;
	height?: number;
};

export type YtDlpInfo = {
	id: string;
	title: string;
	uploader?: string | null;
	channel?: string | null;
	duration?: number | null;
	is_live?: boolean | null;
	live_status?: string | null;
	age_limit?: number | null;
	availability?: string | null;
	thumbnail?: string | null;
	thumbnails?: YtDlpThumbnail[];
	formats?: YtDlpFormat[];
};

/**
 * Run yt-dlp to completion and collect its stdout into a single
 * string. Used for one-shot operations like `--dump-single-json`
 * where we know the output is small (a few hundred KB at most).
 *
 * Rejects with a descriptive error if yt-dlp exits non-zero. The
 * stderr text from yt-dlp is included because it's where the actual
 * failure reason lives (e.g. "Sign in to confirm you're not a bot",
 * "Video unavailable", "Private video").
 */
function runToBuffer(args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(resolveBinaryPath(), args, {
			// Inherit nothing from the parent's stdin; we only care
			// about stdout/stderr.
			stdio: ["ignore", "pipe", "pipe"],
		});

		// Buffer stdout/stderr until exit. yt-dlp's JSON output for a
		// single video is tens of KB, so the memory cost is fine.
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

		const onAbort = () => {
			// SIGTERM is enough on POSIX; on Windows, Node translates
			// it to TerminateProcess which is the closest equivalent.
			child.kill("SIGTERM");
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});

		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			if (code !== 0) {
				reject(
					new YtDlpError(
						`yt-dlp exited with code ${code}: ${stderr.trim() || "no stderr"}`,
						{ stderr, exitCode: code ?? -1 },
					),
				);
				return;
			}
			resolve(stdout);
		});
	});
}

/**
 * Custom error type so callers can branch on the underlying yt-dlp
 * stderr text. This lets the API endpoints map "Sign in to confirm
 * you're not a bot" → 401, "Private video" → 404, age-gated → 403,
 * etc., without parsing strings in two places.
 */
export class YtDlpError extends Error {
	stderr: string;
	exitCode: number;
	constructor(
		message: string,
		options: { stderr: string; exitCode: number },
	) {
		super(message);
		this.name = "YtDlpError";
		this.stderr = options.stderr;
		this.exitCode = options.exitCode;
	}
}

/**
 * Fetch metadata + format list for a YouTube video.
 *
 * Args explained:
 *   --dump-single-json   Print the full info dict as one JSON blob to
 *                        stdout instead of downloading anything.
 *   --skip-download      Belt-and-suspenders with the above; ensures
 *                        yt-dlp doesn't side-effect to disk if it
 *                        ever interprets the URL as a playlist.
 *   --no-warnings        Suppress informational messages on stderr
 *                        so our error reporting stays clean.
 *   --no-playlist        For URLs like `watch?v=X&list=Y`, only fetch
 *                        the single video — never the whole playlist.
 *   --no-call-home       Skip the optional "phone-home" telemetry
 *                        request yt-dlp can make to check for
 *                        updates. Faster startup, no network hop.
 */
export async function getVideoInfo(
	url: string,
	signal?: AbortSignal,
): Promise<YtDlpInfo> {
	const stdout = await runToBuffer(
		[
			"--dump-single-json",
			"--skip-download",
			"--no-warnings",
			"--no-playlist",
			"--no-call-home",
			url,
		],
		signal,
	);

	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (err) {
		const message = err instanceof Error ? err.message : "invalid JSON";
		throw new Error(`Could not parse yt-dlp output: ${message}`);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error("yt-dlp returned a non-object JSON payload");
	}

	return parsed as YtDlpInfo;
}

/**
 * Spawn yt-dlp in pipe-to-stdout mode and return its audio bytes as
 * a Web `ReadableStream<Uint8Array>`. The stream is suitable for
 * passing directly to `new Response(stream)` in a SvelteKit
 * `+server.ts` handler.
 *
 * Args explained:
 *   -f bestaudio        Pick the best-quality audio-only format
 *                       yt-dlp can find. We don't constrain by
 *                       codec — the browser's `decodeAudioData`
 *                       handles m4a, webm/opus, and webm/vorbis
 *                       interchangeably.
 *   -o -                Write the output to stdout instead of a
 *                       file. Combined with `--no-part`, this
 *                       streams bytes to us as they arrive rather
 *                       than buffering the whole download to disk.
 *   --no-part           Don't write to a `.part` temp file before
 *                       atomically renaming. Required when output
 *                       is stdout.
 *   --quiet             Suppress progress bars and info messages
 *                       on stderr; we only want the actual error
 *                       text if something goes wrong.
 *
 * If `signal` aborts (e.g. the browser disconnected mid-download),
 * we send SIGTERM to yt-dlp, which closes its googlevideo
 * connection and exits cleanly.
 */
export function streamAudio(
	url: string,
	signal?: AbortSignal,
): {
	stream: ReadableStream<Uint8Array>;
	/**
	 * Resolves to the stderr text once yt-dlp exits, regardless of
	 * exit code. Useful for surfacing the actual error to the
	 * client when the stream closes unexpectedly mid-flight.
	 */
	stderr: Promise<string>;
	/** Resolves with yt-dlp's exit code once it has terminated. */
	exitCode: Promise<number>;
} {
	const child = spawn(
		resolveBinaryPath(),
		[
			"-f",
			"bestaudio",
			"-o",
			"-",
			"--no-part",
			"--no-warnings",
			"--no-playlist",
			"--no-call-home",
			"--quiet",
			url,
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	// Collect stderr for the caller's diagnostic use. We don't pipe
	// it anywhere — the real client only ever sees stdout (the
	// audio bytes) and a status code.
	const stderrChunks: Buffer[] = [];
	child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

	const stderr = new Promise<string>((resolve) => {
		child.on("close", () => {
			resolve(Buffer.concat(stderrChunks).toString("utf8"));
		});
	});

	const exitCode = new Promise<number>((resolve) => {
		child.on("close", (code) => resolve(code ?? -1));
	});

	// If the request is aborted mid-flight, kill yt-dlp so it
	// stops downloading from googlevideo. SIGTERM is portable;
	// Node maps it to TerminateProcess on Windows.
	const onAbort = () => child.kill("SIGTERM");
	if (signal) {
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
		// Stop listening once the child is gone, so we don't leak
		// abort handlers if the request finishes normally.
		child.on("close", () => signal.removeEventListener("abort", onAbort));
	}

	// `Readable.toWeb` converts Node's stdout stream into the
	// standard Web ReadableStream that SvelteKit's `Response`
	// constructor expects. We cast the type because Node's stream
	// generic uses `any` while ours is the more specific Uint8Array.
	const stream = Readable.toWeb(
		child.stdout,
	) as ReadableStream<Uint8Array>;

	return { stream, stderr, exitCode };
}

/**
 * Convenience helper: pick the highest-bitrate audio-only format
 * from a yt-dlp info dump.
 *
 * yt-dlp's `formats` list contains every available stream — video,
 * audio, and combined. We filter to audio-only (vcodec === 'none')
 * and pick the highest-bitrate option, preferring AAC / m4a over
 * opus / webm because every browser's `decodeAudioData` handles
 * AAC reliably (older Safari versions are picky about webm/opus).
 */
export function pickBestAudioFormat(info: YtDlpInfo): YtDlpFormat | null {
	const formats = info.formats ?? [];
	const audioOnly = formats.filter(
		(f) => f.vcodec === "none" && f.acodec && f.acodec !== "none",
	);
	if (audioOnly.length === 0) return null;

	const score = (f: YtDlpFormat): number => {
		// Prefer m4a / mp4 (AAC) over webm / opus. Both decode in
		// every modern browser, but AAC is more universally
		// supported and tends to produce smaller intermediate
		// buffers during decode.
		const containerScore =
			f.ext === "m4a" || f.ext === "mp4" ? 1000 : f.ext === "webm" ? 500 : 0;
		const bitrate = f.abr ?? f.tbr ?? 0;
		return containerScore + bitrate;
	};

	return audioOnly.reduce((best, current) =>
		score(current) > score(best) ? current : best,
	);
}
