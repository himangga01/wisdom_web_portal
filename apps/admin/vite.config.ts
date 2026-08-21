import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/admin/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist/admin",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    manifest: "manifest.json",
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/admin-[hash:12].js",
        chunkFileNames: "assets/[name]-[hash:12].js",
        assetFileNames: (assetInfo) => assetInfo.names.some((name) => name.endsWith(".css"))
          ? "assets/admin-[hash:12][extname]"
          : "assets/[name]-[hash:12][extname]",
      },
    },
  },
});
