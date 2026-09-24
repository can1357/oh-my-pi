/**
 * Shared grammar for `omp://` docs scopes.
 *
 * Three callers need the same answers — the `omp://` handler (what doc does
 * this URL name?), `grep`'s virtual-resource expansion (does this path mean
 * every doc?), and `find`'s temp corpus (which docs do we materialize?) — so
 * the scope grammar lives here once instead of being re-derived per caller.
 */
import * as path from "node:path";
import { InternalUrlRouter } from "./router";
import type { InternalUrl, ResolveContext } from "./types";

/** `omp://` prefix, case-insensitive: addresses harness docs instead of the filesystem. */
const OMP_DOCS_RE = /^omp:\/\//i;
/** Root scope: `omp://`, `omp:///`, `omp://docs`, `omp://docs/`. */
const OMP_DOCS_ROOT_RE = /^omp:\/\/(?:\/?|docs\/?)$/i;

/** Whether `input` addresses harness docs instead of the filesystem. */
export function isOmpDocsScope(input: string): boolean {
	return OMP_DOCS_RE.test(input.trim());
}

/** Whether `input` is the docs root (every doc) rather than a single-doc URL. */
export function isOmpDocsRoot(input: string): boolean {
	return OMP_DOCS_ROOT_RE.test(input.trim());
}

/** Host + path of an `omp://` URL, exactly as the handler reads it; `""` when the URL names the docs root. */
export function ompDocFilename(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const pathname = url.rawPathname ?? url.pathname;
	return host ? (pathname && pathname !== "/" ? host + pathname : host) : "";
}

/**
 * Canonical doc path relative to `docs/` for an `omp://` URL, or `""` for the
 * docs root (`omp://`, `omp:///`, `omp://docs`, `omp://docs/`). Throws on
 * absolute paths and `..` traversal — the rejections the handler reports.
 */
export function ompDocRel(url: InternalUrl): string {
	const filename = ompDocFilename(url);
	if (filename.length === 0) return "";
	if (path.isAbsolute(filename)) throw new Error("Absolute paths are not allowed in omp:// URLs");
	const normalized = path.posix.normalize(filename.replaceAll("\\", "/"));
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new Error("Path traversal (..) is not allowed in omp:// URLs");
	}
	if (normalized === "." || normalized === "docs") return "";
	return normalized.startsWith("docs/") ? normalized.slice("docs/".length) : normalized;
}

/** One embedded doc of a `omp://` root scope. */
export interface OmpDocEntry {
	/** Canonical `omp://<rel>` URL. */
	url: string;
	/** Doc path relative to `docs/`. */
	rel: string;
	/** Doc text. */
	content: string;
}

/**
 * Every embedded doc for a root scope, one entry per unique completion in
 * completion order. Empty when no docs corpus is reachable.
 */
export async function ompDocsScopeEntries(context?: ResolveContext): Promise<OmpDocEntry[]> {
	const router = InternalUrlRouter.instance();
	const completions = (await router.complete("omp", "")) ?? [];
	const entries: OmpDocEntry[] = [];
	const seen = new Set<string>();
	for (const completion of completions) {
		const rel = completion.value;
		if (rel.length === 0 || seen.has(rel)) continue;
		seen.add(rel);
		context?.signal?.throwIfAborted();
		const url = `omp://${rel}`;
		entries.push({ url, rel, content: (await router.resolve(url, context)).content });
	}
	return entries;
}
