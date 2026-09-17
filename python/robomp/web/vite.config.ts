import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Vite writes the bundle into `web/dist/`. After the rollup stage finishes we
// fan the output out into the Python package directory (`src/static/`)
// so FastAPI can mount it directly. Done in a Vite plugin so both `bun run
// web:build` and the Docker `web-builder` stage produce an installable layout
// without any extra shell glue.
const outDir = path.resolve(dirname, "dist");
const staticDir = path.resolve(dirname, "..", "src", "static");

const PRESERVED_FILES: ReadonlySet<string> = new Set([".gitkeep"]);

function syncStaticBundle(): Plugin {
  return {
    name: "robomp-sync-static",
    apply: "build",
    closeBundle() {
      if (!existsSync(staticDir)) {
        mkdirSync(staticDir, { recursive: true });
      }

      // Clear out previous build output but keep the committed stub anchors
      // (`.gitkeep`). The build is about to write fresh `index.html` and
      // `assets/`, so any stale file in there is dead weight.
      for (const entry of readdirSync(staticDir)) {
        if (PRESERVED_FILES.has(entry)) continue;
        const target = path.join(staticDir, entry);
        const stats = statSync(target);
        rmSync(target, { recursive: stats.isDirectory(), force: true });
      }

      cpSync(outDir, staticDir, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [solid(), tailwindcss(), syncStaticBundle()],
  base: "/static/",
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Hashed filenames so FastAPI can cache `/static/*` aggressively in
        // future; today the bundle is small enough that one chunk is fine.
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
      "/readyz": "http://localhost:8080",
      "/events": "http://localhost:8080",
      "/issues": "http://localhost:8080",
    },
  },
});
