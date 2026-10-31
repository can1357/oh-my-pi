import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Settings } from "../config/settings";
import { CwdLookupMemo } from "../utils/forge-cli";
import { gitlab } from "../utils/gitlab";
import { type PrDiffPayload, parsePrUnifiedDiff } from "./gh-pr-diff";
import type { ViewLookupResult } from "./gh-view";
import { GITLAB_TOKEN_ENV_VARS, getGlabConfigPath, getOrFetchView, resolveGitlabCacheAuthKey } from "./github-cache";
import { ToolAbortError } from "./tool-errors";

/**
 * GitLab project refs are `<host>/<namespace…>/<project>` (host lowercased).
 * glab's `-R` accepts a full URL, which disambiguates nested groups and
 * self-managed hosts.
 */
export function formatGitlabProjectArg(project: string): string {
	return `https://${project}`;
}

/** One namespace or project path segment of a GitLab project ref. */
export const GITLAB_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
/** A GitLab host with optional port; rejects userinfo, paths, and control characters. */
export const GITLAB_HOST_PATTERN = /^[A-Za-z0-9.-]+(?::\d+)?$/;

/** Parse a GitLab project web URL into a `<host>/<namespace…>/<project>` ref. */
export function parseGitlabProjectWebUrl(webUrl: string): string | undefined {
	let url: URL;
	try {
		url = new URL(webUrl);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length < 2 || !segments.every(segment => GITLAB_PATH_SEGMENT_PATTERN.test(segment))) return undefined;
	return `${url.host.toLowerCase()}/${segments.join("/")}`;
}

/**
 * glab sends `GITLAB_TOKEN`/`GITLAB_ACCESS_TOKEN`/`OAUTH_TOKEN` to whatever
 * host it talks to, while stored config.yml tokens are per host. When an env
 * token is set, MR URLs (pasted, detected in conversation, or model-chosen)
 * may only reach hosts the user already trusts with credentials: gitlab.com,
 * the configured default host, a host in glab's config, or the host of the
 * checkout's own GitLab remote.
 */
async function assertGitlabHostTrustedForEnvToken(host: string, cwd: string, signal?: AbortSignal): Promise<void> {
	if (!GITLAB_TOKEN_ENV_VARS.some(name => process.env[name])) return;
	const trusted = new Set(["gitlab.com"]);
	for (const name of ["GITLAB_HOST", "GITLAB_URI", "GL_HOST"]) {
		const value = process.env[name]?.trim();
		if (!value) continue;
		try {
			trusted.add(new URL(value.includes("://") ? value : `https://${value}`).host.toLowerCase());
		} catch {
			logger.debug("glab: ignoring unparseable default host", { name, value });
		}
	}
	if (trusted.has(host)) return;
	try {
		const config = Bun.YAML.parse(await Bun.file(getGlabConfigPath()).text()) as { hosts?: unknown } | null;
		if (config && typeof config.hosts === "object" && config.hosts !== null) {
			for (const name of Object.keys(config.hosts)) trusted.add(name.toLowerCase());
		}
	} catch (err) {
		if (!isEnoent(err)) logger.debug("glab: failed to read config hosts", { err: String(err) });
	}
	if (trusted.has(host)) return;
	try {
		// The checkout's remote is the user's own; `glab repo view` already talks to it.
		const ownProject = await resolveDefaultGitlabProjectMemoized(cwd, signal);
		if (ownProject.split("/")[0] === host) return;
	} catch (err) {
		if (signal?.aborted) throw new ToolAbortError();
		logger.debug("glab: no GitLab project for cwd while checking host trust", { err: String(err) });
	}
	throw new ToolError(
		`Refusing to send GitLab token environment variables to ${host}: it is not gitlab.com, GITLAB_HOST, a host in glab's config, or this checkout's GitLab host. Run \`glab auth login --hostname ${host}\` or set GITLAB_HOST to trust it.`,
	);
}

const defaultProjectMemo = new CwdLookupMemo(resolveGitlabProjectFromCwd);

async function resolveGitlabProjectFromCwd(cwd: string): Promise<string> {
	const view = await gitlab.json<{ web_url?: string; http_url_to_repo?: string }>(cwd, ["repo", "view", "-F", "json"]);
	const project =
		(view.web_url ? parseGitlabProjectWebUrl(view.web_url) : undefined) ??
		(view.http_url_to_repo ? parseGitlabProjectWebUrl(view.http_url_to_repo.replace(/\.git$/, "")) : undefined);
	if (!project) throw new ToolError(`GitLab CLI returned an unrecognized project URL: ${String(view.web_url)}`);
	return project;
}

/** `glab repo view` for `cwd`, memoized per absolute cwd. */
export function resolveDefaultGitlabProjectMemoized(cwd: string, signal?: AbortSignal): Promise<string> {
	return defaultProjectMemo.get(cwd, signal);
}

export function resetDefaultGitlabProjectMemoForTests(): void {
	defaultProjectMemo.clear();
}

export async function fetchMrDiffFresh(
	cwd: string,
	project: string,
	iid: number,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: PrDiffPayload }> {
	const baseArgs = ["mr", "diff", String(iid), "-R", formatGitlabProjectArg(project)];
	let text: string;
	try {
		text = await gitlab.text(cwd, [...baseArgs, "--raw", "--color", "never"], signal, { trimOutput: false });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// glab releases without `--raw` print bare `---`/`+++` headers for every
		// diff version, which no parser here can split into one file list.
		if (message.includes("unknown flag: --raw")) {
			throw new ToolError("GitLab CLI is too old for `glab mr diff --raw`; upgrade glab.");
		}
		// Instances without the `raw_diffs` endpoint: glab's rendered diff of the
		// latest version still carries `diff --git` headers.
		if (!(message.includes("could not obtain raw diff") && message.includes("404"))) throw err;
		logger.debug("GitLab raw_diffs endpoint unavailable; retrying without --raw", { project, iid, err: message });
		text = await gitlab.text(cwd, [...baseArgs, "--color", "never"], signal, { trimOutput: false });
	}
	const payload = parsePrUnifiedDiff(text);
	if (payload.files.length === 0 && text.trim()) {
		throw new ToolError("GitLab CLI returned a diff without `diff --git` file headers; upgrade glab.");
	}
	// `rendered` carries the verbatim diff; blank the payload copy so the cache
	// row stores it once. `getOrFetchMrDiff` rehydrates `unified` from `rendered`.
	return { rendered: text, sourceUrl: undefined, payload: { unified: "", files: payload.files } };
}

export interface MrDiffLookupOptions {
	cwd: string;
	/** `<host>/<namespace…>/<project>`. */
	project: string;
	iid: number;
	signal?: AbortSignal;
	settings?: Settings;
	/** `null` bypasses the cache; `undefined` derives the key from glab credentials. */
	cacheAuthKey?: string | null;
}

/**
 * Cache-aware MR diff fetcher; one `mr-diff` cache row backs the listing,
 * full-diff, and per-file slice variants of `mr://…/diff`.
 */
export async function getOrFetchMrDiff(options: MrDiffLookupOptions): Promise<ViewLookupResult<PrDiffPayload>> {
	const host = options.project.split("/")[0]!;
	await assertGitlabHostTrustedForEnvToken(host, options.cwd, options.signal);
	const authKey =
		options.cacheAuthKey === undefined ? (resolveGitlabCacheAuthKey(host) ?? null) : options.cacheAuthKey;
	const lookup = await getOrFetchView<PrDiffPayload>({
		repo: options.project,
		kind: "mr-diff",
		number: options.iid,
		includeComments: false,
		settings: options.settings,
		authKey,
		fetchFresh: () => fetchMrDiffFresh(options.cwd, options.project, options.iid, options.signal),
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: { unified: lookup.rendered, files: lookup.payload.files },
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}
