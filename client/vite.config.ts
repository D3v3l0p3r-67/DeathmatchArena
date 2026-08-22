import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  server: {
    port: 5173,
    // `@deathmatch/shared` lives outside client/, so Vite needs permission to read it.
    fs: { allow: [".."] },
  },
  optimizeDeps: {
    // The shared package ships TypeScript sources; let Vite compile it as part of
    // the app instead of trying to pre-bundle it as a dependency.
    exclude: ["@deathmatch/shared"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // Two pages, not one app with a route: the administration interface shares
      // the configuration and arena models with the game and nothing else -- no
      // Phaser, no Colyseus -- and building them separately is what keeps it
      // that way.
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        admin: resolve(import.meta.dirname, "admin.html"),
      },
      output: {
        // Phaser is by far the biggest dependency; splitting it keeps the app
        // chunk small and lets the browser cache the engine across deploys.
        manualChunks(id: string) {
          if (id.includes("node_modules/phaser")) return "phaser";
          return undefined;
        },
      },
    },
  },
});
