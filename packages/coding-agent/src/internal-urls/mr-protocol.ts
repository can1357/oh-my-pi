/**
 * Protocol handler for `mr://` — GitLab merge requests and diffs via `glab`.
 *
 * URL shapes:
 * - `mr://` — list open MRs in the current project (`?state=&limit=&author=&reviewer=&label=&source_branch=`).
 * - `mr://<host>/<group…>/<project>` — list MRs in an explicit project.
 * - `mr://<iid>` / `mr://<host>/<group…>/<project>/<iid>` — cached MR overview (`?comments=0&unresolved=1`).
 * - `mr://<iid>/diff[/all|/<i>]` / `mr://<host>/<group…>/<project>/<iid>/diff[/all|/<i>]` — changed files & diffs.
 */
import mrReferenceDoc from "../prompts/internal-urls/mr-reference.md" with { type: "text" };
import mrDoc from "../prompts/internal-urls/mr.md" with { type: "text" };
import { parsePositiveDecimalInt } from "../tools/gh";
import {
	encodeProjectPath,
	formatGlLabels,
	formatGlUser,
	glabApiJson,
	parseCanonicalGitlabProject,
} from "../tools/gl-common";
import type { GlMrApi } from "../tools/gl-types";
import { formatMrView, getOrFetchMr } from "../tools/gl-view";
import {
	assertGitlabHostTrustedForEnvToken,
	GITLAB_HOST_PATTERN,
	GITLAB_PATH_SEGMENT_PATTERN,
	getOrFetchMrDiff,
	isGitlabHostSegment,
	resolveDefaultGitlabProjectMemoized,
} from "../tools/glab-mr";
import { formatFreshnessNote } from "../tools/github-cache";
import { gitlab } from "../utils/gitlab";
import { renderDiffFamilyResource, resolveCwd, splitInternalUrlSegments } from "./forge-diff";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, SchemeSpec } from "./types";

export interface ParsedMrListUrl {
	kind: "list";
	/** `<host>/<namespace…>/<project>`; undefined for the bare `mr://` form. */
	project?: string;
	state: "opened" | "closed" | "merged" | "all";
	limit: number;
	author?: string;
	reviewer?: string;
	label?: string;
	sourceBranch?: string;
}

export interface ParsedMrSingleUrl {
	kind: "single";
	/** `<host>/<namespace…>/<project>`; undefined for the short `mr://<iid>` form. */
	project?: string;
	iid: number;
	comments: boolean;
	unresolved: boolean;
}

export interface ParsedMrDiffUrl {
	kind: "diff";
	/** `<host>/<namespace…>/<project>`; undefined for the short `mr://<iid>/diff` form. */
	project?: string;
	iid: number;
	mode: "list" | "all" | "slice";
	index?: number;
}

export type ParsedMrUrl = ParsedMrListUrl | ParsedMrSingleUrl | ParsedMrDiffUrl;

const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 100;
const ALLOWED_LIST_STATES: ReadonlyArray<ParsedMrListUrl["state"]> = ["opened", "closed", "merged", "all"];

const INVALID_MR_URL =
	"Invalid mr:// URL. Expected mr://, mr://<iid>, mr://<iid>/diff, mr://<host>/<group>/<project>, or mr://<host>/<group>/<project>/<iid>[/diff[/all|/<i>]].";

function parseListOptions(url: InternalUrl, project: string | undefined): ParsedMrListUrl {
	const stateRaw = url.searchParams.get("state");
	if (stateRaw !== null && !(ALLOWED_LIST_STATES as readonly string[]).includes(stateRaw)) {
		throw new Error(`Invalid mr:// list state '${stateRaw}'. Expected one of: ${ALLOWED_LIST_STATES.join(", ")}.`);
	}
	const state = (stateRaw ?? "opened") as ParsedMrListUrl["state"];

	const limitRaw = url.searchParams.get("limit");
	let limit = LIST_LIMIT_DEFAULT;
	if (limitRaw !== null) {
		const parsed = parsePositiveDecimalInt(limitRaw);
		if (parsed === undefined) {
			throw new Error(
				`Invalid mr:// list limit '${limitRaw}'. Expected a positive integer (max ${LIST_LIMIT_MAX}).`,
			);
		}
		limit = Math.min(parsed, LIST_LIMIT_MAX);
	}

	return {
		kind: "list",
		project,
		state,
		limit,
		author: url.searchParams.get("author") ?? undefined,
		reviewer: url.searchParams.get("reviewer") ?? undefined,
		label: url.searchParams.get("label") ?? undefined,
		sourceBranch: url.searchParams.get("source_branch") ?? url.searchParams.get("sourceBranch") ?? undefined,
	};
}

function parseSingleFlags(url: InternalUrl): { comments: boolean; unresolved: boolean } {
	const unresolvedParam = url.searchParams.get("unresolved");
	const unresolved = unresolvedParam !== null && (unresolvedParam === "1" || unresolvedParam.toLowerCase() === "true");
	const commentsParam = url.searchParams.get("comments");
	const comments =
		unresolved || commentsParam === null ? true : !(commentsParam === "0" || commentsParam.toLowerCase() === "false");
	return { comments, unresolved };
}

export function parseMrUrl(url: InternalUrl): ParsedMrUrl {
	const host = url.rawHost || url.hostname;
	const pathSegments = splitInternalUrlSegments(url, "mr");

	if (!host && pathSegments.length === 0) {
		return parseListOptions(url, undefined);
	}
	if (host && pathSegments.length === 0) {
		const iid = parsePositiveDecimalInt(host);
		if (iid === undefined) throw new Error(INVALID_MR_URL);
		return { kind: "single", iid, ...parseSingleFlags(url) };
	}

	const all = [host, ...pathSegments];
	const last = all.length - 1;

	let iidIndex: number | undefined;
	let mode: ParsedMrDiffUrl["mode"] | undefined;
	let index: number | undefined;
	if (all[last] === "diff" && last >= 1 && parsePositiveDecimalInt(all[last - 1]) !== undefined) {
		iidIndex = last - 1;
		mode = "list";
	} else if (all.length >= 3 && all[last - 1] === "diff" && parsePositiveDecimalInt(all[last - 2]) !== undefined) {
		iidIndex = last - 2;
		const sub = all[last] ?? "";
		if (sub === "all") {
			mode = "all";
		} else {
			index = parsePositiveDecimalInt(sub);
			if (index === undefined) {
				throw new Error(`Invalid mr:// diff sub-path '${sub}'. Use 'all' or a 1-indexed file number.`);
			}
			mode = "slice";
		}
	}

	if (iidIndex !== undefined && mode !== undefined) {
		const iid = parsePositiveDecimalInt(all[iidIndex]);
		if (iid === undefined) throw new Error(INVALID_MR_URL);
		if (iidIndex === 0) return { kind: "diff", iid, mode, index };

		const segments = all.slice(1, iidIndex);
		if (
			!GITLAB_HOST_PATTERN.test(host) ||
			segments.length < 2 ||
			!segments.every(segment => GITLAB_PATH_SEGMENT_PATTERN.test(segment))
		) {
			throw new Error(INVALID_MR_URL);
		}
		return { kind: "diff", project: `${host.toLowerCase()}/${segments.join("/")}`, iid, mode, index };
	}

	const trailingIid = all.length >= 4 ? parsePositiveDecimalInt(all[last]) : undefined;
	if (trailingIid !== undefined) {
		const segments = all.slice(1, last);
		if (
			!GITLAB_HOST_PATTERN.test(host) ||
			segments.length < 2 ||
			!segments.every(segment => GITLAB_PATH_SEGMENT_PATTERN.test(segment))
		) {
			throw new Error(INVALID_MR_URL);
		}
		return {
			kind: "single",
			project: `${host.toLowerCase()}/${segments.join("/")}`,
			iid: trailingIid,
			...parseSingleFlags(url),
		};
	}

	const listSegments = all.slice(1);
	if (
		isGitlabHostSegment(host) &&
		GITLAB_HOST_PATTERN.test(host) &&
		listSegments.length >= 2 &&
		listSegments.every(segment => GITLAB_PATH_SEGMENT_PATTERN.test(segment))
	) {
		return parseListOptions(url, `${host.toLowerCase()}/${listSegments.join("/")}`);
	}
	throw new Error(INVALID_MR_URL);
}

function formatMrListItem(project: string, item: GlMrApi): string {
	const iid = item.iid ?? "?";
	const title = item.title ?? "(no title)";
	const state = item.state?.toLowerCase() ?? "?";
	const draftSuffix = item.draft || item.work_in_progress ? " [draft]" : "";
	const author = formatGlUser(item.author) ?? "?";
	const updated = item.updated_at ?? item.created_at ?? "";
	const branchInfo = item.source_branch && item.target_branch ? `  ${item.source_branch} → ${item.target_branch}` : "";
	const labels = formatGlLabels(item.labels);
	const labelSuffix = labels ? `  labels: ${labels}` : "";
	const itemUrl = iid === "?" ? `mr://${project}` : `mr://${project}/${iid}`;
	return `- [${state}${draftSuffix}] !${iid}${branchInfo}  ${author}  ${updated}\n    ${title}${labelSuffix}\n    ${itemUrl}`;
}

async function resolveMrProject(
	parsedProject: string | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	fallbackHint: string,
): Promise<string> {
	if (parsedProject) return parsedProject;
	try {
		return await resolveDefaultGitlabProjectMemoized(cwd, signal);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`${fallbackHint} could not resolve a default project from the current session: ${message}`);
	}
}

async function fetchAndRenderMrList(
	url: InternalUrl,
	parsed: ParsedMrListUrl,
	context: ResolveContext | undefined,
): Promise<InternalResource> {
	const cwd = resolveCwd(context);
	const project = await resolveMrProject(parsed.project, cwd, context?.signal, "mr://");
	const ref = parseCanonicalGitlabProject(project);
	await assertGitlabHostTrustedForEnvToken(ref.host, cwd, context?.signal);
	const items = await glabApiJson<GlMrApi[]>(
		cwd,
		ref.host,
		`projects/${encodeProjectPath(ref.path)}/merge_requests`,
		{
			query: {
				state: parsed.state,
				per_page: parsed.limit,
				order_by: "updated_at",
				sort: "desc",
				author_username: parsed.author,
				reviewer_username: parsed.reviewer,
				labels: parsed.label,
				source_branch: parsed.sourceBranch,
			},
		},
		context?.signal,
	);
	const header = `# Merge Requests in ${project} (${parsed.state}, up to ${parsed.limit})`;
	const body = items.length === 0 ? "_No matches._" : items.map(item => formatMrListItem(project, item)).join("\n\n");
	const footer = `\n\n---\nRead a specific MR: \`mr://${project}/<iid>\` (or \`mr://<iid>\` for the current project).`;
	const content = `${header}\n\n${body}${footer}`;
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [`Live listing for ${project}`],
	};
}

/**
 * Handler for `mr://` URLs.
 */
export class MrProtocolHandler implements ProtocolHandler {
	readonly scheme = "mr";
	readonly spec: SchemeSpec = { backing: "remote", selectors: "lines", immutable: true };

	promptDoc(): string | undefined {
		return gitlab.available() ? mrDoc.trim() : undefined;
	}

	promptReference(): string | undefined {
		return gitlab.available() ? mrReferenceDoc.trim() : undefined;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (context?.signal?.aborted) {
			throw new Error("aborted");
		}
		const parsed = parseMrUrl(url);
		const cwd = resolveCwd(context);

		if (parsed.kind === "list") {
			return fetchAndRenderMrList(url, parsed, context);
		}

		if (parsed.kind === "single") {
			const project = await resolveMrProject(parsed.project, cwd, context?.signal, `mr://${parsed.iid}`);
			const lookup = await getOrFetchMr({
				cwd,
				project,
				iid: parsed.iid,
				includeComments: parsed.comments,
				signal: context?.signal,
				settings: context?.settings,
			});
			const rendered = parsed.unresolved ? formatMrView(lookup.payload, { unresolvedOnly: true }) : lookup.rendered;
			const content =
				lookup.status === "stale"
					? `> WARNING: Live GitLab refresh failed; this mr content is cached and may be stale.\n\n${rendered}`
					: rendered;
			const notes: string[] = [formatFreshnessNote(lookup.status, lookup.fetchedAt)];
			if (!parsed.comments) notes.push("Comments disabled");
			if (parsed.unresolved) notes.push("Unresolved discussions only");
			notes.push(`Diff: mr://${project}/${parsed.iid}/diff`);
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
				notes,
			};
		}

		const project = await resolveMrProject(parsed.project, cwd, context?.signal, `mr://${parsed.iid}/diff`);
		const lookup = await getOrFetchMrDiff({
			cwd,
			project,
			iid: parsed.iid,
			signal: context?.signal,
			settings: context?.settings,
		});
		return renderDiffFamilyResource(url, parsed.mode, parsed.index, lookup, {
			baseUrl: `mr://${project}/${parsed.iid}`,
			heading: `Merge Request Diff: ${project}!${parsed.iid}`,
			noun: "MR",
		});
	}
}
