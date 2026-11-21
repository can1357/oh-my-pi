import * as path from "node:path";
import { generateEmbeddedExtension } from "../../browser-relay/scripts/build-extension";

/** The module builds replace; null on disk. */
const PLACEHOLDER = path.resolve(import.meta.dir, "../src/tools/browser/relay/embedded-extension.ts");
const EMBEDDED_ZST = path.resolve(import.meta.dir, "../src/tools/browser/relay/extension.generated.json.zst");

let generated: Promise<string> | undefined;

/**
 * Bun.build `files` that compile the omp extension into a binary or bundle as a zstd-compressed file asset, read only
 * when the extension is installed or synced. Generates it once per process (which also refreshes the checkout's
 * `extension.generated.json`, shipped in the npm package's `src`) and swaps a path to the asset in for the null
 * placeholder.
 */
export async function embeddedRelayExtensionFiles(): Promise<Record<string, string | Uint8Array>> {
	generated ??= generateEmbeddedExtension();
	const compressed = await Bun.zstdCompress(Buffer.from(await generated, "utf8"), { level: 19 });
	return {
		[EMBEDDED_ZST]: compressed,
		// A compiled binary gets an absolute `$bunfs` path; the npm bundle gets one relative to `dist/cli.js`.
		[PLACEHOLDER]:
			'import * as path from "node:path";\n' +
			'import zstPath from "./extension.generated.json.zst" with { type: "file" };\n' +
			"export const embeddedRelayExtensionZstPath: string | null =\n" +
			"\tpath.isAbsolute(zstPath) || path.win32.isAbsolute(zstPath) ? zstPath : Bun.fileURLToPath(new URL(zstPath, import.meta.url));\n",
	};
}
