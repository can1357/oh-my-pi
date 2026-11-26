import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { pushLine } from "./gh-format";
import type { GlToolDetails } from "./details/gitlab";
import { ToolError } from "./tool-errors";
import { logger } from "@oh-my-pi/pi-utils";
import { gitlab } from "../utils/gitlab";
import { normalizeBlock, normalizeOptionalString, requireNonEmpty } from "./gh-common";
import { formatGitlabProjectArg } from "./glab-mr";
import { invalidateAllForNumber } from "./github-cache";
import {
	buildGlTextResult,
	encodeProjectPath,
	formatGlLabels,
	formatGlUser,
	formatGlUsers,
	glabApiJson,
	glabApiPaginated,
	parseCanonicalGitlabProject,
	parseGitlabMrUrl,
	resolveGitlabMrIid,
	resolveGitlabProject,
	requireSingleMrIdentifier,
	type GitlabProjectRef,
} from "./gl-common";
import type { GitlabInput, GlDiscussionApi, GlMrApi, GlNoteApi } from "./gl-types";
import { formatMrDiscussionsList, isDiscussionResolved, isDiscussionUnresolved } from "./gl-view";
import type { ToolSession } from ".";
import { ToolAbortError } from "./tool-errors";

const ALLOWED_DISCUSSION_STATES = new Set(["unresolved", "resolved", "all"]);
const ALLOWED_NOTE_TYPES = new Set(["diff", "general", "system", "all"]);

function appendRepeatedFlag(args: string[], flag: string, values: readonly string[] | undefined): void {
	for (const raw of values ?? []) {
		const trimmed = raw.trim();
		if (trimmed) args.push(flag, trimmed);
	}
}

function formatMrSummary(heading: string, mr: GlMrApi): string {
	const lines: string[] = [heading, ""];
	const isDraft = Boolean(mr.draft || mr.work_in_progress);
	pushLine(lines, "IID", mr.iid !== undefined ? `!${mr.iid}` : undefined);
	pushLine(lines, "Title", mr.title);
	pushLine(lines, "State", mr.state ? `${mr.state}${isDraft ? " [draft]" : ""}` : undefined);
	if (mr.source_branch || mr.target_branch) {
		pushLine(lines, "Branch", `${mr.source_branch ?? "?"} → ${mr.target_branch ?? "?"}`);
	}
	pushLine(lines, "Author", formatGlUser(mr.author));
	pushLine(lines, "Assignees", formatGlUsers(mr.assignees));
	pushLine(lines, "Reviewers", formatGlUsers(mr.reviewers));
	pushLine(lines, "Labels", formatGlLabels(mr.labels));
	if (mr.remove_source_branch !== undefined) pushLine(lines, "Remove source branch", mr.remove_source_branch);
	if (mr.squash !== undefined) pushLine(lines, "Squash", mr.squash);
	pushLine(lines, "URL", mr.web_url);
	return lines.join("\n").trim();
}

export async function executeMrCreate(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const explicitRepo = normalizeOptionalString(params.repo);
	const fill = params.fill === true;
	const title = normalizeOptionalString(params.title);
	const body = params.body;

	if (!fill && !title) {
		throw new ToolError("title is required unless fill is true");
	}
	if (fill && (title || body !== undefined)) {
		throw new ToolError("fill is mutually exclusive with title and body");
	}

	const ref = explicitRepo ? await resolveGitlabProject(session.cwd, explicitRepo, undefined, signal) : undefined;

	const args = ["mr", "create", "--push=false", "--yes"];
	if (ref) {
		args.push("-R", formatGitlabProjectArg(ref.full));
	}
	const sourceBranch = normalizeOptionalString(params.sourceBranch);
	const targetBranch = normalizeOptionalString(params.targetBranch);
	if (sourceBranch) args.push("--source-branch", sourceBranch);
	if (targetBranch) args.push("--target-branch", targetBranch);
	if (params.draft === true) args.push("--draft");
	if (fill) {
		args.push("--fill");
	} else if (title) {
		args.push("--title", title);
	}
	if (params.removeSourceBranch !== undefined) {
		args.push(`--remove-source-branch=${String(params.removeSourceBranch)}`);
	}
	if (params.squash !== undefined) {
		args.push(`--squash-before-merge=${String(params.squash)}`);
	}
	appendRepeatedFlag(args, "--reviewer", params.reviewer);
	appendRepeatedFlag(args, "--assignee", params.assignee);
	appendRepeatedFlag(args, "--label", params.label);

	let tempDir: string | undefined;
	let output: string;
	try {
		if (!fill) {
			const normalizedBody = normalizeBlock(body);
			if (normalizedBody.length > 0) {
				tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gl-mr-body-"));
				const bodyPath = path.join(tempDir, "body.md");
				await Bun.write(bodyPath, normalizedBody);
				args.push("--description-file", bodyPath);
			} else {
				args.push("--description", "");
			}
		}
		output = await gitlab.text(session.cwd, args, signal);
	} finally {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	const urlMatch = /https?:\/\/[^\s<>"']+\/-\/merge_requests\/\d+(?:[/?#][^\s<>"']*)?/i.exec(output);
	const parsedUrl = parseGitlabMrUrl(urlMatch?.[0]);
	const targetRef = ref ?? (parsedUrl.project ? parseCanonicalGitlabProject(parsedUrl.project) : undefined);

	if (targetRef && parsedUrl.iid !== undefined) {
		invalidateAllForNumber(parsedUrl.iid, targetRef.full);
		try {
			const mr = await glabApiJson<GlMrApi>(
				session.cwd,
				targetRef.host,
				`projects/${encodeProjectPath(targetRef.path)}/merge_requests/${parsedUrl.iid}`,
				undefined,
				signal,
			);
			return buildGlTextResult(formatMrSummary(`# Created Merge Request !${parsedUrl.iid}`, mr), mr.web_url, {
				repo: targetRef.full,
				branch: mr.source_branch,
			});
		} catch (err) {
			if (err instanceof ToolAbortError) throw err;
			logger.debug("gl: post-create MR lookup failed; returning CLI output", { err: String(err) });
		}
	}

	return buildGlTextResult(output.trim() || "Merge request created.", urlMatch?.[0], {
		repo: targetRef?.full,
		branch: sourceBranch,
	});
}

export async function executeMrUpdate(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const mrStr = requireSingleMrIdentifier(params.mr, "mr_update");
	const urlParsed = parseGitlabMrUrl(mrStr);
	const ref = await resolveGitlabProject(session.cwd, normalizeOptionalString(params.repo), urlParsed.project, signal);
	const iid = await resolveGitlabMrIid(session.cwd, ref, mrStr, signal);

	const title = normalizeOptionalString(params.title);
	const targetBranch = normalizeOptionalString(params.targetBranch);
	const hasBody = params.body !== undefined;
	const normalizedBody = hasBody ? normalizeBlock(params.body) : undefined;
	const clearingBody = hasBody && normalizedBody === "";
	const hasNonEmptyBody = hasBody && normalizedBody !== undefined && normalizedBody.length > 0;
	const hasDraft = params.draft !== undefined;
	const hasReviewers = (params.reviewer?.filter(v => v.trim().length > 0).length ?? 0) > 0;
	const hasAssignees = (params.assignee?.filter(v => v.trim().length > 0).length ?? 0) > 0;
	const hasLabels = (params.label?.filter(v => v.trim().length > 0).length ?? 0) > 0;
	const hasApiUpdates = clearingBody || params.removeSourceBranch !== undefined || params.squash !== undefined;
	const hasCliUpdates = Boolean(
		title || hasNonEmptyBody || hasDraft || targetBranch || hasReviewers || hasAssignees || hasLabels,
	);

	if (!hasCliUpdates && !hasApiUpdates) {
		throw new ToolError("mr_update requires at least one field to update.");
	}

	if (hasCliUpdates) {
		const args = ["mr", "update", String(iid), "-R", formatGitlabProjectArg(ref.full), "--yes"];
		if (title) args.push("--title", title);
		if (params.draft === true) args.push("--draft");
		else if (params.draft === false) args.push("--ready");
		if (targetBranch) args.push("--target-branch", targetBranch);
		appendRepeatedFlag(args, "--reviewer", params.reviewer);
		appendRepeatedFlag(args, "--assignee", params.assignee);
		appendRepeatedFlag(args, "--label", params.label);

		let tempDir: string | undefined;
		try {
			if (hasNonEmptyBody && normalizedBody) {
				tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gl-mr-update-"));
				const bodyPath = path.join(tempDir, "body.md");
				await Bun.write(bodyPath, normalizedBody);
				args.push("--description-file", bodyPath);
			}
			await gitlab.text(session.cwd, args, signal);
		} finally {
			if (tempDir) {
				await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
			}
		}
		invalidateAllForNumber(iid, ref.full);
	}

	let latestMr: GlMrApi | undefined;
	if (hasApiUpdates) {
		latestMr = await glabApiJson<GlMrApi>(
			session.cwd,
			ref.host,
			`projects/${encodeProjectPath(ref.path)}/merge_requests/${iid}`,
			{
				method: "PUT",
				jsonBody: {
					...(clearingBody ? { description: "" } : {}),
					...(params.removeSourceBranch !== undefined ? { remove_source_branch: params.removeSourceBranch } : {}),
					...(params.squash !== undefined ? { squash: params.squash } : {}),
				},
			},
			signal,
		);
		invalidateAllForNumber(iid, ref.full);
	} else {
		latestMr = await glabApiJson<GlMrApi>(
			session.cwd,
			ref.host,
			`projects/${encodeProjectPath(ref.path)}/merge_requests/${iid}`,
			undefined,
			signal,
		);
	}

	return buildGlTextResult(formatMrSummary(`# Updated Merge Request !${iid}`, latestMr), latestMr.web_url, {
		repo: ref.full,
		branch: latestMr.source_branch,
	});
}

export async function executeMrDiscussions(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const mrStr = requireSingleMrIdentifier(params.mr, "mr_discussions");
	const urlParsed = parseGitlabMrUrl(mrStr);
	const ref = await resolveGitlabProject(session.cwd, normalizeOptionalString(params.repo), urlParsed.project, signal);
	const iid = await resolveGitlabMrIid(session.cwd, ref, mrStr, signal);

	if (params.state !== undefined && !ALLOWED_DISCUSSION_STATES.has(params.state)) {
		throw new ToolError(`Invalid discussion state '${params.state}'. Expected unresolved, resolved, or all.`);
	}
	if (params.noteType !== undefined && !ALLOWED_NOTE_TYPES.has(params.noteType)) {
		throw new ToolError(`Invalid noteType '${params.noteType}'. Expected diff, general, system, or all.`);
	}

	const discussions = await glabApiPaginated<GlDiscussionApi>(
		session.cwd,
		ref.host,
		`projects/${encodeProjectPath(ref.path)}/merge_requests/${iid}/discussions`,
		{},
		10,
		signal,
	);

	const noteType = params.noteType;
	const stateFilter = params.state ?? "all";
	const pathFilter = normalizeOptionalString(params.path);

	const filtered = discussions.filter(discussion => {
		const notes = discussion.notes ?? [];
		if (noteType === undefined) {
			if (!notes.some(note => !note.system)) return false;
		} else if (noteType === "diff") {
			if (!notes.some(note => !note.system && note.type === "DiffNote")) return false;
		} else if (noteType === "general") {
			if (!notes.some(note => !note.system && note.type !== "DiffNote")) return false;
		} else if (noteType === "system") {
			if (!notes.some(note => note.system === true)) return false;
		}

		if (stateFilter === "unresolved" && !isDiscussionUnresolved(discussion)) return false;
		if (stateFilter === "resolved" && !isDiscussionResolved(discussion)) return false;

		if (pathFilter) {
			const matchesPath = notes.some(
				note => note.position?.new_path === pathFilter || note.position?.old_path === pathFilter,
			);
			if (!matchesPath) return false;
		}
		return true;
	});

	const nonSystem = discussions.filter(discussion => (discussion.notes ?? []).some(note => !note.system));
	const unresolvedCount = nonSystem.filter(isDiscussionUnresolved).length;
	const resolvedCount = nonSystem.filter(isDiscussionResolved).length;

	const headerLines = [
		`# Discussions on ${ref.full}!${iid}`,
		"",
		`Summary: ${unresolvedCount} unresolved, ${resolvedCount} resolved (${filtered.length} shown)`,
	];
	if (noteType) pushLine(headerLines, "Note type", noteType);
	if (stateFilter !== "all") pushLine(headerLines, "State filter", stateFilter);
	if (pathFilter) pushLine(headerLines, "Path filter", pathFilter);

	const includeSystem = noteType === "system" || noteType === "all";
	const formatted = formatMrDiscussionsList(filtered, { includeSystem });
	if (formatted.length === 0) {
		headerLines.push("", "No matching discussions found.");
	} else {
		headerLines.push("", ...formatted);
	}

	const sourceUrl = `https://${ref.host}/${ref.path}/-/merge_requests/${iid}`;
	return buildGlTextResult(headerLines.join("\n").trim(), sourceUrl, { repo: ref.full });
}

async function resolveDiscussionId(
	cwd: string,
	ref: GitlabProjectRef,
	iid: number,
	idOrPrefix: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const trimmed = idOrPrefix.trim();
	if (trimmed.length >= 40) return trimmed;
	if (trimmed.length < 8) {
		throw new ToolError("discussionId prefix must be at least 8 characters (or pass the full discussion ID).");
	}
	const discussions = await glabApiPaginated<GlDiscussionApi>(
		cwd,
		ref.host,
		`projects/${encodeProjectPath(ref.path)}/merge_requests/${iid}/discussions`,
		{},
		10,
		signal,
	);
	const matches = discussions.filter(discussion => discussion.id?.startsWith(trimmed));
	if (matches.length === 0) {
		throw new ToolError(`No discussion matching prefix '${trimmed}' found on ${ref.full}!${iid}.`);
	}
	if (matches.length > 1) {
		throw new ToolError(
			`Ambiguous discussionId prefix '${trimmed}' matched ${matches.length} discussions; pass more characters or the full ID.`,
		);
	}
	return matches[0]!.id!;
}

export async function executeMrNote(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const body = requireNonEmpty(normalizeBlock(params.body), "body");
	const discussionIdInput = normalizeOptionalString(params.discussionId);
	const notePath = normalizeOptionalString(params.path);
	const hasLine = params.line !== undefined;
	const hasOldLine = params.oldLine !== undefined;

	if (
		discussionIdInput &&
		(notePath || hasLine || hasOldLine || params.resolvable === false || params.internal === true)
	) {
		throw new ToolError(
			"discussionId cannot be combined with path, line, oldLine, internal=true, or resolvable=false.",
		);
	}
	if ((hasLine || hasOldLine) && !notePath) {
		throw new ToolError("path is required when line or oldLine is specified.");
	}
	if (notePath && (params.internal === true || params.resolvable === false)) {
		throw new ToolError("Diff comments cannot be internal or non-resolvable.");
	}
	if (params.line !== undefined && (!Number.isInteger(params.line) || params.line <= 0)) {
		throw new ToolError("line must be a positive integer.");
	}
	if (params.oldLine !== undefined && (!Number.isInteger(params.oldLine) || params.oldLine <= 0)) {
		throw new ToolError("oldLine must be a positive integer.");
	}

	const mrStr = requireSingleMrIdentifier(params.mr, "mr_note");
	const urlParsed = parseGitlabMrUrl(mrStr);
	const ref = await resolveGitlabProject(session.cwd, normalizeOptionalString(params.repo), urlParsed.project, signal);
	const iid = await resolveGitlabMrIid(session.cwd, ref, mrStr, signal);
	const encodedPath = encodeProjectPath(ref.path);
	const mrUrl = `https://${ref.host}/${ref.path}/-/merge_requests/${iid}`;

	let noteId: number | undefined;
	let discussionId: string | undefined;
	let modeLabel: string;

	if (discussionIdInput) {
		const fullId = await resolveDiscussionId(session.cwd, ref, iid, discussionIdInput, signal);
		const note = await glabApiJson<GlNoteApi>(
			session.cwd,
			ref.host,
			`projects/${encodedPath}/merge_requests/${iid}/discussions/${encodeURIComponent(fullId)}/notes`,
			{ method: "POST", jsonBody: { body } },
			signal,
		);
		discussionId = fullId;
		noteId = note.id;
		modeLabel = "Replied to discussion";
	} else if (notePath) {
		const [mr, mrDiffs] = await Promise.all([
			glabApiJson<GlMrApi>(
				session.cwd,
				ref.host,
				`projects/${encodedPath}/merge_requests/${iid}`,
				undefined,
				signal,
			),
			glabApiPaginated<{ old_path?: string; new_path?: string }>(
				session.cwd,
				ref.host,
				`projects/${encodedPath}/merge_requests/${iid}/diffs`,
				{},
				10,
				signal,
			).catch(err => {
				if (err instanceof ToolAbortError) throw err;
				logger.debug("gl: ignoring MR diffs lookup while resolving diff comment path", { err: String(err) });
				return [] as Array<{ old_path?: string; new_path?: string }>;
			}),
		]);
		const diffRefs = mr.diff_refs;
		if (!diffRefs?.base_sha || !diffRefs.start_sha || !diffRefs.head_sha) {
			throw new ToolError(`MR !${iid} has no diff_refs; cannot post a diff comment.`);
		}
		const matchedDiff = hasOldLine
			? (mrDiffs.find(d => d.old_path === notePath) ?? mrDiffs.find(d => d.new_path === notePath))
			: (mrDiffs.find(d => d.new_path === notePath) ?? mrDiffs.find(d => d.old_path === notePath));
		const oldPath = matchedDiff?.old_path || notePath;
		const newPath = matchedDiff?.new_path || notePath;
		const position: Record<string, unknown> = {
			position_type: hasLine || hasOldLine ? "text" : "file",
			base_sha: diffRefs.base_sha,
			start_sha: diffRefs.start_sha,
			head_sha: diffRefs.head_sha,
			old_path: oldPath,
			new_path: newPath,
			...(params.line !== undefined ? { new_line: params.line } : {}),
			...(params.oldLine !== undefined ? { old_line: params.oldLine } : {}),
		};
		const discussion = await glabApiJson<GlDiscussionApi>(
			session.cwd,
			ref.host,
			`projects/${encodedPath}/merge_requests/${iid}/discussions`,
			{ method: "POST", jsonBody: { body, position } },
			signal,
		);
		discussionId = discussion.id;
		noteId = discussion.notes?.[0]?.id;
		modeLabel = "Posted diff comment";
	} else if (params.resolvable === false || params.internal === true) {
		const note = await glabApiJson<GlNoteApi>(
			session.cwd,
			ref.host,
			`projects/${encodedPath}/merge_requests/${iid}/notes`,
			{
				method: "POST",
				jsonBody: {
					body,
					...(params.internal === true ? { internal: true } : {}),
				},
			},
			signal,
		);
		noteId = note.id;
		modeLabel = params.internal ? "Posted internal note" : "Posted note";
	} else {
		const discussion = await glabApiJson<GlDiscussionApi>(
			session.cwd,
			ref.host,
			`projects/${encodedPath}/merge_requests/${iid}/discussions`,
			{ method: "POST", jsonBody: { body } },
			signal,
		);
		discussionId = discussion.id;
		noteId = discussion.notes?.[0]?.id;
		modeLabel = "Posted discussion";
	}

	invalidateAllForNumber(iid, ref.full);

	const lines = [`# ${modeLabel} on ${ref.full}!${iid}`, ""];
	pushLine(lines, "Note ID", noteId);
	pushLine(lines, "Discussion ID", discussionId);
	if (notePath) {
		const lineSuffix =
			params.line !== undefined ? `:${params.line}` : params.oldLine !== undefined ? `:${params.oldLine} (old)` : "";
		pushLine(lines, "Location", `${notePath}${lineSuffix}`);
	}
	pushLine(lines, "MR URL", mrUrl);
	return buildGlTextResult(lines.join("\n").trim(), mrUrl, { repo: ref.full });
}

export async function executeMrDiscussionResolve(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const discussionIdInput = requireNonEmpty(normalizeOptionalString(params.discussionId), "discussionId");
	const resolved = params.resolved ?? true;
	const mrStr = requireSingleMrIdentifier(params.mr, "mr_discussion_resolve");
	const urlParsed = parseGitlabMrUrl(mrStr);
	const ref = await resolveGitlabProject(session.cwd, normalizeOptionalString(params.repo), urlParsed.project, signal);
	const iid = await resolveGitlabMrIid(session.cwd, ref, mrStr, signal);
	const fullId = await resolveDiscussionId(session.cwd, ref, iid, discussionIdInput, signal);

	await glabApiJson<GlDiscussionApi>(
		session.cwd,
		ref.host,
		`projects/${encodeProjectPath(ref.path)}/merge_requests/${iid}/discussions/${encodeURIComponent(fullId)}`,
		{ method: "PUT", jsonBody: { resolved } },
		signal,
	);

	invalidateAllForNumber(iid, ref.full);
	const mrUrl = `https://${ref.host}/${ref.path}/-/merge_requests/${iid}`;
	const action = resolved ? "Resolved" : "Reopened";
	const lines = [
		`# ${action} Discussion on ${ref.full}!${iid}`,
		"",
		`Discussion ID: \`${fullId}\``,
		`Resolved: ${resolved}`,
		`MR URL: ${mrUrl}`,
	];
	return buildGlTextResult(lines.join("\n"), mrUrl, { repo: ref.full });
}
