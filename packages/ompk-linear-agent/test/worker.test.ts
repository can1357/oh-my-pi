import { beforeEach, describe, expect, it } from "bun:test";
import type { IssueDetails } from "../src/linear";
import type { Env, Job } from "../src/types";
import { createWorker } from "../src/worker";
import { FakeQueueStub } from "./queue-fixture";

const WEBHOOK_SECRET = "test-webhook-secret";
const RELAY_TOKEN = "test-relay-token";
const STATUS_TOKEN = "test-status-token";

function makeEnv(overrides: Partial<Env> = {}): Env {
	// JOB_QUEUE is unused: the tests inject `queue` deps directly.
	const namespace = {} as unknown as DurableObjectNamespace;
	return {
		JOB_QUEUE: namespace,
		LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
		LINEAR_API_TOKEN: "lin_api_test",
		RELAY_TOKEN,
		STATUS_TOKEN,
		LINEAR_AGENT_USER_ID: "agent-user-1",
		ALLOWED_PROJECT_IDS: "proj-1",
		ALLOWED_MODELS: "combo-a",
		...overrides,
	};
}

function makeIssue(overrides: Partial<IssueDetails> = {}): IssueDetails {
	return {
		id: "issue-1",
		identifier: "OMP-1",
		title: "Fix the parser",
		description: "It breaks on `&& del /q *` inputs",
		labels: ["model:combo-a", "Queue/Queued"],
		assigneeId: "agent-user-1",
		projectId: "proj-1",
		updatedAt: "2026-07-13T00:00:00.000Z",
		...overrides,
	};
}

interface Harness {
	worker: { fetch(request: Request, env: Env): Promise<Response> };
	stub: FakeQueueStub;
	comments: Array<{ issueId: string; body: string }>;
	issue: IssueDetails;
	setIssue(issue: IssueDetails): void;
}

function makeHarness(): Harness {
	const stub = new FakeQueueStub();
	const comments: Array<{ issueId: string; body: string }> = [];
	const state = { issue: makeIssue() };
	const worker = createWorker({
		fetchIssue: async () => state.issue,
		postComment: async (_token, issueId, body) => {
			comments.push({ issueId, body });
		},
		queue: () => stub,
	});
	return {
		worker,
		stub,
		comments,
		get issue() {
			return state.issue;
		},
		setIssue(issue: IssueDetails) {
			state.issue = issue;
		},
	};
}

async function signBody(body: string, secret: string = WEBHOOK_SECRET): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function webhookRequest(
	payload: unknown,
	options: { deliveryId?: string | null; secret?: string } = {},
): Promise<Request> {
	const body = JSON.stringify(payload);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"linear-signature": await signBody(body, options.secret ?? WEBHOOK_SECRET),
	};
	if (options.deliveryId !== null) {
		headers["linear-delivery"] = options.deliveryId ?? "delivery-1";
	}
	return new Request("https://worker.test/webhook", { method: "POST", headers, body });
}

const ISSUE_UPDATE_PAYLOAD = { action: "update", type: "Issue", data: { id: "issue-1" } };

describe("webhook authorization", () => {
	let harness: Harness;
	beforeEach(() => {
		harness = makeHarness();
	});

	it("rejects an invalid signature", async () => {
		const request = await webhookRequest(ISSUE_UPDATE_PAYLOAD, { secret: "wrong-secret" });
		const response = await harness.worker.fetch(request, makeEnv());
		expect(response.status).toBe(401);
		expect(await harness.stub.listJobs()).toHaveLength(0);
	});

	it("fails closed when allowlist configuration is missing", async () => {
		const response = await harness.worker.fetch(
			await webhookRequest(ISSUE_UPDATE_PAYLOAD),
			makeEnv({ ALLOWED_MODELS: "" }),
		);
		const body = (await response.json()) as { skipped?: string };
		expect(body.skipped).toContain("dispatch disabled");
		expect(await harness.stub.listJobs()).toHaveLength(0);
	});

	it("does not dispatch an unrelated issue edit lacking the admission state", async () => {
		harness.setIssue(makeIssue({ labels: ["bug"] }));
		const response = await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD), makeEnv());
		expect(response.status).toBe(200);
		expect(await harness.stub.listJobs()).toHaveLength(0);
	});

	it("does not dispatch on a model label alone without Queue/Queued", async () => {
		harness.setIssue(makeIssue({ labels: ["model:combo-a"] }));
		await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD), makeEnv());
		expect(await harness.stub.listJobs()).toHaveLength(0);
	});

	it("rejects wrong project, wrong assignee, and unsupported model", async () => {
		for (const issue of [
			makeIssue({ projectId: "proj-other" }),
			makeIssue({ assigneeId: "impostor" }),
			makeIssue({ labels: ["model:not-allowed", "Queue/Queued"] }),
		]) {
			harness.setIssue(issue);
			await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD), makeEnv());
		}
		expect(await harness.stub.listJobs()).toHaveLength(0);
	});

	it("dispatches the authorized transition exactly once and rejects the replayed delivery", async () => {
		const first = await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD), makeEnv());
		const firstBody = (await first.json()) as { queued?: string };
		expect(firstBody.queued).toBeDefined();

		const replay = await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD), makeEnv());
		const replayBody = (await replay.json()) as { skipped?: string };
		expect(replayBody.skipped).toBe("duplicate");
		expect(await harness.stub.listJobs()).toHaveLength(1);
	});

	it("rejects a second delivery for the same stale revision while a job is active", async () => {
		await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD), makeEnv());
		const second = await harness.worker.fetch(
			await webhookRequest(ISSUE_UPDATE_PAYLOAD, { deliveryId: "delivery-2" }),
			makeEnv(),
		);
		const body = (await second.json()) as { skipped?: string };
		// Same content, different delivery id: a duplicate, never a refresh.
		expect(body.skipped).toBe("duplicate");
		expect(await harness.stub.listJobs()).toHaveLength(1);
	});
});

describe("relay poll and fenced completion", () => {
	let harness: Harness;
	beforeEach(async () => {
		harness = makeHarness();
		await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD), makeEnv());
	});

	function pollRequest(token = RELAY_TOKEN): Request {
		return new Request("https://worker.test/poll?relay=test-relay", {
			headers: { authorization: `Bearer ${token}` },
		});
	}

	function resultRequest(body: unknown, token = RELAY_TOKEN): Request {
		return new Request("https://worker.test/result", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("requires relay credentials on poll and result", async () => {
		expect((await harness.worker.fetch(pollRequest("wrong"), makeEnv())).status).toBe(401);
		expect((await harness.worker.fetch(resultRequest({}, "wrong"), makeEnv())).status).toBe(401);
	});

	it("leases a job with fencing identity and completes it with exactly one comment", async () => {
		const leased = (await (await harness.worker.fetch(pollRequest(), makeEnv())).json()) as {
			id: string;
			attemptId: string;
			leaseToken: string;
			prompt: string;
		};
		expect(leased.attemptId).toBeDefined();
		expect(leased.leaseToken).toBeDefined();
		expect(leased.prompt).toContain("Fix the parser");

		const done = await harness.worker.fetch(
			resultRequest({
				jobId: leased.id,
				attemptId: leased.attemptId,
				leaseToken: leased.leaseToken,
				success: true,
				output: "did the work",
			}),
			makeEnv(),
		);
		expect(done.status).toBe(200);
		expect(harness.comments).toHaveLength(1);
		expect(harness.comments[0]!.body).toContain("did the work");

		// The completion response is redacted — no prompt text.
		const doneText = JSON.stringify(await done.json());
		expect(doneText).not.toContain("Fix the parser");
	});

	it("rejects a completion with an invalid token and posts no comment", async () => {
		const leased = (await (await harness.worker.fetch(pollRequest(), makeEnv())).json()) as {
			id: string;
			attemptId: string;
		};
		const rejected = await harness.worker.fetch(
			resultRequest({
				jobId: leased.id,
				attemptId: leased.attemptId,
				leaseToken: "forged",
				success: true,
				output: "evil overwrite",
			}),
			makeEnv(),
		);
		expect(rejected.status).toBe(409);
		expect(harness.comments).toHaveLength(0);
	});

	it("accepts duplicate completion idempotently without repeating the comment", async () => {
		const leased = (await (await harness.worker.fetch(pollRequest(), makeEnv())).json()) as {
			id: string;
			attemptId: string;
			leaseToken: string;
		};
		const body = {
			jobId: leased.id,
			attemptId: leased.attemptId,
			leaseToken: leased.leaseToken,
			success: true,
			output: "once",
		};
		await harness.worker.fetch(resultRequest(body), makeEnv());
		const duplicate = await harness.worker.fetch(resultRequest(body), makeEnv());
		expect(duplicate.status).toBe(200);
		expect(((await duplicate.json()) as { duplicate: boolean }).duplicate).toBe(true);
		expect(harness.comments).toHaveLength(1);
	});

	it("returns 404 for unknown jobs and 400 for malformed bodies", async () => {
		const missing = await harness.worker.fetch(
			resultRequest({ jobId: "nope", attemptId: "a", leaseToken: "t", success: true, output: "" }),
			makeEnv(),
		);
		expect(missing.status).toBe(404);
		const malformed = await harness.worker.fetch(resultRequest({ jobId: 42 }), makeEnv());
		expect(malformed.status).toBe(400);
	});
});

describe("status endpoint", () => {
	let harness: Harness;
	beforeEach(async () => {
		harness = makeHarness();
		await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD), makeEnv());
	});

	function statusRequest(token?: string, jobId?: string): Request {
		const url = jobId ? `https://worker.test/status?jobId=${jobId}` : "https://worker.test/status";
		return new Request(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
	}

	it("rejects missing and invalid credentials", async () => {
		expect((await harness.worker.fetch(statusRequest(), makeEnv())).status).toBe(401);
		expect((await harness.worker.fetch(statusRequest(RELAY_TOKEN), makeEnv())).status).toBe(401);
		expect((await harness.worker.fetch(statusRequest("nope"), makeEnv())).status).toBe(401);
	});

	it("rejects status access when no admin credential is configured", async () => {
		expect((await harness.worker.fetch(statusRequest(""), makeEnv({ STATUS_TOKEN: "" }))).status).toBe(401);
	});

	it("returns only redacted operational metadata — never prompts, output, or lease tokens", async () => {
		// Complete the job so the record carries a result body to leak.
		const leased = (await (
			await harness.worker.fetch(
				new Request("https://worker.test/poll?relay=r", { headers: { authorization: `Bearer ${RELAY_TOKEN}` } }),
				makeEnv(),
			)
		).json()) as { id: string; attemptId: string; leaseToken: string };
		await harness.worker.fetch(
			new Request("https://worker.test/result", {
				method: "POST",
				headers: { authorization: `Bearer ${RELAY_TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					jobId: leased.id,
					attemptId: leased.attemptId,
					leaseToken: leased.leaseToken,
					success: true,
					output: "SECRET-MODEL-OUTPUT",
				}),
			}),
			makeEnv(),
		);

		const detail = await harness.worker.fetch(statusRequest(STATUS_TOKEN, leased.id), makeEnv());
		expect(detail.status).toBe(200);
		const serialized = JSON.stringify(await detail.json());
		expect(serialized).not.toContain("Fix the parser");
		expect(serialized).not.toContain("del /q");
		expect(serialized).not.toContain("SECRET-MODEL-OUTPUT");
		expect(serialized).not.toContain(leased.leaseToken);
		expect(serialized).toContain("OMP-1");
		expect(serialized).toContain("combo-a");

		const list = await harness.worker.fetch(statusRequest(STATUS_TOKEN), makeEnv());
		expect(list.status).toBe(200);
		const listSerialized = JSON.stringify(await list.json());
		expect(listSerialized).not.toContain("Fix the parser");
		expect(listSerialized).not.toContain("SECRET-MODEL-OUTPUT");
	});

	it("returns 404 for unknown job ids", async () => {
		const detail = await harness.worker.fetch(statusRequest(STATUS_TOKEN, "missing-id"), makeEnv());
		expect(detail.status).toBe(404);
	});
});

describe("liveness endpoints", () => {
	let harness: Harness;
	let leased: { id: string; attemptId: string; leaseToken: string; heartbeatMs: number };

	beforeEach(async () => {
		harness = makeHarness();
		await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD), makeEnv());
		leased = (await (
			await harness.worker.fetch(
				new Request("https://worker.test/poll?relay=relay-1", {
					headers: { authorization: `Bearer ${RELAY_TOKEN}` },
				}),
				makeEnv(),
			)
		).json()) as typeof leased;
	});

	function heartbeatRequest(body: unknown, token = RELAY_TOKEN): Request {
		return new Request("https://worker.test/heartbeat", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	function reconcileRequest(body: unknown, token = RELAY_TOKEN): Request {
		return new Request("https://worker.test/reconcile", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	function pollAgain(): Promise<Response> {
		return harness.worker.fetch(
			new Request("https://worker.test/poll?relay=relay-1", {
				headers: { authorization: `Bearer ${RELAY_TOKEN}` },
			}),
			makeEnv(),
		);
	}

	it("grants leases carrying the heartbeat cadence", () => {
		expect(leased.heartbeatMs).toBeGreaterThan(0);
	});

	it("accepts a fenced heartbeat and rejects forged, unknown, or unauthorized ones", async () => {
		const ok = await harness.worker.fetch(
			heartbeatRequest({ jobId: leased.id, attemptId: leased.attemptId, leaseToken: leased.leaseToken }),
			makeEnv(),
		);
		expect(ok.status).toBe(200);
		expect((await ok.json()) as { ok: boolean; restored: boolean }).toMatchObject({ ok: true, restored: false });

		const forged = await harness.worker.fetch(
			heartbeatRequest({ jobId: leased.id, attemptId: leased.attemptId, leaseToken: "forged" }),
			makeEnv(),
		);
		expect(forged.status).toBe(409);

		const unknown = await harness.worker.fetch(
			heartbeatRequest({ jobId: "missing", attemptId: "a", leaseToken: "t" }),
			makeEnv(),
		);
		expect(unknown.status).toBe(404);

		const malformed = await harness.worker.fetch(heartbeatRequest({ jobId: 42 }), makeEnv());
		expect(malformed.status).toBe(400);

		const wrongCredential = await harness.worker.fetch(
			heartbeatRequest(
				{ jobId: leased.id, attemptId: leased.attemptId, leaseToken: leased.leaseToken },
				STATUS_TOKEN,
			),
			makeEnv(),
		);
		expect(wrongCredential.status).toBe(401);
	});

	it("parks a silent lease on poll, comments exactly once, and never re-grants it", async () => {
		harness.stub.nowOffsetMs = 21 * 60_000;
		const parked = await pollAgain();
		expect(parked.status).toBe(204);
		expect(harness.comments).toHaveLength(1);
		expect(harness.comments[0]!.body).toContain("liveness uncertain");

		await pollAgain();
		expect(harness.comments).toHaveLength(1);
		expect((await harness.stub.getJob(leased.id))?.status).toBe("reconcile");
	});

	it("restores a parked job on a fenced heartbeat and completes it normally", async () => {
		harness.stub.nowOffsetMs = 21 * 60_000;
		await pollAgain();

		const beat = await harness.worker.fetch(
			heartbeatRequest({ jobId: leased.id, attemptId: leased.attemptId, leaseToken: leased.leaseToken }),
			makeEnv(),
		);
		expect(beat.status).toBe(200);
		expect(((await beat.json()) as { restored: boolean }).restored).toBe(true);
		expect((await harness.stub.getJob(leased.id))?.status).toBe("leased");

		const done = await harness.worker.fetch(
			new Request("https://worker.test/result", {
				method: "POST",
				headers: { authorization: `Bearer ${RELAY_TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					jobId: leased.id,
					attemptId: leased.attemptId,
					leaseToken: leased.leaseToken,
					success: true,
					output: "survived the partition",
				}),
			}),
			makeEnv(),
		);
		expect(done.status).toBe(200);
		expect(harness.comments.some(c => c.body.includes("survived the partition"))).toBe(true);
	});

	it("startup sweep requeues only that runner's parked jobs and dispatch resumes", async () => {
		harness.stub.nowOffsetMs = 21 * 60_000;
		await pollAgain();

		const adminAttempt = await harness.worker.fetch(
			reconcileRequest({ runner: "relay-1", startupSweep: true }, STATUS_TOKEN),
			makeEnv(),
		);
		expect(adminAttempt.status).toBe(401);

		const swept = await harness.worker.fetch(reconcileRequest({ runner: "relay-1", startupSweep: true }), makeEnv());
		expect(swept.status).toBe(200);
		expect((await swept.json()) as Record<string, unknown>).toMatchObject({
			ok: true,
			resolved: 1,
			requeued: 1,
			deadLettered: 0,
		});

		const regrant = await pollAgain();
		expect(regrant.status).toBe(200);
		expect(((await regrant.json()) as { id: string }).id).toBe(leased.id);
		expect((await harness.stub.getJob(leased.id))?.attempts).toBe(2);
		// Parking comment only; requeues are not mirrored.
		expect(harness.comments).toHaveLength(1);
	});

	it("requires the admin credential for unfenced resolution and mirrors the dead letter", async () => {
		harness.stub.nowOffsetMs = 21 * 60_000;
		await pollAgain();

		const relayUnfenced = await harness.worker.fetch(
			reconcileRequest({ jobId: leased.id, requeue: false, reason: "killed" }),
			makeEnv(),
		);
		expect(relayUnfenced.status).toBe(401);

		const adminTerminate = await harness.worker.fetch(
			reconcileRequest({ jobId: leased.id, requeue: false, reason: "operator terminated the runner" }, STATUS_TOKEN),
			makeEnv(),
		);
		expect(adminTerminate.status).toBe(200);
		expect(((await adminTerminate.json()) as { disposition: string }).disposition).toBe("failed");
		expect(harness.comments.some(c => c.body.includes("dead-lettered"))).toBe(true);
		expect((await harness.stub.getJob(leased.id))?.status).toBe("failed");
	});

	it("rejects resolution of a job that is not parked", async () => {
		const active = await harness.worker.fetch(
			reconcileRequest({ jobId: leased.id, attemptId: leased.attemptId, leaseToken: leased.leaseToken }),
			makeEnv(),
		);
		expect(active.status).toBe(409);
	});
});

describe("transient retry via /result", () => {
	let harness: Harness;
	let leased: { id: string; attemptId: string; leaseToken: string };

	beforeEach(async () => {
		harness = makeHarness();
		await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD), makeEnv());
		leased = (await (
			await harness.worker.fetch(
				new Request("https://worker.test/poll?relay=relay-1", {
					headers: { authorization: `Bearer ${RELAY_TOKEN}` },
				}),
				makeEnv(),
			)
		).json()) as typeof leased;
	});

	function resultRequest(body: unknown): Request {
		return new Request("https://worker.test/result", {
			method: "POST",
			headers: { authorization: `Bearer ${RELAY_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("schedules a transient failure silently and re-grants after the backoff gate", async () => {
		const res = await harness.worker.fetch(
			resultRequest({
				jobId: leased.id,
				attemptId: leased.attemptId,
				leaseToken: leased.leaseToken,
				success: false,
				output: "",
				error: "socket hang up",
				failureClass: "transient",
			}),
			makeEnv(),
		);
		expect(res.status).toBe(200);
		expect((await res.json()) as Record<string, unknown>).toMatchObject({ ok: true, retryScheduled: true });
		// No per-retry noise on the Linear issue.
		expect(harness.comments).toHaveLength(0);
		expect((await harness.stub.getJob(leased.id))?.status).toBe("pending");

		// The fence died with the attempt: a duplicate submit is rejected.
		const dupe = await harness.worker.fetch(
			resultRequest({
				jobId: leased.id,
				attemptId: leased.attemptId,
				leaseToken: leased.leaseToken,
				success: false,
				output: "",
				failureClass: "transient",
			}),
			makeEnv(),
		);
		expect(dupe.status).toBe(409);

		// Not grantable before the gate opens; grantable after (default 30s).
		const early = await harness.worker.fetch(
			new Request("https://worker.test/poll?relay=relay-2", {
				headers: { authorization: `Bearer ${RELAY_TOKEN}` },
			}),
			makeEnv(),
		);
		expect(early.status).toBe(204);
		harness.stub.nowOffsetMs = 31_000;
		const regrant = await harness.worker.fetch(
			new Request("https://worker.test/poll?relay=relay-2", {
				headers: { authorization: `Bearer ${RELAY_TOKEN}` },
			}),
			makeEnv(),
		);
		expect(regrant.status).toBe(200);
		expect(((await regrant.json()) as { id: string }).id).toBe(leased.id);
		expect((await harness.stub.getJob(leased.id))?.attempts).toBe(2);
	});

	it("rejects an unknown failureClass", async () => {
		const res = await harness.worker.fetch(
			resultRequest({
				jobId: leased.id,
				attemptId: leased.attemptId,
				leaseToken: leased.leaseToken,
				success: false,
				output: "",
				failureClass: "sometimes",
			}),
			makeEnv(),
		);
		expect(res.status).toBe(400);
	});
});

describe("prompt refresh and attempt identity", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = makeHarness();
		await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD), makeEnv());
	});

	it("stamps the logical attempt key from the webhook organization on grant", async () => {
		harness.setIssue(makeIssue());
		const withOrg = makeHarness();
		await withOrg.worker.fetch(await webhookRequest({ ...ISSUE_UPDATE_PAYLOAD, organizationId: "org-1" }), makeEnv());
		const grant = await withOrg.stub.lease("relay-1");
		expect(grant?.job.logicalAttemptKey).toBe("linear:org-1:issue-1:1");
	});

	it("refreshes a pending job's prompt immediately on an authorized revision", async () => {
		harness.setIssue(makeIssue({ description: "Updated: also handle CRLF", updatedAt: "2026-07-14T00:00:00.000Z" }));
		const response = await harness.worker.fetch(
			await webhookRequest(ISSUE_UPDATE_PAYLOAD, { deliveryId: "delivery-2" }),
			makeEnv(),
		);
		expect((await response.json()) as Record<string, unknown>).toMatchObject({ ok: true, refreshed: "immediate" });
		const jobs = await harness.stub.listJobs();
		expect(jobs).toHaveLength(1);
		expect(jobs[0]!.prompt).toContain("Updated: also handle CRLF");
	});

	it("stages a revision while an attempt is in flight and applies it on the next grant", async () => {
		const first = await harness.stub.lease("relay-1");
		harness.setIssue(
			makeIssue({ description: "Second thoughts: different approach", updatedAt: "2026-07-15T00:00:00.000Z" }),
		);
		const response = await harness.worker.fetch(
			await webhookRequest(ISSUE_UPDATE_PAYLOAD, { deliveryId: "delivery-3" }),
			makeEnv(),
		);
		expect((await response.json()) as Record<string, unknown>).toMatchObject({ ok: true, refreshed: "staged" });
		// The in-flight attempt keeps the prompt it started with.
		expect((await harness.stub.getJob(first!.job.id))?.prompt).toContain("It breaks on");

		// Transient failure ends the attempt; the regrant carries the revision.
		await harness.stub.complete(first!.job.id, first!.attemptId, first!.leaseToken, {
			success: false,
			output: "",
			error: "socket hang up",
			failureClass: "transient",
		});
		harness.stub.nowOffsetMs = 31_000;
		const second = await harness.stub.lease("relay-2");
		expect(second?.job.prompt).toContain("Second thoughts");
		expect(second?.job.stagedPrompt).toBeUndefined();
	});

	it("ignores a replayed revision delivery", async () => {
		harness.setIssue(makeIssue({ updatedAt: "2026-07-14T00:00:00.000Z" }));
		await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD, { deliveryId: "delivery-2" }), makeEnv());
		const replay = await harness.worker.fetch(
			await webhookRequest(ISSUE_UPDATE_PAYLOAD, { deliveryId: "delivery-2" }),
			makeEnv(),
		);
		expect((await replay.json()) as Record<string, unknown>).toMatchObject({ ok: true, skipped: "duplicate" });
	});
});

describe("fence-check endpoint", () => {
	let harness: Harness;
	let leased: { id: string; attemptId: string; leaseToken: string };

	beforeEach(async () => {
		harness = makeHarness();
		await harness.worker.fetch(await webhookRequest(ISSUE_UPDATE_PAYLOAD), makeEnv());
		const grant = await harness.stub.lease("relay-1");
		leased = { id: grant!.job.id, attemptId: grant!.attemptId, leaseToken: grant!.leaseToken };
	});

	function fenceRequest(body: unknown): Request {
		return new Request("https://worker.test/fence-check", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("validates the current fence and rejects forged or malformed ones", async () => {
		const ok = await harness.worker.fetch(
			fenceRequest({ jobId: leased.id, attemptId: leased.attemptId, leaseToken: leased.leaseToken }),
			makeEnv(),
		);
		expect(ok.status).toBe(200);
		expect((await ok.json()) as Record<string, unknown>).toEqual({ valid: true });

		const forged = await harness.worker.fetch(
			fenceRequest({ jobId: leased.id, attemptId: leased.attemptId, leaseToken: "forged" }),
			makeEnv(),
		);
		expect(forged.status).toBe(409);

		const malformed = await harness.worker.fetch(fenceRequest({ jobId: leased.id }), makeEnv());
		expect(malformed.status).toBe(400);
	});

	it("invalidates a superseded fence after retry and re-grant", async () => {
		await harness.stub.complete(leased.id, leased.attemptId, leased.leaseToken, {
			success: false,
			output: "",
			error: "timeout",
			failureClass: "transient",
		});
		harness.stub.nowOffsetMs = 31_000;
		const regrant = await harness.stub.lease("relay-2");
		expect(regrant?.job.id).toBe(leased.id);

		const stale = await harness.worker.fetch(
			fenceRequest({ jobId: leased.id, attemptId: leased.attemptId, leaseToken: leased.leaseToken }),
			makeEnv(),
		);
		expect(stale.status).toBe(409);

		const fresh = await harness.worker.fetch(
			fenceRequest({ jobId: leased.id, attemptId: regrant!.attemptId, leaseToken: regrant!.leaseToken }),
			makeEnv(),
		);
		expect(fresh.status).toBe(200);
	});
});

describe("GitHub JIT token broker endpoint", () => {
	it("requires the host relay bearer in addition to the current GitHub fence", async () => {
		const stub = new FakeQueueStub();
		const githubJob: Job = {
			id: "github-job-1",
			source: "github",
			github: {
				owner: "kingkillery",
				repo: "oh-my-pk",
				number: 41,
				installationId: "12345",
				defaultBranch: "main",
				isPullRequest: false,
			},
			issueId: "kingkillery/oh-my-pk#41",
			issueIdentifier: "kingkillery/oh-my-pk#41",
			model: "combo-a",
			prompt: "implement",
			status: "pending",
			createdAt: new Date().toISOString(),
			dedupeKey: "github:issue:41",
			attempts: 0,
		};
		await stub.admit(githubJob);
		const grant = await stub.lease("relay-test");
		expect(grant).not.toBeNull();
		let tokenMints = 0;
		const worker = createWorker({
			fetchIssue: async () => makeIssue(),
			postComment: async () => undefined,
			github: {
				createInstallationToken: async (_env, installationId) => {
					expect(installationId).toBe("12345");
					tokenMints += 1;
					return { token: "ghs_jit_host_only", expiresAt: "2026-08-06T20:00:00Z" };
				},
				fetchWorkItem: async () => {
					throw new Error("unused");
				},
				postComment: async () => undefined,
				getCollaboratorPermission: async () => null,
			},
			queue: () => stub,
		});
		const currentFence = {
			jobId: githubJob.id,
			attemptId: grant!.attemptId,
			leaseToken: grant!.leaseToken,
		};
		const tokenRequest = (body: unknown, bearer?: string): Request => {
			const headers = new Headers({ "Content-Type": "application/json" });
			if (bearer !== undefined) headers.set("Authorization", `Bearer ${bearer}`);
			return new Request("https://worker.test/github-token", {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
		};

		const missingBearer = await worker.fetch(tokenRequest(currentFence), makeEnv());
		expect(missingBearer.status).toBe(401);
		const wrongBearer = await worker.fetch(tokenRequest(currentFence, "wrong-relay-token"), makeEnv());
		expect(wrongBearer.status).toBe(401);
		expect(tokenMints).toBe(0);

		const valid = await worker.fetch(tokenRequest(currentFence, RELAY_TOKEN), makeEnv());
		expect(valid.status).toBe(200);
		expect(await valid.json()).toEqual({
			token: "ghs_jit_host_only",
			expiresAt: "2026-08-06T20:00:00Z",
		});

		const stale = await worker.fetch(tokenRequest({ ...currentFence, leaseToken: "forged" }, RELAY_TOKEN), makeEnv());
		expect(stale.status).toBe(409);
		expect(tokenMints).toBe(1);
	});
});
