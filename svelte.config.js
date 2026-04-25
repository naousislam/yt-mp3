import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Build a self-contained Node server in ./build that can be started
    // with `node ./build/index.js`. We use Node (not Bun) at runtime
    // because @distube/ytdl-core calls `undici.Agent.compose()`, which
    // Bun's built-in undici polyfill does not implement. Bun is still
    // fine for installs and the dev server.
    adapter: adapter({
      out: "build",
      precompress: false,
      envPrefix: "",
    }),
  },
};

export default config;
