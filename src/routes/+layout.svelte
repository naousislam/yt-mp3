<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>YT to MP3 — Convert YouTube videos to high-quality MP3</title>
</svelte:head>

{@render children()}
