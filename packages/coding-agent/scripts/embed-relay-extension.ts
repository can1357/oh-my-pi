import * as path from "node:path";
import { generateEmbeddedExtension } from "../../browser-relay/scripts/build-extension";

/** The module builds replace; null on disk. */
const PLACEHOLDER = path.resolve(import.meta.dir, "../src/tools/browser/relay/embedded-extension.ts");

let generated: Promise<string> | undefined;

/**
 * Bun.build `files` that compile the omp extension into a binary or bundle. Generates it once per process (which
 * also refreshes the checkout's `extension.generated.json`, shipped in the npm package's `src`) and swaps it in for
 * the null placeholder.
 */
export async function embeddedRelayExtensionFiles(): Promise<Record<string, string>> {
	generated ??= generateEmbeddedExtension();
	return {
		[PLACEHOLDER]: `export const embeddedRelayExtension = JSON.parse(${JSON.stringify(await generated)});\n`,
	};
}
