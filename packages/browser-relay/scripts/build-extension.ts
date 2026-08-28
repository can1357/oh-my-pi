/**
 * Builds the browser relay extension and its distribution artifacts:
 * - `dist/extension/` — unpacked extension (load via chrome://extensions)
 * - `dist/omp-browser-relay-extension.zip` — packaged extension for GH releases
 * - `../coding-agent/src/tools/browser/relay/extension-assets/*.txt` —
 *   generated text assets embedded into the omp CLI so `omp browser-relay
 *   install` works from the compiled binary (same committed-generated-output
 *   pattern as tool-views.generated.js). Re-run this script after touching
 *   anything under `extension/` and commit the regenerated assets.
 *
 * Dependency-free on purpose: CI runs this without `bun install`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const root = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(root, "../..");
const dist = path.join(root, "dist");
const distExtension = path.join(dist, "extension");
const assetsDir = path.resolve(root, "../coding-agent/src/tools/browser/relay/extension-assets");

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(distExtension, { recursive: true });

const bundle = await Bun.build({
	entrypoints: [path.join(root, "extension/background.ts")],
	outdir: distExtension,
	target: "browser",
	sourcemap: "none",
});
if (!bundle.success) {
	for (const log of bundle.logs) console.error(log);
	process.exit(1);
}

for (const file of ["manifest.json", "options.html", "options.js"]) {
	await Bun.write(path.join(distExtension, file), Bun.file(path.join(root, "extension", file)));
}
for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.txt"]) {
	await Bun.write(path.join(distExtension, file), Bun.file(path.join(repoRoot, file)));
}

const zip = await $`zip -qr ../omp-browser-relay-extension.zip .`.cwd(distExtension).nothrow();
if (zip.exitCode !== 0) {
	console.error("zip failed:", zip.stderr.toString());
	process.exit(1);
}

await fs.rm(assetsDir, { recursive: true, force: true });
const embeddedAssets = [
	["background.js", "background.js.txt"],
	["manifest.json", "manifest.json.txt"],
	["options.html", "options.html.txt"],
	["options.js", "options.js.txt"],
	["LICENSE", "LICENSE.txt"],
	["THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"],
] as const;
for (const [source, destination] of embeddedAssets) {
	await Bun.write(path.join(assetsDir, destination), Bun.file(path.join(distExtension, source)));
}

console.log("built:");
console.log(`  ${distExtension}`);
console.log(`  ${path.join(dist, "omp-browser-relay-extension.zip")}`);
console.log(`  ${assetsDir} (embedded CLI assets — commit these)`);
