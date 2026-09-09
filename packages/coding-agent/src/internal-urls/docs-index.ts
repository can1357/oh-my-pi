/**
 * Harness documentation index for the `omp://` protocol.
 *
 * Compiled binaries and the prepacked npm bundle inline a compressed index of the
 * docs (injected via `process.env.PI_DOCS_EMBED` at build time). The format is two lines:
 *   1. a plain JSON array of the sorted doc file names, and
 *   2. a base64 gzip blob of the index-aligned doc bodies (`string[]`).
 * Listing/completion (`getDocFilenames`) parses only the small first line and
 * never inflates the blob; the bodies are gunzipped off the event loop (via the
 * async `node:zlib` threadpool) lazily, once, on the first actual read. When the
 * placeholder is empty (running from TypeScript source), the index falls back to
 * the embed file shipped in the npm package (`dist/docs-index.generated.txt`,
 * written by `gen:bundle`) — so `@oh-my-pi/pi-coding-agent/*` SDK consumers
 * resolve docs and never probe the consumer's `node_modules/docs` — and then to
 * the repo `docs/` directory on disk for a monorepo checkout.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { Glob } from "bun";

const docsEmbed = process.env.PI_DOCS_EMBED ?? "";

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

/**
 * Dev tree / source checkout: build the index from the repo `docs/` directory.
 * Returns `null` when that directory is absent — for an npm-installed package,
 * four levels up from `src/internal-urls/` is `node_modules/`, not a repo root,
 * so `docs/` is structurally unreachable and the caller falls back to the
 * shipped embed instead.
 */
function readDocsFromDisk(): DocsIndex | null {
	const docsDir = path.resolve(import.meta.dir, "../../../../docs");
	const filenames: string[] = [];
	const bodies: Record<string, string> = {};
	try {
		for (const relativePath of new Glob("**/*.md").scanSync(docsDir)) {
			const normalized = relativePath.split(path.sep).join("/");
			filenames.push(normalized);
			bodies[normalized] = readFileSync(path.join(docsDir, relativePath), "utf8");
		}
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	filenames.sort();
	return { filenames, getBody: relativePath => Promise.resolve(bodies[relativePath]) };
}

/**
 * Prepacked npm package: the docs embed is written to `dist/docs-index.generated.txt`
 * during `gen:bundle` (compiled binaries inline it via `PI_DOCS_EMBED` instead).
 * SDK consumers importing `@oh-my-pi/pi-coding-agent/*` load TypeScript source, where
 * the build-time placeholder is empty, so this shipped file is their only reachable
 * corpus. Returns `null` when the file is absent (dev tree before a bundle build).
 */
function readShippedEmbed(): DocsIndex | null {
	const embedPath = path.resolve(import.meta.dir, "../../dist/docs-index.generated.txt");
	let raw: string;
	try {
		raw = readFileSync(embedPath, "utf8");
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	const decoded = decodeDocsIndex(raw);
	if (decoded === null) {
		throw new Error(
			`Malformed shipped docs index at ${embedPath}: payload without a newline separator. Rebuild the bundle.`,
		);
	}
	return decoded;
}

/** Empty index for when no docs corpus is reachable — degrades `omp://` instead of throwing ENOENT at callers. */
function emptyIndex(): DocsIndex {
	logger.warn(
		"omp:// docs corpus unavailable: no build-time embed, on-disk docs/ directory, or shipped dist embed found",
	);
	return { filenames: [], getBody: () => Promise.resolve(undefined) };
}

let index: DocsIndex | undefined;
function getIndex(): DocsIndex {
	if (index !== undefined) return index;
	// Populated embed in compiled binaries / npm bundle entrypoint. A non-empty
	// payload with no newline is a broken build (truncated/corrupt embed).
	if (docsEmbed.length > 0) {
		const decoded = decodeDocsIndex(docsEmbed);
		if (decoded === null) {
			throw new Error(
				"Malformed embedded docs index: non-empty payload without a newline separator. " +
					"Rebuild the binary or bundle.",
			);
		}
		index = decoded;
		return index;
	}
	// No build-time embed → running from TypeScript source. Prefer the shipped
	// embed file (`dist/docs-index.generated.txt`): it exists only in the packaged
	// npm tarball (or a dev tree that ran `gen:bundle`), so it authoritatively
	// identifies an installed package and avoids probing the consumer's
	// `node_modules/docs`, which `readDocsFromDisk()` would otherwise resolve to
	// and where a stray `docs` dir/package could shadow the real corpus. Fall back
	// to the on-disk `docs/` corpus for a genuine monorepo checkout, then degrade
	// to an empty index so a missing corpus never propagates ENOENT to callers.
	index = readShippedEmbed() ?? readDocsFromDisk() ?? emptyIndex();
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
