/**
 * Shared types for the API endpoints.
 *
 * Kept in `$lib` (rather than colocated with the `+server.ts` files) so that
 * the client-side `+page.svelte` can `import type { ... }` without pulling
 * the server-only `@distube/ytdl-core` module into the client/SSR graph.
 *
 * Importing from `+server.ts` files works at type-check time, but Vite's
 * SSR bundler walks those imports at build time and tries to load the
 * server module, which fails on runtimes (like Bun) whose `undici`
 * polyfill is missing APIs that `ytdl-core` calls during module init.
 */

export type AudioFormatMeta = {
	/** YouTube's internal format tag, useful for debugging. */
	itag: number;
	/** Full mimeType string, e.g. `audio/mp4; codecs="mp4a.40.2"`. */
	mimeType: string;
	/** Container as ytdl-core labels it: `mp4`, `webm`, `3gp`, `flv`, `ts`. */
	container: string;
	/** Codec extracted from the mimeType (e.g. `mp4a.40.2` or `opus`). */
	codec: string;
	/** Source bitrate in kbps as reported by YouTube. */
	bitrate: number;
	/** Total byte length of the compressed stream, if known. */
	contentLength: number | null;
};

export type InfoResponse = {
	/** Canonical 11-character YouTube video ID. */
	id: string;
	/** Display title of the video. */
	title: string;
	/** Channel / uploader name. */
	author: string;
	/** Total length of the video in seconds. */
	durationSeconds: number;
	/** URL of the highest-resolution thumbnail YouTube exposes. */
	thumbnail: string;
	/** Sanitized filename (no extension) suitable for use in a download. */
	filename: string;
	/** Metadata about the audio format the server selected. */
	format: AudioFormatMeta;
};

/**
 * Shape of the JSON body SvelteKit's `error()` helper produces. We surface
 * `message` to the user when a request to /api/info or /api/stream fails.
 */
export type ApiErrorBody = {
	message: string;
};
