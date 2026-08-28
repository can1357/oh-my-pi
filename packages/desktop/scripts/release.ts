/**
 * Build a distributable omp Desktop.
 *
 * Wraps the two steps that must happen in order and are easy to get wrong:
 * the sidecar has to be a real compiled binary with the target-triple suffix
 * (a dev shim points at a path that will not exist on anyone else's machine),
 * and only then can Tauri bundle it.
 *
 *   bun run scripts/release.ts --sidecar <path-to-compiled-omp>
 *   bun run scripts/release.ts --allow-shim      # local smoke build only
 *
 * Signing and notarization are read from the environment; see README.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const HERE = path.dirname(path.dirname(Bun.fileURLToPath(import.meta.url)));

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

const sidecar = flag("sidecar");
const allowShim = process.argv.includes("--allow-shim");

if (!sidecar && !allowShim) {
	console.error(
		[
			"Refusing to build without a compiled sidecar.",
			"",
			"  --sidecar <path>   a compiled omp binary to bundle",
			"  --allow-shim       build anyway with the dev shim (local smoke test only)",
			"",
			"The dev shim execs an omp on THIS machine's PATH. Shipped, it produces an",
			"app that launches and then fails to find its agent.",
		].join("\n"),
	);
	process.exit(1);
}

console.log(sidecar ? `→ sidecar: ${sidecar}` : "→ sidecar: dev shim (NOT distributable)");
await $`bun run sync:sidecar ${sidecar ? ["--from", sidecar] : []}`.cwd(HERE);

// Surface the signing posture rather than letting an unsigned build look normal.
const identity = process.env.APPLE_SIGNING_IDENTITY;
const notarize = process.env.APPLE_API_KEY || process.env.APPLE_PASSWORD;
console.log(`→ signing: ${identity ? identity : "unsigned (Gatekeeper will block it)"}`);
console.log(`→ notarization: ${notarize ? "credentials present" : "skipped"}`);

await $`bun run app:build`.cwd(HERE);

const bundleDir = path.join(HERE, "src-tauri", "target", "release", "bundle");
const artifacts: string[] = [];

for (const kind of ["dmg", "macos"]) {
	const dir = path.join(bundleDir, kind);
	const entries = await fs.readdir(dir).catch(() => [] as string[]);
	for (const entry of entries) {
		const full = path.join(dir, entry);
		const stat = await fs.stat(full);
		artifacts.push(`  ${path.relative(HERE, full)}  ${(stat.size / 1e6).toFixed(1)} MB`);
	}
}

console.log(artifacts.length ? `\nArtifacts:\n${artifacts.join("\n")}` : "\nNo artifacts found.");

if (!identity) {
	console.log(
		"\nThis build is unsigned. Distributing it means users must right-click → Open,\n" +
			"and the updater will refuse it. Set APPLE_SIGNING_IDENTITY to sign.",
	);
}
