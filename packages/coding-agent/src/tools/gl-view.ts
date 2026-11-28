import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { pushLine } from "./gh-format";
import type { GlToolDetails } from "./details/gitlab";
import { ToolError } from "./tool-errors";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { normalizeOptionalString, normalizeText, parsePositiveDecimalInt, requireNonEmpty } from "./gh-common";
import type { ViewLookupResult } from "./gh-view";
import { assertGitlabHostTrustedForEnvToken, GITLAB_PATH_SEGMENT_PATTERN, parseGitlabProjectWebUrl } from "./glab-mr";
import { getOrFetchView, resolveGitlabCacheAuthKey } from "./github-cache";
import {
	buildGlTextResult,
	encodeProjectPath,
	formatGlLabels,
	formatGlUser,
	formatGlUsers,
	glabApiJson,
	glabApiPaginated,
	parseCanonicalGitlabProject,
	parseGitlabIssueUrl,
	resolveGitlabProject,
} from "./gl-common";
import type {
	GitlabInput,
	GlApprovalsApi,
	GlDiscussionApi,
	GlFileApi,
	GlIssueApi,
	GlMrApi,
	GlNoteApi,
	GlNotePositionApi,
	GlProjectApi,
} from "./gl-types";
import type { ToolSession } from ".";
import { ToolAbortError } from "./tool-errors";

const README_MAX_CHARS = 4000;

export interface GlMrViewPayload {
	state?: string;
	mr: GlMrApi;
	approvals?: GlApprovalsApi;
	discussions?: GlDiscussionApi[];
}

export interface GlIssueViewPayload {
	state?: string;
	issue: GlIssueApi;
	notes?: GlNoteApi[];
}

export interface MrViewLookupOptions {
	cwd: string;
	/** `<host>/<namespace…>/<project>`. */
	project: string;
	iid: number;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

function extractReadmePath(readmeUrl: string | null | undefined): string {
	if (!readmeUrl) return "README.md";
	try {
		const url = new URL(readmeUrl);
		const segments = url.pathname.split("/").filter(Boolean);
		const blobIdx = segments.indexOf("blob");
		if (blobIdx >= 0 && blobIdx + 2 < segments.length) {
			const fileSegments = segments.slice(blobIdx + 2);
			if (fileSegments.every(segment => GITLAB_PATH_SEGMENT_PATTERN.test(segment))) {
				return fileSegments.join("/");
			}
		}
	} catch {
		// Fall back to README.md when readme_url is malformed.
	}
	return "README.md";
}

export function formatRepoView(data: GlProjectApi, input: { repo: string; ref?: string; readme?: string }): string {
	const lines: string[] = [];
	lines.push(`# ${data.path_with_namespace ?? input.repo}`);
	lines.push("");
	lines.push(normalizeText(data.description) || "No description provided.");
	lines.push("");
	pushLine(lines, "URL", data.web_url);
	pushLine(lines, "Visibility", data.visibility);
	pushLine(lines, "Default branch", data.default_branch ?? undefined);
	pushLine(lines, "Ref", normalizeOptionalString(input.ref));
	pushLine(lines, "Stars", data.star_count);
	pushLine(lines, "Forks", data.forks_count);
	pushLine(lines, "Open issues", data.open_issues_count);
	pushLine(lines, "Archived", data.archived);
	const topics = formatGlLabels(data.topics?.length ? data.topics : data.tag_list);
	pushLine(lines, "Topics", topics);
	pushLine(lines, "SSH URL", data.ssh_url_to_repo);
	pushLine(lines, "HTTP URL", data.http_url_to_repo);
	pushLine(lines, "Last activity", data.last_activity_at);

	if (input.readme) {
		lines.push("");
		lines.push("## README");
		lines.push("");
		lines.push(input.readme);
	}

	return lines.join("\n").trim();
}

export async function executeRepoView(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const ref = await resolveGitlabProject(session.cwd, normalizeOptionalString(params.repo), undefined, signal);
	const data = await glabApiJson<GlProjectApi>(
		session.cwd,
		ref.host,
		`projects/${encodeProjectPath(ref.path)}`,
		undefined,
		signal,
	);
	const requestedRef = normalizeOptionalString(params.ref);
	const targetRef = requestedRef ?? data.default_branch ?? undefined;

	let readmeText: string | undefined;
	const readmePath = extractReadmePath(data.readme_url);
	try {
		const file = await glabApiJson<GlFileApi>(
			session.cwd,
			ref.host,
			`projects/${encodeProjectPath(ref.path)}/repository/files/${encodeURIComponent(readmePath)}`,
			{ query: targetRef ? { ref: targetRef } : undefined },
			signal,
		);
		if (file.encoding === "base64" && typeof file.content === "string") {
			const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
				Buffer.from(file.content.replaceAll(/\s/g, ""), "base64"),
			);
			const normalized = decoded.trim();
			if (normalized) {
				readmeText =
					normalized.length > README_MAX_CHARS
						? `${normalized.slice(0, README_MAX_CHARS)}\n\n[…README truncated…]`
						: normalized;
			}
		}
	} catch (err) {
		if (err instanceof ToolAbortError) throw err;
		logger.debug("gl: ignoring README fetch error in repo_view", { repo: ref.full, err: String(err) });
	}

	const canonicalRepo = (data.web_url ? parseGitlabProjectWebUrl(data.web_url) : undefined) ?? ref.full;
	return buildGlTextResult(
		formatRepoView(data, { repo: canonicalRepo, ref: requestedRef, readme: readmeText }),
		data.web_url,
		{
			repo: canonicalRepo,
			branch: targetRef,
		},
	);
}

export function formatDiscussionPosition(position: GlNotePositionApi | null | undefined): string | undefined {
	if (!position) return undefined;
	const isOldOnly = position.new_line == null && position.old_line != null;
	const filePath = isOldOnly ? position.old_path || position.new_path : position.new_path || position.old_path;
	if (!filePath) return undefined;
	const line = position.new_line ?? position.old_line;
	return line != null ? `${filePath}:${line}` : filePath;
}

export function isDiscussionUnresolved(discussion: GlDiscussionApi): boolean {
	return (discussion.notes ?? []).some(note => !note.system && note.resolvable === true && note.resolved !== true);
}

export function isDiscussionResolved(discussion: GlDiscussionApi): boolean {
	const resolvableNotes = (discussion.notes ?? []).filter(note => !note.system && note.resolvable === true);
	return resolvableNotes.length > 0 && resolvableNotes.every(note => note.resolved === true);
}

export function formatMrDiscussionsList(
	discussions: readonly GlDiscussionApi[],
	options?: { unresolvedOnly?: boolean; includeSystem?: boolean },
): string[] {
	const includeSystem = options?.includeSystem ?? false;
	let filtered = includeSystem
		? [...discussions]
		: discussions.filter(discussion => (discussion.notes ?? []).some(note => !note.system));
	if (options?.unresolvedOnly) {
		filtered = filtered.filter(isDiscussionUnresolved);
	}
	if (filtered.length === 0) return [];

	const lines: string[] = [];
	for (const discussion of filtered) {
		const notes = (discussion.notes ?? []).filter(note => includeSystem || !note.system);
		if (notes.length === 0) continue;

		const hasResolvable = notes.some(note => note.resolvable === true);
		const badge = hasResolvable ? (isDiscussionUnresolved(discussion) ? "[UNRESOLVED]" : "[RESOLVED]") : "[note]";
		const id = discussion.id ?? "unknown";
		const shortId = id.slice(0, 8);
		lines.push(`### ${badge} Discussion \`${id}\` (${shortId})`);

		const location = notes.map(note => formatDiscussionPosition(note.position)).find(Boolean);
		if (location) {
			lines.push(`Location: ${location}`);
		}

		for (const note of notes) {
			const author = formatGlUser(note.author) ?? "unknown";
			const createdAt = note.created_at ? ` · ${note.created_at}` : "";
			const tags = `${note.internal ? " [internal]" : ""}${note.system ? " [system]" : ""}`;
			lines.push("");
			lines.push(`- **${author}**${createdAt}${tags}`);
			lines.push(`  ${normalizeText(note.body) || "No comment body."}`);
		}
		lines.push("");
	}
	return lines;
}

export function formatMrView(payload: GlMrViewPayload, options?: { unresolvedOnly?: boolean }): string {
	const { mr, approvals, discussions } = payload;
	const lines: string[] = [];
	const iid = mr.iid ?? "?";
	const isDraft = Boolean(mr.draft || mr.work_in_progress);
	lines.push(`# Merge Request !${iid}: ${mr.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", `${mr.state ?? "unknown"}${isDraft ? " [draft]" : ""}`);
	pushLine(lines, "Branch", `${mr.source_branch ?? "?"} → ${mr.target_branch ?? "?"}`);
	pushLine(lines, "Author", formatGlUser(mr.author));
	pushLine(lines, "Assignees", formatGlUsers(mr.assignees));
	pushLine(lines, "Reviewers", formatGlUsers(mr.reviewers));
	pushLine(lines, "Labels", formatGlLabels(mr.labels));
	pushLine(lines, "Milestone", mr.milestone?.title);
	pushLine(lines, "Merge status", mr.detailed_merge_status ?? mr.merge_status);
	if (mr.has_conflicts !== undefined) pushLine(lines, "Conflicts", mr.has_conflicts);
	if (mr.blocking_discussions_resolved !== undefined) {
		pushLine(lines, "Blocking discussions resolved", mr.blocking_discussions_resolved);
	}
	if (approvals) {
		const approvers = (approvals.approved_by ?? [])
			.map(entry => formatGlUser(entry.user))
			.filter((value): value is string => Boolean(value));
		const approvedCount = approvers.length;
		const reqText = approvals.approvals_required !== undefined ? ` / ${approvals.approvals_required} required` : "";
		const whoText = approvers.length > 0 ? ` (${approvers.join(", ")})` : "";
		pushLine(lines, "Approvals", `${approvedCount}${reqText}${whoText}`);
	}
	const headPipeline = mr.head_pipeline ?? mr.pipeline;
	if (headPipeline?.id !== undefined) {
		const urlPart = headPipeline.web_url ? ` ${headPipeline.web_url}` : "";
		pushLine(lines, "Head pipeline", `#${headPipeline.id} [${headPipeline.status ?? "unknown"}]${urlPart}`);
	}
	pushLine(lines, "Created", mr.created_at);
	pushLine(lines, "Updated", mr.updated_at);
	pushLine(lines, "URL", mr.web_url);
	lines.push("");
	lines.push("## Description");
	lines.push("");
	lines.push(normalizeText(mr.description) || "No description provided.");

	if (discussions !== undefined) {
		const renderedDiscussions = formatMrDiscussionsList(discussions, { unresolvedOnly: options?.unresolvedOnly });
		const visibleCount = renderedDiscussions.filter(line => line.startsWith("### ")).length;
		lines.push("");
		if (options?.unresolvedOnly) {
			lines.push(visibleCount > 0 ? `## Unresolved Discussions (${visibleCount})` : "## Unresolved Discussions");
		} else {
			lines.push(visibleCount > 0 ? `## Discussions (${visibleCount})` : "## Discussions");
		}
		lines.push("");
		if (renderedDiscussions.length === 0) {
			lines.push(options?.unresolvedOnly ? "No unresolved discussions." : "No discussions.");
		} else {
			lines.push(...renderedDiscussions);
		}
	}

	return lines.join("\n").trim();
}

export async function fetchMrViewFresh(
	cwd: string,
	project: string,
	iid: number,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GlMrViewPayload }> {
	const ref = parseCanonicalGitlabProject(project);
	const encodedPath = encodeProjectPath(ref.path);
	const mr = await glabApiJson<GlMrApi>(
		cwd,
		ref.host,
		`projects/${encodedPath}/merge_requests/${iid}`,
		undefined,
		signal,
	);

	let approvals: GlApprovalsApi | undefined;
	try {
		approvals = await glabApiJson<GlApprovalsApi>(
			cwd,
			ref.host,
			`projects/${encodedPath}/merge_requests/${iid}/approvals`,
			undefined,
			signal,
		);
	} catch (err) {
		if (err instanceof ToolAbortError) throw err;
		logger.debug("gl: approvals endpoint unavailable for MR view", { project, iid, err: String(err) });
	}

	let discussions: GlDiscussionApi[] | undefined;
	if (includeComments) {
		discussions = await glabApiPaginated<GlDiscussionApi>(
			cwd,
			ref.host,
			`projects/${encodedPath}/merge_requests/${iid}/discussions`,
			{},
			10,
			signal,
		);
	}

	const payload: GlMrViewPayload = { state: mr.state, mr, approvals, discussions };
	return { rendered: formatMrView(payload), sourceUrl: mr.web_url, payload };
}

export async function getOrFetchMr(options: MrViewLookupOptions): Promise<ViewLookupResult<GlMrViewPayload>> {
	const ref = parseCanonicalGitlabProject(options.project);
	await assertGitlabHostTrustedForEnvToken(ref.host, options.cwd, options.signal);
	const includeComments = options.includeComments ?? true;
	const authKey =
		options.cacheAuthKey === undefined ? (resolveGitlabCacheAuthKey(ref.host) ?? null) : options.cacheAuthKey;
	const lookup = await getOrFetchView<GlMrViewPayload>({
		repo: options.project,
		kind: "mr",
		number: options.iid,
		includeComments,
		settings: options.settings,
		authKey,
		fetchFresh: () => fetchMrViewFresh(options.cwd, options.project, options.iid, includeComments, options.signal),
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

export function formatIssueView(payload: GlIssueViewPayload): string {
	const { issue, notes } = payload;
	const lines: string[] = [];
	lines.push(`# Issue #${issue.iid ?? "?"}: ${issue.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", issue.state);
	pushLine(lines, "Type", issue.issue_type);
	if (issue.confidential) pushLine(lines, "Confidential", true);
	pushLine(lines, "Author", formatGlUser(issue.author));
	pushLine(lines, "Assignees", formatGlUsers(issue.assignees));
	pushLine(lines, "Labels", formatGlLabels(issue.labels));
	pushLine(lines, "Milestone", issue.milestone?.title);
	pushLine(lines, "Created", issue.created_at);
	pushLine(lines, "Updated", issue.updated_at);
	pushLine(lines, "URL", issue.web_url);
	lines.push("");
	lines.push("## Description");
	lines.push("");
	lines.push(normalizeText(issue.description) || "No description provided.");

	const visibleNotes = (notes ?? []).filter(note => !note.system);
	if (visibleNotes.length > 0) {
		lines.push("");
		lines.push(`## Comments (${visibleNotes.length})`);
		lines.push("");
		for (const note of visibleNotes) {
			const author = formatGlUser(note.author) ?? "unknown";
			const createdAt = note.created_at ? ` · ${note.created_at}` : "";
			const tags = note.internal ? " [internal]" : "";
			lines.push(`### ${author}${createdAt}${tags}`);
			lines.push("");
			lines.push(normalizeText(note.body) || "No comment body.");
			lines.push("");
		}
	}

	return lines.join("\n").trim();
}

export async function executeIssueView(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const identifier = requireNonEmpty(normalizeOptionalString(params.issue), "issue");
	if (identifier.startsWith("-")) {
		throw new ToolError(`Invalid issue identifier '${identifier}'. Pass an issue IID, #IID, or URL.`);
	}
	const urlParsed = parseGitlabIssueUrl(identifier);
	const ref = await resolveGitlabProject(session.cwd, normalizeOptionalString(params.repo), urlParsed.project, signal);
	const iid = urlParsed.iid ?? parsePositiveDecimalInt(identifier.replace(/^#/, ""));
	if (iid === undefined) {
		throw new ToolError(`Invalid GitLab issue identifier '${identifier}'. Pass an issue IID, #IID, or URL.`);
	}

	const authKey = resolveGitlabCacheAuthKey(ref.host) ?? null;
	const encodedPath = encodeProjectPath(ref.path);
	const lookup = await getOrFetchView<GlIssueViewPayload>({
		repo: ref.full,
		kind: "gl-issue",
		number: iid,
		includeComments: true,
		settings: session.settings,
		authKey,
		fetchFresh: async () => {
			const [issue, notes] = await Promise.all([
				glabApiJson<GlIssueApi>(session.cwd, ref.host, `projects/${encodedPath}/issues/${iid}`, undefined, signal),
				glabApiPaginated<GlNoteApi>(
					session.cwd,
					ref.host,
					`projects/${encodedPath}/issues/${iid}/notes`,
					{ sort: "asc" },
					10,
					signal,
				),
			]);
			const payload: GlIssueViewPayload = { state: issue.state, issue, notes };
			return { rendered: formatIssueView(payload), sourceUrl: issue.web_url, payload };
		},
	});

	const content =
		lookup.status === "stale"
			? `> WARNING: Live GitLab refresh failed; this issue content is cached and may be stale.\n\n${lookup.rendered}`
			: lookup.rendered;
	return buildGlTextResult(content, lookup.sourceUrl, { repo: ref.full });
}
