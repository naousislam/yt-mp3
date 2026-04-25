#!/usr/bin/env node
/**
 * Postinstall script: downloads the yt-dlp binary appropriate for the
 * host OS into ./bin so the SvelteKit server can spawn it at runtime.
 *
 * yt-dlp ships standalone binaries (no Python install required) on its
 * GitHub releases page. We grab the latest stable build the first time
 * `bun install` / `npm install` runs, and skip re-downloading if the
 * binary already exists. To force a refresh: `bun run yt-dlp:update`.
 *
 * Why we do this instead of `pip install yt-dlp`:
 *   - Removes Python from the user's prerequisites — Node is enough.
 *   - Keeps the version pinned per project, so an OS-wide yt-dlp
 *     upgrade can't unexpectedly change the app's behaviour.
 *   - The binary self-updates against YouTube's API changes; we just
 *     need to occasionally re-pull the latest release.
 *
 * Designed to be safe to run repeatedly. If the download fails (e.g.
 * the user is offline at install time), we print a friendly message
 * and exit 0 so the install doesn't fail outright — the user can
 * retry later with `bun run yt-dlp:update`.
 */

import { mkdir, stat, chmod, rename, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { platform, arch } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const BIN_DIR = join(PROJECT_ROOT, 'bin');

/**
 * Pick the right asset name from yt-dlp's GitHub release for the
 * current OS + architecture. Names are taken from the asset list at
 * https://github.com/yt-dlp/yt-dlp/releases/latest.
 *
 * We prefer the single-file standalone binaries (no extra runtime
 * needed) over the .zip / .tar archives.
 */
function pickAsset() {
	if (platform === 'win32') {
		// `yt-dlp.exe` is the standard standalone Windows build.
		return { asset: 'yt-dlp.exe', filename: 'yt-dlp.exe', executable: false };
	}
	if (platform === 'darwin') {
		// macOS standalone binary; works on both Intel and Apple Silicon.
		return { asset: 'yt-dlp_macos', filename: 'yt-dlp', executable: true };
	}
	if (platform === 'linux') {
		// Pick the right Linux build by architecture. yt-dlp publishes
		// dedicated arm / aarch64 binaries; the generic `yt-dlp` asset
		// is a Python zipapp that requires Python 3.9+ on PATH, which
		// we don't want to depend on. The native ones below are
		// self-contained.
		if (arch === 'arm64') {
			return { asset: 'yt-dlp_linux_aarch64', filename: 'yt-dlp', executable: true };
		}
		if (arch === 'arm') {
			return { asset: 'yt-dlp_linux_armv7l', filename: 'yt-dlp', executable: true };
		}
		// x64 / unknown → the standard Linux build.
		return { asset: 'yt-dlp_linux', filename: 'yt-dlp', executable: true };
	}
	return null;
}

/** Returns true if `path` exists and is non-empty. */
async function exists(path) {
	try {
		const s = await stat(path);
		return s.isFile() && s.size > 0;
	} catch {
		return false;
	}
}

/**
 * Stream a remote URL to a file on disk. Follows redirects (GitHub
 * release downloads redirect to a CDN). Throws on non-2xx.
 */
async function downloadTo(url, destPath) {
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText} fetching ${url}`);
	}
	if (!response.body) {
		throw new Error(`Empty response body fetching ${url}`);
	}
	// Write to a sibling .tmp file first, then rename, so an
	// interrupted download doesn't leave a half-written binary
	// that exists() will later think is valid.
	const tmpPath = `${destPath}.tmp`;
	await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath));
	await rename(tmpPath, destPath);
}

async function main() {
	const choice = pickAsset();
	if (!choice) {
		console.warn(
			`[install-yt-dlp] Unsupported platform: ${platform}/${arch}. ` +
				`Skipping download — you'll need to place a yt-dlp binary in ./bin manually.`
		);
		return;
	}

	const force = process.argv.includes('--force');
	const destPath = join(BIN_DIR, choice.filename);

	if (!force && (await exists(destPath))) {
		// Already installed — staying quiet keeps `bun install`
		// output uncluttered for everyday installs.
		return;
	}

	const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${choice.asset}`;
	console.log(`[install-yt-dlp] Downloading ${choice.asset} → bin/${choice.filename}`);

	try {
		await mkdir(BIN_DIR, { recursive: true });
		// Best-effort cleanup of any prior partial download.
		await unlink(`${destPath}.tmp`).catch(() => {});
		await downloadTo(url, destPath);
		if (choice.executable) {
			await chmod(destPath, 0o755);
		}
		console.log(`[install-yt-dlp] Done. yt-dlp is ready at bin/${choice.filename}.`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(
			`[install-yt-dlp] Failed to download yt-dlp: ${message}\n` +
				`The app will not be able to fetch videos until you run:\n` +
				`    bun run yt-dlp:update\n` +
				`(or place a yt-dlp binary at bin/${choice.filename} manually).`
		);
		// Exit 0 so the package install itself doesn't fail. Many
		// users hit `bun install` offline / behind firewalls and we
		// don't want to block their setup over a fetchable binary.
		process.exitCode = 0;
	}
}

main().catch((err) => {
	console.error('[install-yt-dlp] Unexpected error:', err);
	// Same rationale as above: don't break `bun install` over this.
	process.exitCode = 0;
});
