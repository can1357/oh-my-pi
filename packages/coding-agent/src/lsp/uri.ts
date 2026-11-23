/**
 * File URI conversion for LSP traffic, apart from `./utils` (diagnostic and
 * symbol formatting) so the daemon's LSP module converts URIs without loading
 * the theme, path-resolution, and model-catalog code those formatters reach.
 */
import * as path from "node:path";

/**
 * Convert a file path to a file:// URI.
 * Uses the URL machinery so special characters (`%`, `#`, `?`, spaces) are
 * percent-encoded; plain concatenation produced URIs that broke round-trips.
 * Handles Windows drive letters correctly.
 */
export function fileToUri(filePath: string): string {
	return Bun.pathToFileURL(path.resolve(filePath)).href;
}

/**
 * Convert a file:// URI to a file path.
 * Tolerates both percent-encoded URIs and lax servers that send raw paths.
 * Handles Windows drive letters correctly.
 */
export function uriToFile(uri: string): string {
	if (!uri.startsWith("file://")) {
		return uri;
	}

	// A raw `#`/`?` parses *successfully* as fragment/query and silently
	// truncates the path — it never reaches the catch below. LSP servers do
	// not use fragments or queries on file URIs (encoded forms are %23/%3F),
	// so raw occurrences mean a lax server sent an unencoded path.
	if (uri.includes("#") || uri.includes("?")) {
		return laxUriToFile(uri);
	}

	try {
		return Bun.fileURLToPath(uri);
	} catch {
		// Not a well-formed file URL (unencoded characters, stray `%`, host
		// component). Fall back to a lenient manual conversion.
		return laxUriToFile(uri);
	}
}

function laxUriToFile(uri: string): string {
	let filePath = uri.slice(7);
	try {
		filePath = decodeURIComponent(filePath);
	} catch {
		// Invalid percent-encoding — treat as a literal path.
	}

	// Windows: file:///C:/path → C:/path (strip leading slash before drive letter)
	if (process.platform === "win32" && filePath.startsWith("/") && /^[A-Za-z]:/.test(filePath.slice(1))) {
		filePath = filePath.slice(1);
	}

	return filePath;
}

/** Map that treats equivalent file URI spellings as the same key. */
export class EquivalentUriMap<Value> extends Map<string, Value> {
	#key(uri: string): string {
		if (!uri.startsWith("file://")) return uri;
		const filePath = path.normalize(uriToFile(uri));
		return process.platform === "win32" ? filePath.toLowerCase() : filePath;
	}

	override delete(uri: string): boolean {
		const key = this.#key(uri);
		return super.delete(key);
	}

	override get(uri: string): Value | undefined {
		const key = this.#key(uri);
		return super.get(key);
	}

	override has(uri: string): boolean {
		const key = this.#key(uri);
		return super.has(key);
	}

	override set(uri: string, value: Value): this {
		const key = this.#key(uri);
		return super.set(key, value);
	}
}
