/**
 * Protocol handler for `mr://` — GitLab merge request diffs via `glab`.
 *
 * URL shapes (diff family only):
 * - `mr://<host>/<group…>/<project>/<iid>/diff` — changed-file listing.
 * - `…/diff/all` — full unified diff; `…/diff/<i>` — one file (1-indexed).
 * - `mr://<iid>/diff[/…]` — same, project derived from the session cwd.
 *
 * GitLab project paths have variable depth (nested groups), so parsing
 * anchors on the `diff` segment at the tail of the path.
 */
import mrDoc from "../prompts/internal-urls/mr.md" with { type: "text" };
import { parsePositiveDecimalInt } from "../tools/gh";
import {
	GITLAB_HOST_PATTERN,
	GITLAB_PATH_SEGMENT_PATTERN,
	getOrFetchMrDiff,
	resolveDefaultGitlabProjectMemoized,
} from "../tools/glab-mr";
import { gitlab } from "../utils/gitlab";
import { renderDiffFamilyResource, resolveCwd, splitInternalUrlSegments } from "./forge-diff";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, SchemeSpec } from "./types";

export interface ParsedMrUrl {
	/** `<host>/<namespace…>/<project>`; undefined for the short `mr://<iid>/…` form. */
	project?: string;
	iid: number;
	mode: "list" | "all" | "slice";
	index?: number;
}

const INVALID_MR_URL =
	"Invalid mr:// URL. Expected mr://<iid>/diff or mr://<host>/<group>/<project>/<iid>/diff, optionally followed by /all or /<i>.";

export function parseMrUrl(url: InternalUrl): ParsedMrUrl {
	const host = url.rawHost || url.hostname;
	const all = [host, ...splitInternalUrlSegments(url, "mr")];
	const last = all.length - 1;

	let iidIndex: number;
	let mode: ParsedMrUrl["mode"];
	let index: number | undefined;
	if (all[last] === "diff") {
		mode = "list";
		iidIndex = last - 1;
	} else if (all.length >= 2 && all[last - 1] === "diff") {
		const sub = all[last]!;
		iidIndex = last - 2;
		if (sub === "all") {
			mode = "all";
		} else {
			index = parsePositiveDecimalInt(sub);
			if (index === undefined) {
				throw new Error(`Invalid mr:// diff sub-path '${sub}'. Use 'all' or a 1-indexed file number.`);
			}
			mode = "slice";
		}
	} else {
		throw new Error(INVALID_MR_URL);
	}

	const iid = iidIndex >= 0 ? parsePositiveDecimalInt(all[iidIndex]) : undefined;
	if (iid === undefined) throw new Error(INVALID_MR_URL);
	if (iidIndex === 0) return { iid, mode, index };

	const segments = all.slice(1, iidIndex);
	if (
		!GITLAB_HOST_PATTERN.test(host) ||
		segments.length < 2 ||
		!segments.every(segment => GITLAB_PATH_SEGMENT_PATTERN.test(segment))
	) {
		throw new Error(INVALID_MR_URL);
	}
	return { project: `${host.toLowerCase()}/${segments.join("/")}`, iid, mode, index };
}

/**
 * Handler for `mr://` URLs.
 */
export class MrProtocolHandler implements ProtocolHandler {
	readonly scheme = "mr";
	readonly spec: SchemeSpec = { backing: "remote", selectors: "lines", immutable: true };

	/** Advertised only when `glab` is on PATH. */
	promptDoc(): string | undefined {
		return gitlab.available() ? mrDoc.trim() : undefined;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (context?.signal?.aborted) {
			throw new Error("aborted");
		}
		const parsed = parseMrUrl(url);
		try {
			const cwd = resolveCwd(context);
			let project = parsed.project;
			if (!project) {
				try {
					project = await resolveDefaultGitlabProjectMemoized(cwd, context?.signal);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(
						`mr://${parsed.iid}/diff could not resolve a default GitLab project from the current session: ${message}\nUse mr://<host>/<group>/<project>/${parsed.iid}/diff.`,
					);
				}
			}
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
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`mr:// diff resolution failed: ${message}`);
		}
	}
}
