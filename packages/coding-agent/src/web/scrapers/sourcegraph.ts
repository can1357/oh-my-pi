import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";

const GRAPHQL_ENDPOINT = "https://sourcegraph.com/.api/graphql";
const GRAPHQL_HEADERS = {
	Accept: "application/json",
	"Content-Type": "application/json",
};

type SourcegraphTarget =
	| { type: "search"; query: string }
	| { type: "repo"; repoName: string; rev?: string }
	| { type: "file"; repoName: string; rev?: string; filePath: string };

interface SourcegraphRepository {
	name: string;
	url: string;
	description?: string | null;
	defaultBranch?: { name: string } | null;
}

interface RepoQueryData {
	repository?: SourcegraphRepository | null;
}

interface RepoFileQueryData {
	repository?:
		| (SourcegraphRepository & {
				commit?: {
					blob?: { content?: string | null } | null;
				} | null;
		  })
		| null;
}

interface SearchQueryData {
	search?: {
		results?: {
			results?: SearchResultItem[] | null;
			matchCount?: number | null;
			limitHit?: boolean | null;
		} | null;
	} | null;
}

interface FileMatchResult {
	__typename: "FileMatch";
	repository?: { name?: string | null; url?: string | null } | null;
	file?: { path?: string | null; url?: string | null } | null;
	lineMatches?: Array<{ preview?: string | null; lineNumber?: number | null }> | null;
}

interface RepositoryResult {
	__typename: "Repository";
	name?: string | null;
	url?: string | null;
}

type SearchResultItem = FileMatchResult | RepositoryResult | { __typename: string };

const REPO_QUERY = `query Repo($name: String!) {
	repository(name: $name) {
		name
		url
		description
		defaultBranch {
			name
		}
	}
}`;

const REPO_FILE_QUERY = `query RepoFile($name: String!, $path: String!, $rev: String!) {
	repository(name: $name) {
		name
		url
		description
		defaultBranch {
			name
		}
		commit(rev: $rev) {
			blob(path: $path) {
				content
			}
		}
	}
}`;

const SEARCH_QUERY = `query Search($query: String!) {
	search(query: $query, version: V2) {
		results {
			results {
				__typename
				... on FileMatch {
					repository {
						name
						url
					}
					file {
						path
						url
					}
					lineMatches {
						preview
						lineNumber
					}
				}
				... on Repository {
					name
					url
				}
			}
			matchCount
			limitHit
		}
	}
}`;

function parseSourcegraphUrl(url: string): SourcegraphTarget | null {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "sourcegraph.com" && parsed.hostname !== "www.sourcegraph.com") return null;

		if (parsed.pathname.startsWith("/search")) {
			const query = parsed.searchParams.get("q")?.trim();
			if (!query) return null;
			return { type: "search", query };
		}

		const parts = parsed.pathname
			.split("/")
			.filter(Boolean)
			.map(part => decodeURIComponent(part));
		if (parts.length < 3) return null;

		const hyphenIndex = parts.indexOf("-");
		const repoParts = hyphenIndex === -1 ? parts : parts.slice(0, hyphenIndex);
		if (repoParts.length < 3) return null;

		const lastRepoPart = repoParts[repoParts.length - 1];
		const atIndex = lastRepoPart.indexOf("@");
		let rev: string | undefined;
		let repoTail = lastRepoPart;
		if (atIndex > 0) {
			repoTail = lastRepoPart.slice(0, atIndex);
			rev = lastRepoPart.slice(atIndex + 1) || undefined;
		}

		repoParts[repoParts.length - 1] = repoTail;
		const repoName = repoParts.join("/");

		if (hyphenIndex !== -1 && parts[hyphenIndex + 1] === "blob") {
			const filePath = parts.slice(hyphenIndex + 2).join("/");
			if (!filePath) return null;
			return { type: "file", repoName, rev, filePath };
		}

		return { type: "repo", repoName, rev };
	} catch {
		return null;
	}
}

async function fetchGraphql<T>(
	query: string,
	variables: Record<string, unknown>,
	timeout: number,
	signal?: AbortSignal,
): Promise<T | null> {
	const body = JSON.stringify({ query, variables });
	const result = await loadPage(GRAPHQL_ENDPOINT, {
		timeout,
		headers: GRAPHQL_HEADERS,
		method: "POST",
		body,
		signal,
	});
	if (!result.ok) return null;

	const parsed = tryParseJson<{ data?: T; errors?: unknown }>(result.content);
	if (!parsed?.data) return null;
	if (Array.isArray(parsed.errors) && parsed.errors.length > 0) return null;
	return parsed.data;
}

function isFileMatchResult(result: SearchResultItem): result is FileMatchResult {
	return result.__typename === "FileMatch";
}

function isRepositoryResult(result: SearchResultItem): result is RepositoryResult {
	return result.__typename === "Repository";
}

function formatRepoMarkdown(repo: SourcegraphRepository): string {
	let md = `# ${repo.name}\n\n`;
	if (repo.description) md += `${repo.description}\n\n`;
	md += `**URL:** ${repo.url}\n`;
	if (repo.defaultBranch?.name) md += `**Default branch:** ${repo.defaultBranch.name}\n`;
	return md;
}

async function renderRepo(
	repoName: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean }> {
	const data = await fetchGraphql<RepoQueryData>(REPO_QUERY, { name: repoName }, timeout, signal);
	if (!data?.repository) return { content: "", ok: false };

	return { content: formatRepoMarkdown(data.repository), ok: true };
}

async function renderFile(
	repoName: string,
	filePath: string,
	rev: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean }> {
	const data = await fetchGraphql<RepoFileQueryData>(
		REPO_FILE_QUERY,
		{ name: repoName, path: filePath, rev },
		timeout,
		signal,
	);
	const repo = data?.repository;
	const content = repo?.commit?.blob?.content ?? null;
	if (!repo || content === null) return { content: "", ok: false };

	let md = `${formatRepoMarkdown(repo)}\n`;
	md += `**Path:** ${filePath}\n`;
	md += `**Revision:** ${rev}\n\n`;
	md += `---\n\n## File\n\n`;
	md += "```text\n";
	md += `${content}\n`;
	md += "```\n";
	return { content: md, ok: true };
}

async function renderSearch(
	query: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean }> {
	const data = await fetchGraphql<SearchQueryData>(SEARCH_QUERY, { query }, timeout, signal);
	const resultsData = data?.search?.results;
	if (!resultsData) return { content: "", ok: false };
	const results = resultsData.results ?? [];

	let md = "# Sourcegraph Search\n\n";
	md += `**Query:** \`${query}\`\n`;
	if (typeof resultsData?.matchCount === "number") {
		md += `**Matches:** ${resultsData.matchCount}\n`;
	}
	if (typeof resultsData?.limitHit === "boolean") {
		md += `**Limit hit:** ${resultsData.limitHit ? "yes" : "no"}\n`;
	}
	md += "\n";

	if (!results || results.length === 0) {
		md += "_No results._\n";
		return { content: md, ok: true };
	}

	const maxResults = 10;
	md += "## Results\n\n";
	for (const result of results.slice(0, maxResults)) {
		if (isFileMatchResult(result)) {
			const repoName = result.repository?.name ?? "unknown";
			const filePath = result.file?.path ?? "unknown";
			md += `### ${repoName}/${filePath}\n\n`;
			if (result.repository?.url) md += `**Repository:** ${result.repository.url}\n`;
			if (result.file?.url) md += `**File:** ${result.file.url}\n`;

			const lineMatches = result.lineMatches ?? [];
			if (lineMatches.length > 0) {
				md += "\n```text\n";
				for (const line of lineMatches.slice(0, 5)) {
					const preview = (line.preview ?? "").replace(/\n/g, " ").trim();
					const lineNumber = line.lineNumber ?? 0;
					md += `L${lineNumber}: ${preview}\n`;
				}
				md += "```\n\n";
			}
			continue;
		}

		if (isRepositoryResult(result)) {
			const name = result.name ?? "unknown";
			md += `### ${name}\n\n`;
			if (result.url) md += `**Repository:** ${result.url}\n`;
			md += "\n";
		}
	}

	if (results.length > maxResults) {
		md += `[…${results.length - maxResults} results elided…]\n`;
	}

	return { content: md, ok: true };
}

export const handleSourcegraph: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const target = parseSourcegraphUrl(url);
		if (!target) return null;

		const fetchedAt = new Date().toISOString();
		const notes = ["Fetched via Sourcegraph GraphQL API"];

		switch (target.type) {
			case "search": {
				const result = await renderSearch(target.query, timeout, signal);
				if (!result.ok) return null;
				return buildResult(result.content, { url, method: "sourcegraph-search", fetchedAt, notes });
			}
			case "file": {
				const rev = target.rev ?? "HEAD";
				const result = await renderFile(target.repoName, target.filePath, rev, timeout, signal);
				if (!result.ok) return null;
				return buildResult(result.content, { url, method: "sourcegraph-file", fetchedAt, notes });
			}
			case "repo": {
				const result = await renderRepo(target.repoName, timeout, signal);
				if (!result.ok) return null;
				return buildResult(result.content, { url, method: "sourcegraph-repo", fetchedAt, notes });
			}
		}
	} catch {}

	return null;
};
