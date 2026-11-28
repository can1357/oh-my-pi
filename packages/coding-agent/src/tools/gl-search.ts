import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { formatShortSha, pushLine } from "./gh-format";
import type { GlToolDetails } from "./details/gitlab";
import { ToolError } from "./tool-errors";
import { normalizeOptionalString, normalizeText, requireNonEmpty } from "./gh-common";
import { FIXED_UNIT_MS, parseSearchDateBound, RELATIVE_DURATION_PATTERN, resolveSearchLimit } from "./gh-search";
import { assertGitlabHostTrustedForEnvToken, resolveDefaultGitlabProjectMemoized } from "./glab-mr";
import {
	buildGlTextResult,
	defaultGitlabHost,
	encodeProjectPath,
	formatGlLabels,
	formatGlUser,
	glabApiJson,
	hasExplicitGitlabHost,
	parseCanonicalGitlabProject,
	parseGitlabGroupRef,
	resolveGitlabProject,
	type GitlabProjectRef,
} from "./gl-common";
import type {
	GitlabInput,
	GlIssueApi,
	GlMrApi,
	GlProjectApi,
	GlSearchCodeItemApi,
	GlSearchCommitItemApi,
} from "./gl-types";
import type { ToolSession } from ".";
import { ToolAbortError } from "./tool-errors";

const ALLOWED_MR_STATES = new Set(["opened", "closed", "merged", "all"]);
const ALLOWED_ISSUE_STATES = new Set(["opened", "closed", "all"]);
const ISO_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type SearchScope =
	| { host: string; scope: "project"; ref: GitlabProjectRef }
	| { host: string; scope: "group"; ref: GitlabProjectRef }
	| { host: string; scope: "global"; ref?: undefined };

export function toGitlabIsoDateBound(raw: string, boundary: "start" | "end", now: Date = new Date()): string {
	const trimmed = raw.trim();
	const relMatch = RELATIVE_DURATION_PATTERN.exec(trimmed);
	if (relMatch) {
		const count = Number(relMatch[1]);
		const unit = relMatch[2]!.toLowerCase();
		const fixedMs = FIXED_UNIT_MS[unit];
		let bound: Date;
		if (fixedMs !== undefined) {
			bound = new Date(now.getTime() - count * fixedMs);
		} else {
			bound = new Date(now);
			if (unit === "mo") {
				bound.setUTCMonth(bound.getUTCMonth() - count);
			} else {
				bound.setUTCFullYear(bound.getUTCFullYear() - count);
			}
		}
		return bound.toISOString();
	}
	if (ISO_DATE_ONLY_PATTERN.test(trimmed)) {
		const [yearStr, monthStr, dayStr] = trimmed.split("-");
		const year = Number(yearStr);
		const month = Number(monthStr);
		const day = Number(dayStr);
		const check = new Date(Date.UTC(year, month - 1, day));
		if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
			throw new ToolError(`Invalid calendar date: ${raw}`);
		}
		return boundary === "start" ? `${trimmed}T00:00:00.000Z` : `${trimmed}T23:59:59.999Z`;
	}
	const parsedMs = Date.parse(trimmed);
	if (!Number.isNaN(parsedMs)) {
		return new Date(parsedMs).toISOString();
	}
	return parseSearchDateBound(raw, now);
}

async function resolveSearchScope(
	cwd: string,
	explicitRepo: string | undefined,
	explicitGroup: string | undefined,
	signal: AbortSignal | undefined,
): Promise<SearchScope> {
	if (explicitRepo && explicitGroup) {
		throw new ToolError("repo and group are mutually exclusive.");
	}
	if (explicitRepo) {
		const ref = await resolveGitlabProject(cwd, explicitRepo, undefined, signal);
		return { host: ref.host, scope: "project", ref };
	}
	if (explicitGroup) {
		const fallbackHost = hasExplicitGitlabHost(explicitGroup, 1)
			? "gitlab.com"
			: await defaultGitlabHost(cwd, signal);
		const ref = parseGitlabGroupRef(explicitGroup, fallbackHost);
		await assertGitlabHostTrustedForEnvToken(ref.host, cwd, signal);
		return { host: ref.host, scope: "group", ref };
	}
	if (vcs.git(cwd)) {
		try {
			const defaultProject = await resolveDefaultGitlabProjectMemoized(cwd, signal);
			const ref = parseCanonicalGitlabProject(defaultProject);
			await assertGitlabHostTrustedForEnvToken(ref.host, cwd, signal);
			return { host: ref.host, scope: "project", ref };
		} catch (err) {
			if (err instanceof ToolAbortError || signal?.aborted) throw new ToolAbortError();
			const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
			const isNoGitlabProject =
				msg.includes("not a git repository") ||
				msg.includes("no git remotes") ||
				msg.includes("none of the git remotes") ||
				msg.includes("no remotes") ||
				msg.includes("not a gitlab");
			if (!isNoGitlabProject) throw err;
		}
	}
	const host = await defaultGitlabHost(cwd, signal);
	await assertGitlabHostTrustedForEnvToken(host, cwd, signal);
	return { host, scope: "global" };
}

function buildDateQueryParams(
	dateField: "created" | "updated" | undefined,
	since: string | undefined,
	until: string | undefined,
): Record<string, string | undefined> {
	const field = dateField ?? "created";
	const afterKey = field === "updated" ? "updated_after" : "created_after";
	const beforeKey = field === "updated" ? "updated_before" : "created_before";
	return {
		[afterKey]: since ? toGitlabIsoDateBound(since, "start") : undefined,
		[beforeKey]: until ? toGitlabIsoDateBound(until, "end") : undefined,
	};
}

function cleanStringList(values: readonly string[] | undefined): string[] {
	return (values ?? []).map(v => v.trim()).filter(Boolean);
}

function formatCommaList(values: readonly string[] | undefined): string | undefined {
	const cleaned = cleanStringList(values);
	return cleaned.length > 0 ? cleaned.join(",") : undefined;
}

function buildAssigneeQueryParam(values: readonly string[] | undefined): Record<string, string | string[] | undefined> {
	const assignees = cleanStringList(values);
	if (assignees.length === 0) return {};
	if (assignees.length === 1) return { assignee_username: assignees[0] };
	return { "assignee_username[]": assignees };
}

function scopeLabel(scope: SearchScope): string {
	return scope.ref ? scope.ref.full : `${scope.host} (global)`;
}

export async function executeSearchMrs(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const scope = await resolveSearchScope(
		session.cwd,
		normalizeOptionalString(params.repo),
		normalizeOptionalString(params.group),
		signal,
	);
	const state = normalizeOptionalString(params.state) ?? "all";
	if (!ALLOWED_MR_STATES.has(state)) {
		throw new ToolError(`Invalid MR search state '${state}'. Expected opened, closed, merged, or all.`);
	}
	const limit = resolveSearchLimit(params.limit);
	const query = normalizeOptionalString(params.query);
	const reviewers = cleanStringList(params.reviewer);
	if (reviewers.length > 1) {
		throw new ToolError(
			"GitLab merge request search supports at most one reviewer; pass a single username in reviewer.",
		);
	}
	const endpoint =
		scope.scope === "project"
			? `projects/${encodeProjectPath(scope.ref.path)}/merge_requests`
			: scope.scope === "group"
				? `groups/${encodeProjectPath(scope.ref.path)}/merge_requests`
				: "merge_requests";

	const items = await glabApiJson<GlMrApi[]>(
		session.cwd,
		scope.host,
		endpoint,
		{
			query: {
				...(scope.scope === "global" ? { scope: "all" } : {}),
				state,
				search: query,
				author_username: normalizeOptionalString(params.author),
				...buildAssigneeQueryParam(params.assignee),
				reviewer_username: reviewers[0],
				labels: formatCommaList(params.label),
				source_branch: normalizeOptionalString(params.sourceBranch),
				target_branch: normalizeOptionalString(params.targetBranch),
				wip: params.draft !== undefined ? (params.draft ? "yes" : "no") : undefined,
				...buildDateQueryParams(
					params.dateField,
					normalizeOptionalString(params.since),
					normalizeOptionalString(params.until),
				),
				per_page: limit,
				order_by: "updated_at",
				sort: "desc",
			},
		},
		signal,
	);

	const lines = [`# GitLab merge requests search`, ""];
	pushLine(lines, "Scope", scopeLabel(scope));
	pushLine(lines, "Query", query);
	pushLine(lines, "State", state);
	pushLine(lines, "Results", items.length);
	if (items.length === 0) {
		lines.push("", "No merge requests found.");
	} else {
		for (const item of items) {
			const draftBadge = item.draft || item.work_in_progress ? " [draft]" : "";
			lines.push("");
			lines.push(`- !${item.iid ?? "?"} ${item.title ?? "Untitled"}`);
			pushLine(lines, "  State", `${item.state ?? "unknown"}${draftBadge}`);
			if (item.source_branch || item.target_branch) {
				pushLine(lines, "  Branch", `${item.source_branch ?? "?"} → ${item.target_branch ?? "?"}`);
			}
			pushLine(lines, "  Author", formatGlUser(item.author));
			pushLine(lines, "  Labels", formatGlLabels(item.labels));
			pushLine(lines, "  Created", item.created_at);
			pushLine(lines, "  Updated", item.updated_at);
			pushLine(lines, "  URL", item.web_url);
		}
	}
	return buildGlTextResult(lines.join("\n").trim(), undefined, {
		repo: scope.scope === "project" ? scope.ref.full : undefined,
	});
}

export async function executeSearchIssues(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const scope = await resolveSearchScope(
		session.cwd,
		normalizeOptionalString(params.repo),
		normalizeOptionalString(params.group),
		signal,
	);
	const state = normalizeOptionalString(params.state) ?? "all";
	if (!ALLOWED_ISSUE_STATES.has(state)) {
		throw new ToolError(`Invalid issue search state '${state}'. Expected opened, closed, or all.`);
	}
	const limit = resolveSearchLimit(params.limit);
	const query = normalizeOptionalString(params.query);
	const endpoint =
		scope.scope === "project"
			? `projects/${encodeProjectPath(scope.ref.path)}/issues`
			: scope.scope === "group"
				? `groups/${encodeProjectPath(scope.ref.path)}/issues`
				: "issues";

	const items = await glabApiJson<GlIssueApi[]>(
		session.cwd,
		scope.host,
		endpoint,
		{
			query: {
				...(scope.scope === "global" ? { scope: "all" } : {}),
				state,
				search: query,
				author_username: normalizeOptionalString(params.author),
				...buildAssigneeQueryParam(params.assignee),
				labels: formatCommaList(params.label),
				...buildDateQueryParams(
					params.dateField,
					normalizeOptionalString(params.since),
					normalizeOptionalString(params.until),
				),
				per_page: limit,
				order_by: "updated_at",
				sort: "desc",
			},
		},
		signal,
	);

	const lines = [`# GitLab issues search`, ""];
	pushLine(lines, "Scope", scopeLabel(scope));
	pushLine(lines, "Query", query);
	pushLine(lines, "State", state);
	pushLine(lines, "Results", items.length);
	if (items.length === 0) {
		lines.push("", "No issues found.");
	} else {
		for (const item of items) {
			lines.push("");
			lines.push(`- #${item.iid ?? "?"} ${item.title ?? "Untitled"}`);
			pushLine(lines, "  State", item.state);
			pushLine(lines, "  Author", formatGlUser(item.author));
			pushLine(lines, "  Labels", formatGlLabels(item.labels));
			pushLine(lines, "  Created", item.created_at);
			pushLine(lines, "  Updated", item.updated_at);
			pushLine(lines, "  URL", item.web_url);
		}
	}
	return buildGlTextResult(lines.join("\n").trim(), undefined, {
		repo: scope.scope === "project" ? scope.ref.full : undefined,
	});
}

export async function executeSearchCode(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	if (normalizeOptionalString(params.since) || normalizeOptionalString(params.until)) {
		throw new ToolError("search_code does not support since or until date filters.");
	}
	const query = requireNonEmpty(normalizeOptionalString(params.query), "query");
	const scope = await resolveSearchScope(
		session.cwd,
		normalizeOptionalString(params.repo),
		normalizeOptionalString(params.group),
		signal,
	);
	const limit = resolveSearchLimit(params.limit);
	const refName = normalizeOptionalString(params.ref);
	const endpoint =
		scope.scope === "project"
			? `projects/${encodeProjectPath(scope.ref.path)}/search`
			: scope.scope === "group"
				? `groups/${encodeProjectPath(scope.ref.path)}/search`
				: "search";

	const items = await glabApiJson<GlSearchCodeItemApi[]>(
		session.cwd,
		scope.host,
		endpoint,
		{
			query: {
				scope: "blobs",
				search: query,
				ref: scope.scope === "project" ? refName : undefined,
				per_page: limit,
			},
		},
		signal,
	);

	const lines = [`# GitLab code search`, ""];
	pushLine(lines, "Scope", scopeLabel(scope));
	pushLine(lines, "Query", query);
	pushLine(lines, "Results", items.length);
	if (items.length === 0) {
		lines.push("", "No code matches found.");
	} else {
		for (const item of items) {
			const filePath = item.path ?? item.filename ?? "(unknown path)";
			lines.push("");
			lines.push(`- ${filePath}${item.startline !== undefined ? `:${item.startline}` : ""}`);
			pushLine(lines, "  Ref", item.ref);
			pushLine(lines, "  Project ID", item.project_id);
			const snippet = normalizeText(item.data).split("\n").slice(0, 3).join(" | ");
			if (snippet) pushLine(lines, "  Match", snippet);
		}
	}
	return buildGlTextResult(lines.join("\n").trim(), undefined, {
		repo: scope.scope === "project" ? scope.ref.full : undefined,
		branch: refName,
	});
}

export async function executeSearchCommits(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const query = normalizeOptionalString(params.query);
	const since = normalizeOptionalString(params.since);
	const until = normalizeOptionalString(params.until);
	const refName = normalizeOptionalString(params.ref);
	const limit = resolveSearchLimit(params.limit);
	const scope = await resolveSearchScope(
		session.cwd,
		normalizeOptionalString(params.repo),
		normalizeOptionalString(params.group),
		signal,
	);

	if (query && (since || until)) {
		throw new ToolError(
			"search_commits with query uses GitLab's search API, which does not support since/until date filters; omit query to filter repository commits by date.",
		);
	}

	let items: GlSearchCommitItemApi[];
	if (query) {
		const endpoint =
			scope.scope === "project"
				? `projects/${encodeProjectPath(scope.ref.path)}/search`
				: scope.scope === "group"
					? `groups/${encodeProjectPath(scope.ref.path)}/search`
					: "search";
		items = await glabApiJson<GlSearchCommitItemApi[]>(
			session.cwd,
			scope.host,
			endpoint,
			{
				query: {
					scope: "commits",
					search: query,
					ref: scope.scope === "project" ? refName : undefined,
					per_page: limit,
				},
			},
			signal,
		);
	} else {
		if (scope.scope !== "project") {
			throw new ToolError(
				"search_commits without query requires a project scope (pass repo or run in a GitLab repo).",
			);
		}
		items = await glabApiJson<GlSearchCommitItemApi[]>(
			session.cwd,
			scope.host,
			`projects/${encodeProjectPath(scope.ref.path)}/repository/commits`,
			{
				query: {
					ref_name: refName,
					since: since ? toGitlabIsoDateBound(since, "start") : undefined,
					until: until ? toGitlabIsoDateBound(until, "end") : undefined,
					per_page: limit,
				},
			},
			signal,
		);
	}

	const lines = [`# GitLab commits search`, ""];
	pushLine(lines, "Scope", scopeLabel(scope));
	pushLine(lines, "Query", query);
	pushLine(lines, "Ref", refName);
	pushLine(lines, "Results", items.length);
	if (items.length === 0) {
		lines.push("", "No commits found.");
	} else {
		for (const item of items) {
			const sha = formatShortSha(item.short_id ?? item.id) ?? "(unknown sha)";
			const subject = normalizeText(item.title ?? item.message).split("\n", 1)[0] || "(no commit message)";
			lines.push("");
			lines.push(`- ${sha} ${subject}`);
			pushLine(lines, "  Project ID", item.project_id);
			pushLine(lines, "  Author", item.author_name);
			pushLine(lines, "  Date", item.committed_date ?? item.authored_date);
			pushLine(lines, "  URL", item.web_url);
		}
	}
	return buildGlTextResult(lines.join("\n").trim(), undefined, {
		repo: scope.scope === "project" ? scope.ref.full : undefined,
		branch: refName,
	});
}

export async function executeSearchProjects(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const query = requireNonEmpty(normalizeOptionalString(params.query), "query");
	const limit = resolveSearchLimit(params.limit);
	const explicitGroup = normalizeOptionalString(params.group);
	let host: string;
	let endpoint = "projects";
	const extraQuery: Record<string, string | number | boolean | undefined> = {};

	if (explicitGroup) {
		const fallbackHost = hasExplicitGitlabHost(explicitGroup, 1)
			? "gitlab.com"
			: await defaultGitlabHost(session.cwd, signal);
		const groupRef = parseGitlabGroupRef(explicitGroup, fallbackHost);
		await assertGitlabHostTrustedForEnvToken(groupRef.host, session.cwd, signal);
		host = groupRef.host;
		endpoint = `groups/${encodeProjectPath(groupRef.path)}/projects`;
		extraQuery.include_subgroups = true;
	} else {
		host = await defaultGitlabHost(session.cwd, signal);
		await assertGitlabHostTrustedForEnvToken(host, session.cwd, signal);
	}

	const items = await glabApiJson<GlProjectApi[]>(
		session.cwd,
		host,
		endpoint,
		{
			query: {
				...extraQuery,
				search: query,
				simple: true,
				per_page: limit,
				order_by: "last_activity_at",
				sort: "desc",
			},
		},
		signal,
	);

	const lines = [`# GitLab projects search`, ""];
	pushLine(lines, "Host", host);
	pushLine(lines, "Query", query);
	pushLine(lines, "Results", items.length);
	if (items.length === 0) {
		lines.push("", "No projects found.");
	} else {
		for (const item of items) {
			lines.push("");
			lines.push(`- ${item.path_with_namespace ?? item.name ?? "(unknown project)"}`);
			const desc = normalizeText(item.description).split("\n", 1)[0];
			if (desc) pushLine(lines, "  Description", desc);
			pushLine(lines, "  Visibility", item.visibility);
			pushLine(lines, "  Default branch", item.default_branch ?? undefined);
			pushLine(lines, "  Stars", item.star_count);
			pushLine(lines, "  Forks", item.forks_count);
			pushLine(lines, "  Last activity", item.last_activity_at);
			pushLine(lines, "  URL", item.web_url);
		}
	}
	return buildGlTextResult(lines.join("\n").trim());
}
