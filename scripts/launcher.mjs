#!/usr/bin/env node
/**
 * Desktop launcher for the YT → MP3 app.
 *
 * This is the entry point compiled into the standalone binary by
 * `@yao-pkg/pkg`. When the user double-clicks the resulting `.exe`
 * (or Mac / Linux binary), this is what runs.
 *
 * Responsibilities, in order:
 *
 *   1. Extract the bundled yt-dlp binary from pkg's read-only
 *      virtual snapshot to a real, writable, executable location
 *      under the user's home directory. We can't `execve` files
 *      that live inside the snapshot — there's no inode for the
 *      OS to point a file descriptor at — so we copy bytes out
 *      to disk on first run.
 *
 *   2. Pick a free TCP port. Defaults to 3000, falls back to a
 *      random ephemeral port if 3000 is in use (common when the
 *      user already has another local server running).
 *
 *   3. Set the env vars the SvelteKit server expects:
 *        - PORT / HOST  → adapter-node binds to the right place
 *        - ORIGIN       → adapter-node's CSRF / origin checks pass
 *        - YT_DLP_PATH  → src/lib/yt-dlp.ts uses the extracted
 *                        binary instead of looking at ./bin
 *
 *   4. Dynamically import the built SvelteKit Node server. We use
 *      ESM `import()` (and ship this file as `.mjs`) because
 *      `@sveltejs/adapter-node` produces ESM output with top-level
 *      `await`, which pkg's CommonJS transformer can't handle —
 *      the only reliable way to load it inside a pkg snapshot is
 *      through the native ESM loader.
 *
 *   5. Once the server is listening, open the user's default
 *      browser to http://localhost:<port>. The user never sees a
 *      terminal — the whole interaction is "double-click → app
 *      opens in the browser".
 *
 *   6. Keep the process alive until the user closes the console
 *      window or hits Ctrl+C, at which point we cleanly exit.
 */

import { spawn } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Path / environment helpers
// ---------------------------------------------------------------------------

/**
 * `__dirname` doesn't exist in ESM, so we synthesize it from
 * `import.meta.url`. Inside a pkg snapshot this resolves to a path
 * like `/snapshot/yt-mp3/scripts`, which `fs` and `require` both
 * understand because pkg patches them; outside (during `bun run
 * launcher` against a checkout) it's the real filesystem path.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Whether we're running inside a pkg-compiled binary. */
const IS_PACKAGED = typeof process.pkg !== 'undefined';

/** Default port; can be overridden via the PORT env var. */
const DEFAULT_PORT = Number(process.env.PORT) || 3000;

/** Bind host. 127.0.0.1 keeps the app local-only — we don't want
 *  random devices on the same Wi-Fi hitting the user's server. */
const HOST = process.env.HOST || '127.0.0.1';

/** Platform-specific yt-dlp executable name. */
const YT_DLP_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

/** Print a status line with a uniform `[yt-mp3]` prefix so the user
 *  can tell launcher output from any noise the SvelteKit server
 *  itself emits later. */
function log(message) {
	process.stdout.write(`[yt-mp3] ${message}\n`);
}

/** Non-fatal warning. Prints to stderr but execution continues. */
function warn(message) {
	process.stderr.write(`[yt-mp3] ${message}\n`);
}

/**
 * Print a fatal error and keep the console window open long enough
 * for the user to actually read it. In a pkg-built binary launched
 * by double-click, the window closes the instant the process exits,
 * which is too fast for any non-technical user to see what went
 * wrong. We pause on stdin until they hit Enter (or 60s, so we
 * don't hang headless invocations).
 */
function fatal(message) {
	process.stderr.write(`\n[yt-mp3] ERROR: ${message}\n\n`);
	process.stderr.write('Press Enter to close this window.\n');
	try {
		process.stdin.resume();
		process.stdin.once('data', () => process.exit(1));
		setTimeout(() => process.exit(1), 60_000).unref();
	} catch {
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// Step 1: extract the bundled yt-dlp binary
// ---------------------------------------------------------------------------

/**
 * Copy the bundled yt-dlp binary out of pkg's read-only snapshot
 * into a real, writable, executable file on disk, and return its
 * path. We extract once per install and reuse the result on
 * subsequent launches.
 *
 * In dev mode (running this file directly, not from a packaged
 * binary), the yt-dlp binary already exists at `./bin/yt-dlp` —
 * `scripts/install-yt-dlp.mjs` puts it there as a postinstall
 * step — so we just return that path verbatim.
 */
function extractYtDlp() {
	if (!IS_PACKAGED) {
		const devPath = join(process.cwd(), 'bin', YT_DLP_NAME);
		if (!existsSync(devPath)) {
			fatal(
				`yt-dlp binary not found at ${devPath}. ` +
					`Run \`bun run yt-dlp:update\` and try again.`
			);
		}
		return devPath;
	}

	// pkg statically analyses `path.join(__dirname, ...)` calls at
	// build time to decide which assets to bundle. The literal
	// `bin/<name>` segment matches the `pkg.assets` glob in
	// package.json so the binary actually ends up in the snapshot.
	const snapshotPath = join(__dirname, '..', 'bin', YT_DLP_NAME);

	// Pick a stable destination under the user's home directory.
	// `.yt-mp3` is hidden on POSIX and harmless on Windows — easy to
	// delete by hand if the user wants a clean uninstall, doesn't
	// collide with anything else on disk.
	const dataDir = join(homedir(), '.yt-mp3');
	const destPath = join(dataDir, YT_DLP_NAME);

	// Fast path: already extracted from a previous launch.
	try {
		const s = statSync(destPath);
		if (s.isFile() && s.size > 0) return destPath;
	} catch {
		// Doesn't exist yet — fall through to extract.
	}

	log('First run: unpacking yt-dlp (this happens once)…');

	try {
		mkdirSync(dataDir, { recursive: true });
	} catch (err) {
		fatal(`Could not create app data directory at ${dataDir}: ${err.message}`);
	}

	let bytes;
	try {
		bytes = readFileSync(snapshotPath);
	} catch (err) {
		fatal(
			`Could not read bundled yt-dlp from ${snapshotPath}: ${err.message}\n` +
				`This usually means the binary was built without yt-dlp included. ` +
				`Check that bin/${YT_DLP_NAME} existed at build time.`
		);
	}

	// Write through a `.tmp` sibling and rename so an interrupted
	// write (user closes the window during first-run extraction)
	// doesn't leave a half-written binary that the next launch
	// would happily try to execute.
	const tmpPath = `${destPath}.tmp`;
	try {
		writeFileSync(tmpPath, bytes);
		if (process.platform !== 'win32') {
			chmodSync(tmpPath, 0o755);
		}
		renameSync(tmpPath, destPath);
	} catch (err) {
		fatal(
			`Could not write yt-dlp to ${destPath}: ${err.message}\n` +
				`Check that you have write permission to your home directory.`
		);
	}

	log(`Unpacked to ${destPath}`);
	return destPath;
}

// ---------------------------------------------------------------------------
// Step 2: pick a free port
// ---------------------------------------------------------------------------

/**
 * Resolve to a TCP port we can bind on `HOST`. Tries `preferred`
 * first; if it's in use, asks the OS for a random ephemeral port
 * (port 0 in `server.listen`). There's a tiny race between this
 * check and the SvelteKit server actually binding, but on a single
 * user's machine it's not a real problem.
 */
function pickPort(preferred) {
	return new Promise((resolve) => {
		const tryBind = (port) => {
			const server = createServer();
			server.unref();
			server.once('error', (err) => {
				if (port === preferred && err.code === 'EADDRINUSE') {
					tryBind(0);
				} else {
					// Anything else (permission denied, etc.) — bail
					// to the preferred port and let the SvelteKit
					// server surface a clearer error if it can't
					// actually bind either.
					resolve(preferred);
				}
			});
			server.listen(port, HOST, () => {
				const addr = server.address();
				const chosen = typeof addr === 'object' && addr ? addr.port : port;
				server.close(() => resolve(chosen));
			});
		};
		tryBind(preferred);
	});
}

// ---------------------------------------------------------------------------
// Step 3: open the user's browser
// ---------------------------------------------------------------------------

/**
 * Open `url` in the user's default browser using the OS's standard
 * "open this thing" command. Done with `spawn` rather than the `open`
 * npm package because:
 *
 *   - One less dependency in the bundle.
 *   - The `open` package's behaviour inside pkg snapshots has
 *     historically been flaky on Windows.
 *   - The native commands below are stable and well-understood.
 *
 * If launching the browser fails (no GUI, headless container,
 * exotic distro) we just print the URL and trust the user to
 * copy/paste it. Failing to open a browser shouldn't crash the
 * launcher — the server is still up and reachable.
 */
function openBrowser(url) {
	let command;
	let args;
	if (process.platform === 'win32') {
		// `start` is a cmd.exe builtin, not a standalone exe. Spawn
		// through cmd, with an empty string as the (otherwise
		// ambiguous) "window title" arg so URLs that look like
		// quoted strings don't confuse cmd's parser.
		command = 'cmd';
		args = ['/c', 'start', '', url];
	} else if (process.platform === 'darwin') {
		command = 'open';
		args = [url];
	} else {
		command = 'xdg-open';
		args = [url];
	}

	try {
		const child = spawn(command, args, {
			stdio: 'ignore',
			detached: true
		});
		// Detach so the launcher can exit even if the browser is
		// still around.
		child.unref();
		child.on('error', () => {
			warn(`Could not launch browser automatically. Open ${url} manually.`);
		});
	} catch {
		warn(`Could not launch browser automatically. Open ${url} manually.`);
	}
}

// ---------------------------------------------------------------------------
// Step 4: start the SvelteKit server
// ---------------------------------------------------------------------------

/**
 * Boot up the bundled SvelteKit Node server.
 *
 * The server entry is `build/index.js`, generated by
 * `@sveltejs/adapter-node`. It reads `PORT`, `HOST`, and `ORIGIN`
 * from `process.env` and starts listening on import, so we just
 * have to set those env vars and `import()` it.
 *
 * Why dynamic import (rather than top-level `import` or `require`):
 *
 *   - We need the env vars set before the module evaluates,
 *     otherwise adapter-node binds with the wrong port/host.
 *
 *   - The output is ESM with top-level `await`, which `require()`
 *     simply cannot load. pkg's CJS transformer also struggles
 *     with it; dynamic ESM `import()` is the only reliable path.
 *
 *   - Wrapping the path in `pathToFileURL` is required on Windows
 *     where bare `C:\...` paths are not valid module specifiers.
 */
async function startServer(port, ytDlpPath) {
	process.env.PORT = String(port);
	process.env.HOST = HOST;
	process.env.YT_DLP_PATH = ytDlpPath;

	// adapter-node compares the request's Origin header against
	// this value to decide whether to serve POST requests (CSRF
	// protection). For a localhost-only app the actual user is
	// always the only "origin", so we set it to match.
	process.env.ORIGIN = `http://${HOST}:${port}`;

	const serverEntry = join(__dirname, '..', 'build', 'index.js');

	if (!IS_PACKAGED && !existsSync(serverEntry)) {
		fatal(
			`Server bundle not found at ${serverEntry}.\n` +
				`Run \`bun run build\` before launching.`
		);
	}

	try {
		await import(pathToFileURL(serverEntry).href);
	} catch (err) {
		const msg = err && err.message ? err.message : String(err);
		fatal(
			`Could not start the server from ${serverEntry}: ${msg}\n` +
				`This usually means the build/ directory was not bundled into ` +
				`the binary correctly.`
		);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	log('Starting YT → MP3…');

	// 1. Get yt-dlp ready.
	const ytDlpPath = extractYtDlp();

	// 2. Pick a port.
	const port = await pickPort(DEFAULT_PORT);
	if (port !== DEFAULT_PORT) {
		warn(`Port ${DEFAULT_PORT} was in use; using port ${port} instead.`);
	}

	// 3. Start the server. adapter-node listens synchronously during
	//    its module load, so by the time `await import(...)` returns
	//    the port is bound.
	await startServer(port, ytDlpPath);

	const url = `http://${HOST}:${port}`;
	log(`Server is listening at ${url}`);
	log('Opening your browser…');
	log('Keep this window open while you use the app. Close it to quit.');

	// 4. Open the browser. We give the server a small head start to
	//    finish any pending startup work (route synthesis, asset
	//    indexing) before the browser actually hits it. 300ms is
	//    plenty in practice and imperceptible to the user.
	setTimeout(() => openBrowser(url), 300);

	// 5. Wire up clean shutdown. SIGINT (Ctrl+C) and SIGTERM both
	//    just exit; adapter-node closes its listener on process
	//    exit. We intentionally don't trap them and try to do
	//    graceful cleanup beyond that — a localhost server has no
	//    in-flight state worth waiting for, and the user expects
	//    the window to disappear when they close it.
	process.once('SIGINT', () => process.exit(0));
	process.once('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
	fatal(err && err.message ? err.message : String(err));
});
