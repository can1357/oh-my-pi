/**
 * Harness documentation index for the `omp://` protocol.
 *
 * Compiled binaries and the prepacked npm bundle inline a compressed index from
 * `docs-index.generated.txt` (populated by `gen:docs` at build time). The format is two lines:
 *   1. a plain JSON array of the sorted doc file names, and
 *   2. a base64 gzip blob of the index-aligned doc bodies (`string[]`).
 * Listing/completion (`getDocFilenames`) parses only the small first line and
 * never inflates the blob; the bodies are gunzipped off the event loop (via the
 * async `node:zlib` threadpool) lazily, once, on the first actual read. When the
 * placeholder is empty (dev tree, source checkout), the index is read from the
 * repo `docs/` directory on disk instead.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { Glob } from "bun";
import docsEmbed from "./docs-index.generated.txt";

const gunzipAsync = promisify(gunzip);

export interface DocsIndex {
	/** Sorted documentation file names, relative to `docs/`. */
	readonly filenames: readonly string[];
	/** Resolve a doc body by path; inflates the embedded bodies off-thread, lazily, on first call. */
	getBody(relativePath: string): Promise<string | undefined>;
}

/**
 * Decode a populated two-line embed (`<filenames JSON>\n<base64 gzip of bodies>`)
 * into a lazily-inflating index, or `null` when there is no newline separator
 * (the empty placeholder, or a malformed payload — the caller decides which).
 * Reading `filenames` never touches the blob; the bodies are gunzipped off the
 * event loop into a path→content table on the first `getBody` call, and that
 * work is shared across concurrent reads.
 */
export function decodeDocsIndex(embed: string): DocsIndex | null {
	const newline = embed.indexOf("\n");
	if (newline === -1) return null;
	const filenames = JSON.parse(embed.slice(0, newline)) as string[];
	let bodies: Promise<Record<string, string>> | undefined;
	return {
		filenames,
		getBody(relativePath: string): Promise<string | undefined> {
			bodies ??= (async () => {
				const inflated = await gunzipAsync(Buffer.from(embed.slice(newline + 1), "base64"));
				const decoded = JSON.parse(inflated.toString("utf8")) as string[];
				const map: Record<string, string> = {};
				for (let i = 0; i < filenames.length; i++) map[filenames[i]] = decoded[i];
				return map;
			})();
			return bodies.then(map => map[relativePath]);
		},
	};
}

/** Dev tree / source checkout: build the index from the repo `docs/` directory. */
function readDocsFromDisk(): DocsIndex {
	const docsDir = path.resolve(import.meta.dir, "../../../../docs");
	const filenames: string[] = [];
	const bodies: Record<string, string> = {};
	for (const relativePath of new Glob("**/*.md").scanSync(docsDir)) {
		const normalized = relativePath.split(path.sep).join("/");
		filenames.push(normalized);
		bodies[normalized] = readFileSync(path.join(docsDir, relativePath), "utf8");
	}
	filenames.sort();
	return { filenames, getBody: relativePath => Promise.resolve(bodies[relativePath]) };
}

let index: DocsIndex | undefined;
function getIndex(): DocsIndex {
	if (index !== undefined) return index;
	// Empty placeholder → dev tree / source checkout: read docs from disk.
	if (docsEmbed.length === 0) {
		index = readDocsFromDisk();
		return index;
	}
	// Populated embed in compiled binaries / npm bundle. A non-empty payload with
	// no newline is a broken build (truncated/corrupt embed), not a placeholder.
	const decoded = decodeDocsIndex(docsEmbed);
	if (decoded === null) {
		throw new Error(
			"Malformed embedded docs index (docs-index.generated.txt): non-empty payload without a newline separator. " +
				"Rebuild with `bun run gen:docs`.",
		);
	}
	index = decoded;
	return index;
}

/** Sorted list of available documentation file names (relative to `docs/`). */
export function getDocFilenames(): readonly string[] {
	return getIndex().filenames;
}

/** Resolve a documentation file's content, or `undefined` when not found. */
export function getEmbeddedDoc(relativePath: string): Promise<string | undefined> {
	return getIndex().getBody(relativePath);
}
