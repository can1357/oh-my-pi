/**
 * Helpers shared by the forge protocols (`pr://`, `mr://`): session cwd
 * resolution, URL-segment splitting, and diff-family rendering (`…/diff`,
 * `…/diff/all`, `…/diff/<i>`).
 */
import { AgentRegistry } from "../registry/agent-registry";
import type { PrDiffFile, PrDiffPayload } from "../tools/gh-pr-diff";
import type { ViewLookupResult } from "../tools/gh-view";
import { formatFreshnessNote } from "../tools/github-cache";
import type { InternalResource, InternalUrl, ResolveContext } from "./types";

/**
 * Resolve the working directory the protocol should use.
 *
 * Order:
 * 1. Caller-supplied `context.cwd` (the session that initiated `read`).
 * 2. First registered session via `AgentRegistry` (single-session fallback).
 * 3. `process.cwd()` (last resort).
 *
 * The cwd drives `gh repo view` / `glab repo view` and repo listings for
 * short-form URLs, so getting this right is what keeps reads of `issue://N`
 * or `mr://N/diff` from picking the wrong repo across concurrent sessions.
 */
export function resolveCwd(context: ResolveContext | undefined): string {
	if (context?.cwd) return context.cwd;
	for (const ref of AgentRegistry.global().list()) {
		const cwd = ref.session?.sessionManager?.getCwd();
		if (cwd) return cwd;
	}
	return process.cwd();
}

/**
 * Split an internal URL path into raw (undecoded) segments, rejecting empty,
 * `.`, `..`, and undecodable segments.
 */
export function splitInternalUrlSegments(url: InternalUrl, scheme: string): string[] {
	const rawPath = url.rawPathname ?? url.pathname;
	// Strip a single leading slash so we can detect empty internal segments
	// (e.g. `pr://owner//77` → pathname `//77` → stripped `/77` → ["", "77"]).
	const stripped = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
	const parts: string[] = [];
	if (stripped === "") return parts;
	for (const seg of stripped.split("/")) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(seg);
		} catch {
			throw new Error(`Invalid ${scheme}:// URL: empty or unsafe path segment`);
		}
		if (decoded === "" || decoded === "." || decoded === "..") {
			throw new Error(`Invalid ${scheme}:// URL: empty or unsafe path segment`);
		}
		parts.push(seg);
	}
	return parts;
}

export interface DiffFamilyLabels {
	/** URL prefix without `/diff`, e.g. `pr://owner/repo/7`. */
	baseUrl: string;
	/** Listing header title, e.g. `Pull Request Diff: owner/repo#7`. */
	heading: string;
	/** Short noun used in range errors, e.g. `PR`. */
	noun: string;
}

function formatFileLine(idx: number, file: PrDiffFile, baseUrl: string): string {
	const stats = file.changeType === "binary" ? "(binary)" : `+${file.additions} -${file.deletions}`;
	const rename = file.oldPath ? `  (renamed from ${file.oldPath})` : "";
	return `${idx}. ${file.path}  ${stats}  [${file.changeType}]${rename}\n   ${baseUrl}/diff/${idx}`;
}

export function renderDiffFamilyResource(
	url: InternalUrl,
	mode: "list" | "all" | "slice",
	index: number | undefined,
	lookup: ViewLookupResult<PrDiffPayload>,
	labels: DiffFamilyLabels,
): InternalResource {
	const { baseUrl } = labels;
	const files = lookup.payload.files;
	const freshness = formatFreshnessNote(lookup.status, lookup.fetchedAt);
	const fileCount = `${files.length} file${files.length === 1 ? "" : "s"}`;

	if (mode === "all") {
		const content = lookup.payload.unified;
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [freshness, `Full diff for ${baseUrl} (${fileCount})`],
		};
	}

	if (mode === "slice") {
		const idx = index ?? 0;
		if (idx < 1 || idx > files.length) {
			throw new Error(
				`${baseUrl}/diff/${idx} is out of range; ${labels.noun} has ${fileCount}. Use ${baseUrl}/diff to list available indices.`,
			);
		}
		const file = files[idx - 1];
		if (!file) {
			throw new Error(`${baseUrl}/diff/${idx} resolved to a missing slice (parser bug).`);
		}
		const content = lookup.payload.unified.slice(file.startOffset, file.endOffset);
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [freshness, `Showing file ${idx}/${files.length}: ${file.path}`, `Read all: ${baseUrl}/diff/all`],
		};
	}

	const header = `# ${labels.heading} (${fileCount})`;
	const body =
		files.length === 0 ? "_No file changes._" : files.map((f, i) => formatFileLine(i + 1, f, baseUrl)).join("\n\n");
	const footer = `\n\n---\nRead all: \`${baseUrl}/diff/all\`. Each file is also available as \`${baseUrl}/diff/<i>\`.`;
	const content = `${header}\n\n${body}${footer}`;
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [freshness, `File listing for ${baseUrl}`],
	};
}
