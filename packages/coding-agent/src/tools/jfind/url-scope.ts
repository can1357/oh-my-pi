/**
 * Virtual internal-URL search scope for `find`: the semantic cascade only
 * walks directories, while enumerable URLs (a handler with `enumerate`, e.g. a
 * docs root) have no local files. Materialize the enumerated documents into a
 * temp corpus, run the unchanged cascade over it, then remap hits back to
 * their URLs — the same materialize-and-remap shape `grep` uses for archives.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { splitUrlScheme } from "@oh-my-pi/pi-tui/tools/url-scheme-host";
import { InternalUrlRouter } from "../../internal-urls/router";
import type { ResolveContext } from "../../internal-urls/types";

export interface UrlScope {
	/** Temp corpus root: the cascade's `root`. */
	dir: string;
	/** Remove the temp corpus. Hits are remapped first, so callers run this in a `finally`. */
	cleanup: () => Promise<void>;
	/** Temp-root-relative `rel` (either separator) → the enumerated document's URL. */
	toUrl: (rel: string) => string;
	/** Display form for headers: the single document's URL, else the scope URL as given. */
	scopePath: string;
}

/** Whether `input` is a URL whose handler expands it into searchable documents (`enumerate`). */
export function isEnumerableScope(input: string): boolean {
	return InternalUrlRouter.instance().canEnumerate(input.trim());
}

/** Corpus-relative file for a document URL: its host/path segments, minus anything that could escape the corpus. */
function corpusRel(url: string, index: number): string {
	const segments = (splitUrlScheme(url)?.rest ?? url)
		.split(/[/\\]/)
		.filter(segment => segment.length > 0 && segment !== "." && segment !== "..");
	return segments.length > 0 ? segments.join("/") : String(index);
}

/**
 * Materialize an enumerable URL scope ({@link isEnumerableScope}) into a temp
 * corpus of its documents. Rejects read selectors (find searches whole files)
 * and reports handler failures (unknown documents, empty corpus) as tool errors.
 */
export async function materializeUrlScope(rawInput: string, context?: ResolveContext): Promise<UrlScope> {
	const input = rawInput.trim();
	// `find` searches whole files, so a trailing `:N-M` would silently be
	// ignored downstream — reject it with the reason instead.
	const router = InternalUrlRouter.instance();
	const { path: url, sel } = router.split(router.normalize(input));
	if (sel !== undefined) {
		throw new ToolError(`find searches whole files; line-range selectors are not supported: ${input}`);
	}
	let entries: Array<{ url: string; content: string }> | null;
	try {
		entries = await router.enumerate(url, context);
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
	if (!entries || entries.length === 0) throw new ToolError(`No searchable documents behind ${url}`);

	const dir = await mkdtemp(path.join(tmpdir(), "find-scope-"));
	const cleanup = async (): Promise<void> => {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	};
	const urlByRel = new Map<string, string>();
	try {
		for (const [index, entry] of entries.entries()) {
			const rel = corpusRel(entry.url, index);
			urlByRel.set(rel, entry.url);
			await Bun.write(path.join(dir, rel), entry.content);
		}
	} catch (error) {
		await cleanup();
		throw error;
	}
	const toUrl = (rel: string): string => {
		const normalized = rel.replace(/\\/g, "/");
		return urlByRel.get(normalized) ?? normalized;
	};
	return { dir, cleanup, toUrl, scopePath: entries.length === 1 ? entries[0].url : url };
}
