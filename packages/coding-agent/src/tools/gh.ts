import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { IsoBackendKind } from "@oh-my-pi/pi-natives";
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
import { loadImageAttachmentInput, webpExclusionForModel } from "../utils/image-loading";
import type { ToolSession } from ".";
import {
	buildTextResult,
	defaultGhHost,
	ghApiHostArgs,
	normalizeOptionalString,
	parseRepoRef,
	requireNonEmpty,
	resolveGitHubRepo,
} from "./gh-common";
import { executePrCheckout, executePrCreate, executePrPush } from "./gh-pr-checkout";
import { executeRunWatch } from "./gh-run-watch";
import {
	executeSearchCode,
	executeSearchCommits,
	executeSearchIssues,
	executeSearchPrs,
	executeSearchRepos,
} from "./gh-search";
import { executeRepoView } from "./gh-view";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

export { formatRepoRef, parsePositiveDecimalInt, resolveDefaultRepoMemoized } from "./gh-common";
export {
	getOrFetchPrDiff,
	type PrDiffFile,
	type PrDiffLookupOptions,
	type PrDiffPayload,
	parsePrUnifiedDiff,
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
		"'repo_view' | 'file_read' | 'pr_create' | 'pr_checkout' | 'pr_push' | 'search_issues' | 'search_prs' | 'search_code' | 'search_commits' | 'search_repos' | 'run_watch'",
	).describe("github operation"),
	"repo?": type("string").describe("owner/repo"),
	"branch?": type("string").describe("branch"),
	"path?": type("string").describe("repository-relative file path"),
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
	"query?": type("string").describe("search query"),
	"since?": type("string").describe("lower-bound date filter"),
	"until?": type("string").describe("upper-bound date filter"),
	"dateField?": type("'created' | 'updated'").describe("date field"),
	"limit?": type("number").describe("max results"),
	"run?": type("string").describe("actions run id or url"),
	"tail?": type("number").describe("log lines per failed job"),
});

type GithubInput = typeof githubSchema.infer;

interface GitHubContentsFile {
	type?: string;
	encoding?: string;
	size?: number;
	content?: string;
	html_url?: string | null;
}

type GitHubContentsResponse = GitHubContentsFile | GitHubContentsFile[];

function isGitHubContentsFile(response: GitHubContentsResponse): response is GitHubContentsFile {
	return !Array.isArray(response) && response.type === "file";
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

export interface GhToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	worktreePath?: string;
	remote?: string;
	remoteBranch?: string;
	headSha?: string;
	runId?: number;
	runIds?: number[];
	status?: string;
	conclusion?: string;
	failedJobs?: string[];
	watch?: GhRunWatchViewDetails;
	checkouts?: GhPrCheckoutSummary[];
}

export interface GhPrCheckoutSummary {
	prNumber?: number;
	url?: string;
	branch: string;
	worktreePath: string;
	remote: string;
	remoteBranch: string;
	reused: boolean;
	clonedWith?: IsoBackendKind;
}

export interface GhRunWatchJobDetails {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
	url?: string;
}

export interface GhRunWatchRunDetails {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	url?: string;
	jobs: GhRunWatchJobDetails[];
}

export interface GhRunWatchFailedLogDetails {
	runId: number;
	workflowName?: string;
	jobName: string;
	conclusion?: string;
	tail?: string;
	available: boolean;
}

export interface GhRunWatchViewDetails {
	mode: "run" | "commit";
	state: "watching" | "completed";
	repo: string;
	branch?: string;
	headSha?: string;
	pollCount?: number;
	note?: string;
	run?: GhRunWatchRunDetails;
	runs?: GhRunWatchRunDetails[];
	failedLogs?: GhRunWatchFailedLogDetails[];
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
	const filePath = requireNonEmpty(normalizeOptionalString(params.path), "path");
	if (filePath.startsWith("/")) {
		throw new ToolError("path must be repository-relative");
	}
	const branch = normalizeOptionalString(params.branch);
	const endpointPath = filePath
		.split("/")
		.map(segment => encodeURIComponent(segment))
		.join("/");
	const ref = parseRepoRef(repo);
	const args = [
		"api",
		...ghApiHostArgs(ref),
		`/repos/${ref.slug}/contents/${endpointPath}`,
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
	const response = await github.json<GitHubContentsResponse>(session.cwd, args, signal, {
		repoProvided: true,
		trimOutput: false,
	});
	if (!isGitHubContentsFile(response)) {
		throw new ToolError(`GitHub path '${filePath}' is not a file.`);
	}

	// A host-less ref went to gh's default host, so the link has to match it.
	const fallbackHost = ref.host ?? defaultGhHost();
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
			autoResize: session.settings.get("images.autoResize"),
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
		return buildTextResult(new TextDecoder("utf-8", { fatal: true }).decode(bytes), sourceUrl, { repo, branch });
	} catch {
		return buildBinaryFileReadResult(filePath, bytes.byteLength, sourceUrl, repo, branch);
	}
}
