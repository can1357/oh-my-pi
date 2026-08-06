export interface GitHubUser {
	login?: string;
	type?: string;
}

export interface GitHubEventPayload {
	action?: string;
	repository?: { full_name?: string; default_branch?: string; owner?: { login?: string } };
	installation?: { id?: number; account?: { login?: string } };
	issue?: {
		number?: number;
		title?: string;
		body?: string | null;
		user?: GitHubUser;
		author_association?: string;
		pull_request?: unknown;
		html_url?: string;
	};
	comment?: {
		id?: number;
		body?: string | null;
		user?: GitHubUser;
		author_association?: string;
		html_url?: string;
		path?: string;
		line?: number | null;
		original_line?: number | null;
	};
	pull_request?: {
		number?: number;
		title?: string;
		body?: string | null;
		user?: GitHubUser;
		author_association?: string;
		html_url?: string;
		head?: { ref?: string; repo?: { full_name?: string } };
		base?: { ref?: string; repo?: { full_name?: string } };
	};
	review?: {
		id?: number;
		body?: string | null;
		user?: GitHubUser;
		author_association?: string;
		html_url?: string;
	};
	sender?: GitHubUser;
}

export interface GitHubMentionTrigger {
	kind: "issue" | "pr";
	event: string;
	repo: string;
	number: number;
	actor: string;
	association: string | null;
	request: string;
	/**
	 * Redelivery-stable identity: GitHub retries reuse comment/review ids while
	 * the X-GitHub-Delivery GUID changes per attempt, so dedupe keys use this.
	 */
	dedupeId: string;
	htmlUrl?: string;
	location?: string;
	crossRepo?: boolean;
}

export type GitHubTriggerResult = { ok: true; trigger: GitHubMentionTrigger } | { ok: false; reason: string };

const TRUSTED_ASSOCIATIONS: Record<string, true> = { OWNER: true, MEMBER: true, COLLABORATOR: true };
const TRUSTED_PERMISSIONS: Record<string, true> = { admin: true, maintain: true, write: true };

export function stripCodeSegments(body: string): string {
	const out: string[] = [];
	let fenceChar: string | null = null;
	let fenceLength = 0;
	for (const line of body.split("\n")) {
		const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fenceChar === null) {
			if (fence) {
				fenceChar = fence[1]![0]!;
				fenceLength = fence[1]!.length;
				continue;
			}
			out.push(line.replace(/(`+)[^`]*?\1/g, " "));
		} else if (fence && fence[1]![0] === fenceChar && fence[1]!.length >= fenceLength) {
			fenceChar = null;
		}
	}
	return out.join("\n");
}

function mentionPattern(handle: string): RegExp {
	const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		String.raw`(?<![A-Za-z0-9_])@${escaped}(?:\[bot\](?![A-Za-z0-9_-])|(?![A-Za-z0-9_/-])(?=\.+[ \t\W]|\.+$|[^0-9A-Za-z_.]|$))`,
		"gi",
	);
}

export function hasMention(body: string | null | undefined, handle: string): boolean {
	return Boolean(body && mentionPattern(handle).test(stripCodeSegments(body)));
}

export function stripMention(body: string, handle: string): string {
	return body
		.replace(mentionPattern(handle), "")
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
		.trim();
}

export function isTrustedAssociation(association: string | null | undefined): boolean {
	return typeof association === "string" && TRUSTED_ASSOCIATIONS[association.toUpperCase()] === true;
}

export function isTrustedPermission(permission: string | null | undefined): boolean {
	return typeof permission === "string" && TRUSTED_PERMISSIONS[permission.toLowerCase()] === true;
}

function isBotUser(user: GitHubUser | undefined, handle: string): boolean {
	const login = user?.login?.toLowerCase() ?? "";
	return Boolean(login && (user?.type === "Bot" || login.endsWith("[bot]") || login === handle.toLowerCase()));
}

function crossRepo(pr: GitHubEventPayload["pull_request"], repo: string): boolean | undefined {
	const headRepo = pr?.head?.repo?.full_name;
	return typeof headRepo === "string" && headRepo.length > 0
		? headRepo.toLowerCase() !== repo.toLowerCase()
		: undefined;
}

export function parseGitHubTrigger(
	eventName: string,
	payload: GitHubEventPayload,
	handle: string,
): GitHubTriggerResult {
	const repo = payload.repository?.full_name;
	if (!repo?.includes("/")) return { ok: false, reason: "payload missing repository.full_name" };
	const action = payload.action ?? "";
	const event = `${eventName}.${action}`;

	if (eventName === "issue_comment" && action === "created") {
		const issue = payload.issue;
		const comment = payload.comment;
		if (typeof issue?.number !== "number") return { ok: false, reason: "comment missing issue number" };
		if (isBotUser(comment?.user, handle)) return { ok: false, reason: "bot-authored comment" };
		if (!hasMention(comment?.body, handle)) return { ok: false, reason: `no @${handle} mention in comment` };
		return {
			ok: true,
			trigger: {
				kind: issue.pull_request ? "pr" : "issue",
				event,
				repo,
				number: issue.number,
				actor: comment?.user?.login ?? "",
				association: comment?.author_association ?? null,
				request: stripMention(comment?.body ?? "", handle),
				dedupeId: `issue_comment:${comment?.id ?? `${repo}#${issue.number}`}`,
				htmlUrl: comment?.html_url,
			},
		};
	}

	if (eventName === "pull_request_review_comment" && action === "created") {
		const pr = payload.pull_request;
		const comment = payload.comment;
		if (typeof pr?.number !== "number") return { ok: false, reason: "review comment missing PR number" };
		if (isBotUser(comment?.user, handle)) return { ok: false, reason: "bot-authored review comment" };
		if (!hasMention(comment?.body, handle)) return { ok: false, reason: `no @${handle} mention in review comment` };
		const line = comment?.line ?? comment?.original_line;
		return {
			ok: true,
			trigger: {
				kind: "pr",
				event,
				repo,
				number: pr.number,
				actor: comment?.user?.login ?? "",
				association: comment?.author_association ?? null,
				request: stripMention(comment?.body ?? "", handle),
				dedupeId: `review_comment:${comment?.id ?? `${repo}#${pr.number}`}`,
				location: comment?.path ? `${comment.path}${typeof line === "number" ? `:${line}` : ""}` : undefined,
				htmlUrl: comment?.html_url,
				crossRepo: crossRepo(pr, repo),
			},
		};
	}

	if (eventName === "pull_request_review" && action === "submitted") {
		const pr = payload.pull_request;
		const review = payload.review;
		if (typeof pr?.number !== "number") return { ok: false, reason: "review missing PR number" };
		if (isBotUser(review?.user, handle)) return { ok: false, reason: "bot-authored review" };
		if (!hasMention(review?.body, handle)) return { ok: false, reason: `no @${handle} mention in review body` };
		return {
			ok: true,
			trigger: {
				kind: "pr",
				event,
				repo,
				number: pr.number,
				actor: review?.user?.login ?? "",
				association: review?.author_association ?? null,
				request: stripMention(review?.body ?? "", handle),
				dedupeId: `review:${review?.id ?? `${repo}#${pr.number}`}`,
				htmlUrl: review?.html_url,
				crossRepo: crossRepo(pr, repo),
			},
		};
	}

	if (eventName === "pull_request" && action === "opened") {
		const pr = payload.pull_request;
		if (typeof pr?.number !== "number") return { ok: false, reason: "pull request missing number" };
		if (isBotUser(pr.user, handle)) return { ok: false, reason: "bot-authored pull request" };
		if (!hasMention(pr.body, handle) && !hasMention(pr.title, handle)) {
			return { ok: false, reason: `no @${handle} mention in PR body/title` };
		}
		return {
			ok: true,
			trigger: {
				kind: "pr",
				event,
				repo,
				number: pr.number,
				actor: pr.user?.login ?? "",
				association: pr.author_association ?? null,
				request: `${stripMention(pr.title ?? "", handle)}\n\n${stripMention(pr.body ?? "", handle)}`.trim(),
				dedupeId: `pr_opened:${repo}#${pr.number}`,
				htmlUrl: pr.html_url,
				crossRepo: crossRepo(pr, repo),
			},
		};
	}

	if (eventName === "issues" && action === "opened") {
		const issue = payload.issue;
		if (typeof issue?.number !== "number") return { ok: false, reason: "issue missing number" };
		if (issue.pull_request) return { ok: false, reason: "issue payload is a pull request" };
		if (isBotUser(issue.user, handle)) return { ok: false, reason: "bot-authored issue" };
		if (!hasMention(issue.body, handle) && !hasMention(issue.title, handle)) {
			return { ok: false, reason: `no @${handle} mention in issue body/title` };
		}
		return {
			ok: true,
			trigger: {
				kind: "issue",
				event,
				repo,
				number: issue.number,
				actor: issue.user?.login ?? "",
				association: issue.author_association ?? null,
				request: `${stripMention(issue.title ?? "", handle)}\n\n${stripMention(issue.body ?? "", handle)}`.trim(),
				dedupeId: `issue_opened:${repo}#${issue.number}`,
				htmlUrl: issue.html_url,
			},
		};
	}

	return { ok: false, reason: `${event} not handled` };
}

const SUPPORTED_EVENTS: Record<string, true> = {
	issues: true,
	issue_comment: true,
	pull_request: true,
	pull_request_review: true,
	pull_request_review_comment: true,
};

export function isSupportedGitHubEvent(eventName: string): boolean {
	return SUPPORTED_EVENTS[eventName] === true;
}
