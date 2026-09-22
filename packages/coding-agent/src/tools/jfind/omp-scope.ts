/**
 * `omp://` search scope for `find`: the semantic cascade only walks
 * directories, while harness docs are virtual (no `sourcePath`). Materialize
 * the requested docs into a temp corpus, run the unchanged cascade over it,
 * then remap hits back to `omp://` URLs — the same materialize-and-remap
 * shape `grep` uses for archives.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { splitInternalUrlSel } from "@oh-my-pi/pi-tui/tools/read";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { ompDocRel, ompDocsScopeEntries } from "../../internal-urls/omp-scope";
import { parseInternalUrl } from "../../internal-urls/parse";
import { InternalUrlRouter } from "../../internal-urls/router";
import type { ResolveContext } from "../../internal-urls/types";

export interface OmpScope {
	/** Temp corpus root: the cascade's `root`. */
	dir: string;
	/** Remove the temp corpus. Hits are remapped first, so callers run this in a `finally`. */
	cleanup: () => Promise<void>;
	/** Temp-root-relative `rel` (either separator) → canonical `omp://` URL. */
	toOmpRel: (rel: string) => string;
	/** Display form for headers: `omp://`, or `omp://<file>` for a single doc. */
	scopePath: string;
}

/**
 * Materialize an `omp://` scope into a temp corpus of the embedded docs.
 * Root inputs expand to every doc (like grep's virtual `omp://` expansion);
 * anything else resolves one doc and rejects unknown names.
 */
export async function materializeOmpScope(rawInput: string, context?: ResolveContext): Promise<OmpScope> {
	const input = rawInput.trim();
	const dir = await mkdtemp(path.join(tmpdir(), "omp-find-"));
	const cleanup = async (): Promise<void> => {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	};
	const toOmpRel = (rel: string): string => `omp://${rel.replace(/\\/g, "/")}`;
	try {
		// `find` searches whole files, so a trailing `:N-M` would silently be
		// ignored downstream — reject it with the reason instead.
		const { path: url, sel } = splitInternalUrlSel(input);
		if (sel !== undefined) {
			throw new ToolError(`find searches whole files; line-range selectors are not supported: ${input}`);
		}
		let rel: string;
		try {
			rel = ompDocRel(parseInternalUrl(url));
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}

		// No doc named: the docs root, or a form the handler lists rather than
		// reads (`omp:///docs`), expands to the whole corpus.
		if (rel.length === 0) {
			const entries = await ompDocsScopeEntries(context);
			if (entries.length === 0) throw new ToolError("No documentation files found");
			for (const entry of entries) await Bun.write(path.join(dir, entry.rel), entry.content);
			return { dir, cleanup, toOmpRel, scopePath: "omp://" };
		}

		let content: string;
		try {
			content = (await InternalUrlRouter.instance().resolve(`omp://${rel}`, context)).content;
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		await Bun.write(path.join(dir, rel), content);
		return { dir, cleanup, toOmpRel, scopePath: `omp://${rel}` };
	} catch (error) {
		await cleanup();
		throw error;
	}
}
