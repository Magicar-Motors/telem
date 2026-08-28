import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    // The overlays resolve their track with a top-level await, which Vite's
    // default target predates. Everything that renders these pages — OBS's
    // embedded Chromium and the laptops running the dashboard — is well past
    // es2022.
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        debug: resolve(__dirname, "debug.html"),
        editor: resolve(__dirname, "editor.html"),
        review: resolve(__dirname, "review.html"),
        compare: resolve(__dirname, "compare.html"),
        "stream-map": resolve(__dirname, "stream/map.html"),
        "stream-car-data": resolve(__dirname, "stream/car_data.html"),
        "stream-lap-data": resolve(__dirname, "stream/lap_data.html"),
      },
    },
  },
});
