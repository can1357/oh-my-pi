import type { GhToolDetails } from "./details/github";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";

import {
	BINARY_SNIFF_BYTES,
	formatBytes,
	isProbablyBinaryHeader,
	parseImageMetadata,
	prompt,
	untilAborted,
} from "@oh-my-pi/pi-utils";
import githubDescription from "../prompts/tools/github.md" with { type: "text" };
import { github } from "../utils/github";
import { loadImageAttachmentInput } from "../utils/image-loading";
import { webpExclusionForModel } from "../utils/image-input";
import type { ToolSession } from ".";
import {
	buildTextResult,
	defaultGhHost,
	ghApiHostArgs,
	normalizeOptionalString,
	parseRepoRef,
	resolveGitHubRepo,
} from "./gh-common";
import { pushLine } from "./gh-format";
import { executePrCheckout, executePrCreate, executePrPush, executePrUpdate } from "./gh-pr-checkout";
import { executeRunWatch } from "./gh-run-watch";
import {
	executeSearchCode,
	executeSearchCommits,
	executeSearchIssues,
	executeSearchPrs,
	executeSearchRepos,
} from "./gh-search";
import { executeRepoView } from "./gh-view";

import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

import { cfgImagesAutoResize } from "../modes/settings";

export { formatRepoRef, parsePositiveDecimalInt, resolveDefaultRepoMemoized } from "./gh-common";
export {
	getOrFetchPrDiff,
	getPinnedPrDiff,
	type PrDiffFile,
	type PrDiffLookupOptions,
	type PrDiffPayload,
	parsePrUnifiedDiff,
	retainPrDiffGeneration,
} from "./gh-pr-diff";
export { buildSearchDateQualifier, parseSearchDateBound } from "./gh-search";
export {
	getOrFetchIssue,
	getOrFetchPr,
	githubIssueJsonWithStateReasonFallback,
	type IssueViewLookupOptions,
	type PrViewLookupOptions,
	type ViewLookupResult,
} from "./gh-view";

const GITHUB_READONLY_OPS: ReadonlySet<string> = new Set([
	"repo_view",
	"file_read",
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
	"run_watch",
]);

const githubSchema = type({
	op: type(
		"'repo_view' | 'file_read' | 'pr_create' | 'pr_update' | 'pr_checkout' | 'pr_push' | 'search_issues' | 'search_prs' | 'search_code' | 'search_commits' | 'search_repos' | 'run_watch'",
	).describe("github operation"),
	"repo?": type("string").describe("owner/repo"),
	"branch?": type("string").describe("branch"),
	"path?": type("string").describe("repository-relative file or directory path (optional :start-end line range)"),
	"pr?": type("string | string[]").describe("pr number, url, or branch"),
	"force?": type("boolean").describe("reset existing local branch"),
	"forceWithLease?": type("boolean").describe("force-with-lease push"),
	"title?": type("string").describe("pr title"),
	"body?": type("string").describe("pr body markdown"),
	"base?": type("string").describe("pr base branch"),
	"head?": type("string").describe("pr head branch"),
	"draft?": type("boolean").describe("open pr as draft"),
	"fill?": type("boolean").describe("auto-fill pr title/body from commits"),
	"reviewer?": type("string[]").describe("reviewers"),
	"assignee?": type("string[]").describe("assignees"),
	"label?": type("string[]").describe("labels"),
	"state?": type("'open' | 'closed'").describe("pr state"),
	"query?": type("string").describe("search query"),
	"since?": type("string").describe("lower-bound date filter"),
	"until?": type("string").describe("upper-bound date filter"),
	"dateField?": type("'created' | 'updated'").describe("date field"),
	"limit?": type("number").describe("max results"),
	"run?": type("string").describe("actions run id or url"),
	"tail?": type("number").describe("log lines per failed job"),
});

type GithubInput = typeof githubSchema.infer;

interface GitHubContentsEntry {
	name?: string;
	path?: string;
	type?: string;
	encoding?: string;
	size?: number;
	content?: string;
	html_url?: string | null;
}

type GitHubContentsResponse = GitHubContentsEntry | GitHubContentsEntry[];

function isGitHubContentsFile(response: GitHubContentsResponse): response is GitHubContentsEntry {
	return !Array.isArray(response) && response.type === "file";
}

interface FileLineRange {
	start?: number;
	end?: number;
	tail?: number;
}

const FILE_LINE_RANGE_SUFFIX = /:(?:(\d+)(?:-(\d*))?|-(\d+))$/;

export function parseFileReadPath(rawPath: string | undefined): {
	filePath: string;
	lineRange?: FileLineRange;
} {
	const trimmed = normalizeOptionalString(rawPath);
	if (!trimmed || trimmed === ".") {
		return { filePath: "" };
	}
	const match = FILE_LINE_RANGE_SUFFIX.exec(trimmed);
	if (match) {
		const pathPart = trimmed.slice(0, match.index);
		if (pathPart.length > 0) {
			if (match[3] !== undefined) {
				const tail = Number.parseInt(match[3], 10);
				if (tail > 0) return { filePath: pathPart, lineRange: { tail } };
			} else if (match[1] !== undefined) {
				const start = Number.parseInt(match[1], 10);
				const end = match[2] ? Number.parseInt(match[2], 10) : match[2] === "" ? undefined : start;
				if (start > 0 && (end === undefined || end >= start)) {
					return { filePath: pathPart, lineRange: { start, end } };
				}
			}
		}
	}
	return { filePath: trimmed };
}

export function sliceFileLines(text: string, range: FileLineRange): string {
	const lines = text.split("\n");
	const total = lines.length;
	let startIdx: number;
	let endIdx: number;
	if (range.tail !== undefined) {
		startIdx = Math.max(0, total - range.tail);
		endIdx = total - 1;
	} else {
		const start = range.start ?? 1;
		if (start > total) {
			return `[Line ${start} is beyond end of file (${total} lines total).]`;
		}
		startIdx = start - 1;
		endIdx = range.end !== undefined ? Math.min(total - 1, range.end - 1) : total - 1;
	}
	const out: string[] = [];
	for (let i = startIdx; i <= endIdx; i++) {
		out.push(`${i + 1}|${lines[i]}`);
	}
	if (startIdx > 0 || endIdx < total - 1) {
		out.push("", `[Showing lines ${startIdx + 1}-${endIdx + 1} of ${total}]`);
	}
	return out.join("\n");
}

function formatDirectoryListing(
	repo: string,
	dirPath: string,
	branch: string | undefined,
	entries: readonly GitHubContentsEntry[],
): string {
	const location = dirPath ? `${dirPath}/` : "/";
	const lines = [`# Directory ${location} in ${repo}`, ""];
	pushLine(lines, "Branch", branch);
	pushLine(lines, "Entries", entries.length);
	lines.push("");
	if (entries.length === 0) {
		lines.push("_Empty directory._");
	} else {
		for (const entry of entries) {
			const name = entry.name ?? entry.path ?? "(unknown)";
			const kind =
				entry.type === "dir"
					? "dir"
					: entry.type === "submodule"
						? "submodule"
						: entry.type === "symlink"
							? "symlink"
							: "file";
			const suffix = kind === "dir" ? "/" : "";
			lines.push(`- [${kind}] ${name}${suffix}`);
		}
	}
	return lines.join("\n").trim();
}

function buildBinaryFileReadResult(
	filePath: string,
	size: number,
	sourceUrl: string,
	repo: string,
	branch: string | undefined,
): AgentToolResult<GhToolDetails> {
	return buildTextResult(
		`[Cannot read binary file '${filePath}' (${formatBytes(size)}); not valid UTF-8 text. Open ${sourceUrl} to view it.]`,
		sourceUrl,
		{ repo, branch },
	);
}

export class GithubTool implements AgentTool<typeof githubSchema, GhToolDetails> {
	readonly name = "github";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawOp = (args as Partial<GithubInput>).op;
		const op = typeof rawOp === "string" ? rawOp : "";
		return GITHUB_READONLY_OPS.has(op) ? "read" : "exec";
	};
	readonly summary = "Interact with GitHub repositories, files, pull requests, and Actions";
	readonly loadMode = "discoverable";
	readonly label = "GitHub";
	readonly description = prompt.render(githubDescription);
	readonly parameters = githubSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GithubTool | null {
		if (!github.available()) return null;
		return new GithubTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GithubInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GhToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GhToolDetails>> {
		return untilAborted(signal, async () => {
			switch (params.op) {
				case "repo_view":
					return executeRepoView(this.session, params, signal);
				case "file_read":
					return executeFileRead(this.session, params, signal);
				case "pr_create":
					return executePrCreate(this.session, params, signal);
				case "pr_update":
					return executePrUpdate(this.session, params, signal);
				case "pr_checkout":
					return executePrCheckout(this.session, params, signal);
				case "pr_push":
					return executePrPush(this.session, params, signal);
				case "search_issues":
					return executeSearchIssues(this.session, params, signal);
				case "search_prs":
					return executeSearchPrs(this.session, params, signal);
				case "search_code":
					return executeSearchCode(this.session, params, signal);
				case "search_commits":
					return executeSearchCommits(this.session, params, signal);
				case "search_repos":
					return executeSearchRepos(this.session, params, signal);
				case "run_watch":
					return executeRunWatch(this.session, this.name, params, signal, onUpdate);
			}
		});
	}
}

async function executeFileRead(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = await resolveGitHubRepo(session.cwd, normalizeOptionalString(params.repo), undefined, signal);
	const parsedPath = parseFileReadPath(params.path);
	if (parsedPath.filePath.startsWith("/")) {
		throw new ToolError("path must be repository-relative");
	}
	const filePath = parsedPath.filePath.replace(/\/+$/, "");
	const branch = normalizeOptionalString(params.branch);
	const endpointPath = filePath
		? filePath
				.split("/")
				.map(segment => encodeURIComponent(segment))
				.join("/")
		: "";
	const ref = parseRepoRef(repo);
	const contentsEndpoint = endpointPath
		? `/repos/${ref.slug}/contents/${endpointPath}`
		: `/repos/${ref.slug}/contents`;
	const args = [
		"api",
		...ghApiHostArgs(ref),
		contentsEndpoint,
		"--method",
		"GET",
		"-H",
		"Accept: application/vnd.github+json",
		"-H",
		"Accept-Encoding: identity",
	];
	if (branch) {
		args.push("-f", `ref=${branch}`);
	}
	let response: GitHubContentsResponse;
	try {
		response = await github.json<GitHubContentsResponse>(session.cwd, args, signal, {
			repoProvided: true,
			trimOutput: false,
		});
	} catch (error) {
		if (!(error instanceof ToolError)) throw error;
		// Contents API 404s conflate repository, revision, path, and access failures; identify the request without guessing.
		const revision = branch ?? "HEAD";
		throw new ToolError(
			`GitHub file read failed for '${repo}@${revision}:${filePath || "/"}': ${error.message}`,
			error.context,
		);
	}
	const fallbackHost = ref.host ?? defaultGhHost();
	if (Array.isArray(response)) {
		const treeUrl = `https://${fallbackHost}/${ref.slug}/tree/${encodeURIComponent(branch ?? "HEAD")}${endpointPath ? `/${endpointPath}` : ""}`;
		return buildTextResult(formatDirectoryListing(repo, filePath, branch, response), treeUrl, { repo, branch });
	}
	if (!isGitHubContentsFile(response)) {
		throw new ToolError(`GitHub path '${filePath}' is not a file.`);
	}
	// A host-less ref went to gh's default host, so the link has to match it.
	const fallbackSourceUrl = `https://${fallbackHost}/${ref.slug}/blob/${encodeURIComponent(branch ?? "HEAD")}/${endpointPath}`;
	const sourceUrl = response.html_url || fallbackSourceUrl;
	if (response.encoding !== "base64" || typeof response.content !== "string") {
		const size =
			typeof response.size === "number" && response.size >= 0 ? formatBytes(response.size) : "unknown size";
		return buildTextResult(
			`[GitHub did not return file bytes for '${filePath}' (${size}). Open ${sourceUrl} to view it.]`,
			sourceUrl,
			{ repo, branch },
		);
	}

	const encoded = response.content.replaceAll(/\s/g, "");
	const bytes = Buffer.from(encoded, "base64");
	const imageMetadata = parseImageMetadata(bytes);
	if (imageMetadata) {
		const image = await loadImageAttachmentInput({
			image: { type: "image", data: encoded, mimeType: imageMetadata.mimeType },
			label: filePath,
			uri: sourceUrl,
			autoResize: cfgImagesAutoResize.get(session.settings),
			excludeWebP: webpExclusionForModel(session.getActiveModel?.()),
		});
		if (image) {
			const dimensions =
				imageMetadata.width !== undefined && imageMetadata.height !== undefined
					? `\nDimensions: ${imageMetadata.width}x${imageMetadata.height}`
					: "";
			return toolResult<GhToolDetails>({ repo, branch })
				.content([
					{
						type: "text",
						text: `Image file: ${filePath}\nMIME: ${image.mimeType}\nSize: ${formatBytes(bytes.byteLength)}${dimensions}`,
					},
					{ type: "image", data: image.data, mimeType: image.mimeType },
				])
				.sourceUrl(sourceUrl)
				.done();
		}
	}

	if (isProbablyBinaryHeader(bytes.subarray(0, BINARY_SNIFF_BYTES))) {
		return buildBinaryFileReadResult(filePath, bytes.byteLength, sourceUrl, repo, branch);
	}
	try {
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const text = parsedPath.lineRange ? sliceFileLines(decoded, parsedPath.lineRange) : decoded;
		return buildTextResult(text, sourceUrl, { repo, branch });
	} catch {
		return buildBinaryFileReadResult(filePath, bytes.byteLength, sourceUrl, repo, branch);
	}
}
