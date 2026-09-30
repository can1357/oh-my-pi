import * as path from "node:path";
import { DEFAULT_REPO_RESOLVED, tryResolveCurrentRepo } from "./gh-common";
import type { Settings } from "../config/settings";
import { getCached, resolveCacheTtl, resolveGithubCacheAuthKey } from "./github-cache";
import type { GhIssueViewData } from "./gh-types";
import { getOrFetchIssue, getOrFetchPr } from "./gh-view";

/**
 * Title of a PR or issue that this machine has already fetched, or `undefined`.
 *
 * Runs on every frame the `#N` card is drawn, so it never leaves the process: the repository comes from the
 * memoised `gh repo view` result (empty until something has resolved it) and the title from the local view
 * cache. A cold cache is the normal case for a number that was never opened, not an error.
 */
export function lookupCachedReferenceTitle(cwd: string, kind: "pr" | "issue", number: string): string | undefined {
	const repo = DEFAULT_REPO_RESOLVED.get(path.resolve(cwd));
	if (repo === undefined) return undefined;
	const numeric = Number(number);
	if (!Number.isSafeInteger(numeric) || numeric < 1) return undefined;
	// The same local identity key gh-view stores under. Without one it bypasses the cache, and so do we: a view
	// cached for another account is never shown.
	const authKey = resolveGithubCacheAuthKey();
	if (authKey === undefined) return undefined;
	// A view fetched with comments sits in its own row; the title is the same in either.
	for (const includeComments of [false, true]) {
		const view = getCached<GhIssueViewData>(repo, kind, numeric, includeComments, authKey);
		if (!view) continue;
		// GitHub shares one number space and `gh issue view` also answers for a PR, so an issue row can hold a
		// pull request. That number has no issue; showing the PR title under `Issue` would be wrong.
		if (kind === "issue" && /\/pull\/\d+\/?$/.test(view.payload.url ?? "")) return undefined;
		const title = view.payload.title?.trim();
		if (title) return title;
	}
	return undefined;
}

/** Checkouts whose repository lookup was already started, so a failure is not repeated on every frame. */
const attemptedCwds = new Set<string>();

/** Forget which checkouts were tried. Tests only. */
export function resetReferenceRepoAttempts(): void {
	attemptedCwds.clear();
}

/**
 * Make titles available for `cwd`: resolve its `owner/repo` in the background and call `onReady` only when that
 * newly made lookups possible. The card asks on every frame, so each checkout is tried once per process: the
 * shared resolver remembers successes but not failures, and a checkout without a GitHub remote (or with `gh`
 * signed out) would otherwise start a new `gh` process per frame. Never throws and never blocks the caller.
 */
export function warmReferenceRepo(cwd: string, onReady: () => void): void {
	const key = path.resolve(cwd);
	if (DEFAULT_REPO_RESOLVED.has(key) || attemptedCwds.has(key)) return;
	attemptedCwds.add(key);
	void tryResolveCurrentRepo(cwd, undefined).then(repo => {
		if (repo !== undefined) onReady();
	});
}

/** How long the typed number must stay unchanged before its title is fetched. */
const TITLE_FETCH_DEBOUNCE_MS = 400;

/** References already requested (successfully or not), keyed by repo, kind and number: each is fetched once. */
const requestedTitles = new Set<string>();
let pendingTitle: { key: string; timer: ReturnType<typeof setTimeout> } | undefined;

/** Forget requested references and cancel a pending fetch. Tests only. */
export function resetReferenceTitleFetches(): void {
	requestedTitles.clear();
	if (pendingTitle) clearTimeout(pendingTitle.timer);
	pendingTitle = undefined;
}

/**
 * Fetch the title of a reference that is not cached yet, in the background, and call `onReady` when it is stored.
 *
 * Every digit prefix of `#12345` is a valid reference, so the card asks for `1`, `12`, `123`, ...: the request
 * starts only once the number has stopped changing, replaces any earlier pending one, and is skipped when the
 * repository is unknown, when there is no local identity to key the cache with, when the title is already cached,
 * or when this exact reference was requested before (a failure is not retried per frame). The result goes through
 * the same cache rows `pr://` and `issue://` use, so it is also available to them. Never throws.
 */
export function fetchReferenceTitle(
	cwd: string,
	kind: "pr" | "issue",
	number: string,
	onReady: () => void,
	settings?: Settings,
): void {
	const repo = DEFAULT_REPO_RESOLVED.get(path.resolve(cwd));
	const numeric = Number(number);
	if (repo === undefined || !Number.isSafeInteger(numeric) || numeric < 1) return;
	// Someone who turned the GitHub cache off gets no background `gh` process either.
	if (!resolveCacheTtl(settings).enabled) return;
	if (resolveGithubCacheAuthKey() === undefined) return;
	const key = `${repo}|${kind}|${numeric}`;
	if (requestedTitles.has(key) || pendingTitle?.key === key) return;
	if (lookupCachedReferenceTitle(cwd, kind, number) !== undefined) return;
	if (pendingTitle) clearTimeout(pendingTitle.timer);
	const timer = setTimeout(() => {
		pendingTitle = undefined;
		requestedTitles.add(key);
		const options = { cwd, includeComments: false, settings };
		const request =
			kind === "pr"
				? getOrFetchPr({ ...options, repo, number: numeric })
				: getOrFetchIssue({ ...options, repo, issue: String(numeric) });
		void request.then(
			() => onReady(),
			() => undefined,
		);
	}, TITLE_FETCH_DEBOUNCE_MS);
	pendingTitle = { key, timer };
}
