import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import * as git from "../utils/git";
import { appendRepoFlag, ghApiHostArgs, parseRepoRef } from "./gh-common";
import type { ViewLookupResult } from "./gh-view";
import { getOrFetchView, resolveGithubCacheAuthKey } from "./github-cache";
import { ToolError } from "./tool-errors";

export const PR_DIFF_FILES_PAGE_SIZE = 100;
export const PR_DIFF_FILES_MAX = 3000;

// ────────────────────────────────────────────────────────────────────────────
// PR diff fetcher
//
// Used by the `pr://<n>/diff[/…]` internal-URL family. Stores the verbatim
// `gh pr diff` text plus a parsed file index so the listing, full-diff, and
// per-file slice variants all share one cache row.
// ────────────────────────────────────────────────────────────────────────────

export interface PrDiffFile {
	/** Display path. Prefers the post-image (`b/<path>`) when present. */
	path: string;
	additions: number;
	deletions: number;
	changeType: "modified" | "added" | "deleted" | "renamed" | "binary";
	/** Pre-image path for renames/deletes; same as `path` otherwise. */
	oldPath?: string;
	/** Byte offset of the section's `diff --git` line in the unified diff. */
	startOffset: number;
	/** Byte offset of the next section (or end-of-text). */
	endOffset: number;
}

export interface PrDiffPayload {
	/** Full unified diff text as returned by `gh pr diff --color never`. */
	unified: string;
	files: PrDiffFile[];
}

export interface PrDiffLookupOptions {
	cwd: string;
	repo: string;
	number: number;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}
/**
 * Split `gh pr diff` output on `^diff --git ` boundaries and parse per-file
 * metadata. The unified diff is preserved verbatim so callers can slice it by
 * byte offsets without re-running gh.
 */
export function parsePrUnifiedDiff(text: string): PrDiffPayload {
	const files: PrDiffFile[] = [];
	if (text.length === 0) {
		return { unified: text, files };
	}

	// Walk match positions manually so we capture each section's byte range.
	const sectionStarts: number[] = [];
	const re = /^diff --git /gm;
	let m: RegExpExecArray | null = re.exec(text);
	while (m !== null) {
		sectionStarts.push(m.index);
		// Avoid zero-length match infinite loop (regex has fixed prefix, but
		// be explicit).
		if (re.lastIndex === m.index) re.lastIndex += 1;
		m = re.exec(text);
	}

	for (let i = 0; i < sectionStarts.length; i += 1) {
		const startOffset = sectionStarts[i] ?? 0;
		const endOffset = sectionStarts[i + 1] ?? text.length;
		const section = text.slice(startOffset, endOffset);
		files.push(parsePrDiffSection(section, startOffset, endOffset));
	}
	return { unified: text, files };
}

export interface ParsedDiffHeaderToken {
	value: string;
	nextIndex: number;
}

export function skipDiffHeaderSpaces(text: string, index: number): number {
	let i = index;
	while (text.charAt(i) === " ") i += 1;
	return i;
}

export function parseDiffQuotedEscape(text: string, slashIndex: number): ParsedDiffHeaderToken {
	const next = text.charAt(slashIndex + 1);
	if (next === "") return { value: "\\", nextIndex: slashIndex + 1 };

	if (next >= "0" && next <= "7") {
		let end = slashIndex + 1;
		while (end < text.length && end < slashIndex + 4) {
			const digit = text.charAt(end);
			if (digit < "0" || digit > "7") break;
			end += 1;
		}
		return {
			value: String.fromCharCode(Number.parseInt(text.slice(slashIndex + 1, end), 8)),
			nextIndex: end,
		};
	}

	switch (next) {
		case "a":
			return { value: "\x07", nextIndex: slashIndex + 2 };
		case "b":
			return { value: "\b", nextIndex: slashIndex + 2 };
		case "f":
			return { value: "\f", nextIndex: slashIndex + 2 };
		case "n":
			return { value: "\n", nextIndex: slashIndex + 2 };
		case "r":
			return { value: "\r", nextIndex: slashIndex + 2 };
		case "t":
			return { value: "\t", nextIndex: slashIndex + 2 };
		case "v":
			return { value: "\v", nextIndex: slashIndex + 2 };
		case "\\":
		case '"':
			return { value: next, nextIndex: slashIndex + 2 };
		default:
			return { value: next, nextIndex: slashIndex + 2 };
	}
}

export function parseDiffQuotedToken(text: string, startIndex: number): ParsedDiffHeaderToken | undefined {
	if (text.charAt(startIndex) !== '"') return undefined;
	let value = "";
	for (let i = startIndex + 1; i < text.length; i += 1) {
		const ch = text.charAt(i);
		if (ch === '"') return { value, nextIndex: i + 1 };
		if (ch !== "\\") {
			value += ch;
			continue;
		}
		const escaped = parseDiffQuotedEscape(text, i);
		value += escaped.value;
		i = escaped.nextIndex - 1;
	}
	return undefined;
}

export function parseDiffHeaderToken(text: string, startIndex: number): ParsedDiffHeaderToken | undefined {
	const start = skipDiffHeaderSpaces(text, startIndex);
	if (start >= text.length) return undefined;
	const quoted = parseDiffQuotedToken(text, start);
	if (quoted) return quoted;
	const end = text.indexOf(" ", start);
	if (end === -1) return { value: text.slice(start), nextIndex: text.length };
	return { value: text.slice(start, end), nextIndex: end };
}

export function stripPrDiffPathPrefix(value: string, prefix: "a/" | "b/"): string | undefined {
	return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

export function parsePrDiffHeaderPaths(header: string): { oldPath?: string; newPath?: string } {
	const trail = header.slice("diff --git ".length);
	if (trail.startsWith('"')) {
		const oldToken = parseDiffQuotedToken(trail, 0);
		if (!oldToken) return {};
		const newToken = parseDiffHeaderToken(trail, oldToken.nextIndex);
		if (!newToken) return {};
		return {
			oldPath: stripPrDiffPathPrefix(oldToken.value, "a/"),
			newPath: stripPrDiffPathPrefix(newToken.value, "b/"),
		};
	}

	const bIdx = trail.indexOf(" b/");
	if (trail.startsWith("a/") && bIdx > 0) {
		return {
			oldPath: trail.slice(2, bIdx),
			newPath: trail.slice(bIdx + 3),
		};
	}
	return {};
}

export function isPrDiffFileHeaderLine(line: string): boolean {
	return (
		line === "--- /dev/null" ||
		line === "+++ /dev/null" ||
		line.startsWith("--- a/") ||
		line.startsWith("+++ b/") ||
		line.startsWith('--- "a/') ||
		line.startsWith('+++ "b/')
	);
}

export function parsePrDiffSection(section: string, startOffset: number, endOffset: number): PrDiffFile {
	const lines = section.split("\n");
	const header = lines[0] ?? "";
	const headerPaths = parsePrDiffHeaderPaths(header);
	let oldPath = headerPaths.oldPath;
	let newPath = headerPaths.newPath;

	let changeType: PrDiffFile["changeType"] = "modified";
	let isBinary = false;
	let additions = 0;
	let deletions = 0;

	let inHunk = false;
	for (let li = 1; li < lines.length; li += 1) {
		const line = lines[li] ?? "";
		if (line.startsWith("new file mode")) {
			changeType = "added";
			continue;
		}
		if (line.startsWith("deleted file mode")) {
			changeType = "deleted";
			continue;
		}
		if (line.startsWith("rename from ")) {
			changeType = "renamed";
			oldPath = line.slice("rename from ".length);
			continue;
		}
		if (line.startsWith("rename to ")) {
			newPath = line.slice("rename to ".length);
			continue;
		}
		if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
			isBinary = true;
			continue;
		}
		if (line.startsWith("@@ ")) {
			inHunk = true;
			continue;
		}
		if (!inHunk && isPrDiffFileHeaderLine(line)) continue;
		if (line.startsWith("+")) {
			additions += 1;
		} else if (line.startsWith("-")) {
			deletions += 1;
		}
	}

	if (isBinary) {
		if (changeType === "modified") changeType = "binary";
		additions = 0;
		deletions = 0;
	}

	const displayPath =
		changeType === "deleted" ? (oldPath ?? newPath ?? "(unknown)") : (newPath ?? oldPath ?? "(unknown)");
	const file: PrDiffFile = {
		path: displayPath,
		additions,
		deletions,
		changeType,
		startOffset,
		endOffset,
	};
	if (oldPath && oldPath !== displayPath) {
		file.oldPath = oldPath;
	}
	return file;
}

/**
 * A single entry from `GET /repos/{owner}/{repo}/pulls/{n}/files`. `patch` is
 * absent for binary files and for individual file diffs GitHub deems too large
 * to render.
 */
export interface GhPrFileApi {
	filename?: string;
	previous_filename?: string;
	status?: string;
	additions?: number;
	deletions?: number;
	patch?: string;
}

export interface GhPrApi {
	changed_files?: number;
}

/**
 * GitHub rejects the aggregate PR diff endpoint with HTTP 406 once the diff
 * exceeds 20,000 lines. Detect that specific failure so the caller can fall
 * back to the per-file endpoint instead of aborting the whole review.
 */
export function isPrDiffTooLargeError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return (
		/\bHTTP 406\b/.test(message) ||
		/exceeded the maximum number of lines/i.test(message) ||
		/\btoo_large\b/.test(message)
	);
}

export function formatSyntheticDiffPath(prefix: "a/" | "b/", path: string): string {
	const prefixedPath = `${prefix}${path}`;
	if (!/[\u0000-\u001F\s"\\]/.test(prefixedPath)) return prefixedPath;

	let escaped = "";
	for (const char of prefixedPath) {
		switch (char) {
			case "\\":
				escaped += "\\\\";
				break;
			case '"':
				escaped += '\\"';
				break;
			case "\n":
				escaped += "\\n";
				break;
			case "\r":
				escaped += "\\r";
				break;
			case "\t":
				escaped += "\\t";
				break;
			default: {
				const code = char.charCodeAt(0);
				escaped += code < 32 ? `\\${code.toString(8).padStart(3, "0")}` : char;
			}
		}
	}
	return `"${escaped}"`;
}

/**
 * Reconstruct a `diff --git` section from a single files-API entry. The API's
 * `patch` field carries only the hunk body, so the `diff --git`/`---`/`+++`
 * headers are synthesized to match `gh pr diff` output — this keeps
 * {@link parsePrUnifiedDiff} and the review parser producing identical section
 * boundaries and byte offsets. Files whose `patch` is omitted (binary or
 * too-large) stay visible with an explicit marker rather than being dropped.
 */
export function buildSyntheticDiffSection(file: GhPrFileApi): string | undefined {
	const newPath = file.filename;
	if (!newPath) return undefined;
	const status = file.status ?? "modified";
	const oldPath = file.previous_filename ?? newPath;
	const oldDiffPath = formatSyntheticDiffPath("a/", oldPath);
	const newDiffPath = formatSyntheticDiffPath("b/", newPath);
	const lines: string[] = [`diff --git ${oldDiffPath} ${newDiffPath}`];
	if (status === "added") {
		lines.push("new file mode 100644");
	} else if (status === "removed") {
		lines.push("deleted file mode 100644");
	} else if (status === "renamed" || file.previous_filename) {
		lines.push(`rename from ${oldPath}`, `rename to ${newPath}`);
	}
	if (typeof file.patch === "string" && file.patch.length > 0) {
		lines.push(status === "added" ? "--- /dev/null" : `--- ${oldDiffPath}`);
		lines.push(status === "removed" ? "+++ /dev/null" : `+++ ${newDiffPath}`);
		lines.push(file.patch);
	} else {
		lines.push(
			`* patch unavailable (binary or too large); additions ${file.additions ?? 0}, deletions ${file.deletions ?? 0}`,
		);
	}
	return lines.join("\n");
}

/**
 * Fallback PR diff retrieval via the paginated per-file endpoint, used when the
 * aggregate `gh pr diff` is rejected for exceeding GitHub's 20,000-line limit.
 * The per-file patches are not subject to that aggregate cap, so even very
 * large PRs can be reassembled into a synthetic unified diff.
 */
export async function fetchPrDiffViaFilesApi(
	cwd: string,
	repo: string,
	number: number,
	signal: AbortSignal | undefined,
): Promise<string> {
	const ref = parseRepoRef(repo);
	const pull = await git.github.json<GhPrApi>(
		cwd,
		["api", ...ghApiHostArgs(ref), "--method", "GET", `/repos/${ref.slug}/pulls/${number}`],
		signal,
		{ repoProvided: true },
	);
	if ((pull.changed_files ?? 0) > PR_DIFF_FILES_MAX) {
		throw new ToolError(
			`Pull request changes ${pull.changed_files} files, exceeding GitHub's ${PR_DIFF_FILES_MAX}-file limit for the per-file diff API.`,
		);
	}

	const sections: string[] = [];
	let page = 1;
	while (true) {
		const response = await git.github.json<GhPrFileApi[]>(
			cwd,
			[
				"api",
				...ghApiHostArgs(ref),
				"--method",
				"GET",
				`/repos/${ref.slug}/pulls/${number}/files`,
				"-F",
				`per_page=${PR_DIFF_FILES_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);
		for (const file of response) {
			const section = buildSyntheticDiffSection(file);
			if (section) sections.push(section);
		}
		if (response.length < PR_DIFF_FILES_PAGE_SIZE) {
			break;
		}
		page += 1;
	}
	// Trailing newline mirrors `gh pr diff` so downstream parsers splitting on
	// `^diff --git ` see identical boundaries.
	return sections.length > 0 ? `${sections.join("\n")}\n` : "";
}

export async function fetchPrDiffFresh(
	cwd: string,
	repo: string,
	number: number,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: PrDiffPayload }> {
	const args = ["pr", "diff", String(number), "--color", "never"];
	appendRepoFlag(args, repo, String(number));
	let text: string;
	try {
		text = await git.github.text(cwd, args, signal, { repoProvided: true, trimOutput: false });
	} catch (err) {
		if (!isPrDiffTooLargeError(err)) throw err;
		logger.debug("gh pr diff exceeded GitHub's aggregate line limit; falling back to per-file API", {
			repo,
			number,
			err: String(err),
		});
		text = await fetchPrDiffViaFilesApi(cwd, repo, number, signal);
	}
	const payload = parsePrUnifiedDiff(text);
	// `rendered` already carries the verbatim diff; blank the payload copy so
	// the cache row stores a potentially huge diff once instead of twice.
	// `getOrFetchPrDiff` rehydrates `unified` from `rendered`.
	return { rendered: text, sourceUrl: undefined, payload: { unified: "", files: payload.files } };
}

/**
 * Cache-aware PR diff fetcher. Stores the full unified diff plus a parsed
 * file index in a single `pr-diff` cache row so the listing, full-diff, and
 * per-file slice variants of `pr://<n>/diff` share one `gh pr diff`
 * invocation.
 */
export async function getOrFetchPrDiff(options: PrDiffLookupOptions): Promise<ViewLookupResult<PrDiffPayload>> {
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const doFetch = () => fetchPrDiffFresh(options.cwd, options.repo, options.number, options.signal);
	const lookup = await getOrFetchView<PrDiffPayload>({
		repo: options.repo,
		kind: "pr-diff",
		number: options.number,
		includeComments: false,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		// Rehydrate the unified text from `rendered` (stored once per row).
		payload: { unified: lookup.rendered, files: lookup.payload.files },
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}
