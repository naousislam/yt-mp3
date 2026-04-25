import type { Innertube } from "youtubei.js";

/**
 * Module-level Innertube client cache, shared between /api/info and
 * /api/stream so both endpoints resolve formats consistently.
 *
 * `Innertube.create()` does network I/O (it fetches the YouTube player
 * config used to decipher signature ciphers and `n` parameters) and
 * allocates a non-trivial amount of memory for protobuf classes, so we
 * don't want to do that on every request. Caching the instance for the
 * lifetime of the process is safe — youtubei.js handles its own
 * internal player-version refresh when the cached config goes stale.
 *
 * The reason this lives in `$lib` and not next to the API endpoints is
 * a SvelteKit constraint: `+server.ts` files may only export specific
 * symbols (`GET`, `POST`, `config`, `prerender`, etc.). Anything else
 * fails the post-build analysis with:
 *
 *     Invalid export 'getInnertube' in /api/info
 *
 * Lifting the cache up here keeps the API handlers compliant while
 * still letting both endpoints share a single instance.
 */
let innertubePromise: Promise<Innertube> | null = null;

/**
 * Returns a lazily-initialized Innertube client. Concurrent callers
 * during the very first request all `await` the same in-flight
 * promise, so we only do the (expensive) bootstrap once even under
 * load.
 */
export async function getInnertube(): Promise<Innertube> {
	if (!innertubePromise) {
		innertubePromise = createInnertube().catch((err) => {
			// On failure, clear the cache so the next request can retry
			// from scratch. Otherwise a transient YouTube hiccup at boot
			// would poison the process for its entire lifetime.
			innertubePromise = null;
			throw err;
		});
	}
	return innertubePromise;
}

async function createInnertube(): Promise<Innertube> {
	// Lazy-import youtubei.js so the SSR build doesn't have to bundle
	// its (heavy) protobuf classes when only types are needed elsewhere
	// (e.g. when this module is referenced purely for `import type`).
	const { Innertube } = await import("youtubei.js");

	return Innertube.create({
		// Generate the visitor session locally rather than calling out
		// to YouTube for one. Faster startup, no extra network hop, and
		// no behaviour difference for read-only video info / streaming.
		generate_session_locally: true,
	});
}

/**
 * Reset the cached Innertube client. Intended for tests / dev tooling
 * where you want to force a fresh bootstrap (e.g. after mocking the
 * underlying fetch). Not used by the API handlers themselves.
 */
export function resetInnertubeCache(): void {
	innertubePromise = null;
}
