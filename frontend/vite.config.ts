import { defineConfig, loadEnv } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  // The backend reads PORT from the repository root .env; follow it so the proxy always matches.
  const backendPort = loadEnv(mode, "..", "").PORT || "8080";
  return {
    // Skeleton: the Tailwind plugin must come before the Svelte plugin.
    plugins: [tailwindcss(), svelte()],
    server: {
      port: 5173,
      // In development the backend runs separately (default :8080).
      proxy: { "/api": `http://127.0.0.1:${backendPort}` },
    },
  };
});
