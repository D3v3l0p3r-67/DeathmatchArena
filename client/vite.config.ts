import { defineConfig } from "vite";

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
