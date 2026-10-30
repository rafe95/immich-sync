import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Skeleton: the Tailwind plugin must come before the Svelte plugin.
  plugins: [tailwindcss(), svelte()],
  server: {
    port: 5173,
    // In development the backend runs separately on :8080.
    proxy: { "/api": "http://localhost:8080" },
  },
});
