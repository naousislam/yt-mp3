/**
 * Extract a YouTube video ID from various URL formats, or return the input
 * unchanged if it already looks like a bare 11-character ID.
 *
 * Supported formats:
 *  - https://www.youtube.com/watch?v=VIDEO_ID
 *  - https://youtu.be/VIDEO_ID
 *  - https://www.youtube.com/embed/VIDEO_ID
 *  - https://www.youtube.com/shorts/VIDEO_ID
 *  - https://www.youtube.com/v/VIDEO_ID
 *  - https://m.youtube.com/watch?v=VIDEO_ID
 *  - VIDEO_ID (bare 11-char id)
 */
export function extractVideoId(input: string): string | null {
	if (!input) return null;
	const trimmed = input.trim();

	// Bare ID
	if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
		return trimmed;
	}

	let url: URL;
	try {
		// Allow input without protocol (e.g. "youtu.be/...")
		url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
	} catch {
		return null;
	}

	const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');

	if (host === 'youtu.be') {
		const id = url.pathname.slice(1).split('/')[0];
		return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
	}

	if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
		// /watch?v=ID
		const v = url.searchParams.get('v');
		if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

		// /embed/ID, /v/ID, /shorts/ID, /live/ID
		const segments = url.pathname.split('/').filter(Boolean);
		if (segments.length >= 2) {
			const [prefix, id] = segments;
			if (
				['embed', 'v', 'shorts', 'live'].includes(prefix) &&
				/^[a-zA-Z0-9_-]{11}$/.test(id)
			) {
				return id;
			}
		}
	}

	return null;
}

/** Format a duration in seconds as `m:ss` or `h:mm:ss`. */
export function formatDuration(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(s / 3600);
	const minutes = Math.floor((s % 3600) / 60);
	const seconds = s % 60;
	const pad = (n: number) => n.toString().padStart(2, '0');
	if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
	return `${minutes}:${pad(seconds)}`;
}

/** Sanitize a video title so it can safely be used as a filename. */
export function sanitizeFilename(name: string, maxLength = 120): string {
	const cleaned = name
		.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '') // illegal on most filesystems
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length === 0) return 'audio';
	return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

/** Format a byte count as a human-readable string. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	const value = bytes / Math.pow(1024, i);
	return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export const MAX_DURATION_SECONDS = 15 * 60; // 15 minutes
