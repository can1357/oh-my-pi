// Behavior tests for the `@ompk` GitHub mention agent driver
// (scripts/ompk-mention-agent.ts): GitHub-compatible mention matching,
// webhook trigger routing, authorization gates, delivery-mode prompt rules,
// shell-safe criterion authoring, the M2 assignment-verification gate (an
// unproven or rejected criterion must block the success outcome), and a
// drift guard binding the workflow's event surface to the driver's.

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssignmentContractV1, AssignmentResult } from "../packages/coding-agent/src/task/assignment-contract";
import {
	type AssignmentVerifierRunners,
	verifyAssignmentResult,
} from "../packages/coding-agent/src/task/assignment-verifier";
import {
	buildAssignmentContract,
	buildComment,
	buildPrompt,
	checkoutIssueBranch,
	type EventPayload,
	extractAssignmentResult,
	hasMention,
	isTrustedAssociation,
	isTrustedPermission,
	type MentionDeps,
	type MentionTrigger,
	parseTrigger,
	runMentionAgent,
	shQuote,
	stripCodeSegments,
	stripMention,
	truncateReport,
} from "./ompk-mention-agent";

const HANDLE = "ompk";
const BASELINE = "0123abcd0123abcd0123abcd0123abcd0123abcd";
const REPORT_FILE = "/tmp/report.md";

function issueCommentPayload(overrides?: {
	body?: string;
	association?: string;
	login?: string;
	userType?: string;
	pullRequest?: boolean;
}): EventPayload {
	return {
		action: "created",
		repository: { full_name: "octo/widget" },
		issue: {
			number: 42,
			title: "Widget breaks",
			body: "It broke.",
			...(overrides?.pullRequest ? { pull_request: {} } : {}),
		},
		comment: {
			id: 777,
			body: overrides?.body ?? `@${HANDLE} please fix this`,
			user: { login: overrides?.login ?? "alice", type: overrides?.userType ?? "User" },
			author_association: overrides?.association ?? "MEMBER",
			html_url: "https://github.com/octo/widget/issues/42#issuecomment-777",
		},
	};
}

describe("mention matching (GitHub-compatible)", () => {
	it("matches plain, case-insensitive, and [bot]-suffixed mentions", () => {
		expect(hasMention("@ompk fix this", HANDLE)).toBe(true);
		expect(hasMention("hey @OMPK, thoughts?", HANDLE)).toBe(true);
		expect(hasMention("cc @ompk[bot]", HANDLE)).toBe(true);
		expect(hasMention("(@ompk)", HANDLE)).toBe(true);
	});

	it("respects login word boundaries like GitHub's MentionFilter", () => {
		// Fixtures follow html-pipeline's MENTION_PATTERN:
		// (?:^|\W)@([a-z0-9][a-z0-9-]*)(?!\/)(?=\.+[ \t\W]|\.+$|[^0-9a-zA-Z_.]|$)
		expect(hasMention("@ompkx fix", HANDLE)).toBe(false);
		expect(hasMention("@ompk-extra fix", HANDLE)).toBe(false); // longer login
		expect(hasMention("mail me at foo@ompk", HANDLE)).toBe(false); // \W boundary
		expect(hasMention("_@ompk", HANDLE)).toBe(false); // `_` is a word char
		expect(hasMention("pre-@ompk works", HANDLE)).toBe(true); // `-` is \W
		expect(hasMention("@ompk/path", HANDLE)).toBe(false); // (?!\/)
		expect(hasMention("@ompk.x", HANDLE)).toBe(false); // dot then word char
		expect(hasMention("@ompk.", HANDLE)).toBe(true); // dots at end of line
		expect(hasMention("@ompk, thanks", HANDLE)).toBe(true);
	});

	it("ignores mentions inside fenced code blocks and inline code", () => {
		expect(hasMention("```\n@ompk in a fence\n```", HANDLE)).toBe(false);
		expect(hasMention("run `@ompk` literally", HANDLE)).toBe(false);
		expect(hasMention("~~~text\n@ompk\n~~~", HANDLE)).toBe(false);
		expect(hasMention("```\ncode\n```\n@ompk after the fence", HANDLE)).toBe(true);
	});

	it("stripCodeSegments drops fenced content but keeps surrounding prose", () => {
		const out = stripCodeSegments("before\n```js\nsecret()\n```\nafter");
		expect(out).toContain("before");
		expect(out).toContain("after");
		expect(out).not.toContain("secret()");
	});

	it("stripMention removes the handle and tidies whitespace", () => {
		expect(stripMention("@ompk   please fix the build", HANDLE)).toBe("please fix the build");
		expect(stripMention("do it, @OMPK[bot], now", HANDLE)).toBe("do it, , now");
	});
});

describe("trust gates", () => {
	it("accepts owner/member/collaborator associations only", () => {
		expect(isTrustedAssociation("OWNER")).toBe(true);
		expect(isTrustedAssociation("member")).toBe(true);
		expect(isTrustedAssociation("COLLABORATOR")).toBe(true);
		expect(isTrustedAssociation("CONTRIBUTOR")).toBe(false);
		expect(isTrustedAssociation("NONE")).toBe(false);
		expect(isTrustedAssociation(null)).toBe(false);
	});

	it("accepts write+ repo permissions only", () => {
		expect(isTrustedPermission("admin")).toBe(true);
		expect(isTrustedPermission("write")).toBe(true);
		expect(isTrustedPermission("maintain")).toBe(true);
		expect(isTrustedPermission("read")).toBe(false);
		expect(isTrustedPermission("none")).toBe(false);
		expect(isTrustedPermission(null)).toBe(false);
	});
});

describe("parseTrigger", () => {
	it("routes an issue comment mention to an issue trigger", () => {
		const result = parseTrigger("issue_comment", issueCommentPayload(), HANDLE);
		if (!result.ok) throw new Error(result.reason);
		expect(result.trigger.kind).toBe("issue");
		expect(result.trigger.repo).toBe("octo/widget");
		expect(result.trigger.number).toBe(42);
		expect(result.trigger.actor).toBe("alice");
		expect(result.trigger.request).toBe("please fix this");
		expect(result.trigger.reactionPath).toBe("repos/octo/widget/issues/comments/777/reactions");
	});

	it("routes a comment on a PR thread to a pr trigger with unknown crossRepo", () => {
		const result = parseTrigger("issue_comment", issueCommentPayload({ pullRequest: true }), HANDLE);
		if (!result.ok) throw new Error(result.reason);
		expect(result.trigger.kind).toBe("pr");
		expect(result.trigger.crossRepo).toBeUndefined();
	});

	it("skips comments without a mention and bot-authored comments", () => {
		const noMention = parseTrigger("issue_comment", issueCommentPayload({ body: "just chatting" }), HANDLE);
		expect(noMention.ok).toBe(false);
		const bot = parseTrigger("issue_comment", issueCommentPayload({ login: "robo[bot]" }), HANDLE);
		expect(bot.ok).toBe(false);
		const self = parseTrigger("issue_comment", issueCommentPayload({ login: "OMPK" }), HANDLE);
		expect(self.ok).toBe(false);
	});

	it("skips mentions that only appear inside code blocks", () => {
		const result = parseTrigger("issue_comment", issueCommentPayload({ body: "```\n@ompk\n```" }), HANDLE);
		expect(result.ok).toBe(false);
	});

	it("routes review comments with file/line location and fork detection", () => {
		const payload: EventPayload = {
			action: "created",
			repository: { full_name: "octo/widget" },
			pull_request: { number: 9, head: { ref: "fix", repo: { full_name: "fork/widget" } } },
			comment: {
				id: 5,
				body: `@${HANDLE} tighten this loop`,
				user: { login: "bob" },
				author_association: "COLLABORATOR",
				path: "src/loop.ts",
				line: 12,
			},
		};
		const result = parseTrigger("pull_request_review_comment", payload, HANDLE);
		if (!result.ok) throw new Error(result.reason);
		expect(result.trigger.kind).toBe("pr");
		expect(result.trigger.location).toBe("src/loop.ts:12");
		expect(result.trigger.crossRepo).toBe(true);
		expect(result.trigger.reactionPath).toBe("repos/octo/widget/pulls/comments/5/reactions");
	});

	it("routes submitted review bodies and marks same-repo heads pushable", () => {
		const payload: EventPayload = {
			action: "submitted",
			repository: { full_name: "octo/widget" },
			pull_request: { number: 9, head: { ref: "fix", repo: { full_name: "octo/widget" } } },
			review: {
				id: 1,
				body: `@${HANDLE} address my comments`,
				user: { login: "carol" },
				author_association: "OWNER",
			},
		};
		const result = parseTrigger("pull_request_review", payload, HANDLE);
		if (!result.ok) throw new Error(result.reason);
		expect(result.trigger.crossRepo).toBe(false);
		expect(result.trigger.reactionPath).toBeUndefined();
	});

	it("routes pull_request.opened body/title mentions with fork detection", () => {
		const payload: EventPayload = {
			action: "opened",
			repository: { full_name: "octo/widget" },
			pull_request: {
				number: 11,
				title: "Add caching",
				body: `@${HANDLE} review the invalidation logic`,
				user: { login: "frank" },
				author_association: "MEMBER",
				head: { ref: "cache", repo: { full_name: "fork/widget" } },
			},
		};
		const result = parseTrigger("pull_request", payload, HANDLE);
		if (!result.ok) throw new Error(result.reason);
		expect(result.trigger.kind).toBe("pr");
		expect(result.trigger.number).toBe(11);
		expect(result.trigger.request).toBe("review the invalidation logic");
		expect(result.trigger.crossRepo).toBe(true);
		// PR reactions go through the issues endpoint.
		expect(result.trigger.reactionPath).toBe("repos/octo/widget/issues/11/reactions");
	});

	it("deliberately skips pull_request.edited (no newly-added-mention tracking)", () => {
		const payload: EventPayload = {
			action: "edited",
			repository: { full_name: "octo/widget" },
			pull_request: { number: 11, body: `@${HANDLE} do it`, user: { login: "frank" } },
		};
		expect(parseTrigger("pull_request", payload, HANDLE).ok).toBe(false);
	});

	it("routes issues.opened with a body mention", () => {
		const payload: EventPayload = {
			action: "opened",
			repository: { full_name: "octo/widget" },
			issue: {
				number: 7,
				title: "Crash on save",
				body: `@${HANDLE} take a look`,
				user: { login: "dana" },
				author_association: "OWNER",
			},
		};
		const result = parseTrigger("issues", payload, HANDLE);
		if (!result.ok) throw new Error(result.reason);
		expect(result.trigger.kind).toBe("issue");
		expect(result.trigger.request).toBe("take a look");
	});

	it("routes issues.assigned to the handle via the sender with a live-check association", () => {
		const payload: EventPayload = {
			action: "assigned",
			repository: { full_name: "octo/widget" },
			issue: { number: 8, title: "Add retries", body: "Please add retries." },
			assignee: { login: "OMPK" },
			sender: { login: "erin" },
		};
		const result = parseTrigger("issues", payload, HANDLE);
		if (!result.ok) throw new Error(result.reason);
		expect(result.trigger.actor).toBe("erin");
		expect(result.trigger.association).toBeNull();
		expect(result.trigger.request).toContain("Add retries");
	});

	it("skips assignment to someone else and unhandled events", () => {
		const other = parseTrigger(
			"issues",
			{
				action: "assigned",
				repository: { full_name: "octo/widget" },
				issue: { number: 8 },
				assignee: { login: "human" },
			},
			HANDLE,
		);
		expect(other.ok).toBe(false);
		const push = parseTrigger("push", { repository: { full_name: "octo/widget" } }, HANDLE);
		expect(push.ok).toBe(false);
	});
});

const issueTrigger: MentionTrigger = {
	kind: "issue",
	event: "issue_comment.created",
	repo: "octo/widget",
	number: 42,
	actor: "alice",
	association: "MEMBER",
	request: "please fix this",
};

function makeContract(overrides?: { deliveryBranch?: string; reportFile?: string }): AssignmentContractV1 {
	return buildAssignmentContract(issueTrigger, {
		runId: "run-1",
		baselineSha: BASELINE,
		deliveryBranch: overrides?.deliveryBranch ?? "ompk/issue-42",
		reportFile: overrides?.reportFile ?? REPORT_FILE,
	});
}

describe("buildPrompt", () => {
	it("points issue runs at issue:// and the driver-created work branch", () => {
		const prompt = buildPrompt(issueTrigger, { handle: HANDLE, workBranch: "ompk/issue-42" });
		expect(prompt).toContain("issue://octo/widget/42");
		expect(prompt).toContain("`ompk/issue-42`");
		expect(prompt).toContain("NEVER commit to or push the repository's default branch");
		expect(prompt).toContain("please fix this");
	});

	it("points PR runs at pr:// resources and the head branch workflow", () => {
		const prompt = buildPrompt({ ...issueTrigger, kind: "pr" }, { handle: HANDLE });
		expect(prompt).toContain("pr://octo/widget/42");
		expect(prompt).toContain("pr://octo/widget/42/diff");
		expect(prompt).toContain("PR head branch");
	});

	it("embeds the contract digest, baseline sha, and mandatory reporting rules", () => {
		const contract = makeContract();
		const prompt = buildPrompt(issueTrigger, {
			handle: HANDLE,
			contract,
			baselineSha: BASELINE,
			workBranch: "ompk/issue-42",
		});
		expect(prompt).toContain(contract.digest);
		expect(prompt).toContain(`Baseline commit (pre-run HEAD): ${BASELINE}`);
		expect(prompt).toContain("Result reporting (MANDATORY)");
		expect(prompt).toContain("assignment-result/v1");
	});
});

describe("shell-safe criterion authoring", () => {
	it("shQuote neutralizes quotes, substitution, and separators", () => {
		expect(shQuote("plain")).toBe("'plain'");
		expect(shQuote("a'b")).toBe(`'a'\\''b'`);
		// Round-trip through a real shell: the quoted value must come back
		// byte-identical and the harmless sentinels must NOT appear as
		// separate command output — proving `$()`, `;`, and backticks stay
		// literal. Sentinels only; never a destructive payload here.
		const hostile = `pwn'; printf INJECTED; printf ' $(printf SUBSTITUTED) \`printf BACKTICKED\``;
		const quoted = shQuote(hostile);
		if (Bun.which("bash")) {
			const proc = Bun.spawnSync(["bash", "-c", `printf %s ${quoted}`]);
			expect(proc.success).toBe(true);
			const out = proc.stdout.toString();
			expect(out).toBe(hostile);
			// The sentinel strings appear only as literal bytes of the input,
			// never as substituted/executed output fragments on their own.
			expect(out).toContain("$(printf SUBSTITUTED)");
		}
	});

	it("interpolates hostile branch names and paths only in quoted form", () => {
		const hostileBranch = `x'; echo pwned; '`;
		const hostilePath = `/tmp/o'ops/$(whoami)/report.md`;
		const contract = makeContract({ deliveryBranch: hostileBranch, reportFile: hostilePath });
		const delivered = contract.acceptance.find(c => c.id === "work-delivered");
		const report = contract.acceptance.find(c => c.id === "public-report");
		expect(String(delivered?.params?.command)).toContain(shQuote(hostileBranch));
		expect(String(delivered?.params?.command)).not.toContain(` ${hostileBranch}`);
		expect(String(report?.params?.command)).toBe(`test -s ${shQuote(hostilePath)}`);
	});

	it("rejects a non-hex baseline sha outright", () => {
		expect(() =>
			buildAssignmentContract(issueTrigger, {
				runId: "run-1",
				baselineSha: "$(evil)",
				deliveryBranch: "ompk/issue-42",
				reportFile: REPORT_FILE,
			}),
		).toThrow(/hex object id/);
	});
});

describe("assignment contract gate", () => {
	const passRunners: AssignmentVerifierRunners = {
		runCommand: async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }),
	};

	function makeResult(
		contract: AssignmentContractV1,
		overrides?: Partial<{
			status: "success" | "failed" | "blocked" | "partial";
			changedFiles: string[];
			evidence: { criterionId: string; passed: boolean; summary: string }[];
			digest: string;
		}>,
	): AssignmentResult {
		return {
			version: "assignment-result/v1",
			contractId: contract.id,
			revision: contract.revision,
			digest: overrides?.digest ?? contract.digest,
			status: overrides?.status ?? "success",
			changedFiles: overrides?.changedFiles ?? [],
			evidence:
				overrides?.evidence ??
				contract.acceptance.map(criterion => ({
					criterionId: criterion.id,
					passed: true,
					summary: `verified: ${criterion.description}`,
				})),
			summary: "Answered the request; no code change was needed.",
		} as AssignmentResult;
	}

	it("builds a digest-bound contract with delivery + report criteria", () => {
		const contract = makeContract();
		expect(contract.digest).toHaveLength(64);
		expect(contract.scope.allowedPaths).toEqual(["."]);
		expect(contract.acceptance.map(c => c.id)).toEqual([
			"clean-worktree",
			"changed-files-in-scope",
			"public-report",
			"work-delivered",
		]);
	});

	it("verifies a truthful success result", async () => {
		const contract = makeContract();
		const outcome = await verifyAssignmentResult({
			contract,
			result: makeResult(contract),
			runners: passRunners,
			actualChangedFiles: [],
		});
		expect(outcome.verified).toBe(true);
	});

	it("rejects success when a criterion is unproven (missing evidence)", async () => {
		const contract = makeContract();
		const outcome = await verifyAssignmentResult({
			contract,
			result: makeResult(contract, {
				evidence: [{ criterionId: "clean-worktree", passed: true, summary: "clean tree confirmed" }],
			}),
			runners: passRunners,
			actualChangedFiles: [],
		});
		expect(outcome.verified).toBe(false);
		expect(outcome.reasons.join(" ")).toContain("changed-files-in-scope");
	});

	it("rejects a claimed delivery when the parent-run delivery check fails", async () => {
		// Simulates unpushed commits: `work-delivered` exits 1 while every
		// other parent command passes — a fabricated success cannot verify.
		const contract = makeContract();
		const outcome = await verifyAssignmentResult({
			contract,
			result: makeResult(contract, { changedFiles: ["src/widget.ts"] }),
			runners: {
				runCommand: async command => ({
					exitCode: command.includes("rev-list") ? 1 : 0,
					timedOut: false,
					stdout: "",
					stderr: "",
				}),
			},
			actualChangedFiles: ["src/widget.ts"],
		});
		expect(outcome.verified).toBe(false);
	});

	it("rejects an empty public report via the parent-run report check", async () => {
		const contract = makeContract();
		const outcome = await verifyAssignmentResult({
			contract,
			result: makeResult(contract),
			runners: {
				runCommand: async command => ({
					exitCode: command.startsWith("test -s") ? 1 : 0,
					timedOut: false,
					stdout: "",
					stderr: "",
				}),
			},
			actualChangedFiles: [],
		});
		expect(outcome.verified).toBe(false);
	});

	it("rejects digest tampering and undeclared changed files", async () => {
		const contract = makeContract();
		const tampered = await verifyAssignmentResult({
			contract,
			result: makeResult(contract, { digest: "0".repeat(64) }),
			runners: passRunners,
			actualChangedFiles: [],
		});
		expect(tampered.verified).toBe(false);
		const omitted = await verifyAssignmentResult({
			contract,
			result: makeResult(contract, { changedFiles: [] }),
			runners: passRunners,
			actualChangedFiles: ["src/sneaky.ts"],
		});
		expect(omitted.verified).toBe(false);
	});
});

describe("extractAssignmentResult", () => {
	it("pulls the trailing result block and keeps the prose report", () => {
		const report = [
			"I fixed the widget.",
			"```json",
			'{ "not": "a result" }',
			"```",
			"Details above.",
			"```json",
			'{ "version": "assignment-result/v1", "contractId": "c", "revision": 1, "digest": "d", "status": "success", "changedFiles": [], "evidence": [] }',
			"```",
		].join("\n");
		const { result, rest } = extractAssignmentResult(report);
		expect(result).toBeDefined();
		expect(rest).toContain("I fixed the widget.");
		expect(rest).toContain('"not": "a result"');
		expect(rest).not.toContain("assignment-result/v1");
	});

	it("returns undefined when no result block exists", () => {
		const { result, rest } = extractAssignmentResult("plain answer, no block");
		expect(result).toBeUndefined();
		expect(rest).toBe("plain answer, no block");
	});
});

describe("reply rendering", () => {
	it("truncates oversized reports with a notice", () => {
		const report = "x".repeat(70_000);
		const out = truncateReport(report);
		expect(out.length).toBeLessThan(61_000);
		expect(out).toContain("truncated");
		expect(truncateReport("short")).toBe("short");
	});

	it("marks failed runs, lists verification reasons, and links the run", () => {
		const ok = buildComment({ handle: HANDLE, ok: true, report: "done", runUrl: "https://ci/run/1" });
		expect(ok).toContain("### `@ompk`");
		expect(ok).toContain("done");
		expect(ok).toContain("https://ci/run/1");
		const failed = buildComment({
			handle: HANDLE,
			ok: false,
			report: "",
			verification: { verified: false, reasons: ["agent did not emit the mandatory assignment-result block"] },
		});
		expect(failed).toContain("run failed");
		expect(failed).toContain("no output");
		expect(failed).toContain("did not pass independent verification");
		expect(failed).toContain("mandatory assignment-result block");
	});
});

describe("workflow event surface", () => {
	// Drift guard: every event surface the driver handles must be wired in
	// the workflow's `on:` block (and prefiltered where a body exists), so a
	// parseTrigger branch can never silently lack its trigger. Precedent for
	// asserting on workflow config: scripts/ci-concurrency.test.ts.
	it("ompk-mention.yml subscribes to every driver-handled event", async () => {
		const workflow = await Bun.file(
			path.resolve(import.meta.dir, "..", ".github", "workflows", "ompk-mention.yml"),
		).text();
		const surfaces: [event: string, actions: string][] = [
			["issues", "[opened, assigned]"],
			["issue_comment", "[created]"],
			["pull_request_review_comment", "[created]"],
			["pull_request_review", "[submitted]"],
			["pull_request", "[opened]"],
		];
		for (const [event, actions] of surfaces) {
			// Comment lines may sit between the event key and its types list.
			const pattern = new RegExp(
				`^  ${event}:\\n(?:    #[^\\n]*\\n)*    types: ${actions.replace(/[[\]]/g, "\\$&")}$`,
				"m",
			);
			expect(workflow).toMatch(pattern);
		}
		// The cheap prefilter must cover every body/title field the driver
		// inspects, or mentions on that surface never reach the runner.
		for (const field of [
			"github.event.comment.body",
			"github.event.review.body",
			"github.event.issue.body",
			"github.event.issue.title",
			"github.event.pull_request.body",
			"github.event.pull_request.title",
		]) {
			// Handle is parameterized in ONE place: the repo/org variable,
			// falling back to 'ompk', so the prefilter and the driver's
			// OMPK_MENTION_HANDLE env can never disagree.
			expect(workflow).toContain(`contains(${field}, format('@{0}', vars.OMPK_MENTION_HANDLE || 'ompk'))`);
		}
		expect(workflow).toContain("github.event.assignee.login == (vars.OMPK_MENTION_HANDLE || 'ompk')");
		expect(workflow).toContain(`OMPK_MENTION_HANDLE: \${{ vars.OMPK_MENTION_HANDLE || 'ompk' }}`);
		// Fork-originated pull_request/review runs get no secrets and a
		// downgraded token; the workflow must skip them at the job gate so
		// the driver never runs (or half-runs) without being able to reply.
		expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
	});
});

// --- shared real-git fixture -------------------------------------------------

function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync(
		["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd },
	);
	if (!proc.success) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

// Bare origin plus two clones, so branch-resume paths can be exercised from
// a machine that has never fetched the work branch.
async function makeFixture(): Promise<{ root: string; origin: string; cloneA: string; cloneB: string }> {
	const { mkdtemp } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const root = await mkdtemp(path.join(tmpdir(), "ompk-mention-git-"));
	const origin = path.join(root, "origin.git");
	const cloneA = path.join(root, "clone-a");
	const cloneB = path.join(root, "clone-b");
	git(root, "init", "--bare", "-b", "main", origin);
	git(root, "clone", origin, cloneA);
	await Bun.write(path.join(cloneA, "readme.md"), "hello\n");
	git(cloneA, "add", "readme.md");
	git(cloneA, "commit", "-m", "initial");
	git(cloneA, "push", "-u", "origin", "main");
	git(root, "clone", origin, cloneB);
	return { root, origin, cloneA, cloneB };
}

describe("checkoutIssueBranch (real git)", () => {
	it("creates a fresh branch from HEAD when origin has none", async () => {
		const { cloneA } = await makeFixture();
		const baseSha = git(cloneA, "rev-parse", "HEAD");
		const mode = await checkoutIssueBranch("ompk/issue-9", cloneA);
		expect(mode).toBe("created");
		expect(git(cloneA, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ompk/issue-9");
		expect(git(cloneA, "rev-parse", "HEAD")).toBe(baseSha);
	});

	it("resumes from the pushed tip on follow-up mentions, even without a tracking ref", async () => {
		const { cloneA, cloneB } = await makeFixture();
		// First run: clone A creates the branch, commits, pushes.
		await checkoutIssueBranch("ompk/issue-9", cloneA);
		await Bun.write(path.join(cloneA, "fix.md"), "work from run 1\n");
		git(cloneA, "add", "fix.md");
		git(cloneA, "commit", "-m", "run 1 work");
		git(cloneA, "push", "-u", "origin", "ompk/issue-9");
		const pushedTip = git(cloneA, "rev-parse", "HEAD");
		// Second run: clone B starts on main WITHOUT the remote-tracking ref
		// (fresh runner state) — the explicit fetch refspec must create it.
		git(cloneB, "update-ref", "-d", "refs/remotes/origin/ompk/issue-9");
		const mode = await checkoutIssueBranch("ompk/issue-9", cloneB);
		expect(mode).toBe("resumed");
		expect(git(cloneB, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ompk/issue-9");
		// HEAD is the previously pushed tip, NOT a reset to main: run 2 builds
		// on run 1 instead of producing a non-fast-forward push.
		expect(git(cloneB, "rev-parse", "HEAD")).toBe(pushedTip);
		expect(git(cloneB, "rev-parse", "HEAD")).not.toBe(git(cloneB, "rev-parse", "origin/main"));
	});
});

describe("runMentionAgent trigger path (real git + verifier, fake gh/agent)", () => {
	// End-to-end through runMentionAgent(): authorization, reaction, branch
	// checkout, contract authoring, result extraction, REAL verifier
	// re-execution in the fixture repo, and the posted reply. Only the two
	// external seams (gh network, LLM process) are deterministic fakes.
	const hasBash = Bun.which("bash") !== null;

	interface Harness {
		deps: MentionDeps;
		ghCalls: string[][];
		posted: string[];
	}

	async function makeHarness(repoDir: string, runAgent: MentionDeps["runAgent"]): Promise<Harness> {
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const tempDir = await mkdtemp(path.join(tmpdir(), "ompk-mention-tmp-"));
		const ghCalls: string[][] = [];
		const posted: string[] = [];
		const deps: MentionDeps = {
			repoDir,
			tempDir,
			handle: HANDLE,
			runId: "itest-1",
			runUrl: "https://ci.example/run/1",
			gh: async args => {
				ghCalls.push(args);
				const bodyArg = args.find(a => a.startsWith("body=@"));
				if (bodyArg) posted.push(await Bun.file(bodyArg.slice("body=@".length)).text());
				return "";
			},
			runAgent,
			log: () => {},
		};
		return { deps, ghCalls, posted };
	}

	/** Stub agent helper: parse the digest-bound contract out of the prompt. */
	function contractFromPrompt(prompt: string): AssignmentContractV1 {
		const block = prompt.match(/```json\n([\s\S]*?)\n```/);
		if (!block) throw new Error("prompt carries no contract block");
		return JSON.parse(block[1]) as AssignmentContractV1;
	}

	function successResult(contract: AssignmentContractV1, changedFiles: string[]): string {
		return JSON.stringify({
			version: "assignment-result/v1",
			contractId: contract.id,
			revision: contract.revision,
			digest: contract.digest,
			status: "success",
			changedFiles,
			evidence: contract.acceptance.map(c => ({
				criterionId: c.id,
				passed: true,
				summary: `checked ${c.id}: state inspected in the workspace after finishing`,
			})),
			summary: "Explained the widget failure root cause; no code change was required.",
		});
	}

	it.skipIf(!hasBash)("verifies a truthful answer-only run end to end", async () => {
		const { cloneA } = await makeFixture();
		const { deps, ghCalls, posted } = await makeHarness(cloneA, async prompt => {
			const contract = contractFromPrompt(prompt);
			return {
				exitCode: 0,
				stdout: `The widget breaks because the cache is stale.\n\n\`\`\`json\n${successResult(contract, [])}\n\`\`\`\n`,
			};
		});
		const outcome = await runMentionAgent(
			"issue_comment",
			issueCommentPayload({ body: `@${HANDLE} why does the widget break?` }),
			deps,
		);
		expect(outcome.outcome).toBe("verified");
		// Real side effects happened: 👀 reaction + posted reply.
		expect(ghCalls.some(args => args.join(" ").includes("reactions"))).toBe(true);
		expect(posted).toHaveLength(1);
		expect(posted[0]).toContain("### `@ompk`");
		expect(posted[0]).toContain("cache is stale");
		expect(posted[0]).not.toContain("run failed");
		// The work branch was really checked out in the fixture repo.
		expect(git(cloneA, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ompk/issue-42");
	});

	it.skipIf(!hasBash)("fails the run when the agent omits the result block", async () => {
		const { cloneA } = await makeFixture();
		const { deps, posted } = await makeHarness(cloneA, async () => ({
			exitCode: 0,
			stdout: "I did lots of great work, trust me.",
		}));
		const outcome = await runMentionAgent("issue_comment", issueCommentPayload({ body: `@${HANDLE} fix it` }), deps);
		expect(outcome.outcome).toBe("failed");
		expect(posted[0]).toContain("run failed");
		expect(posted[0]).toContain("mandatory assignment-result block");
	});

	it.skipIf(!hasBash)("rejects a fabricated success over unpushed commits via the real verifier", async () => {
		const { cloneA } = await makeFixture();
		const { deps, posted } = await makeHarness(cloneA, async prompt => {
			const contract = contractFromPrompt(prompt);
			// The "agent" commits work on the branch but never pushes, then
			// claims success — work-delivered must catch it with real git.
			await Bun.write(path.join(cloneA, "hack.md"), "unpushed work\n");
			git(cloneA, "add", "hack.md");
			git(cloneA, "commit", "-m", "unpushed");
			return {
				exitCode: 0,
				stdout: `Fixed it and pushed everything.\n\n\`\`\`json\n${successResult(contract, ["hack.md"])}\n\`\`\`\n`,
			};
		});
		const outcome = await runMentionAgent(
			"issue_comment",
			issueCommentPayload({ body: `@${HANDLE} fix the widget` }),
			deps,
		);
		expect(outcome.outcome).toBe("failed");
		expect(posted[0]).toContain("run failed");
		expect(posted[0]).toContain("did not pass independent verification");
	});

	it("refuses fork PRs before any checkout or agent run", async () => {
		const { cloneA } = await makeFixture();
		const { deps, posted } = await makeHarness(cloneA, async () => {
			throw new Error("agent must never run for fork PRs");
		});
		const payload: EventPayload = {
			action: "submitted",
			repository: { full_name: "octo/widget" },
			pull_request: { number: 9, head: { ref: "fix", repo: { full_name: "fork/widget" } } },
			review: {
				id: 1,
				body: `@${HANDLE} please finish this`,
				user: { login: "carol" },
				author_association: "OWNER",
			},
		};
		const outcome = await runMentionAgent("pull_request_review", payload, deps);
		expect(outcome.outcome).toBe("refused-fork");
		expect(posted).toHaveLength(1);
		expect(posted[0]).toContain("fork PRs");
		// No checkout happened: the fixture repo is untouched on main.
		expect(git(cloneA, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
	});
});
