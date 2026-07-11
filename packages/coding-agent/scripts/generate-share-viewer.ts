#!/usr/bin/env bun
/**
 * Build the standalone share-viewer page the omp relay serves at `GET /s/<id>`.
 *
 * Same template as HTML exports, but with no embedded session: share-loader.js
 * (injected right after the empty #session-data tag) fetches the sealed blob
 * (gist or relay store), decrypts it with the `#<key>` fragment in-browser, and
 * hands the JSON to template.js via `window.__OMP_SESSION_DATA__`.
 *
 * The relay repo's build script runs this and embeds the output via go:embed.
 */
import * as path from "node:path";
import { generateThemeVars, getTemplate } from "../src/export/html";

const outPath = process.argv[2];
if (!outPath) {
	console.error("usage: bun scripts/generate-share-viewer.ts <output.html>");
	process.exit(2);
}

const loaderJs = await Bun.file(new URL("../src/export/html/share-loader.js", import.meta.url).pathname).text();
// Pin the omp brand palette (collab-web pink/purple identity) — the viewer is
// a public artifact matching the live my.omp.sh client, not a per-user export
// that should mirror the host's terminal theme.
const themeVars = await generateThemeVars("web");

const html = getTemplate()
	.replace("<theme-vars/>", () => `<style>:root { ${themeVars} }</style>`)
	.replace("<title>Session Export</title>", () => "<title>omp session</title>")
	.replace("{{SESSION_DATA}}</script>", () => `</script>\n  <script>${loaderJs}</script>`);

if (html.includes("{{SESSION_DATA}}")) throw new Error("session-data placeholder survived substitution");
if (!html.includes("__OMP_SESSION_DATA__")) throw new Error("share loader not injected");

await Bun.write(outPath, html);
console.log(`Generated ${path.resolve(outPath)} (${(html.length / 1024).toFixed(0)} KB)`);
