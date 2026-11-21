import * as path from "node:path";
import { generateEmbeddedExtension } from "../../browser-relay/scripts/build-extension";

/** The module builds replace; null on disk. */
const PLACEHOLDER = path.resolve(import.meta.dir, "../src/tools/browser/relay/embedded-extension.ts");
const EMBEDDED_ZST = path.resolve(import.meta.dir, "../src/tools/browser/relay/extension.generated.json.zst");

/**
 * zstd level for the embedded extension: slow, but paid once per binary or bundle build (once per target when
 * cross-compiling), while the smaller asset ships in every binary and npm package.
 */
const EMBEDDED_RELAY_EXTENSION_ZSTD_LEVEL = 19;

let generated: Promise<string> | undefined;

/**
 * Bun.build `files` that compile the omp extension into a binary or bundle as a zstd-compressed file asset, read only
 * when the extension is installed or synced. Generates it once per process (which also refreshes the checkout's
 * `extension.generated.json`, shipped in the npm package's `src`) and swaps a path to the asset and the extension's
 * build id in for the null placeholder.
 */
export async function embeddedRelayExtensionFiles(): Promise<Record<string, string | Uint8Array>> {
	generated ??= generateEmbeddedExtension();
	const text = await generated;
	const bundle: unknown = JSON.parse(text);
	if (typeof bundle !== "object" || bundle === null || !("build" in bundle) || typeof bundle.build !== "string")
		throw new Error("The generated omp extension has no build id");
	const compressed = await Bun.zstdCompress(Buffer.from(text, "utf8"), { level: EMBEDDED_RELAY_EXTENSION_ZSTD_LEVEL });
	return {
		[EMBEDDED_ZST]: compressed,
		// A compiled binary gets an absolute `$bunfs` path, which `path.resolve` keeps; the npm bundle gets one relative
		// to `dist/cli.js`.
		[PLACEHOLDER]:
			'import * as path from "node:path";\n' +
			'import zstPath from "./extension.generated.json.zst" with { type: "file" };\n' +
			"export const embeddedRelayExtensionZstPath: string | null = path.resolve(import.meta.dir, zstPath);\n" +
			`export const embeddedRelayExtensionBuild: string | null = ${JSON.stringify(bundle.build)};\n`,
	};
}
