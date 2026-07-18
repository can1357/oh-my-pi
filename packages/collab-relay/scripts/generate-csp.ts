#!/usr/bin/env bun
/**
 * Emit `dist/csp.txt` — the Content-Security-Policy the worker stamps on the
 * guest client's HTML (see `src/asset-service.ts`). Inline executable scripts
 * in the BUILT index.html are allowed by sha256 hash, so the policy needs no
 * 'unsafe-inline' for scripts and stays correct however the bundler rewrites
 * the page. Regenerate on every build; the worker fails open (no CSP header)
 * if the file is missing, and verify-build.ts fails the build in that case.
 */
import * as path from "node:path";

const ANALYTICS_ORIGIN = "https://um.can.ac";
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
/** Executable inline script types; data blocks like application/ld+json are not governed by script-src. */
const EXECUTABLE_TYPES = new Set(["module", "text/javascript", "application/javascript"]);

const distRoot = path.resolve(process.argv[2] ?? "dist");
const html = await Bun.file(path.join(distRoot, "index.html")).text();

const hashes = new Set<string>();
for (const match of html.matchAll(SCRIPT_RE)) {
	const attrs = match[1] ?? "";
	const body = match[2] ?? "";
	// (?:^|\s) keeps data-src / data-type attributes from masquerading as src / type.
	if (/(?:^|\s)src\s*=/i.test(attrs) || body.length === 0) continue;
	const type = /(?:^|\s)type\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
	if (type !== undefined && !EXECUTABLE_TYPES.has(type)) continue;
	const digest = new Bun.CryptoHasher("sha256").update(body).digest("base64");
	hashes.add(`'sha256-${digest}'`);
}

const csp = [
	"default-src 'self'",
	`script-src 'self' ${[...hashes, ANALYTICS_ORIGIN].join(" ")}`,
	// React style attributes need inline styles; CSS injection is a far smaller blast radius than script.
	"style-src 'self' 'unsafe-inline'",
	// Session images arrive inline in entry frames and render as data:/blob: URIs.
	"img-src 'self' data: blob:",
	// Custom relays from pasted links are arbitrary wss hosts; plain ws is localhost-only by link policy.
	`connect-src 'self' wss: ws://localhost:* ws://127.0.0.1:* ${ANALYTICS_ORIGIN}`,
	"font-src 'self' data:",
	"media-src 'self' data: blob:",
	"manifest-src 'self'",
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

await Bun.write(path.join(distRoot, "csp.txt"), `${csp}\n`);
console.log(`Wrote csp.txt (${hashes.size} inline script hash${hashes.size === 1 ? "" : "es"})`);
