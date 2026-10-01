/**
 * Document-ingest sources for the Dakera memory backend.
 *
 * One abstraction: a source names a registered tool and learns how to turn that
 * tool's arguments plus its text result into a document import. Adding a source
 * is one table entry — the auto-ingest whitelist (`dakera.ingestToolResults`)
 * decides which ones fire, so new documentation tools need no wiring elsewhere.
 *
 * `documentId` semantics follow the agreed policy: auto-ingest ids derive from
 * the source identity (URL / repo+path / library+topic), so a refetch of the same
 * source REPLACES the stored document; ad-hoc saves may omit the id and take the
 * server's content-hash default.
 */

import { CryptoHasher } from "bun";

export type DocMediaType = "text/plain" | "text/markdown" | "text/html";

/** What an ingest source produced, ready for `DakeraApi.importDocument`. */
export interface DocIngest {
	content: string;
	mediaType: DocMediaType;
	title: string;
	/** Stable across refetches; omitted → server content-hash id. */
	documentId?: string;
}

/** A registered tool whose successful results are documentation worth keeping. */
export interface DocIngestSource {
	/** Registered tool name (`mcp__<server>_<tool>` for MCP tools). */
	toolName: string;
	extract(args: Record<string, unknown>, text: string): DocIngest | undefined;
}

/** Stable document id from the source identity: the same source replaces itself on refetch. */
export function docIdFor(...parts: string[]): string {
	const digest = new CryptoHasher("sha256").update(parts.join("\u0000")).digest("hex");
	return `doc-${digest.slice(0, 24)}`;
}

/** Text of a tool result: a plain string or an `AgentToolResult`-shaped content block list. */
export function docTextOf(result: unknown): string | undefined {
	if (typeof result === "string") return result.trim() || undefined;
	if (result !== null && typeof result === "object" && "content" in result) {
		const content: unknown = result.content;
		if (Array.isArray(content)) {
			const text = content
				.filter((block): block is { text?: unknown } => block !== null && typeof block === "object")
				.map(block => (typeof block.text === "string" ? block.text : ""))
				.join("\n")
				.trim();
			return text || undefined;
		}
	}
	return undefined;
}

/** Media type from a path/URL extension; documents stay in the format the tool returned. */
export function docMediaTypeForPath(pathOrUrl: string): DocMediaType {
	const path = pathOrUrl.toLowerCase().split(/[?#]/u)[0] ?? "";
	if (path.endsWith(".md") || path.endsWith(".markdown")) return "text/markdown";
	if (path.endsWith(".html") || path.endsWith(".htm") || path.endsWith(".xhtml")) return "text/html";
	return "text/plain";
}

const str = (args: Record<string, unknown>, key: string): string | undefined =>
	typeof args[key] === "string" && args[key] !== "" ? (args[key] as string) : undefined;

/** Web-page tools return readable markdown (`searxng_web_url_read`, `fetch`). */
const webPageSource = (toolName: string): DocIngestSource => ({
	toolName,
	extract(args, text) {
		const url = str(args, "url");
		if (!url) return undefined;
		return {
			content: text,
			// Both tools hand back converted markdown, not raw HTML.
			mediaType: "text/markdown",
			title: url,
			documentId: docIdFor("web", url),
		};
	},
});

export const DOC_INGEST_SOURCES: DocIngestSource[] = [
	{
		toolName: "mcp__context7_query_docs",
		extract(args, text) {
			const libraryId = str(args, "libraryId");
			const topic = str(args, "topic");
			return {
				content: text,
				mediaType: "text/markdown",
				title: `context7 ${[libraryId, topic].filter(Boolean).join(" ")}`.trim(),
				documentId: docIdFor("ctx7", libraryId ?? "", topic ?? ""),
			};
		},
	},
	{
		toolName: "mcp__github_get_file_contents",
		extract(args, text) {
			const owner = str(args, "owner");
			const repo = str(args, "repo");
			const path = str(args, "path");
			if (!owner || !repo || !path) return undefined;
			return {
				content: text,
				mediaType: docMediaTypeForPath(path),
				title: `${owner}/${repo}/${path}`,
				// `ref` deliberately excluded: refetching the same file replaces the
				// document regardless of branch or commit.
				documentId: docIdFor("gh", owner, repo, path),
			};
		},
	},
	webPageSource("mcp__searxng_web_url_read"),
	webPageSource("mcp__fetch_fetch"),
	{
		toolName: "mcp__deepwiki_read_wiki_contents",
		extract(args, text) {
			const repoName = str(args, "repoName");
			const pageName = str(args, "pageName");
			if (!repoName) return undefined;
			return {
				content: text,
				mediaType: "text/markdown",
				title: `wiki ${repoName}${pageName ? ` ${pageName}` : ""}`,
				documentId: docIdFor("wiki", repoName, pageName ?? ""),
			};
		},
	},
];

/** Default auto-ingest whitelist: the registered names of {@link DOC_INGEST_SOURCES}. */
export const DEFAULT_INGEST_TOOL_NAMES: string[] = DOC_INGEST_SOURCES.map(source => source.toolName);

/** Find the ingest source for a tool, if it has one. */
export function docIngestSourceFor(toolName: string): DocIngestSource | undefined {
	return DOC_INGEST_SOURCES.find(source => source.toolName === toolName);
}
