import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

const testing = Boolean(process.env.VITEST);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit()],
  resolve: testing ? { conditions: ["browser"] } : undefined,

  // Keep desktop logs visible beside Vite output.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // The backend is built separately by the Electron development runner.
      ignored: ["**/src-tauri/**"],
    },
  },
}));
