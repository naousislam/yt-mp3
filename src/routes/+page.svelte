<script lang="ts">
	import { downloadAndEncodeMp3, triggerDownload, type EncodeProgress } from '$lib/mp3';
	import { formatBytes, formatDuration } from '$lib/youtube';
	import type { InfoResponse } from '$lib/api-types';

	type Phase = 'idle' | 'fetching-info' | 'ready' | 'converting' | 'done' | 'error';

	let urlInput = $state('');
	let phase = $state<Phase>('idle');
	let info = $state<InfoResponse | null>(null);
	let errorMessage = $state<string | null>(null);

	let progress = $state<EncodeProgress | null>(null);
	let resultBlob = $state<Blob | null>(null);
	let resultMeta = $state<{
		size: number;
		bitrate: number;
		channels: 1 | 2;
		sampleRate: number;
	} | null>(null);

	let bitrate = $state<128 | 160 | 192 | 256 | 320>(192);

	let abortController: AbortController | null = null;

	const stageLabels: Record<EncodeProgress['stage'], string> = {
		downloading: 'Downloading',
		decoding: 'Decoding',
		encoding: 'Encoding',
		finalizing: 'Finalizing'
	};

	const isBusy = $derived(phase === 'fetching-info' || phase === 'converting');

	const progressPercent = $derived(
		progress?.progress != null ? Math.round(progress.progress * 100) : null
	);

	function reset() {
		abortController?.abort();
		abortController = null;
		phase = 'idle';
		info = null;
		errorMessage = null;
		progress = null;
		resultBlob = null;
		resultMeta = null;
	}

	function pasteFromClipboard() {
		if (!navigator.clipboard?.readText) return;
		navigator.clipboard
			.readText()
			.then((text) => {
				if (text) urlInput = text.trim();
			})
			.catch(() => {
				/* user denied permission — silently ignore */
			});
	}

	async function fetchInfo(event?: Event) {
		event?.preventDefault();
		if (!urlInput.trim() || isBusy) return;

		phase = 'fetching-info';
		errorMessage = null;
		info = null;
		resultBlob = null;
		resultMeta = null;
		progress = null;

		try {
			// POST `/api/info` with no cookies. The server still accepts an
			// optional `cookies` array (see `src/lib/cookies.ts` and the API
			// handlers) — we just don't surface that path in the UI any more.
			// Running locally on a residential IP, YouTube treats requests
			// as legitimate and the cookie workaround is unnecessary.
			const response = await fetch('/api/info', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: urlInput.trim() })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message ?? `Request failed (HTTP ${response.status})`);
			}
			info = (await response.json()) as InfoResponse;
			phase = 'ready';
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Could not fetch video info';
			phase = 'error';
		}
	}

	async function convert() {
		if (!info || isBusy) return;

		phase = 'converting';
		errorMessage = null;
		progress = {
			stage: 'downloading',
			progress: 0,
			message: 'Starting download…'
		};
		resultBlob = null;
		resultMeta = null;

		abortController = new AbortController();

		try {
			const result = await downloadAndEncodeMp3({
				input: info.id,
				contentLength: info.format.contentLength,
				bitrate,
				signal: abortController.signal,
				onProgress: (p) => {
					progress = p;
				}
			});

			resultBlob = result.blob;
			resultMeta = {
				size: result.blob.size,
				bitrate: result.bitrate,
				channels: result.channels,
				sampleRate: result.sampleRate
			};
			phase = 'done';

			// Auto-trigger download for the user immediately.
			triggerDownload(result.blob, `${info.filename}.mp3`);
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') {
				phase = 'ready';
				progress = null;
				return;
			}
			errorMessage = err instanceof Error ? err.message : 'Conversion failed';
			phase = 'error';
		} finally {
			abortController = null;
		}
	}

	function cancel() {
		abortController?.abort();
	}

	function downloadAgain() {
		if (resultBlob && info) {
			triggerDownload(resultBlob, `${info.filename}.mp3`);
		}
	}
</script>

<svelte:head>
	<meta
		name="description"
		content="Convert any YouTube video to a high-quality MP3 file. Encoding happens locally in your browser — no servers process your audio."
	/>
</svelte:head>

<main class="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-8 sm:px-6 sm:py-12">
	<header class="mb-8 sm:mb-12">
		<div class="flex items-center gap-3">
			<div
				class="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-purple-500 shadow-lg shadow-brand-500/20"
			>
				<svg viewBox="0 0 24 24" class="h-6 w-6 text-white" fill="currentColor">
					<path d="M9 7v8.5a2.5 2.5 0 1 1-1.5-2.29V8h7V6H9z" transform="translate(-1 1)" />
				</svg>
			</div>
			<div>
				<h1 class="text-lg font-semibold tracking-tight">YT → MP3</h1>
				<p class="text-xs text-zinc-400">High-quality audio, encoded in your browser</p>
			</div>
		</div>
	</header>

	<section class="mb-6">
		<h2 class="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
			Convert any YouTube video to <span
				class="bg-gradient-to-r from-brand-300 via-brand-400 to-purple-400 bg-clip-text text-transparent"
				>high-quality MP3</span
			>
		</h2>
		<p class="mt-3 text-balance text-sm text-zinc-400 sm:text-base">
			Paste a link, pick a quality, and download. The MP3 is encoded locally on your device — your
			audio never sits on our servers.
		</p>
	</section>

	<form class="glass rounded-2xl p-4 shadow-2xl shadow-black/40 sm:p-5" onsubmit={fetchInfo}>
		<label for="yt-url" class="block text-xs font-medium text-zinc-400">
			YouTube URL or video ID
		</label>
		<div class="mt-2 flex flex-col gap-2 sm:flex-row">
			<div class="relative flex-1">
				<svg
					viewBox="0 0 24 24"
					class="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-500"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
					<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
				</svg>
				<input
					id="yt-url"
					type="url"
					inputmode="url"
					autocomplete="off"
					autocapitalize="off"
					autocorrect="off"
					spellcheck="false"
					placeholder="https://youtube.com/watch?v=…"
					bind:value={urlInput}
					disabled={isBusy}
					class="w-full rounded-xl border border-white/10 bg-black/30 py-3 pl-10 pr-24 text-base text-zinc-50 placeholder:text-zinc-500 outline-none transition focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-60"
				/>
				{#if urlInput && !isBusy}
					<button
						type="button"
						aria-label="Clear input"
						onclick={() => (urlInput = '')}
						class="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
					>
						<svg
							viewBox="0 0 24 24"
							class="h-4 w-4"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				{:else if !urlInput && !isBusy}
					<button
						type="button"
						onclick={pasteFromClipboard}
						class="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-medium text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
					>
						Paste
					</button>
				{/if}
			</div>
			<button
				type="submit"
				disabled={isBusy || !urlInput.trim()}
				class="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-500/20 transition hover:bg-brand-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500 disabled:shadow-none"
			>
				{#if phase === 'fetching-info'}
					<svg
						class="h-4 w-4 animate-spin"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						aria-hidden="true"
					>
						<path d="M21 12a9 9 0 1 1-6.22-8.56" stroke-linecap="round" />
					</svg>
					Loading…
				{:else}
					Fetch
				{/if}
			</button>
		</div>
		<p class="mt-2 text-xs text-zinc-500">
			Maximum length: 15 minutes. Live streams and age-restricted videos aren't supported.
		</p>
	</form>

	{#if errorMessage}
		<div
			role="alert"
			class="mt-4 flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200"
		>
			<svg
				viewBox="0 0 24 24"
				class="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="10" />
				<line x1="12" y1="8" x2="12" y2="12" />
				<line x1="12" y1="16" x2="12.01" y2="16" />
			</svg>
			<div class="flex-1">
				<p class="font-medium text-red-100">Something went wrong</p>
				<p class="mt-0.5 text-red-200/90">{errorMessage}</p>
			</div>
			<button
				type="button"
				onclick={reset}
				class="rounded-md px-2 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/10"
			>
				Dismiss
			</button>
		</div>
	{/if}

	{#if info}
		<section class="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/50">
			<div class="flex flex-col gap-4 p-4 sm:flex-row sm:p-5">
				<div
					class="relative aspect-video w-full overflow-hidden rounded-xl bg-zinc-800 sm:w-56 sm:flex-shrink-0"
				>
					<img
						src={info.thumbnail}
						alt=""
						loading="lazy"
						class="absolute inset-0 h-full w-full object-cover"
					/>
					<div
						class="absolute bottom-2 right-2 rounded-md bg-black/80 px-1.5 py-0.5 text-xs font-medium text-white"
					>
						{formatDuration(info.durationSeconds)}
					</div>
				</div>

				<div class="min-w-0 flex-1">
					<h3 class="line-clamp-2 text-base font-semibold text-zinc-50 sm:text-lg">
						{info.title}
					</h3>
					<p class="mt-1 truncate text-sm text-zinc-400">{info.author}</p>

					<dl class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
						<div>
							<dt class="inline text-zinc-600">Source:</dt>
							<dd class="ml-1 inline font-mono text-zinc-300">
								{info.format.container || 'audio'}
								{#if info.format.bitrate}· {Math.round(info.format.bitrate)} kbps{/if}
							</dd>
						</div>
						{#if info.format.contentLength}
							<div>
								<dt class="inline text-zinc-600">Size:</dt>
								<dd class="ml-1 inline font-mono text-zinc-300">
									{formatBytes(info.format.contentLength)}
								</dd>
							</div>
						{/if}
					</dl>
				</div>
			</div>

			{#if phase === 'ready' || phase === 'done'}
				<div class="border-t border-white/10 bg-black/20 p-4 sm:p-5">
					<fieldset class="flex flex-wrap items-center gap-2" disabled={isBusy}>
						<legend class="mr-2 text-xs font-medium text-zinc-400">Quality</legend>
						{#each [128, 192, 256, 320] as kbps (kbps)}
							<label
								class="relative cursor-pointer rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-white/20 has-checked:border-brand-500/60 has-checked:bg-brand-500/10 has-checked:text-brand-200"
							>
								<input
									type="radio"
									name="bitrate"
									value={kbps}
									bind:group={bitrate}
									class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
								/>
								{kbps} kbps
							</label>
						{/each}
					</fieldset>

					<div class="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
						<p class="text-xs text-zinc-500">
							{#if phase === 'done'}
								Encoded at {bitrate} kbps · download started automatically
							{:else}
								Encoding happens entirely on your device.
							{/if}
						</p>
						<div class="flex gap-2">
							{#if phase === 'done'}
								<button
									type="button"
									onclick={downloadAgain}
									class="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-brand-500/20 transition hover:bg-brand-400 active:scale-[0.98]"
								>
									<svg
										viewBox="0 0 24 24"
										class="h-4 w-4"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
										<polyline points="7 10 12 15 17 10" />
										<line x1="12" y1="15" x2="12" y2="3" />
									</svg>
									Download again
								</button>
								<button
									type="button"
									onclick={reset}
									class="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-white/[0.06]"
								>
									New conversion
								</button>
							{:else}
								<button
									type="button"
									onclick={convert}
									class="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-brand-500/20 transition hover:bg-brand-400 active:scale-[0.98]"
								>
									<svg
										viewBox="0 0 24 24"
										class="h-4 w-4"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<path d="M12 2v13" />
										<path d="m6 9 6 6 6-6" />
										<path d="M5 22h14" />
									</svg>
									Convert to MP3
								</button>
							{/if}
						</div>
					</div>
				</div>
			{/if}

			{#if phase === 'converting' && progress}
				<div class="border-t border-white/10 bg-black/20 p-4 sm:p-5">
					<div class="flex items-center justify-between text-xs">
						<span class="font-medium text-zinc-300">{stageLabels[progress.stage]}</span>
						<span class="font-mono text-zinc-500">
							{progressPercent != null ? `${progressPercent}%` : '…'}
						</span>
					</div>
					<div class="relative mt-2 h-2 overflow-hidden rounded-full bg-white/5">
						{#if progressPercent != null}
							<div
								class="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-brand-500 to-purple-500 transition-[width] duration-200"
								style:width="{progressPercent}%"
							></div>
						{:else}
							<div class="absolute inset-0 shimmer"></div>
						{/if}
					</div>
					<div class="mt-3 flex items-center justify-between gap-3">
						<p class="truncate text-xs text-zinc-500">{progress.message}</p>
						<button
							type="button"
							onclick={cancel}
							class="flex-shrink-0 rounded-md px-2 py-1 text-xs font-medium text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
						>
							Cancel
						</button>
					</div>
				</div>
			{/if}

			{#if phase === 'done' && resultMeta}
				<div class="border-t border-white/10 bg-emerald-500/[0.06] p-4 sm:p-5">
					<div class="flex items-start gap-3">
						<div
							class="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-emerald-500/20 text-emerald-300"
						>
							<svg
								viewBox="0 0 24 24"
								class="h-4 w-4"
								fill="none"
								stroke="currentColor"
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<polyline points="20 6 9 17 4 12" />
							</svg>
						</div>
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium text-emerald-100">MP3 ready</p>
							<p class="mt-0.5 text-xs text-emerald-200/70">
								{formatBytes(resultMeta.size)} ·
								{resultMeta.bitrate} kbps ·
								{resultMeta.channels === 2 ? 'stereo' : 'mono'} ·
								{(resultMeta.sampleRate / 1000).toFixed(1)} kHz
							</p>
						</div>
					</div>
				</div>
			{/if}
		</section>
	{/if}

	<section class="mt-10 grid gap-3 sm:grid-cols-3">
		<div class="glass rounded-xl p-4">
			<div class="grid h-8 w-8 place-items-center rounded-lg bg-brand-500/15 text-brand-300">
				<svg
					viewBox="0 0 24 24"
					class="h-4 w-4"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
					<path d="M7 11V7a5 5 0 0 1 10 0v4" />
				</svg>
			</div>
			<h3 class="mt-3 text-sm font-semibold text-zinc-100">Local encoding</h3>
			<p class="mt-1 text-xs text-zinc-400">
				Audio is decoded and encoded entirely in your browser. We never store your files.
			</p>
		</div>
		<div class="glass rounded-xl p-4">
			<div class="grid h-8 w-8 place-items-center rounded-lg bg-purple-500/15 text-purple-300">
				<svg
					viewBox="0 0 24 24"
					class="h-4 w-4"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
				</svg>
			</div>
			<h3 class="mt-3 text-sm font-semibold text-zinc-100">Up to 320 kbps</h3>
			<p class="mt-1 text-xs text-zinc-400">
				Pick from 128, 192, 256, or 320 kbps to balance quality and file size.
			</p>
		</div>
		<div class="glass rounded-xl p-4">
			<div class="grid h-8 w-8 place-items-center rounded-lg bg-emerald-500/15 text-emerald-300">
				<svg
					viewBox="0 0 24 24"
					class="h-4 w-4"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<rect x="2" y="4" width="20" height="16" rx="2" />
					<path d="M2 9h20" />
				</svg>
			</div>
			<h3 class="mt-3 text-sm font-semibold text-zinc-100">Runs locally</h3>
			<p class="mt-1 text-xs text-zinc-400">
				Self-hosted on your own machine. Your residential IP keeps YouTube happy.
			</p>
		</div>
	</section>

	<footer class="mt-auto pt-10 text-center text-xs text-zinc-600">
		<p>
			For personal use only. Respect content creators and YouTube's
			<a
				href="https://www.youtube.com/t/terms"
				target="_blank"
				rel="noopener noreferrer"
				class="underline-offset-2 hover:text-zinc-400 hover:underline">Terms of Service</a
			>.
		</p>
	</footer>
</main>
