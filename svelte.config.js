// Electron loads the generated files directly, so the app is emitted as a static SPA.
// See: https://svelte.dev/docs/kit/single-page-apps
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    paths: {
      relative: true,
    },
    csp: {
      mode: "hash",
      directives: {
        "default-src": ["self"],
        "base-uri": ["none"],
        "object-src": ["none"],
        "frame-ancestors": ["none"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:", "blob:"],
        "font-src": ["self", "data:"],
        "connect-src": [
          "self",
          "http://127.0.0.1:1420",
          "ws://127.0.0.1:1420",
        ],
      },
    },
  },
};

export default config;
