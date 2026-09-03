import type { GhPrViewData } from "../tools/gh-types";
import type { SessionEntry } from "./session-entries";

/** Session custom-entry namespace for PRs explicitly created or adopted by OMP. */
export const TRACKED_PR_ENTRY_TYPE = "omp.pr-tracker";

export interface TrackedPullRequest {
	repo: string;
	number: number;
	url: string;
	title?: string;
	source: "github" | "adopt";
}

export interface TrackedPullRequestStatus {
	label: string;
	terminal: boolean;
	terminalState?: "CLOSED" | "MERGED";
}

type TrackedPullRequestEntry =
	| { action: "register"; pullRequest: TrackedPullRequest }
	| { action: "terminal"; repo: string; number: number; state: "CLOSED" | "MERGED" };

type TrackedPullRequestSessionManager = {
	appendCustomEntry(customType: string, data?: unknown): string;
	ensureOnDisk(): Promise<void>;
	getBranch(): SessionEntry[];
};

function isTrackedPullRequest(value: unknown): value is TrackedPullRequest {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.repo === "string" &&
		candidate.repo.length > 0 &&
		typeof candidate.number === "number" &&
		Number.isSafeInteger(candidate.number) &&
		candidate.number > 0 &&
		typeof candidate.url === "string" &&
		candidate.url.length > 0 &&
		(candidate.title === undefined || typeof candidate.title === "string") &&
		(candidate.source === "github" || candidate.source === "adopt")
	);
}

function parseTrackedPullRequestEntry(value: unknown): TrackedPullRequestEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if (candidate.action === "register" && isTrackedPullRequest(candidate.pullRequest)) {
		return { action: "register", pullRequest: candidate.pullRequest };
	}
	if (
		candidate.action === "terminal" &&
		typeof candidate.repo === "string" &&
		candidate.repo.length > 0 &&
		typeof candidate.number === "number" &&
		Number.isSafeInteger(candidate.number) &&
		candidate.number > 0 &&
		(candidate.state === "CLOSED" || candidate.state === "MERGED")
	) {
		return { action: "terminal", repo: candidate.repo, number: candidate.number, state: candidate.state };
	}
	return undefined;
}

function pullRequestKey(repo: string, number: number): string {
	return `${repo.toLowerCase()}#${number}`;
}

/** Rebuild the active session's open PR tracker from its append-only custom entries. */
export function getTrackedPullRequests(entries: readonly SessionEntry[]): TrackedPullRequest[] {
	const tracked = new Map<string, TrackedPullRequest>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TRACKED_PR_ENTRY_TYPE) continue;
		const record = parseTrackedPullRequestEntry(entry.data);
		if (!record) continue;
		const repo = record.action === "register" ? record.pullRequest.repo : record.repo;
		const number = record.action === "register" ? record.pullRequest.number : record.number;
		const key = pullRequestKey(repo, number);
		if (record.action === "register") tracked.set(key, record.pullRequest);
		else tracked.delete(key);
	}
	return [...tracked.values()];
}

/** Persist a registration exactly once, forcing a metadata-only session to be resumable. */
export async function registerTrackedPullRequest(
	sessionManager: TrackedPullRequestSessionManager,
	pullRequest: TrackedPullRequest,
): Promise<boolean> {
	const key = pullRequestKey(pullRequest.repo, pullRequest.number);
	if (
		getTrackedPullRequests(sessionManager.getBranch()).some(entry => pullRequestKey(entry.repo, entry.number) === key)
	) {
		return false;
	}
	await sessionManager.ensureOnDisk();
	sessionManager.appendCustomEntry(TRACKED_PR_ENTRY_TYPE, {
		action: "register",
		pullRequest,
	} satisfies TrackedPullRequestEntry);
	return true;
}

/** Persist terminal acknowledgement so a closed or merged PR is notified once then removed. */
export function recordTrackedPullRequestTerminal(
	sessionManager: Pick<TrackedPullRequestSessionManager, "appendCustomEntry">,
	pullRequest: Pick<TrackedPullRequest, "repo" | "number">,
	state: "CLOSED" | "MERGED",
): void {
	sessionManager.appendCustomEntry(TRACKED_PR_ENTRY_TYPE, {
		action: "terminal",
		repo: pullRequest.repo,
		number: pullRequest.number,
		state,
	} satisfies TrackedPullRequestEntry);
}

/** Compact status text for an open PR; terminal state is handled by the tracker lifecycle. */
export function getTrackedPullRequestStatus(
	pr: Pick<GhPrViewData, "state" | "isDraft" | "reviewDecision" | "mergeStateStatus">,
): TrackedPullRequestStatus {
	const state = pr.state?.toUpperCase();
	if (state === "MERGED" || state === "CLOSED")
		return { label: state.toLowerCase(), terminal: true, terminalState: state };
	if (pr.isDraft) return { label: "draft", terminal: false };
	switch (pr.reviewDecision?.toUpperCase()) {
		case "APPROVED":
			return { label: "approved", terminal: false };
		case "CHANGES_REQUESTED":
			return { label: "changes", terminal: false };
		case "REVIEW_REQUIRED":
			return { label: "review", terminal: false };
	}
	switch (pr.mergeStateStatus?.toUpperCase()) {
		case "BLOCKED":
			return { label: "blocked", terminal: false };
		case "BEHIND":
			return { label: "behind", terminal: false };
		case "DIRTY":
			return { label: "conflict", terminal: false };
	}
	return { label: "open", terminal: false };
}
