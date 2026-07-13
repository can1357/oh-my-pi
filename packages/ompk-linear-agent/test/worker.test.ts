import { beforeEach, describe, expect, it } from "bun:test";
import type { IssueDetails } from "../src/linear";
import { QueueCore, type QueueStorage } from "../src/queue-core";
import type { Env, Job, JobResult } from "../src/types";
import { createWorker, type JobQueueStub } from "../src/worker";

class MemoryStorage implements QueueStorage {
	readonly #data = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return this.#data.get(key) as T | undefined;
	}

	async put(key: string, value: unknown): Promise<void> {
		this.#data.set(key, structuredClone(value));
	}

	async delete(key: string): Promise<void> {
		this.#data.delete(key);
	}
}

/** Fake stub running the REAL queue core, so endpoint tests exercise production queue semantics. */
class FakeQueueStub implements JobQueueStub {
	readonly core = new QueueCore(new MemoryStorage());

	async admit(job: Job) {
		return this.core.admit(job);
	}

	async lease(leasedBy: string) {
		return this.core.lease(leasedBy, Date.now());
	}

	async complete(id: string, attemptId: string, leaseToken: string, result: Omit<JobResult, "completedAt">) {
		return this.core.complete(id, attemptId, leaseToken, result, Date.now());
	}

	async getJob(id: string) {
		return this.core.getJob(id);
	}

	async listJobs() {
		return this.core.listJobs();
	}
}

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
		expect(body.skipped).toBe("active_job_exists");
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
