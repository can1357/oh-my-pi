/**
 * Builds the omp extension. `bun scripts/build-extension.ts` writes `dist/extension/`, the GitHub release ZIP, and the
 * CLI's embedded copy for `omp browser-relay install`; `--embedded` writes only the embedded copy. That copy is
 * generated, not committed: `bun install` writes it for source checkouts, and binary and npm builds embed it through
 * {@link generateEmbeddedExtension}.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clientBundlePlugins } from "@oh-my-pi/omp-stats/client-bundle";
import { $ } from "bun";
import {
	stampRelayExtensionManifest,
	stampRelayExtensionScript,
} from "../../coding-agent/src/tools/browser/relay/protocol";

const root = path.resolve(import.meta.dir, "..");
const source = path.join(root, "extension");
const dist = path.join(root, "dist");
/** Where the CLI reads the embedded copy in a source checkout (see extension-files.ts). */
const embeddedFile = path.resolve(root, "../coding-agent/src/tools/browser/relay/extension.generated.json");

if (import.meta.main) {
	if (process.argv.includes("--embedded")) {
		await generateEmbeddedExtension();
		console.log(`Generated ${embeddedFile}`);
	} else {
		await buildRelease();
	}
}

/**
 * Bundle the unstamped extension and write it to `extension.generated.json` as `{ build, files }`, binary files
 * base64-encoded. Returns the JSON text written.
 */
export async function generateEmbeddedExtension(): Promise<string> {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-extension-"));
	try {
		await bundleExtension(scratch);
		return (await writeEmbedded(scratch)).json;
	} finally {
		await fs.rm(scratch, { recursive: true, force: true });
	}
}

/** `dist/extension/`, the pre-stamped release ZIP, and the embedded copy. */
async function buildRelease(): Promise<void> {
	const distExtension = path.join(dist, "extension");
	await fs.rm(dist, { recursive: true, force: true });
	await bundleExtension(distExtension);
	const { build } = await writeEmbedded(distExtension);
	// Only the release ZIP is pre-stamped. CLI installs stamp their own version with this build.
	const manifest = path.join(distExtension, "manifest.json");
	const background = path.join(distExtension, "background.js");
	const { version: ompVersion } = await Bun.file(path.join(root, "../coding-agent/package.json")).json();
	const [unstampedManifest, unstampedScript] = await Promise.all([
		Bun.file(manifest).text(),
		Bun.file(background).text(),
	]);
	await Promise.all([
		Bun.write(manifest, stampRelayExtensionManifest(unstampedManifest, ompVersion)),
		Bun.write(background, stampRelayExtensionScript(unstampedScript, ompVersion, build)),
	]);
	const zipPath = path.join(dist, "omp-browser-relay-extension.zip");
	await $`zip -qr ${zipPath} .`.cwd(distExtension);
	console.log(`Built:\n  ${distExtension}\n  ${zipPath}\n  ${embeddedFile}`);
}

/** Bundle the extension's scripts and copy its static files into `outDir`, unstamped. */
async function bundleExtension(outDir: string): Promise<void> {
	await fs.mkdir(outDir, { recursive: true });
	await Promise.all([
		bundle(outDir, "background.ts", "background", "iife"),
		bundle(outDir, "panel/main.tsx", "panel", "esm"),
		bundle(outDir, "overlay/main.ts", "overlay", "iife"),
		bundle(outDir, "teach/recorder.ts", "recorder", "iife"),
		bundle(outDir, "offscreen/main.ts", "offscreen", "iife"),
	]);

	const staticFiles = [
		"manifest.json",
		"panel.html",
		"offscreen.html",
		...new Bun.Glob("icons/*.png").scanSync({ cwd: source }),
	];
	await Promise.all([
		...staticFiles.map(name => Bun.write(path.join(outDir, name), Bun.file(path.join(source, name)))),
		Bun.write(path.join(outDir, "LICENSE"), Bun.file(path.resolve(root, "../../LICENSE"))),
	]);
	for (const name of ["panel.css", "icons/omp-16.png", "icons/omp-32.png", "icons/omp-48.png", "icons/omp-128.png"]) {
		if (!(await Bun.file(path.join(outDir, name)).exists())) throw new Error(`Missing extension file: ${name}`);
	}
}

/** Write the unstamped extension in `extensionDir` to {@link embeddedFile}; returns its build id and the JSON text. */
async function writeEmbedded(extensionDir: string): Promise<{ build: string; json: string }> {
	const names = [...new Bun.Glob("**/*").scanSync({ cwd: extensionDir, dot: true })]
		.map(name => name.replaceAll(path.sep, "/"))
		.sort();
	const files: Record<string, string | { base64: string }> = {};
	for (const name of names) {
		const file = Bun.file(path.join(extensionDir, name));
		const isText = name === "LICENSE" || /\.(?:css|html|js|json|map|svg|txt)$/.test(name);
		files[name] = isText ? await file.text() : { base64: Buffer.from(await file.arrayBuffer()).toBase64() };
	}
	const build = await buildId(extensionDir, names);
	const json = JSON.stringify({ build, files });
	await Bun.write(embeddedFile, json);
	return { build, json };
}

/** First 16 hex chars of SHA-256 over each unstamped file's name and bytes, in `names` order. */
async function buildId(extensionDir: string, files: readonly string[]): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const name of files) {
		hasher.update(`${name}\0`);
		hasher.update(new Uint8Array(await Bun.file(path.join(extensionDir, name)).arrayBuffer()));
		hasher.update("\0");
	}
	return hasher.digest("hex").slice(0, 16);
}

/**
 * Bundle `entry` (relative to `extension/`) into `outDir` as `<name>.js` for the browser. The panel's tool cards use
 * pi-utils' JSON helpers, which read `node:util/types`, so every script gets the stats client's browser plugins.
 * Exported for tests.
 */
export async function bundle(outDir: string, entry: string, name: string, format: "iife" | "esm"): Promise<void> {
	const result = await Bun.build({
		entrypoints: [path.join(source, entry)],
		outdir: outDir,
		target: "browser",
		format,
		naming: { entry: `${name}.[ext]` },
		minify: name === "panel",
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		plugins: clientBundlePlugins,
	});
	if (!result.success) throw new AggregateError(result.logs, `Failed to bundle ${entry}`);
	if (!(await Bun.file(path.join(outDir, `${name}.js`)).exists())) {
		throw new Error(`Bundling ${entry} did not produce ${name}.js`);
	}
}
