import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { webpExclusionForModel } from "../utils/image-input";
import { pushLine } from "./gh-format";
import type { GlToolDetails } from "./details/gitlab";
import { ToolError } from "./tool-errors";
import {
	BINARY_SNIFF_BYTES,
	formatBytes,
	isProbablyBinaryHeader,
	parseImageMetadata,
	prompt,
	untilAborted,
} from "@oh-my-pi/pi-utils";
import { cfgImagesAutoResize } from "../modes/settings";
import gitlabDescription from "../prompts/tools/gitlab.md" with { type: "text" };
import { gitlab } from "../utils/gitlab";
import { loadImageAttachmentInput } from "../utils/image-loading";
import { normalizeOptionalString } from "./gh-common";
import {
	executeCiLint,
	executeJobLog,
	executeJobRetry,
	executePipelineList,
	executePipelineView,
	executePipelineWatch,
} from "./gl-ci";
import {
	buildGlTextResult,
	encodeProjectPath,
	glabApiJson,
	glabApiPaginatedWithMeta,
	resolveGitlabProject,
} from "./gl-common";
import {
	executeMrCreate,
	executeMrDiscussionResolve,
	executeMrDiscussions,
	executeMrNote,
	executeMrUpdate,
} from "./gl-mr";
import { executeMrCheckout, executeMrPush } from "./gl-mr-checkout";
import {
	executeSearchCode,
	executeSearchCommits,
	executeSearchIssues,
	executeSearchMrs,
	executeSearchProjects,
} from "./gl-search";
import type { GitlabInput, GlFileApi, GlTreeEntryApi } from "./gl-types";
import { executeIssueView, executeRepoView } from "./gl-view";
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

export {
	defaultGitlabHost,
	encodeProjectPath,
	parseGitlabGroupRef,
	parseGitlabIssueUrl,
	parseGitlabJobUrl,
	parseGitlabMrUrl,
	parseGitlabPipelineUrl,
	parseGitlabProjectRef,
	resolveGitlabMrIid,
	resolveGitlabProject,
} from "./gl-common";
export { stripGitlabTraceAnsi } from "./gl-ci";
export {
	fetchMrViewFresh,
	formatMrView,
	getOrFetchMr,
	type GlIssueViewPayload,
	type GlMrViewPayload,
	type MrViewLookupOptions,
} from "./gl-view";
export {
	assertGitlabHostTrustedForEnvToken,
	formatGitlabProjectArg,
	getOrFetchMrDiff,
	GITLAB_HOST_PATTERN,
	GITLAB_PATH_SEGMENT_PATTERN,
	parseGitlabProjectWebUrl,
	resolveDefaultGitlabProjectMemoized,
} from "./glab-mr";

const GITLAB_READONLY_OPS: ReadonlySet<string> = new Set([
	"repo_view",
	"file_read",
	"issue_view",
	"mr_discussions",
	"search_mrs",
	"search_issues",
	"search_code",
	"search_commits",
	"search_projects",
	"pipeline_list",
	"pipeline_view",
	"pipeline_watch",
	"job_log",
]);

const gitlabSchema = type({
	op: type(
		"'repo_view' | 'file_read' | 'issue_view' | 'mr_create' | 'mr_update' | 'mr_checkout' | 'mr_push' | 'mr_discussions' | 'mr_note' | 'mr_discussion_resolve' | 'search_mrs' | 'search_issues' | 'search_code' | 'search_commits' | 'search_projects' | 'pipeline_list' | 'pipeline_view' | 'pipeline_watch' | 'job_log' | 'job_retry' | 'ci_lint'",
	).describe("gitlab operation"),
	"repo?": type("string").describe("[host/]group/project (nested groups supported)"),
	"group?": type("string").describe("[host/]group path for search scoping"),
	"ref?": type("string").describe("branch, tag, commit sha, or local mr branch"),
	"path?": type("string").describe("repository-relative file or directory path"),
	"mr?": type("string | string[]").describe("merge request iid, !iid, url, or branch"),
	"issue?": type("string").describe("issue iid, #iid, or url"),
	"force?": type("boolean").describe("reset existing local branch"),
	"forceWithLease?": type("boolean").describe("force-with-lease push"),
	"title?": type("string").describe("merge request title"),
	"body?": type("string").describe("markdown body or comment text"),
	"sourceBranch?": type("string").describe("mr source branch"),
	"targetBranch?": type("string").describe("mr target branch"),
	"draft?": type("boolean").describe("mark mr as draft/ready or filter draft state"),
	"fill?": type("boolean").describe("auto-fill mr title and description from commits"),
	"removeSourceBranch?": type("boolean").describe("delete source branch when mr is merged"),
	"squash?": type("boolean").describe("squash commits when mr is merged"),
	"reviewer?": type("string[]").describe("reviewer usernames"),
	"assignee?": type("string[]").describe("assignee usernames"),
	"label?": type("string[]").describe("labels"),
	"discussionId?": type("string").describe("discussion id or >=8-char prefix"),
	"resolved?": type("boolean").describe("set discussion resolved state"),
	"line?": type("number").describe("new-side line number for diff comment"),
	"oldLine?": type("number").describe("old-side line number for diff comment"),
	"resolvable?": type("boolean").describe("create general note as resolvable discussion (default true)"),
	"internal?": type("boolean").describe("post internal note (not allowed on diff comments)"),
	"state?": type("string").describe("filter state (opened/closed/merged/all/unresolved/resolved or pipeline status)"),
	"noteType?": type("'diff' | 'general' | 'system' | 'all'").describe("discussion note type filter"),
	"author?": type("string").describe("author username filter"),
	"query?": type("string").describe("search query"),
	"since?": type("string").describe("lower-bound date filter"),
	"until?": type("string").describe("upper-bound date filter"),
	"dateField?": type("'created' | 'updated'").describe("date field for search filters"),
	"limit?": type("number").describe("max results"),
	"pipeline?": type("string").describe("pipeline id or url"),
	"job?": type("string").describe("job id, url, or job name"),
	"tail?": type("number").describe("log lines to show"),
	"dryRun?": type("boolean").describe("run ci_lint as dry run"),
	"includeJobs?": type("boolean").describe("include expanded jobs in ci_lint output"),
});

type GitlabSchemaInput = typeof gitlabSchema.infer;

function buildBinaryFileReadResult(
	filePath: string,
	size: number,
	sourceUrl: string,
	repo: string,
	branch: string | undefined,
): AgentToolResult<GlToolDetails> {
	return buildGlTextResult(
		`[Cannot read binary file '${filePath}' (${formatBytes(size)}); not valid UTF-8 text. Open ${sourceUrl} to view it.]`,
		sourceUrl,
		{ repo, branch },
	);
}

function formatTreeListing(
	project: string,
	dirPath: string | undefined,
	refName: string | undefined,
	entries: readonly GlTreeEntryApi[],
	truncated: boolean,
): string {
	const location = dirPath ? `${dirPath}/` : "/";
	const lines = [`# Directory ${location} in ${project}`, ""];
	pushLine(lines, "Ref", refName);
	pushLine(lines, "Entries", truncated ? `${entries.length}+ (truncated)` : entries.length);
	lines.push("");
	if (entries.length === 0) {
		lines.push("_Empty directory._");
	} else {
		for (const entry of entries) {
			const name = entry.name ?? entry.path ?? "(unknown)";
			const suffix = entry.type === "tree" ? "/" : "";
			const kind = entry.type === "tree" ? "dir" : entry.type === "commit" ? "submodule" : "file";
			lines.push(`- [${kind}] ${name}${suffix}`);
		}
		if (truncated) {
			lines.push("", "_Directory listing truncated after 1,000 entries._");
		}
	}
	return lines.join("\n").trim();
}

export class GitlabTool implements AgentTool<typeof gitlabSchema, GlToolDetails> {
	readonly name = "gitlab";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawOp = args && typeof args === "object" && "op" in args ? args.op : undefined;
		const op = typeof rawOp === "string" ? rawOp : "";
		return GITLAB_READONLY_OPS.has(op) ? "read" : "exec";
	};
	readonly summary = "Interact with GitLab projects, files, merge requests, discussions, and CI pipelines";
	readonly loadMode = "discoverable";
	readonly label = "GitLab";
	readonly description = prompt.render(gitlabDescription);
	readonly parameters = gitlabSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GitlabTool | null {
		if (!gitlab.available()) return null;
		return new GitlabTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GitlabSchemaInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GlToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GlToolDetails>> {
		const typedParams: GitlabInput = params;
		return untilAborted(signal, async () => {
			switch (typedParams.op) {
				case "repo_view":
					return executeRepoView(this.session, typedParams, signal);
				case "file_read":
					return executeFileRead(this.session, typedParams, signal);
				case "issue_view":
					return executeIssueView(this.session, typedParams, signal);
				case "mr_create":
					return executeMrCreate(this.session, typedParams, signal);
				case "mr_update":
					return executeMrUpdate(this.session, typedParams, signal);
				case "mr_checkout":
					return executeMrCheckout(this.session, typedParams, signal);
				case "mr_push":
					return executeMrPush(this.session, typedParams, signal);
				case "mr_discussions":
					return executeMrDiscussions(this.session, typedParams, signal);
				case "mr_note":
					return executeMrNote(this.session, typedParams, signal);
				case "mr_discussion_resolve":
					return executeMrDiscussionResolve(this.session, typedParams, signal);
				case "search_mrs":
					return executeSearchMrs(this.session, typedParams, signal);
				case "search_issues":
					return executeSearchIssues(this.session, typedParams, signal);
				case "search_code":
					return executeSearchCode(this.session, typedParams, signal);
				case "search_commits":
					return executeSearchCommits(this.session, typedParams, signal);
				case "search_projects":
					return executeSearchProjects(this.session, typedParams, signal);
				case "pipeline_list":
					return executePipelineList(this.session, typedParams, signal);
				case "pipeline_view":
					return executePipelineView(this.session, typedParams, signal);
				case "pipeline_watch":
					return executePipelineWatch(this.session, typedParams, signal, onUpdate);
				case "job_log":
					return executeJobLog(this.session, typedParams, signal);
				case "job_retry":
					return executeJobRetry(this.session, typedParams, signal);
				case "ci_lint":
					return executeCiLint(this.session, typedParams, signal);
			}
		});
	}
}

async function executeFileRead(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const ref = await resolveGitlabProject(session.cwd, normalizeOptionalString(params.repo), undefined, signal);
	const rawPath = normalizeOptionalString(params.path);
	if (rawPath?.startsWith("/")) {
		throw new ToolError("path must be repository-relative");
	}
	const branchOrRef = normalizeOptionalString(params.ref);
	const encodedProject = encodeProjectPath(ref.path);

	if (!rawPath || rawPath === ".") {
		const { items: entries, truncated } = await glabApiPaginatedWithMeta<GlTreeEntryApi>(
			session.cwd,
			ref.host,
			`projects/${encodedProject}/repository/tree`,
			{ ref: branchOrRef },
			10,
			signal,
		);
		const treeUrl = `https://${ref.host}/${ref.path}${branchOrRef ? `/-/tree/${encodeURIComponent(branchOrRef)}` : ""}`;
		return buildGlTextResult(formatTreeListing(ref.full, undefined, branchOrRef, entries, truncated), treeUrl, {
			repo: ref.full,
			branch: branchOrRef,
		});
	}

	const filePath = rawPath.replace(/\/+$/, "");
	const endpointPath = filePath
		.split("/")
		.map(segment => encodeURIComponent(segment))
		.join("/");

	let file: GlFileApi;
	try {
		file = await glabApiJson<GlFileApi>(
			session.cwd,
			ref.host,
			`projects/${encodedProject}/repository/files/${encodeURIComponent(filePath)}`,
			{ query: { ref: branchOrRef ?? "HEAD" } },
			signal,
		);
	} catch (error) {
		if (!(error instanceof ToolError)) throw error;
		if (error.message.includes("404") || error.message.includes("Not Found")) {
			const { items: entries, truncated } = await glabApiPaginatedWithMeta<GlTreeEntryApi>(
				session.cwd,
				ref.host,
				`projects/${encodedProject}/repository/tree`,
				{ path: filePath, ref: branchOrRef },
				10,
				signal,
			);
			if (entries.length > 0) {
				const treeUrl = `https://${ref.host}/${ref.path}/-/tree/${encodeURIComponent(branchOrRef ?? "HEAD")}/${endpointPath}`;
				return buildGlTextResult(formatTreeListing(ref.full, filePath, branchOrRef, entries, truncated), treeUrl, {
					repo: ref.full,
					branch: branchOrRef,
				});
			}
		}
		const revision = branchOrRef ?? "HEAD";
		throw new ToolError(
			`GitLab file read failed for '${ref.full}@${revision}:${filePath}': ${error.message}`,
			error.context,
		);
	}

	const effectiveRef = branchOrRef ?? file.ref;
	const sourceUrl = `https://${ref.host}/${ref.path}/-/blob/${encodeURIComponent(effectiveRef ?? "HEAD")}/${endpointPath}`;
	if (file.encoding !== "base64" || typeof file.content !== "string") {
		const size = typeof file.size === "number" && file.size >= 0 ? formatBytes(file.size) : "unknown size";
		return buildGlTextResult(
			`[GitLab did not return file bytes for '${filePath}' (${size}). Open ${sourceUrl} to view it.]`,
			sourceUrl,
			{ repo: ref.full, branch: effectiveRef },
		);
	}

	const encoded = file.content.replaceAll(/\s/g, "");
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
			return toolResult<GlToolDetails>({ repo: ref.full, branch: effectiveRef })
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
		return buildBinaryFileReadResult(filePath, bytes.byteLength, sourceUrl, ref.full, effectiveRef);
	}
	try {
		return buildGlTextResult(new TextDecoder("utf-8", { fatal: true }).decode(bytes), sourceUrl, {
			repo: ref.full,
			branch: effectiveRef,
		});
	} catch {
		return buildBinaryFileReadResult(filePath, bytes.byteLength, sourceUrl, ref.full, effectiveRef);
	}
}
