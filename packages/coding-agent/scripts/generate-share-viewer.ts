#!/usr/bin/env bun
/**
 * Build the standalone share-viewer page served at `GET /s/<id>`.
 *
 * Same template as HTML exports, but with no embedded session: share-loader.js
 * (injected right after the empty #session-data tag) fetches the sealed blob
 * (gist or relay store), decrypts it with the `#<key>` fragment in-browser, and
 * hands the JSON to template.js via `window.__OMP_SESSION_DATA__`.
 *
 * The owned collab relay build writes this page into its static asset bundle.
 */
import * as path from "node:path";
import { generateThemeVars, getTemplate } from "../src/export/html";

function inlineContentHashes(html: string, tagName: "script" | "style"): string[] {
	const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "gi");
	const hashes: string[] = [];
	for (const match of html.matchAll(pattern)) {
		const content = match[1];
		if (!content) continue;
		const digest = new Bun.CryptoHasher("sha256").update(content).digest("base64");
		hashes.push(`'sha256-${digest}'`);
	}
	return hashes;
}

const outPath = process.argv[2];
if (!outPath) {
	console.error("usage: bun scripts/generate-share-viewer.ts <output.html>");
	process.exit(2);
}

const loaderJs = await Bun.file(new URL("../src/export/html/share-loader.js", import.meta.url)).text();
// Pin the omp brand palette (collab-web pink/purple identity) — the viewer is
// a public artifact matching the live collab.pkking.computer client, not a per-user export
// that should mirror the host's terminal theme.
const themeVars = await generateThemeVars("web");

const html = getTemplate()
	.replace("<theme-vars/>", () => `<style>:root { ${themeVars} }</style>`)
	.replace("<title>Session Export</title>", () => "<title>omp session</title>")
	.replace("{{SESSION_DATA}}</script>", () => `</script>\n  <script>${loaderJs}</script>`);

if (html.includes("{{SESSION_DATA}}")) throw new Error("session-data placeholder survived substitution");
if (!html.includes("__OMP_SESSION_DATA__")) throw new Error("share loader not injected");

const scriptHashes = inlineContentHashes(html, "script");
if (scriptHashes.length === 0) throw new Error("share viewer has no inline scripts to authorize");
const csp = [
	"default-src 'none'",
	`script-src ${scriptHashes.join(" ")} https://cdnjs.cloudflare.com`,
	"style-src 'unsafe-inline'",
	"img-src 'self' data:",
	"connect-src 'self' https://api.github.com https://gist.githubusercontent.com",
	"font-src data:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");
const cspPath = path.join(path.dirname(outPath), "csp.txt");

await Promise.all([Bun.write(outPath, html), Bun.write(cspPath, csp)]);
console.log(`Generated ${path.resolve(outPath)} (${(html.length / 1024).toFixed(0)} KB) with strict CSP`);
