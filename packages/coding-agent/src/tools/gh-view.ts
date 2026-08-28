import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings";
import * as git from "../utils/git";
import type { ToolSession } from ".";
import type { GhToolDetails } from "./gh";
import {
	appendRepoFlag,
	buildTextResult,
	formatAuthor,
	formatLabels,
	ghApiHostArgs,
	normalizeOptionalString,
	normalizeText,
	parseIssueUrl,
	parsePositiveDecimalInt,
	parseRepoRef,
	pushLine,
	requireNonEmpty,
	resolveDefaultRepoMemoized,
} from "./gh-common";
import { formatShortSha } from "./gh-format";
import { FILE_PREVIEW_LIMIT } from "./gh-search";
import type {
	GhComment,
	GhIssueViewData,
	GhPrFile,
	GhPrReview,
	GhPrReviewComment,
	GhPrReviewCommentApi,
	GhPrViewData,
	GhRepoViewData,
	GithubInput,
} from "./gh-types";
import { type CacheStatus, getOrFetchView, resolveGithubCacheAuthKey } from "./github-cache";
import { ToolError } from "./tool-errors";

export const GH_REPO_FIELDS = [
	"nameWithOwner",
	"description",
	"url",
	"defaultBranchRef",
	"homepageUrl",
	"forkCount",
	"isArchived",
	"isFork",
	"primaryLanguage",
	"repositoryTopics",
	"stargazerCount",
	"updatedAt",
	"viewerPermission",
	"visibility",
];
export const GH_ISSUE_FIELDS = [
	"author",
	"body",
	"comments",
	"createdAt",
	"labels",
	"number",
	"state",
	"stateReason",
	"title",
	"updatedAt",
	"url",
];
export const GH_ISSUE_FIELDS_NO_COMMENTS = [
	"author",
	"body",
	"createdAt",
	"labels",
	"number",
	"state",
	"stateReason",
	"title",
	"updatedAt",
	"url",
];

export const GH_ISSUE_STATE_REASON_FIELD = "stateReason";

export function ghJsonErrorNamesField(err: unknown, field: string): boolean {
	if (!(err instanceof Error) || !err.message.includes("Unknown JSON field")) return false;
	return err.message.includes(`"${field}"`) || err.message.includes(`'${field}'`) || err.message.includes(field);
}

export function dropJsonField(args: readonly string[], field: string): string[] | undefined {
	const next = [...args];
	const jsonIndex = next.indexOf("--json");
	if (jsonIndex < 0) return undefined;
	const fields = next[jsonIndex + 1];
	if (!fields) return undefined;
	const splitFields = fields.split(",");
	const kept = splitFields.filter(candidate => candidate !== field);
	if (kept.length === splitFields.length) return undefined;
	next[jsonIndex + 1] = kept.join(",");
	return next;
}

/** Runs `gh --json` for issue data, retrying without optional stateReason on older gh releases. */
export async function githubIssueJsonWithStateReasonFallback<T>(
	cwd: string,
	args: readonly string[],
	signal: AbortSignal | undefined,
	options?: git.GhCommandOptions,
): Promise<T> {
	try {
		return await git.github.json<T>(cwd, [...args], signal, options);
	} catch (err) {
		if (!ghJsonErrorNamesField(err, GH_ISSUE_STATE_REASON_FIELD)) throw err;
		const retryArgs = dropJsonField(args, GH_ISSUE_STATE_REASON_FIELD);
		if (!retryArgs) throw err;
		return await git.github.json<T>(cwd, retryArgs, signal, options);
	}
}

export const GH_PR_FIELDS = [
	"author",
	"baseRefName",
	"body",
	"comments",
	"createdAt",
	"files",
	"headRefName",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviews",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
];
export const GH_PR_FIELDS_NO_COMMENTS = [
	"author",
	"baseRefName",
	"body",
	"createdAt",
	"files",
	"headRefName",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviews",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
];
export const GH_REPO_CLONE_FIELDS = ["nameWithOwner", "sshUrl", "url"];

export const REVIEW_COMMENTS_PAGE_SIZE = 100;

export function normalizePrReviewComment(comment: GhPrReviewCommentApi): GhPrReviewComment | null {
	if (typeof comment.id !== "number") {
		return null;
	}

	return {
		author: comment.user ?? null,
		body: comment.body,
		createdAt: normalizeOptionalString(comment.created_at),
		id: comment.id,
		inReplyToId: typeof comment.in_reply_to_id === "number" ? comment.in_reply_to_id : undefined,
		line: typeof comment.line === "number" ? comment.line : undefined,
		originalLine: typeof comment.original_line === "number" ? comment.original_line : undefined,
		path: normalizeOptionalString(comment.path),
		side: normalizeOptionalString(comment.side),
		url: normalizeOptionalString(comment.html_url),
	};
}

export async function fetchPrReviewComments(
	cwd: string,
	repo: string,
	prNumber: number,
	signal?: AbortSignal,
): Promise<GhPrReviewComment[]> {
	const ref = parseRepoRef(repo);
	const reviewComments: GhPrReviewComment[] = [];
	let page = 1;

	while (true) {
		const response = await git.github.json<GhPrReviewCommentApi[]>(
			cwd,
			[
				"api",
				...ghApiHostArgs(ref),
				"--method",
				"GET",
				`/repos/${ref.slug}/pulls/${prNumber}/comments`,
				"-F",
				`per_page=${REVIEW_COMMENTS_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);

		const pageComments = response
			.map(comment => normalizePrReviewComment(comment))
			.filter((comment): comment is GhPrReviewComment => comment !== null);
		reviewComments.push(...pageComments);

		// Compare the raw page length: a dropped malformed item must not end
		// pagination early and silently lose the remaining pages.
		if (response.length < REVIEW_COMMENTS_PAGE_SIZE) {
			break;
		}

		page += 1;
	}

	return reviewComments;
}

export function formatCommentsSection(comments: GhComment[] | undefined): string[] {
	if (!comments || comments.length === 0) {
		return [];
	}

	const visible = comments.filter(comment => !comment.isMinimized);
	const hiddenCount = comments.length - visible.length;
	const lines: string[] = ["## Comments", ""];

	if (visible.length === 0) {
		lines.push(`No visible comments. Minimized comments omitted: ${hiddenCount}.`);
		return lines;
	}

	lines[0] = `## Comments (${visible.length})`;

	for (const comment of visible) {
		const author = formatAuthor(comment.author) ?? "unknown";
		const createdAt = comment.createdAt ? ` · ${comment.createdAt}` : "";
		lines.push(`### ${author}${createdAt}`);
		lines.push("");
		lines.push(normalizeText(comment.body) || "No comment body.");
		if (comment.url) {
			lines.push("");
			lines.push(`URL: ${comment.url}`);
		}
		lines.push("");
	}

	if (hiddenCount > 0) {
		lines.push(`Minimized comments omitted: ${hiddenCount}.`);
	}

	return lines;
}

export function formatReviewsSection(reviews: GhPrReview[] | undefined): string[] {
	if (!reviews || reviews.length === 0) {
		return [];
	}

	const lines: string[] = [`## Reviews (${reviews.length})`, ""];
	for (const review of reviews) {
		const author = formatAuthor(review.author) ?? "unknown";
		const submittedAt = review.submittedAt ? ` - ${review.submittedAt}` : "";
		const state = review.state ? ` [${review.state}]` : "";
		lines.push(`### ${author}${submittedAt}${state}`);
		if (review.commit?.oid) {
			lines.push("");
			lines.push(`Commit: ${formatShortSha(review.commit.oid)}`);
		}
		lines.push("");
		lines.push(normalizeText(review.body) || "No review body.");
		lines.push("");
	}

	return lines;
}

export function formatReviewCommentLocation(comment: GhPrReviewComment): string | undefined {
	if (!comment.path) {
		return undefined;
	}

	const line = comment.line ?? comment.originalLine;
	return line === undefined ? comment.path : `${comment.path}:${line}`;
}

export function formatReviewCommentsSection(comments: GhPrReviewComment[] | undefined): string[] {
	if (!comments || comments.length === 0) {
		return [];
	}

	const lines: string[] = [`## Review Comments (${comments.length})`, ""];
	for (const comment of comments) {
		const author = formatAuthor(comment.author) ?? "unknown";
		const createdAt = comment.createdAt ? ` · ${comment.createdAt}` : "";
		lines.push(`### ${author}${createdAt}`);
		lines.push("");
		pushLine(lines, "Location", formatReviewCommentLocation(comment));
		pushLine(lines, "Side", comment.side);
		pushLine(lines, "Reply to", comment.inReplyToId);
		pushLine(lines, "URL", comment.url);
		lines.push("");
		lines.push(normalizeText(comment.body) || "No review comment body.");
		lines.push("");
	}

	return lines;
}

export function formatRepoView(data: GhRepoViewData, input: { repo?: string; branch?: string }): string {
	const lines: string[] = [];
	const name = data.nameWithOwner ?? input.repo ?? "GitHub Repository";
	lines.push(`# ${name}`);
	lines.push("");
	lines.push(normalizeText(data.description) || "No description provided.");
	lines.push("");
	pushLine(lines, "URL", data.url);
	pushLine(lines, "Default branch", data.defaultBranchRef?.name);
	pushLine(lines, "Branch", normalizeOptionalString(input.branch));
	pushLine(lines, "Visibility", data.visibility ?? undefined);
	pushLine(lines, "Viewer permission", data.viewerPermission ?? undefined);
	pushLine(lines, "Primary language", data.primaryLanguage?.name);
	pushLine(lines, "Stars", data.stargazerCount);
	pushLine(lines, "Forks", data.forkCount);
	pushLine(lines, "Archived", data.isArchived);
	pushLine(lines, "Fork", data.isFork);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Homepage", data.homepageUrl ?? undefined);
	const topics = data.repositoryTopics
		?.map(topic => topic.name ?? topic.topic?.name)
		.filter((value): value is string => Boolean(value))
		.join(", ");
	pushLine(lines, "Topics", topics || undefined);
	return lines.join("\n").trim();
}

export function formatIssueView(
	data: GhIssueViewData,
	input: { issue: string; repo?: string; comments?: boolean },
): string {
	const lines: string[] = [];
	const issueNumber = data.number ?? input.issue;
	lines.push(`# Issue #${issueNumber}: ${data.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", data.state);
	pushLine(lines, "State reason", data.stateReason ?? undefined);
	pushLine(lines, "Author", formatAuthor(data.author));
	pushLine(lines, "Created", data.createdAt);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Labels", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(normalizeText(data.body) || "No description provided.");

	if ((input.comments ?? true) && data.comments) {
		const commentSection = formatCommentsSection(data.comments);
		if (commentSection.length > 0) {
			lines.push("");
			lines.push(...commentSection);
		}
	}

	return lines.join("\n").trim();
}

export function formatPrFiles(files: GhPrFile[] | undefined): string[] {
	if (!files || files.length === 0) return [];

	const lines: string[] = [`## Files (${files.length})`, ""];
	for (const file of files.slice(0, FILE_PREVIEW_LIMIT)) {
		const changeType = file.changeType ?? "CHANGED";
		const additions = file.additions ?? 0;
		const deletions = file.deletions ?? 0;
		lines.push(`- ${file.path ?? "(unknown file)"} [${changeType}] (+${additions} -${deletions})`);
	}

	if (files.length > FILE_PREVIEW_LIMIT) {
		lines.push(`[…${files.length - FILE_PREVIEW_LIMIT} files elided…]`);
	}

	return lines;
}

export function formatPrView(data: GhPrViewData, input: { pr?: string; repo?: string; comments?: boolean }): string {
	const lines: string[] = [];
	const prIdentifier = data.number ?? input.pr ?? "current";
	lines.push(`# Pull Request #${prIdentifier}: ${data.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", data.state);
	pushLine(lines, "Draft", data.isDraft);
	pushLine(lines, "Author", formatAuthor(data.author));
	pushLine(lines, "Base", data.baseRefName);
	pushLine(lines, "Head", data.headRefName);
	pushLine(lines, "Review decision", data.reviewDecision ?? undefined);
	pushLine(lines, "Merge state", data.mergeStateStatus);
	pushLine(lines, "Created", data.createdAt);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Labels", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(normalizeText(data.body) || "No description provided.");

	const fileSection = formatPrFiles(data.files);
	if (fileSection.length > 0) {
		lines.push("");
		lines.push(...fileSection);
	}

	if ((input.comments ?? true) && data.reviews) {
		const reviewSection = formatReviewsSection(data.reviews);
		if (reviewSection.length > 0) {
			lines.push("");
			lines.push(...reviewSection);
		}
	}

	if ((input.comments ?? true) && data.reviewComments) {
		const reviewCommentsSection = formatReviewCommentsSection(data.reviewComments);
		if (reviewCommentsSection.length > 0) {
			lines.push("");
			lines.push(...reviewCommentsSection);
		}
	}

	if ((input.comments ?? true) && data.comments) {
		const commentSection = formatCommentsSection(data.comments);
		if (commentSection.length > 0) {
			lines.push("");
			lines.push(...commentSection);
		}
	}

	return lines.join("\n").trim();
}

export async function executeRepoView(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const branch = normalizeOptionalString(params.branch);
	const args = ["repo", "view"];
	if (repo) {
		args.push(repo);
	}
	if (branch) {
		args.push("--branch", branch);
	}
	args.push("--json", GH_REPO_FIELDS.join(","));

	const data = await git.github.json<GhRepoViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatRepoView(data, { repo, branch }), data.url);
}

// ────────────────────────────────────────────────────────────────────────────
// Cached issue/PR view fetchers
//
// Used by `executeIssueView`/`executePrView` and by the `issue://` / `pr://`
// internal-URL protocol handlers. The cache wrapper lives in `./github-cache`;
// the fresh fetchers stay here to share the existing formatter helpers.
// ────────────────────────────────────────────────────────────────────────────

export interface IssueViewLookupOptions {
	cwd: string;
	repo?: string;
	/** Issue number or GitHub issue URL. */
	issue: string;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface PrViewLookupOptions {
	cwd: string;
	repo: string;
	number: number;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface ViewLookupResult<T> {
	rendered: string;
	sourceUrl: string | undefined;
	payload: T;
	status: CacheStatus;
	fetchedAt: number;
}

export async function fetchIssueViewFresh(
	cwd: string,
	repo: string | undefined,
	identifier: string,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GhIssueViewData }> {
	const args = ["issue", "view", identifier];
	appendRepoFlag(args, repo, identifier);
	args.push("--json", (includeComments ? GH_ISSUE_FIELDS : GH_ISSUE_FIELDS_NO_COMMENTS).join(","));
	const data = await githubIssueJsonWithStateReasonFallback<GhIssueViewData>(cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	const rendered = formatIssueView(data, { issue: identifier, repo, comments: includeComments });
	return { rendered, sourceUrl: data.url, payload: data };
}

export async function fetchPrViewFresh(
	cwd: string,
	repo: string,
	number: number,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GhPrViewData }> {
	const args = ["pr", "view", String(number)];
	appendRepoFlag(args, repo, String(number));
	args.push("--json", (includeComments ? GH_PR_FIELDS : GH_PR_FIELDS_NO_COMMENTS).join(","));
	const data = await git.github.json<GhPrViewData>(cwd, args, signal, { repoProvided: true });
	if (includeComments && typeof data.number === "number") {
		data.reviewComments = await fetchPrReviewComments(cwd, repo, data.number, signal);
	}
	const rendered = formatPrView(data, { pr: String(number), repo, comments: includeComments });
	return { rendered, sourceUrl: data.url, payload: data };
}

/**
 * Cache-aware issue/view fetcher. Used by both the `github` tool op and the
 * `issue://` protocol handler so a single shared row services both surfaces.
 */
export async function getOrFetchIssue(options: IssueViewLookupOptions): Promise<ViewLookupResult<GhIssueViewData>> {
	const identifier = requireNonEmpty(options.issue, "issue");
	if (identifier.startsWith("-")) {
		throw new ToolError(`invalid issue identifier: ${identifier}. Pass an issue number or URL.`);
	}
	const includeComments = options.includeComments ?? true;
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const urlParse = parseIssueUrl(identifier);
	// Prefer the URL's repo when the identifier is a full URL; fall back to the
	// explicit `repo` option, then to the cwd's default repo.
	let repo = urlParse.repo ?? normalizeOptionalString(options.repo);
	let cacheNumber = urlParse.issueNumber;
	if (cacheNumber === undefined) {
		cacheNumber = parsePositiveDecimalInt(identifier);
	}
	if (cacheNumber !== undefined && !repo) {
		try {
			repo = await resolveDefaultRepoMemoized(options.cwd, options.signal);
		} catch {
			// Resolution failure leaves `repo` undefined: we'll fall through to a
			// direct fetch below so gh produces its own error message instead of
			// us masking it with a friendlier one.
			repo = undefined;
		}
	}

	const doFetch = () => fetchIssueViewFresh(options.cwd, repo, identifier, includeComments, options.signal);

	if (!repo || cacheNumber === undefined) {
		const fresh = await doFetch();
		return { ...fresh, status: "miss", fetchedAt: Date.now() };
	}

	const lookup = await getOrFetchView<GhIssueViewData>({
		repo,
		kind: "issue",
		number: cacheNumber,
		includeComments,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

/**
 * Cache-aware PR view fetcher. Caller must supply a numeric PR number;
 * branch-name / current-branch lookups bypass the cache entirely upstream
 * (see `executePrView`).
 */
export async function getOrFetchPr(options: PrViewLookupOptions): Promise<ViewLookupResult<GhPrViewData>> {
	const includeComments = options.includeComments ?? true;
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const doFetch = () => fetchPrViewFresh(options.cwd, options.repo, options.number, includeComments, options.signal);
	const lookup = await getOrFetchView<GhPrViewData>({
		repo: options.repo,
		kind: "pr",
		number: options.number,
		includeComments,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}
