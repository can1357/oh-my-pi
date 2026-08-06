import { beforeEach, describe, expect, it } from "bun:test";
import { createGitHubAppJwt, verifyGitHubSignature } from "../src/github";
import {
	hasMention,
	isSupportedGitHubEvent,
	isTrustedAssociation,
	isTrustedPermission,
	parseGitHubTrigger,
	stripCodeSegments,
} from "../src/github-dispatch";
import type { Env, GitHubJobTarget } from "../src/types";
import { createWorker } from "../src/worker";
import { FakeQueueStub } from "./queue-fixture";

const GITHUB_SECRET = "test-github-secret";
const RELAY_TOKEN = "test-relay-token";
const REPO = "kingkillery/oh-my-pk";

async function signBody(body: string, secret: string = GITHUB_SECRET): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return `sha256=${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("verifyGitHubSignature", () => {
	it("accepts a valid HMAC signature", async () => {
		const body = JSON.stringify({ hello: "world" });
		expect(await verifyGitHubSignature(body, await signBody(body), GITHUB_SECRET)).toBe(true);
	});

	it("rejects a tampered body", async () => {
		const signature = await signBody(JSON.stringify({ hello: "world" }));
		expect(await verifyGitHubSignature(JSON.stringify({ hello: "tampered" }), signature, GITHUB_SECRET)).toBe(false);
	});

	it("rejects when the secret is not configured", async () => {
		const body = "{}";
		expect(await verifyGitHubSignature(body, await signBody(body), undefined)).toBe(false);
		expect(await verifyGitHubSignature(body, await signBody(body), "  ")).toBe(false);
	});

	it("rejects malformed signature headers", async () => {
		expect(await verifyGitHubSignature("{}", null, GITHUB_SECRET)).toBe(false);
		expect(await verifyGitHubSignature("{}", "sha1=abc", GITHUB_SECRET)).toBe(false);
	});
});

async function makeAppKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
	const pair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	);
	const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
	const encoded = Buffer.from(pkcs8)
		.toString("base64")
		.replace(/(.{64})/g, "$1\n");
	return {
		pem: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
		publicKey: pair.publicKey,
	};
}

function decodeSegment(segment: string): Uint8Array {
	const normalized = segment.replaceAll("-", "+").replaceAll("_", "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

describe("createGitHubAppJwt", () => {
	it("produces a JWT GitHub can verify with the app public key", async () => {
		const { pem, publicKey } = await makeAppKey();
		const now = 1_754_000_000_000;
		const jwt = await createGitHubAppJwt("12345", pem, now);
		const [header, payload, signature] = jwt.split(".");
		expect(header && payload && signature).toBeTruthy();
		const verified = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			publicKey,
			decodeSegment(signature ?? ""),
			new TextEncoder().encode(`${header}.${payload}`),
		);
		expect(verified).toBe(true);
		const claims = JSON.parse(new TextDecoder().decode(decodeSegment(payload ?? ""))) as Record<string, unknown>;
		expect(claims.iss).toBe("12345");
		expect(claims.iat).toBe(Math.floor(now / 1000) - 60);
		expect(claims.exp).toBe(Math.floor(now / 1000) - 60 + 9 * 60);
	});

	it("normalizes PEM secrets stored with literal \\n escapes", async () => {
		const { pem } = await makeAppKey();
		const flattened = pem.replaceAll("\n", "\\n");
		const jwt = await createGitHubAppJwt("12345", flattened);
		expect(jwt.split(".")).toHaveLength(3);
	});

	it("rejects secrets that are not PKCS#8 PEM keys", async () => {
		await expect(createGitHubAppJwt("12345", "not-a-key")).rejects.toThrow("PKCS#8");
	});
});

describe("mention detection", () => {
	it("detects plain mentions case-insensitively", () => {
		expect(hasMention("@ompk fix this", "ompk")).toBe(true);
		expect(hasMention("please @OMPK look", "ompk")).toBe(true);
		expect(hasMention("@ompk[bot] ping", "ompk")).toBe(true);
	});

	it("ignores mentions of other handles", () => {
		expect(hasMention("@ompk-staging deploy", "ompk")).toBe(false);
		expect(hasMention("@ompkbot hello", "ompk")).toBe(false);
		expect(hasMention("mail@ompk.example", "ompk")).toBe(false);
	});

	it("ignores mentions inside code fences and inline code", () => {
		expect(hasMention("```\n@ompk run\n```", "ompk")).toBe(false);
		expect(hasMention("use `@ompk` to trigger", "ompk")).toBe(false);
		expect(hasMention("```ts\nx\n```\n@ompk run", "ompk")).toBe(true);
	});

	it("strips fenced blocks while keeping surrounding text", () => {
		expect(stripCodeSegments("before\n```\nhidden\n```\nafter")).toBe("before\nafter");
	});
});

function basePayload(): Record<string, unknown> {
	// Mirrors a REAL delivery: `installation` is abbreviated to `{id}` on
	// regular events; account identity comes from `repository.owner`.
	return {
		action: "created",
		repository: { full_name: REPO, default_branch: "main", owner: { login: "kingkillery" } },
		installation: { id: 42 },
	};
}

describe("parseGitHubTrigger", () => {
	it("parses issue comments into issue triggers", () => {
		const parsed = parseGitHubTrigger(
			"issue_comment",
			{
				...basePayload(),
				issue: { number: 7, title: "Bug", body: "body" },
				comment: {
					id: 900,
					body: "@ompk please fix the flaky test",
					user: { login: "kingkillery" },
					author_association: "OWNER",
					html_url: "https://github.com/kingkillery/oh-my-pk/issues/7#issuecomment-900",
				},
			},
			"ompk",
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.trigger.kind).toBe("issue");
		expect(parsed.trigger.number).toBe(7);
		expect(parsed.trigger.actor).toBe("kingkillery");
		expect(parsed.trigger.request).toBe("please fix the flaky test");
		expect(parsed.trigger.dedupeId).toBe("issue_comment:900");
	});

	it("classifies PR comments and review comments as pr triggers", () => {
		const onPr = parseGitHubTrigger(
			"issue_comment",
			{
				...basePayload(),
				issue: { number: 8, pull_request: {} },
				comment: { id: 901, body: "@ompk rebase", user: { login: "kingkillery" }, author_association: "OWNER" },
			},
			"ompk",
		);
		expect(onPr.ok && onPr.trigger.kind).toBe("pr");

		const review = parseGitHubTrigger(
			"pull_request_review_comment",
			{
				...basePayload(),
				pull_request: { number: 9, head: { ref: "feat", repo: { full_name: REPO } } },
				comment: {
					id: 902,
					body: "@ompk tighten this loop",
					user: { login: "kingkillery" },
					author_association: "OWNER",
					path: "src/a.ts",
					line: 12,
				},
			},
			"ompk",
		);
		expect(review.ok).toBe(true);
		if (!review.ok) return;
		expect(review.trigger.location).toBe("src/a.ts:12");
		expect(review.trigger.dedupeId).toBe("review_comment:902");
	});

	it("parses reviews, opened PRs, and opened issues", () => {
		const review = parseGitHubTrigger(
			"pull_request_review",
			{
				...basePayload(),
				action: "submitted",
				pull_request: { number: 10 },
				review: {
					id: 903,
					body: "@ompk address the comments",
					user: { login: "kingkillery" },
					author_association: "OWNER",
				},
			},
			"ompk",
		);
		expect(review.ok && review.trigger.dedupeId).toBe("review:903");

		const opened = parseGitHubTrigger(
			"pull_request",
			{
				...basePayload(),
				action: "opened",
				pull_request: {
					number: 11,
					title: "@ompk review this",
					body: "details",
					user: { login: "kingkillery" },
					author_association: "OWNER",
					head: { ref: "feat", repo: { full_name: REPO } },
				},
			},
			"ompk",
		);
		expect(opened.ok && opened.trigger.dedupeId).toBe(`pr_opened:${REPO}#11`);

		const issue = parseGitHubTrigger(
			"issues",
			{
				...basePayload(),
				action: "opened",
				issue: {
					number: 12,
					title: "Crash",
					body: "@ompk investigate",
					user: { login: "kingkillery" },
					author_association: "OWNER",
				},
			},
			"ompk",
		);
		expect(issue.ok && issue.trigger.dedupeId).toBe(`issue_opened:${REPO}#12`);
	});

	it("rejects bot authors, missing mentions, and unsupported actions", () => {
		const bot = parseGitHubTrigger(
			"issue_comment",
			{
				...basePayload(),
				issue: { number: 7 },
				comment: { id: 1, body: "@ompk loop", user: { login: "ompk[bot]", type: "Bot" } },
			},
			"ompk",
		);
		expect(bot.ok).toBe(false);

		const noMention = parseGitHubTrigger(
			"issue_comment",
			{ ...basePayload(), issue: { number: 7 }, comment: { id: 2, body: "just chatting", user: { login: "u" } } },
			"ompk",
		);
		expect(noMention.ok).toBe(false);

		const edited = parseGitHubTrigger(
			"issue_comment",
			{
				...basePayload(),
				action: "edited",
				issue: { number: 7 },
				comment: { id: 3, body: "@ompk go", user: { login: "u" } },
			},
			"ompk",
		);
		expect(edited.ok).toBe(false);
	});

	it("flags supported events and trusted roles", () => {
		expect(isSupportedGitHubEvent("issue_comment")).toBe(true);
		expect(isSupportedGitHubEvent("push")).toBe(false);
		expect(isTrustedAssociation("OWNER")).toBe(true);
		expect(isTrustedAssociation("NONE")).toBe(false);
		expect(isTrustedPermission("write")).toBe(true);
		expect(isTrustedPermission("read")).toBe(false);
	});
});

interface GitHubHarness {
	worker: { fetch(request: Request, env: Env): Promise<Response> };
	stub: FakeQueueStub;
	linearComments: Array<{ issueId: string; body: string }>;
	githubComments: Array<{ token: string; target: GitHubJobTarget; body: string }>;
	tokenRequests: string[];
	permissionLookups: Array<{ owner: string; repo: string; login: string }>;
	state: { permission: string | null; headRepo?: string; headRef?: string; isPullRequest: boolean };
}

function makeGitHubHarness(): GitHubHarness {
	const stub = new FakeQueueStub();
	const linearComments: Array<{ issueId: string; body: string }> = [];
	const githubComments: Array<{ token: string; target: GitHubJobTarget; body: string }> = [];
	const tokenRequests: string[] = [];
	const permissionLookups: Array<{ owner: string; repo: string; login: string }> = [];
	const state: GitHubHarness["state"] = { permission: null, isPullRequest: false };
	let tokenCounter = 0;
	const worker = createWorker({
		fetchIssue: async () => {
			throw new Error("Linear fetchIssue must not run for GitHub events");
		},
		postComment: async (_token, issueId, body) => {
			linearComments.push({ issueId, body });
		},
		github: {
			createInstallationToken: async (_env, installationId) => {
				tokenRequests.push(installationId);
				tokenCounter += 1;
				return { token: `ghs_test_${tokenCounter}`, expiresAt: "2026-08-06T12:00:00Z" };
			},
			fetchWorkItem: async (_token, owner, repo, number, installationId, defaultBranch) => ({
				target: {
					owner,
					repo,
					number,
					installationId,
					defaultBranch,
					isPullRequest: state.isPullRequest,
					...(state.headRef ? { headRef: state.headRef } : {}),
					...(state.headRepo ? { headRepo: state.headRepo } : {}),
					htmlUrl: `https://github.com/${owner}/${repo}/issues/${number}`,
				},
				title: "Fix the parser",
				body: "It breaks on odd inputs",
			}),
			postComment: async (token, target, body) => {
				githubComments.push({ token, target, body });
			},
			getCollaboratorPermission: async (_token, owner, repo, login) => {
				permissionLookups.push({ owner, repo, login });
				return state.permission;
			},
		},
		queue: () => stub,
	});
	return { worker, stub, linearComments, githubComments, tokenRequests, permissionLookups, state };
}

function makeGitHubEnv(overrides: Partial<Env> = {}): Env {
	const namespace = {} as unknown as DurableObjectNamespace;
	return {
		JOB_QUEUE: namespace,
		LINEAR_WEBHOOK_SECRET: "linear-secret",
		LINEAR_API_TOKEN: "lin_api_test",
		GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
		GITHUB_APP_ID: "12345",
		GITHUB_APP_PRIVATE_KEY: "unused-in-tests",
		GITHUB_INSTALLATION_ID: "42",
		GITHUB_ACCOUNT_LOGIN: "kingkillery",
		GITHUB_MENTION_HANDLE: "ompk",
		GITHUB_MODEL: "combo-a",
		RELAY_TOKEN,
		STATUS_TOKEN: "test-status-token",
		LINEAR_AGENT_USER_ID: "agent-user-1",
		ALLOWED_PROJECT_IDS: "proj-1",
		ALLOWED_MODELS: "combo-a",
		...overrides,
	};
}

function issueCommentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...basePayload(),
		issue: { number: 7, title: "Bug", body: "body" },
		comment: {
			id: 900,
			body: "@ompk please fix the flaky test",
			user: { login: "kingkillery" },
			author_association: "OWNER",
		},
		...overrides,
	};
}

async function postWebhook(
	harness: GitHubHarness,
	env: Env,
	payload: Record<string, unknown>,
	options: { event?: string; delivery?: string; signature?: string } = {},
): Promise<Response> {
	const body = JSON.stringify(payload);
	const headers = new Headers({
		"content-type": "application/json",
		"x-github-event": options.event ?? "issue_comment",
		"x-hub-signature-256": options.signature ?? (await signBody(body)),
	});
	if (options.delivery !== "") headers.set("x-github-delivery", options.delivery ?? "delivery-1");
	const request = new Request("https://worker.example/github/webhook", { method: "POST", headers, body });
	return harness.worker.fetch(request, env);
}

describe("worker /github/webhook", () => {
	let harness: GitHubHarness;
	let env: Env;

	beforeEach(() => {
		harness = makeGitHubHarness();
		env = makeGitHubEnv();
	});

	it("rejects invalid signatures", async () => {
		const response = await postWebhook(harness, env, issueCommentPayload(), { signature: "sha256=deadbeef" });
		expect(response.status).toBe(401);
		expect(await harness.stub.listJobs()).toHaveLength(0);
	});

	it("requires a delivery id", async () => {
		const response = await postWebhook(harness, env, issueCommentPayload(), { delivery: "" });
		expect(response.status).toBe(400);
	});

	it("skips unsupported events without queueing", async () => {
		const response = await postWebhook(harness, env, issueCommentPayload(), { event: "push" });
		const result = (await response.json()) as { skipped?: string };
		expect(response.status).toBe(200);
		expect(result.skipped).toBe("unsupported event");
		expect(await harness.stub.listJobs()).toHaveLength(0);
	});

	it("skips installations that are not the configured account installation", async () => {
		const payload = issueCommentPayload({ installation: { id: 99 } });
		const response = await postWebhook(harness, env, payload);
		const result = (await response.json()) as { skipped?: string };
		expect(result.skipped).toBe("unauthorized installation");
		expect(await harness.stub.listJobs()).toHaveLength(0);
		expect(harness.tokenRequests).toHaveLength(0);
	});

	it("skips repositories owned by another account", async () => {
		const payload = issueCommentPayload({
			repository: { full_name: "someone-else/repo", default_branch: "main", owner: { login: "someone-else" } },
		});
		const response = await postWebhook(harness, env, payload);
		const result = (await response.json()) as { skipped?: string };
		expect(result.skipped).toBe("unauthorized account");
		expect(await harness.stub.listJobs()).toHaveLength(0);
	});

	it("queues a job for a trusted mention", async () => {
		const response = await postWebhook(harness, env, issueCommentPayload());
		const result = (await response.json()) as { queued?: string; target?: string };
		expect(response.status).toBe(200);
		expect(result.queued).toBeTruthy();
		expect(result.target).toBe(`${REPO}#7`);
		const jobs = await harness.stub.listJobs();
		expect(jobs).toHaveLength(1);
		const job = jobs[0];
		expect(job?.source).toBe("github");
		expect(job?.model).toBe("combo-a");
		expect(job?.dedupeKey).toBe("github:issue_comment:900");
		expect(job?.github?.installationId).toBe("42");
		expect(job?.prompt).toContain("please fix the flaky test");
		expect(job?.prompt).toContain(`Repository: ${REPO}`);
	});

	it("deduplicates redeliveries that reuse the same comment id", async () => {
		await postWebhook(harness, env, issueCommentPayload(), { delivery: "delivery-1" });
		const redelivery = await postWebhook(harness, env, issueCommentPayload(), { delivery: "delivery-2" });
		expect(redelivery.status).toBe(200);
		expect(await harness.stub.listJobs()).toHaveLength(1);
	});

	it("denies untrusted commenters and consults collaborator permission", async () => {
		harness.state.permission = "read";
		const payload = issueCommentPayload({
			comment: { id: 905, body: "@ompk do things", user: { login: "drive-by" }, author_association: "NONE" },
		});
		const response = await postWebhook(harness, env, payload);
		const result = (await response.json()) as { skipped?: string };
		expect(result.skipped).toBe("requester is not authorized");
		expect(harness.permissionLookups).toEqual([{ owner: "kingkillery", repo: "oh-my-pk", login: "drive-by" }]);
		expect(await harness.stub.listJobs()).toHaveLength(0);
	});

	it("allows write-permission collaborators without a trusted association", async () => {
		harness.state.permission = "write";
		const payload = issueCommentPayload({
			comment: { id: 906, body: "@ompk do things", user: { login: "teammate" }, author_association: "NONE" },
		});
		const response = await postWebhook(harness, env, payload);
		const result = (await response.json()) as { queued?: string };
		expect(result.queued).toBeTruthy();
	});

	it("refuses fork-originated pull requests", async () => {
		harness.state.isPullRequest = true;
		harness.state.headRepo = "attacker/oh-my-pk";
		harness.state.headRef = "evil-branch";
		const payload = issueCommentPayload({ issue: { number: 8, pull_request: {} } });
		const response = await postWebhook(harness, env, payload);
		const result = (await response.json()) as { skipped?: string };
		expect(result.skipped).toBe("fork-originated execution is not supported");
		expect(await harness.stub.listJobs()).toHaveLength(0);
	});

	it("fails closed when no GitHub model is configured", async () => {
		const response = await postWebhook(harness, makeGitHubEnv({ GITHUB_MODEL: "" }), issueCommentPayload());
		expect(response.status).toBe(503);
		expect(await harness.stub.listJobs()).toHaveLength(0);
	});
});

describe("worker poll and result for GitHub jobs", () => {
	let harness: GitHubHarness;
	let env: Env;

	beforeEach(async () => {
		harness = makeGitHubHarness();
		env = makeGitHubEnv();
		await postWebhook(harness, env, issueCommentPayload());
	});

	async function pollJob(): Promise<{
		id: string;
		attemptId: string;
		leaseToken: string;
		github?: GitHubJobTarget;
		githubToken?: string;
	}> {
		const response = await harness.worker.fetch(
			new Request("https://worker.example/poll?relay=test-relay", {
				headers: { Authorization: `Bearer ${RELAY_TOKEN}` },
			}),
			env,
		);
		expect(response.status).toBe(200);
		return (await response.json()) as {
			id: string;
			attemptId: string;
			leaseToken: string;
			github?: GitHubJobTarget;
			githubToken?: string;
		};
	}

	it("leases GitHub jobs with repo metadata and a fresh installation token", async () => {
		const grant = await pollJob();
		expect(grant.github?.owner).toBe("kingkillery");
		expect(grant.github?.repo).toBe("oh-my-pk");
		expect(grant.githubToken).toMatch(/^ghs_test_/);
	});

	it("reports success back to GitHub with an installation token, not Linear", async () => {
		const grant = await pollJob();
		const response = await harness.worker.fetch(
			new Request("https://worker.example/result", {
				method: "POST",
				headers: { Authorization: `Bearer ${RELAY_TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({
					jobId: grant.id,
					attemptId: grant.attemptId,
					leaseToken: grant.leaseToken,
					success: true,
					output: "Fixed in branch ompk/issue-7",
				}),
			}),
			env,
		);
		expect(response.status).toBe(200);
		expect(harness.githubComments).toHaveLength(1);
		const comment = harness.githubComments[0];
		expect(comment?.target.number).toBe(7);
		expect(comment?.token).toMatch(/^ghs_test_/);
		expect(comment?.body).toContain("done");
		expect(comment?.body).toContain("Fixed in branch");
		expect(harness.linearComments).toHaveLength(0);
	});

	it("reports failures back to GitHub", async () => {
		const grant = await pollJob();
		const response = await harness.worker.fetch(
			new Request("https://worker.example/result", {
				method: "POST",
				headers: { Authorization: `Bearer ${RELAY_TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({
					jobId: grant.id,
					attemptId: grant.attemptId,
					leaseToken: grant.leaseToken,
					success: false,
					output: "",
					error: "tests failed",
					failureClass: "permanent",
				}),
			}),
			env,
		);
		expect(response.status).toBe(200);
		expect(harness.githubComments).toHaveLength(1);
		expect(harness.githubComments[0]?.body).toContain("failed");
		expect(harness.linearComments).toHaveLength(0);
	});
});
