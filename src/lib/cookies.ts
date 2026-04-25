/**
 * Cookie handling for forwarding a user's YouTube session to our server.
 *
 * Why we need this: YouTube blocks requests from known datacenter IP ranges
 * (e.g. Vercel) with a "sign in to confirm you're not a bot" error. The
 * easiest workaround is to let each user paste their own YouTube cookies,
 * which we then forward to ytdl-core on every request. With a real session
 * cookie attached, YouTube treats the request as a normal browser hit.
 *
 * Security note: cookies are stored in localStorage on the client and only
 * sent to our /api/* endpoints over HTTPS. They're never persisted on the
 * server — we attach them to the outbound googlevideo request and forget
 * them. Users should still use a throwaway Google account; see README.
 */
 
/** A single cookie that we'll forward to YouTube. */
export type Cookie = {
	name: string;
	value: string;
	/** Optional domain — `.youtube.com` is assumed if missing. */
	domain?: string;
};

/**
 * The shape ytdl-core's `requestOptions.cookies` accepts. Matches the
 * Netscape cookie object format used by tough-cookie internally.
 */
export type YtdlCookie = {
	name: string;
	value: string;
	domain: string;
};

/** Names of cookies that actually matter for YouTube auth. Everything else
 *  we drop on the floor — there's no point shipping kilobytes of ad / consent
 *  cookies to the server, and it reduces the blast radius if a leak ever
 *  happened. This list mirrors what yt-dlp / ytdl-core care about. */
const RELEVANT_COOKIE_NAMES = new Set([
	'SID',
	'HSID',
	'SSID',
	'APISID',
	'SAPISID',
	'__Secure-1PSID',
	'__Secure-3PSID',
	'__Secure-1PSIDTS',
	'__Secure-3PSIDTS',
	'__Secure-1PSIDCC',
	'__Secure-3PSIDCC',
	'__Secure-1PAPISID',
	'__Secure-3PAPISID',
	'LOGIN_INFO',
	'PREF',
	'YSC',
	'VISITOR_INFO1_LIVE',
	'VISITOR_PRIVACY_METADATA',
	'CONSENT',
	'SOCS',
	'GPS'
]);

/**
 * Parse user-provided cookie text in any of the three formats users might
 * realistically have on their clipboard:
 *
 *   1. Netscape "cookies.txt" format — what extensions like "Get cookies.txt
 *      LOCALLY" and yt-dlp produce. Tab-separated, lines starting with `#`
 *      are comments. Columns: domain, includeSubdomains, path, secure,
 *      expiration, name, value.
 *
 *   2. JSON array — what extensions like "EditThisCookie" and "Cookie-Editor"
 *      export. An array of `{ name, value, domain, ... }` objects.
 *
 *   3. HTTP header style — `name1=value1; name2=value2`. What you get from
 *      copying the `Cookie:` request header in DevTools.
 *
 * Returns only cookies whose name is in `RELEVANT_COOKIE_NAMES`. Throws if
 * nothing parseable is found, so the UI can show a useful error.
 */
export function parseCookies(input: string): Cookie[] {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error('No cookies provided');
	}

	let parsed: Cookie[] = [];
	let lastError: unknown = null;

	// 1. Try JSON first — it's unambiguous (must start with `[` or `{`).
	if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
		try {
			parsed = parseJsonCookies(trimmed);
		} catch (err) {
			lastError = err;
		}
	}

	// 2. If we don't have any cookies yet, try Netscape format.
	//    The signature is "tab-separated lines, often a # Netscape header".
	if (parsed.length === 0 && (/^#/m.test(trimmed) || /\t/.test(trimmed))) {
		try {
			parsed = parseNetscapeCookies(trimmed);
		} catch (err) {
			lastError = err;
		}
	}

	// 3. Last resort: header format. Always attempt this if nothing else
	//    matched, because it's the most permissive parser.
	if (parsed.length === 0) {
		try {
			parsed = parseHeaderCookies(trimmed);
		} catch (err) {
			lastError = err;
		}
	}

	if (parsed.length === 0) {
		const detail =
			lastError instanceof Error ? `: ${lastError.message}` : '';
		throw new Error(
			`Could not parse any cookies from the input${detail}. ` +
				'Make sure you copied them in Netscape, JSON, or "name=value; name=value" format.'
		);
	}

	const filtered = filterRelevantCookies(parsed);
	if (filtered.length === 0) {
		throw new Error(
			'No YouTube authentication cookies were found in the input. ' +
				'Make sure you exported cookies from youtube.com while logged in.'
		);
	}
	return filtered;
}

/** Parse the Netscape "cookies.txt" format. */
function parseNetscapeCookies(text: string): Cookie[] {
	const cookies: Cookie[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		// Skip blank lines and comments. The "#HttpOnly_" prefix is a
		// curl/wget convention that flags httpOnly cookies — strip it and
		// keep parsing.
		if (!line) continue;
		const stripped = line.startsWith('#HttpOnly_')
			? line.slice('#HttpOnly_'.length)
			: line.startsWith('#')
				? null
				: line;
		if (stripped === null) continue;

		const parts = stripped.split('\t');
		// Netscape format has exactly 7 columns; anything else we ignore.
		if (parts.length < 7) continue;
		const [domain, , , , , name, value] = parts;
		if (!name) continue;
		cookies.push({
			name: name.trim(),
			value: value?.trim() ?? '',
			domain: normalizeDomain(domain)
		});
	}
	return cookies;
}

/** Parse a JSON array of cookie objects (EditThisCookie / Cookie-Editor). */
function parseJsonCookies(text: string): Cookie[] {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'invalid JSON';
		throw new Error(message);
	}

	const list = Array.isArray(data) ? data : [data];
	const cookies: Cookie[] = [];
	for (const item of list) {
		if (!item || typeof item !== 'object') continue;
		const obj = item as Record<string, unknown>;
		const name = typeof obj.name === 'string' ? obj.name : null;
		const value = typeof obj.value === 'string' ? obj.value : null;
		if (!name || value === null) continue;
		const domain =
			typeof obj.domain === 'string' ? normalizeDomain(obj.domain) : undefined;
		cookies.push({ name, value, domain });
	}
	return cookies;
}

/** Parse a `Cookie:` request header value: `name=value; name=value; ...` */
function parseHeaderCookies(text: string): Cookie[] {
	const cookies: Cookie[] = [];
	// Header format uses `;` as a separator. Newlines are tolerated for
	// users who paste with weird wrapping.
	const pairs = text
		.split(/[;\n]/)
		.map((p) => p.trim())
		.filter(Boolean);
	for (const pair of pairs) {
		const eq = pair.indexOf('=');
		if (eq <= 0) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (!name) continue;
		// Strip surrounding quotes that browsers sometimes add.
		const cleaned = value.replace(/^"(.*)"$/, '$1');
		cookies.push({ name, value: cleaned });
	}
	return cookies;
}

/** Drop cookies that aren't part of YouTube's auth, and prefer specific
 *  domains over generic ones if the same cookie name appears multiple
 *  times. */
function filterRelevantCookies(cookies: Cookie[]): Cookie[] {
	const byName = new Map<string, Cookie>();
	for (const cookie of cookies) {
		if (!RELEVANT_COOKIE_NAMES.has(cookie.name)) continue;
		const existing = byName.get(cookie.name);
		if (!existing) {
			byName.set(cookie.name, cookie);
			continue;
		}
		// Prefer the variant whose domain looks like a YouTube/Google domain.
		const score = (c: Cookie) => {
			const d = c.domain ?? '';
			if (d.includes('youtube.com')) return 3;
			if (d.includes('google.com')) return 2;
			if (d) return 1;
			return 0;
		};
		if (score(cookie) > score(existing)) {
			byName.set(cookie.name, cookie);
		}
	}
	return Array.from(byName.values());
}

/** Normalize cookie domains: strip leading dots, lowercase. */
function normalizeDomain(raw: string): string {
	const trimmed = raw.trim().toLowerCase();
	return trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
}

/**
 * Convert our internal Cookie objects into the shape ytdl-core expects.
 * If a cookie has no domain, we default to `.youtube.com` because YouTube
 * sets most of its session cookies on either `.youtube.com` or
 * `.google.com` and the former covers ytdl-core's needs.
 */
export function toYtdlCookies(cookies: Cookie[]): YtdlCookie[] {
	return cookies.map((c) => ({
		name: c.name,
		value: c.value,
		domain: c.domain ?? '.youtube.com'
	}));
}

/**
 * Render cookies as a `Cookie:` header string. We use this to forward auth
 * to googlevideo on the streaming endpoint, where ytdl-core has already
 * resolved the URL but we still need the request to look authenticated.
 */
export function toCookieHeader(cookies: Cookie[]): string {
	return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Quick health check for a cookie set. We require at least one of the
 * Google session-ID cookies to be present, otherwise authenticated
 * requests will fail anyway and we'd rather tell the user up front.
 */
export function looksLikeAuthenticated(cookies: Cookie[]): boolean {
	const names = new Set(cookies.map((c) => c.name));
	return (
		names.has('SID') ||
		names.has('__Secure-1PSID') ||
		names.has('__Secure-3PSID')
	);
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'yt-mp3:cookies:v1';

type StoredCookies = {
	savedAt: number;
	cookies: Cookie[];
};

/** Persist cookies in localStorage so the user doesn't have to paste them
 *  on every visit. Safe to call from SSR (no-ops on the server). */
export function saveStoredCookies(cookies: Cookie[]): void {
	if (typeof localStorage === 'undefined') return;
	const payload: StoredCookies = { savedAt: Date.now(), cookies };
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
	} catch {
		// Quota exceeded / private mode — silently ignore. The user can
		// still convert this session, they just won't get auto-fill next time.
	}
}

/** Read cookies previously stored with `saveStoredCookies`, or null if
 *  none / corrupted. */
export function loadStoredCookies(): { cookies: Cookie[]; savedAt: number } | null {
	if (typeof localStorage === 'undefined') return null;
	const raw = localStorage.getItem(STORAGE_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as StoredCookies;
		if (
			!parsed ||
			!Array.isArray(parsed.cookies) ||
			typeof parsed.savedAt !== 'number'
		) {
			return null;
		}
		// Defensive: re-validate every cookie. If the schema changed since
		// the user last visited, drop the stale data instead of crashing.
		const cookies = parsed.cookies.filter(
			(c): c is Cookie =>
				!!c && typeof c.name === 'string' && typeof c.value === 'string'
		);
		if (cookies.length === 0) return null;
		return { cookies, savedAt: parsed.savedAt };
	} catch {
		return null;
	}
}

/** Forget any stored cookies. */
export function clearStoredCookies(): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// nothing useful to do here
	}
}