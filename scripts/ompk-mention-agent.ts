/**
 * GitHub `@ompk` mention agent — the OMPK equivalent of `@claude` /
 * `@copilot` in the GitHub agents pane.
 *
 * Driven by `.github/workflows/ompk-mention.yml`. The workflow does a cheap
 * `contains()` prefilter; this script is the precise gate + runner:
 *
 * 1. Parse the webhook payload into a `MentionTrigger` (which issue/PR, who
 *    asked, what they asked for). Mention matching mirrors GitHub's
 *    html-pipeline MentionFilter: case-insensitive, `\W` leading boundary,
 *    longer logins don't match (`@ompk-x` ≠ `@ompk`), optional `[bot]`
 *    suffix, and mentions inside fenced code blocks or inline code spans are
 *    ignored — matching when GitHub itself notifies a user.
 * 2. Authorize: the triggering user must be OWNER/MEMBER/COLLABORATOR, or
 *    hold write+ repo permission (checked live for events without an
 *    author_association, e.g. `issues.assigned`).
 * 3. Enforce delivery semantics BEFORE the agent runs. Cross-repo (fork) PRs
 *    are refused OUTRIGHT before any checkout: `gh pr checkout` would swap
 *    the worktree to fork-controlled source and the spawned
 *    `bun packages/coding-agent/src/cli.ts` would execute that source with
 *    provider secrets in env — arbitrary code execution. Same-repo PR
 *    mentions work on the head branch; issue mentions get a dedicated
 *    `<handle>/issue-<n>` branch checked out by the driver so the default
 *    branch is never the commit target.
 * 4. Gate the outcome through the M2 assignment verifier: the driver authors
 *    a digest-bound `AssignmentContract`, the agent must end its response
 *    with an `assignment-result/v1` JSON block, and
 *    `verifyAssignmentResult()` re-runs the parent-authored acceptance
 *    checks (clean worktree, changed-file scope vs the pre-run baseline SHA,
 *    non-empty report, commits-past-baseline pushed). A rejected or unproven
 *    criterion fails the run — success is never claimed from
 *    `exitCode === 0` alone.
 * 5. React 👀, run `omp --print --yolo` with a prompt pointing the agent at
 *    the `issue://` / `pr://` internal resources, and post the verified (or
 *    explicitly failed) response back as a comment.
 *
 * Pure helpers are exported for `scripts/ompk-mention-agent.test.ts`; only
 * `main()` touches the network/process surface.
 */

import {
	type AcceptanceCriterion,
	ASSIGNMENT_CONTRACT_VERSION,
	ASSIGNMENT_RESULT_VERSION,
	type AssignmentContract,
	type AssignmentContractV1,
	type AssignmentResult,
	computeAssignmentContractDigest,
} from "../packages/coding-agent/src/task/assignment-contract";
import {
	type AssignmentVerifierRunners,
	verifyAssignmentResult,
} from "../packages/coding-agent/src/task/assignment-verifier";

const DEFAULT_HANDLE = "ompk";
/** GitHub comment hard limit is 65536 chars; leave room for header/footer. */
const MAX_REPORT_CHARS = 60_000;

const TRUSTED_ASSOCIATIONS: Record<string, true> = { OWNER: true, MEMBER: true, COLLABORATOR: true };
const TRUSTED_PERMISSIONS: Record<string, true> = { admin: true, maintain: true, write: true };

interface GhUser {
	login?: string;
	type?: string;
}

interface GhComment {
	id?: number;
	body?: string;
	user?: GhUser;
	author_association?: string;
	html_url?: string;
	/** review-comment only */
	path?: string;
	line?: number | null;
	original_line?: number | null;
}

interface GhIssue {
	number?: number;
	title?: string;
	body?: string;
	user?: GhUser;
	author_association?: string;
	html_url?: string;
	pull_request?: unknown;
}

interface GhPull extends GhIssue {
	head?: { ref?: string; repo?: { full_name?: string } };
}

interface GhReview {
	id?: number;
	body?: string | null;
	user?: GhUser;
	author_association?: string;
	html_url?: string;
}

export interface EventPayload {
	action?: string;
	repository?: { full_name?: string };
	issue?: GhIssue;
	comment?: GhComment;
	pull_request?: GhPull;
	review?: GhReview;
	assignee?: GhUser;
	sender?: GhUser;
}

export interface MentionTrigger {
	/** Whether the target is an issue or a pull request. */
	kind: "issue" | "pr";
	/** `<event>.<action>` that fired, e.g. `issue_comment.created`. */
	event: string;
	/** `owner/repo`. */
	repo: string;
	/** Issue or PR number. */
	number: number;
	/** Login that triggered the run. */
	actor: string;
	/** author_association when the event carries one; null → live check. */
	association: string | null;
	/** Mention-stripped request text. */
	request: string;
	/** Extra location context (review-comment file/line). */
	location?: string;
	/** Link to the triggering item, for the prompt. */
	htmlUrl?: string;
	/** API path for the 👀 reaction, when the event supports one. */
	reactionPath?: string;
	/**
	 * PR head lives in a fork — the run is refused before checkout (fork
	 * source must never execute with secrets). `undefined` = payload did not
	 * say; the runner resolves it via `gh` before touching the worktree.
	 */
	crossRepo?: boolean;
}

export type TriggerResult = { ok: true; trigger: MentionTrigger } | { ok: false; reason: string };

/**
 * Remove fenced code blocks and inline code spans so mention detection
 * matches GitHub's behavior (no notification for `@user` inside code).
 */
export function stripCodeSegments(body: string): string {
	const out: string[] = [];
	let fenceChar: string | null = null;
	let fenceLen = 0;
	for (const line of body.split("\n")) {
		const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fenceChar === null) {
			if (fence) {
				fenceChar = fence[1][0];
				fenceLen = fence[1].length;
				continue;
			}
			// Inline spans: `code`, ``code with ` inside``, etc.
			out.push(line.replace(/(`+)[^`]*?\1/g, " "));
		} else {
			if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLen) {
				fenceChar = null;
			}
			// Fenced content (and the closing fence) is dropped entirely.
		}
	}
	return out.join("\n");
}

/**
 * Word-boundary mention matcher shared by detection and stripping, mirroring
 * GitHub's html-pipeline MentionFilter contract
 * (`(?:^|\W)@([a-z0-9][a-z0-9-]*)(?!\/)(?=\.+[ \t\W]|\.+$|[^0-9a-zA-Z_.]|$)`):
 * - Leading boundary is `\W` — punctuation INCLUDING `-` may precede the `@`
 *   (`pre-@ompk` mentions); a word char (`foo@ompk`, `_@ompk`) does not.
 * - Trailing `[a-z0-9-]` extends the username (`@ompk-extra` is a different
 *   login), `/` is rejected, and a `.` counts only before a non-word char or
 *   end of line (`@ompk.` mentions, `@ompk.x` does not).
 * - A `[bot]` suffix is additionally accepted for app-style logins.
 */
function mentionPattern(handle: string): RegExp {
	const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		String.raw`(?<![A-Za-z0-9_])@${escaped}(?:\[bot\](?![A-Za-z0-9_-])|(?![A-Za-z0-9_/-])(?=\.+[ \t\W]|\.+$|[^0-9a-zA-Z_.]|$))`,
		"gi",
	);
}

/** GitHub-compatible: is `@<handle>` mentioned in `body` (outside code)? */
export function hasMention(body: string | null | undefined, handle: string): boolean {
	if (!body) return false;
	return mentionPattern(handle).test(stripCodeSegments(body));
}

/** Strip `@<handle>` mentions and tidy the whitespace left behind. */
export function stripMention(body: string, handle: string): string {
	const stripped = body.replace(mentionPattern(handle), "");
	return stripped
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

function isBotUser(user: GhUser | undefined, handle: string): boolean {
	const login = user?.login ?? "";
	if (!login) return false;
	const lower = login.toLowerCase();
	return (
		user?.type === "Bot" ||
		lower.endsWith("[bot]") ||
		lower === handle.toLowerCase() ||
		lower === `${handle.toLowerCase()}[bot]`
	);
}

/** `true`/`false` when the payload names the head repo; undefined otherwise. */
function crossRepoFromPayload(pr: GhPull | undefined, repo: string): boolean | undefined {
	const headRepo = pr?.head?.repo?.full_name;
	if (typeof headRepo !== "string" || headRepo.length === 0) return undefined;
	return headRepo.toLowerCase() !== repo.toLowerCase();
}

/**
 * Decide whether this webhook event is an actionable `@<handle>` trigger.
 * Mirrors claude-code-action's surface: issue/PR comments, review comments,
 * review bodies, new issue/PR bodies, and agents-pane-style issue assignment.
 */
export function parseTrigger(eventName: string, payload: EventPayload, handle: string): TriggerResult {
	const repo = payload.repository?.full_name;
	if (typeof repo !== "string" || !repo.includes("/")) {
		return { ok: false, reason: "payload missing repository.full_name" };
	}
	const action = payload.action ?? "";
	const event = `${eventName}.${action}`;

	if (eventName === "issue_comment" && action === "created") {
		const issue = payload.issue ?? {};
		const comment = payload.comment ?? {};
		if (typeof issue.number !== "number") return { ok: false, reason: "comment missing issue number" };
		if (isBotUser(comment.user, handle)) return { ok: false, reason: "bot-authored comment" };
		if (!hasMention(comment.body, handle)) return { ok: false, reason: `no @${handle} mention in comment` };
		return {
			ok: true,
			trigger: {
				kind: issue.pull_request ? "pr" : "issue",
				event,
				repo,
				number: issue.number,
				actor: comment.user?.login ?? "",
				association: comment.author_association ?? null,
				request: stripMention(comment.body ?? "", handle),
				htmlUrl: comment.html_url,
				reactionPath: `repos/${repo}/issues/comments/${comment.id}/reactions`,
				// issue_comment payloads carry no PR head info; runner resolves.
			},
		};
	}

	if (eventName === "pull_request_review_comment" && action === "created") {
		const pr = payload.pull_request ?? {};
		const comment = payload.comment ?? {};
		if (typeof pr.number !== "number") return { ok: false, reason: "review comment missing PR number" };
		if (isBotUser(comment.user, handle)) return { ok: false, reason: "bot-authored review comment" };
		if (!hasMention(comment.body, handle)) return { ok: false, reason: `no @${handle} mention in review comment` };
		const line = comment.line ?? comment.original_line;
		return {
			ok: true,
			trigger: {
				kind: "pr",
				event,
				repo,
				number: pr.number,
				actor: comment.user?.login ?? "",
				association: comment.author_association ?? null,
				request: stripMention(comment.body ?? "", handle),
				location: comment.path ? `${comment.path}${typeof line === "number" ? `:${line}` : ""}` : undefined,
				htmlUrl: comment.html_url,
				reactionPath: `repos/${repo}/pulls/comments/${comment.id}/reactions`,
				crossRepo: crossRepoFromPayload(pr, repo),
			},
		};
	}

	if (eventName === "pull_request_review" && action === "submitted") {
		const pr = payload.pull_request ?? {};
		const review = payload.review ?? {};
		if (typeof pr.number !== "number") return { ok: false, reason: "review missing PR number" };
		if (isBotUser(review.user, handle)) return { ok: false, reason: "bot-authored review" };
		if (!hasMention(review.body, handle)) return { ok: false, reason: `no @${handle} mention in review body` };
		return {
			ok: true,
			trigger: {
				kind: "pr",
				event,
				repo,
				number: pr.number,
				actor: review.user?.login ?? "",
				association: review.author_association ?? null,
				request: stripMention(review.body ?? "", handle),
				htmlUrl: review.html_url,
				crossRepo: crossRepoFromPayload(pr, repo),
				// Review bodies have no reaction endpoint.
			},
		};
	}

	// PR title/body mentions on open. `edited` is deliberately NOT handled:
	// without newly-added-mention tracking it would re-trigger on every
	// unrelated edit while a mention exists — mention again in a comment to
	// re-run instead.
	if (eventName === "pull_request" && action === "opened") {
		const pr = payload.pull_request ?? {};
		if (typeof pr.number !== "number") return { ok: false, reason: "pull request missing number" };
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
				request: stripMention(pr.body ?? "", handle),
				htmlUrl: pr.html_url,
				// PR reactions go through the issues endpoint.
				reactionPath: `repos/${repo}/issues/${pr.number}/reactions`,
				crossRepo: crossRepoFromPayload(pr, repo),
			},
		};
	}

	if (eventName === "issues") {
		const issue = payload.issue ?? {};
		if (typeof issue.number !== "number") return { ok: false, reason: "issue missing number" };
		if (issue.pull_request) return { ok: false, reason: "issue payload is a pull request" };
		const reactionPath = `repos/${repo}/issues/${issue.number}/reactions`;

		if (action === "opened") {
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
					request: stripMention(issue.body ?? "", handle),
					htmlUrl: issue.html_url,
					reactionPath,
				},
			};
		}

		// Agents-pane parity: assigning the issue to the handle == asking the
		// agent to take it on. The *assigner* (sender) is the authorizer; the
		// payload has no association for them, so `association: null` routes
		// main() through a live permission check.
		if (action === "assigned") {
			const assignee = payload.assignee?.login ?? "";
			if (assignee.toLowerCase() !== handle.toLowerCase()) {
				return { ok: false, reason: `assigned to @${assignee}, not @${handle}` };
			}
			return {
				ok: true,
				trigger: {
					kind: "issue",
					event,
					repo,
					number: issue.number,
					actor: payload.sender?.login ?? "",
					association: null,
					request: `${issue.title ?? ""}\n\n${stripMention(issue.body ?? "", handle)}`.trim(),
					htmlUrl: issue.html_url,
					reactionPath,
				},
			};
		}
		return { ok: false, reason: `issues.${action} not handled` };
	}

	return { ok: false, reason: `${event} not handled` };
}

// ---------------------------------------------------------------------------
// Assignment contract (M2 verification gate)
// ---------------------------------------------------------------------------

/**
 * POSIX single-quote escaping for values interpolated into parent-authored
 * acceptance commands: close the quote, emit a literal `'`, reopen. Branch
 * names and temp paths are external inputs; NEVER splice them in raw.
 */
export function shQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface ContractOptions {
	/** Unique run discriminator (GITHUB_RUN_ID). */
	runId: string;
	/** HEAD after checkout/branch setup, before the agent runs. */
	baselineSha: string;
	/** Branch any new commits must land on (issue work branch or PR head). */
	deliveryBranch: string;
	/** File the driver writes the public report to before verification. */
	reportFile: string;
}

/**
 * Author the digest-bound contract the run is verified against. The
 * acceptance checks are parent-authored and re-executed by the driver after
 * the agent finishes — never taken from the child's own claims:
 *
 * - `clean-worktree` (`command_exit`): the working tree must be clean, so
 *   every change is either committed to the sanctioned branch or reverted.
 * - `changed-files-in-scope` (`changed_file_scope`): the child's reported
 *   `changedFiles` must exactly match the driver's baseline-diff observation
 *   and stay inside the declared scope.
 * - `public-report` (`command_exit`): the posted reply body must be
 *   non-empty — a bare result block with no prose fails.
 * - `work-delivered` (`command_exit`): commits made past the baseline must
 *   actually exist on the remote delivery branch; a fabricated "success"
 *   over unpushed (or no-op-claimed-as-pushed) work fails. Runs with zero
 *   new commits pass — answering without code changes is a legitimate
 *   outcome, adjudicated by the human reading the reply.
 */
export function buildAssignmentContract(trigger: MentionTrigger, opts: ContractOptions): AssignmentContractV1 {
	if (!/^[0-9a-f]{4,64}$/i.test(opts.baselineSha)) {
		throw new Error(`baselineSha is not a hex object id: ${JSON.stringify(opts.baselineSha)}`);
	}
	const acceptance: AcceptanceCriterion[] = [
		{
			id: "clean-worktree",
			description: "Working tree is clean after the run: every change is committed or reverted",
			check: "command_exit",
			params: { command: 'test -z "$(git status --porcelain)"' },
		},
		{
			id: "changed-files-in-scope",
			description: "Reported changedFiles exactly match the files changed since the baseline commit",
			check: "changed_file_scope",
		},
		{
			id: "public-report",
			description: "The posted reply body is non-empty",
			check: "command_exit",
			params: { command: `test -s ${shQuote(opts.reportFile)}` },
		},
		{
			id: "work-delivered",
			description: `Commits made past baseline ${opts.baselineSha} exist on origin/${opts.deliveryBranch}`,
			check: "command_exit",
			params: {
				command: `test -z "$(git rev-list '${opts.baselineSha}..HEAD')" || { git fetch -q origin ${shQuote(opts.deliveryBranch)} && test -z "$(git rev-list ${shQuote(`origin/${opts.deliveryBranch}`)}..HEAD)"; }`,
			},
		},
	];
	const deliverables =
		trigger.kind === "pr"
			? ["Focused commits on the PR head branch, pushed", "A summary of what changed and what was verified"]
			: [
					`Either commits on the work branch pushed with a PR referencing #${trigger.number}, or a direct answer when no code change is needed`,
				];
	const base = {
		version: ASSIGNMENT_CONTRACT_VERSION,
		id: `ompk-mention/${trigger.repo}#${trigger.number}/${opts.runId}`,
		revision: 1,
		role: "github-mention-agent",
		workClass: "judgment" as const,
		autonomy: "supervised" as const,
		objective: trigger.request || `Handle ${trigger.repo}#${trigger.number} as requested in the thread`,
		deliverables,
		scope: { allowedPaths: ["."] },
		acceptance,
		reporting: ASSIGNMENT_RESULT_VERSION,
	};
	return { ...base, digest: computeAssignmentContractDigest(base) };
}

export interface ExtractedResult {
	/** Parsed candidate (validated later by the verifier); undefined = absent. */
	result?: AssignmentResult;
	/** Report text with the result block removed — safe to post publicly. */
	rest: string;
}

const RESULT_BLOCK_REGEX = /```json\s*\n([\s\S]*?)\n\s*```/g;

/**
 * Pull the trailing `assignment-result/v1` JSON block out of the agent's
 * printed response. The last parseable block whose `version` matches wins;
 * everything else stays in the public report text.
 */
export function extractAssignmentResult(report: string): ExtractedResult {
	let found: { start: number; end: number; value: AssignmentResult } | undefined;
	for (const match of report.matchAll(RESULT_BLOCK_REGEX)) {
		try {
			const value = JSON.parse(match[1]) as { version?: unknown };
			if (typeof value.version === "string" && value.version.startsWith("assignment-result/")) {
				found = { start: match.index, end: match.index + match[0].length, value: value as AssignmentResult };
			}
		} catch {
			// Not JSON — an ordinary code block; leave it in the report.
		}
	}
	if (!found) return { rest: report };
	return {
		result: found.value,
		rest: `${report.slice(0, found.start)}${report.slice(found.end)}`.trim(),
	};
}

export interface PromptOptions {
	handle: string;
	runUrl?: string;
	/** Issue triggers only: the work branch the driver already checked out. */
	workBranch?: string;
	/** Digest-bound contract the run is verified against. */
	contract?: AssignmentContract;
	/** HEAD before the agent runs; changedFiles are diffed against this. */
	baselineSha?: string;
}

/** Build the single-shot prompt handed to `omp --print`. */
export function buildPrompt(trigger: MentionTrigger, opts: PromptOptions): string {
	const { repo, number } = trigger;
	const contextRef =
		trigger.kind === "pr"
			? `Pull request #${number} — read \`pr://${repo}/${number}\` for the full thread and \`pr://${repo}/${number}/diff\` for the change list before doing anything else.`
			: `Issue #${number} — read \`issue://${repo}/${number}\` for the full thread before doing anything else.`;
	const branchRules =
		trigger.kind === "pr"
			? [
					"- You are checked out on the PR head branch. Make focused commits with clear messages and `git push` when the work is done.",
					"- NEVER commit to or push the repository's default branch.",
				]
			: [
					`- The driver already checked out the work branch \`${opts.workBranch ?? `${opts.handle}/issue-${number}`}\` for you. Commit your work there, push it, and open a PR referencing #${number} via \`gh pr create\`.`,
					"- NEVER commit to or push the repository's default branch.",
					"- If the request needs no code change, just answer it.",
				];
	const contractSection = opts.contract
		? [
				"",
				"## Assignment contract",
				"Your run is verified against this digest-bound contract. The driver independently re-runs every acceptance check after you finish — claims you cannot support MUST be reported as failed.",
				"```json",
				JSON.stringify(opts.contract, null, "\t"),
				"```",
				"",
				"## Result reporting (MANDATORY)",
				"End your final response with a fenced ```json code block containing an `assignment-result/v1` object:",
				"- Copy `contractId` (= the contract's `id`), `revision`, and `digest` from the contract verbatim.",
				'- `status`: "success" only when every acceptance criterion truly holds; otherwise "partial", "failed", or "blocked".',
				`- \`changedFiles\`: every file changed relative to the baseline commit${opts.baselineSha ? ` \`${opts.baselineSha}\`` : ""} (use \`git diff --name-only ${opts.baselineSha ?? "<baseline>"}\` plus any untracked files). Empty when you changed nothing.`,
				'- `evidence`: one entry per acceptance criterion: `{ "criterionId", "passed", "summary" }` with a concrete, non-placeholder summary.',
				"- `summary`: one-paragraph outcome description.",
				"Omitting this block, or failing verification, marks the run failed.",
			]
		: [];
	const lines = [
		`You are @${opts.handle}, an autonomous coding agent triggered by a GitHub mention (like @claude / @copilot).`,
		"",
		"## Context",
		`- Repository: ${repo}, checked out at the current working directory.`,
		`- ${contextRef}`,
		`- Triggered by @${trigger.actor} via \`${trigger.event}\`${trigger.location ? ` on \`${trigger.location}\`` : ""}.`,
		...(opts.baselineSha ? [`- Baseline commit (pre-run HEAD): ${opts.baselineSha}`] : []),
		...(trigger.htmlUrl ? [`- Trigger link: ${trigger.htmlUrl}`] : []),
		...(opts.runUrl ? [`- This run: ${opts.runUrl}`] : []),
		"",
		"## Request",
		trigger.request || "(no explicit request — infer the needed work from the thread above)",
		"",
		"## Operating rules",
		"- Read the referenced issue/PR resource first; it is the authoritative task context.",
		"- Keep changes scoped to the request; run the relevant tests/checks before finishing.",
		...branchRules,
		"- Do NOT post GitHub comments yourself — your final response text is posted as the reply automatically.",
		"- If the request is unclear, destructive, or out of scope, explain why instead of guessing.",
		...contractSection,
	];
	return lines.join("\n");
}

/** Clamp the agent's report to fit GitHub's comment size limit. */
export function truncateReport(report: string, max = MAX_REPORT_CHARS): string {
	if (report.length <= max) return report;
	return `${report.slice(0, max)}\n\n… _(truncated: response exceeded the comment size limit)_`;
}

export interface VerificationSummary {
	verified: boolean;
	reasons: readonly string[];
}

export function buildComment(opts: {
	handle: string;
	ok: boolean;
	report: string;
	runUrl?: string;
	verification?: VerificationSummary;
}): string {
	const header = opts.ok ? `### \`@${opts.handle}\`` : `### \`@${opts.handle}\` — run failed`;
	const body = truncateReport(opts.report.trim() || "_(the agent produced no output)_");
	const verification =
		opts.verification && !opts.verification.verified
			? `\n\n#### Verification\nThe result did not pass independent verification:\n${opts.verification.reasons
					.map(reason => `- ${reason}`)
					.join("\n")}`
			: "";
	const footer = opts.runUrl ? `\n\n---\n_[workflow run](${opts.runUrl})_` : "";
	return `${header}\n\n${body}${verification}${footer}`;
}

// ---------------------------------------------------------------------------
// Runner (side effects live below this line only)
// ---------------------------------------------------------------------------

async function run(cmd: string[], opts?: { allowFailure?: boolean; cwd?: string }): Promise<string> {
	const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: opts?.cwd });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0 && !opts?.allowFailure) {
		throw new Error(`\`${cmd.join(" ")}\` exited ${exitCode}: ${stderr.trim() || stdout.trim()}`);
	}
	return stdout;
}

/** Parent-authored acceptance commands run through a plain shell. */
const verifierRunners: AssignmentVerifierRunners = {
	runCommand: async command => {
		const proc = Bun.spawn(["bash", "-c", command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, timedOut: false, stdout, stderr };
	},
};

/**
 * Authoritative changed-file list: tracked changes (committed + staged +
 * unstaged) relative to the pre-run baseline SHA, plus untracked files.
 */
async function collectChangedFiles(baselineSha: string): Promise<string[]> {
	const tracked = await run(["git", "diff", "--name-only", baselineSha]);
	const untracked = await run(["git", "ls-files", "--others", "--exclude-standard"]);
	const files = new Set<string>();
	for (const line of `${tracked}\n${untracked}`.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) files.add(trimmed);
	}
	return [...files].sort();
}

/**
 * Check out the issue work branch, RESUMING any prior agent run: when
 * `origin/<branch>` already exists (a follow-up `@ompk` mention on the same
 * issue), continue from the pushed tip instead of resetting to the default
 * branch — otherwise the next push would be non-fast-forward or, worse,
 * force-clobber earlier agent work. Fresh issues branch from current HEAD.
 */
export async function checkoutIssueBranch(branch: string, cwd?: string): Promise<"resumed" | "created"> {
	// Explicit refspec: plain `git fetch origin <branch>` is only guaranteed
	// to land in FETCH_HEAD; the rev-parse below reads the tracking ref.
	await run(["git", "fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
		cwd,
		allowFailure: true,
	});
	const remoteTip = (
		await run(["git", "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
			cwd,
			allowFailure: true,
		})
	).trim();
	if (remoteTip) {
		await run(["git", "checkout", "-B", branch, `origin/${branch}`], { cwd });
		return "resumed";
	}
	await run(["git", "checkout", "-B", branch], { cwd });
	return "created";
}

async function postComment(repo: string, number: number, body: string): Promise<void> {
	const file = `${process.env.RUNNER_TEMP ?? "/tmp"}/ompk-mention-comment.md`;
	await Bun.write(file, body);
	await run(["gh", "api", "-X", "POST", `repos/${repo}/issues/${number}/comments`, "-F", `body=@${file}`]);
}

async function main(): Promise<void> {
	const eventName = process.env.GITHUB_EVENT_NAME;
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventName || !eventPath) {
		throw new Error("GITHUB_EVENT_NAME / GITHUB_EVENT_PATH are required (run this from GitHub Actions)");
	}
	const handle = process.env.OMPK_MENTION_HANDLE || DEFAULT_HANDLE;
	const payload = (await Bun.file(eventPath).json()) as EventPayload;

	const result = parseTrigger(eventName, payload, handle);
	if (!result.ok) {
		console.log(`skip: ${result.reason}`);
		return;
	}
	const trigger = result.trigger;
	console.log(`trigger: ${trigger.event} on ${trigger.repo}#${trigger.number} by @${trigger.actor}`);

	// --- authorization ------------------------------------------------------
	let authorized = isTrustedAssociation(trigger.association);
	if (!authorized && trigger.actor) {
		const out = await run(
			["gh", "api", `repos/${trigger.repo}/collaborators/${trigger.actor}/permission`, "--jq", ".permission"],
			{ allowFailure: true },
		);
		authorized = isTrustedPermission(out.trim());
	}
	if (!authorized) {
		// Silent skip: replying to untrusted mentions would let anyone spend
		// CI minutes / tokens by mentioning the handle.
		console.log(`skip: @${trigger.actor} (association=${trigger.association ?? "none"}) is not authorized`);
		return;
	}

	// --- fork refusal (BEFORE any checkout) ----------------------------------
	// `gh pr checkout` on a cross-repo PR would swap this worktree to
	// fork-controlled source, and the spawned `bun packages/coding-agent/...`
	// would execute that source with provider secrets in env. Refuse outright.
	if (trigger.kind === "pr") {
		let crossRepo = trigger.crossRepo;
		if (crossRepo === undefined) {
			const out = await run([
				"gh",
				"pr",
				"view",
				String(trigger.number),
				"--json",
				"isCrossRepository",
				"--jq",
				".isCrossRepository",
			]);
			crossRepo = out.trim() === "true";
		}
		if (crossRepo) {
			console.log("skip: cross-repo (fork) PR — refusing to execute fork-controlled source");
			await postComment(
				trigger.repo,
				trigger.number,
				`### \`@${handle}\`\n\nI can't work on fork PRs: running the agent would execute the fork's code with repository secrets. Push this branch to the base repository (or let a maintainer recreate it there) and mention me again.`,
			);
			return;
		}
	}

	// --- acknowledge --------------------------------------------------------
	if (trigger.reactionPath) {
		await run(["gh", "api", "-X", "POST", trigger.reactionPath, "-f", "content=eyes"], { allowFailure: true });
	}

	// --- workspace + delivery semantics --------------------------------------
	// PR: work on the same-repo head branch. Issue: the driver checks out a
	// dedicated branch so the default branch is never the commit target.
	let workBranch: string | undefined;
	let deliveryBranch: string;
	if (trigger.kind === "pr") {
		await run(["gh", "pr", "checkout", String(trigger.number)]);
		deliveryBranch = (await run(["git", "rev-parse", "--abbrev-ref", "HEAD"])).trim();
	} else {
		workBranch = `${handle}/issue-${trigger.number}`;
		deliveryBranch = workBranch;
		// Follow-up mentions continue from the previously pushed tip.
		const mode = await checkoutIssueBranch(workBranch);
		console.log(`work branch ${workBranch}: ${mode}`);
	}

	// Baseline AFTER checkout/branch setup, BEFORE the agent runs: the
	// authoritative changedFiles diff is anchored here.
	const baselineSha = (await run(["git", "rev-parse", "HEAD"])).trim();

	// --- run the agent ------------------------------------------------------
	const runUrl =
		process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
			? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
			: undefined;
	const reportFile = `${process.env.RUNNER_TEMP ?? "/tmp"}/ompk-mention-report.md`;
	const contract = buildAssignmentContract(trigger, {
		runId: process.env.GITHUB_RUN_ID ?? String(Date.now()),
		baselineSha,
		deliveryBranch,
		reportFile,
	});
	const prompt = buildPrompt(trigger, { handle, runUrl, workBranch, contract, baselineSha });
	const model = process.env.OMPK_MENTION_MODEL;
	const cmd = [
		"bun",
		"packages/coding-agent/src/cli.ts",
		"--print",
		"--yolo",
		"--no-session",
		...(model ? ["--model", model] : []),
		prompt,
	];
	console.log(`running: ${cmd.slice(0, -1).join(" ")} <prompt>`);
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
	const rawReport = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;

	// --- verify --------------------------------------------------------------
	// Success requires the digest-bound result block to pass independent
	// verification: parent-authored checks re-run by the driver, and the
	// child's changedFiles reconciled against the baseline diff. exitCode
	// alone NEVER produces a success outcome.
	const { result: assignmentResult, rest: report } = extractAssignmentResult(rawReport);
	// The public-report acceptance criterion reads this file; write it before
	// the verifier runs the parent-authored checks.
	await Bun.write(reportFile, report);
	let verification: VerificationSummary;
	if (exitCode !== 0) {
		verification = { verified: false, reasons: [`agent process exited ${exitCode}`] };
	} else if (!assignmentResult) {
		verification = { verified: false, reasons: ["agent did not emit the mandatory assignment-result block"] };
	} else {
		const outcome = await verifyAssignmentResult({
			contract,
			result: assignmentResult,
			runners: verifierRunners,
			actualChangedFiles: await collectChangedFiles(baselineSha),
		});
		verification = { verified: outcome.verified, reasons: outcome.reasons };
	}
	const ok = verification.verified;
	console.log(`verification: ${ok ? "verified" : `REJECTED — ${verification.reasons.join("; ")}`}`);

	// --- reply --------------------------------------------------------------
	await postComment(trigger.repo, trigger.number, buildComment({ handle, ok, report, runUrl, verification }));
	if (!ok) {
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	await main();
}
