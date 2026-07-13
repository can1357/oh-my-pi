/**
 * ompk Linear agent Worker — request handling, separated from the
 * Cloudflare entrypoint (`index.ts`) so contract tests can drive the exact
 * production handlers with injected Linear/queue dependencies.
 *
 * Security invariants enforced here:
 * - Webhook signature verification is necessary but NOT sufficient: dispatch
 *   additionally requires the explicit authorized admission state
 *   (see dispatch-policy.ts) and is deduplicated per delivery + revision.
 * - /poll and /result require the relay credential; completions are fenced
 *   by attempt id + lease token, and Linear side effects (comments) run at
 *   most once per accepted attempt.
 * - /status requires a separate administrative credential and only ever
 *   returns redacted operational metadata — never prompts, outputs, errors,
 *   tokens, or issue text.
 */

import { evaluateDispatch, resolveDispatchConfig } from "./dispatch-policy";
import type { IssueDetails } from "./linear";
import { timingSafeEqual, verifyLinearSignature } from "./linear";
import type { AdmitOutcome, CompleteOutcome, LeaseGrant } from "./queue-core";
import type { Env, Job, JobResult } from "./types";
import { redactJob } from "./types";

export interface JobQueueStub {
	admit(job: Job): Promise<AdmitOutcome>;
	lease(leasedBy: string): Promise<LeaseGrant | null>;
	complete(
		id: string,
		attemptId: string,
		leaseToken: string,
		result: Omit<JobResult, "completedAt">,
	): Promise<CompleteOutcome>;
	getJob(id: string): Promise<Job | null>;
	listJobs(): Promise<Job[]>;
}

export interface WorkerDeps {
	fetchIssue(token: string, issueId: string): Promise<IssueDetails>;
	postComment(token: string, issueId: string, body: string): Promise<void>;
	queue(env: Env): JobQueueStub;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function unauthorized(): Response {
	return json({ error: "unauthorized" }, 401);
}

/** Constant-time bearer check; rejects empty configured secrets outright. */
function bearerAuthorized(request: Request, expectedSecret: string | undefined): boolean {
	const secret = expectedSecret?.trim() ?? "";
	if (!secret) return false;
	const auth = request.headers.get("authorization") ?? "";
	return timingSafeEqual(auth, `Bearer ${secret}`);
}

interface LinearWebhookPayload {
	action?: string;
	type?: string;
	data?: {
		id?: string;
		issueId?: string;
		[key: string]: unknown;
	};
	notification?: {
		type?: string;
		issueId?: string;
	};
}

/** Best-effort extraction of the issue id an incoming webhook event refers to. */
function extractIssueId(payload: LinearWebhookPayload): string | null {
	if (payload.notification?.issueId) return payload.notification.issueId;
	if (typeof payload.data?.issueId === "string") return payload.data.issueId;
	if (payload.type === "Issue" && typeof payload.data?.id === "string") return payload.data.id;
	return null;
}

async function handleWebhook(request: Request, env: Env, deps: WorkerDeps): Promise<Response> {
	const rawBody = await request.text();
	const signature = request.headers.get("linear-signature");
	const valid = await verifyLinearSignature(rawBody, signature, env.LINEAR_WEBHOOK_SECRET);
	if (!valid) return unauthorized();

	const config = resolveDispatchConfig(env);
	if (!config) {
		// Fail closed: without a complete allowlist configuration nothing dispatches.
		return json({ ok: true, skipped: "dispatch disabled: incomplete allowlist configuration" });
	}

	let payload: LinearWebhookPayload;
	try {
		payload = JSON.parse(rawBody) as LinearWebhookPayload;
	} catch {
		return json({ error: "invalid payload" }, 400);
	}
	const issueId = extractIssueId(payload);
	if (!issueId) return json({ ok: true, skipped: "no issue id in payload" });

	const issue = await deps.fetchIssue(env.LINEAR_API_TOKEN, issueId);
	const decision = evaluateDispatch(
		{
			type: payload.type,
			action: payload.action,
			deliveryId: request.headers.get("linear-delivery"),
			issueId,
		},
		issue,
		config,
	);
	if (!decision.dispatch) {
		return json({ ok: true, skipped: decision.reason, issue: issue.identifier });
	}

	const job: Job = {
		id: crypto.randomUUID(),
		issueId: issue.id,
		issueIdentifier: issue.identifier,
		model: decision.model,
		prompt: `${issue.title}\n\n${issue.description ?? ""}`.trim(),
		status: "pending",
		createdAt: new Date().toISOString(),
		dedupeKey: decision.dedupeKey,
		attempts: 0,
	};
	const admitted = await deps.queue(env).admit(job);
	if (!admitted.accepted) {
		return json({ ok: true, skipped: admitted.reason, issue: issue.identifier });
	}
	return json({ ok: true, queued: admitted.jobId, issue: issue.identifier, model: decision.model });
}

/** Relay long-poll: leases the next job (fenced) or returns 204. */
async function handlePoll(request: Request, env: Env, deps: WorkerDeps): Promise<Response> {
	if (!bearerAuthorized(request, env.RELAY_TOKEN)) return unauthorized();
	const url = new URL(request.url);
	const relayName = url.searchParams.get("relay") ?? "unknown-relay";
	const grant = await deps.queue(env).lease(relayName);
	if (!grant) return new Response(null, { status: 204 });
	const { job, attemptId, leaseToken } = grant;
	return json({
		id: job.id,
		issueId: job.issueId,
		issueIdentifier: job.issueIdentifier,
		model: job.model,
		prompt: job.prompt,
		status: job.status,
		createdAt: job.createdAt,
		attemptId,
		leaseToken,
	});
}

interface ResultBody {
	jobId?: unknown;
	attemptId?: unknown;
	leaseToken?: unknown;
	success?: unknown;
	output?: unknown;
	error?: unknown;
}

async function handleResult(request: Request, env: Env, deps: WorkerDeps): Promise<Response> {
	if (!bearerAuthorized(request, env.RELAY_TOKEN)) return unauthorized();
	let body: ResultBody;
	try {
		body = (await request.json()) as ResultBody;
	} catch {
		return json({ error: "invalid body" }, 400);
	}
	if (
		typeof body.jobId !== "string" ||
		typeof body.attemptId !== "string" ||
		typeof body.leaseToken !== "string" ||
		typeof body.success !== "boolean" ||
		typeof body.output !== "string" ||
		(body.error !== undefined && typeof body.error !== "string")
	) {
		return json({ error: "invalid body" }, 400);
	}

	const outcome = await deps.queue(env).complete(body.jobId, body.attemptId, body.leaseToken, {
		success: body.success,
		output: body.output,
		error: body.error,
	});
	if (!outcome.ok) {
		if (outcome.code === "not_found") return json({ error: "job not found" }, 404);
		return json({ error: `completion rejected: ${outcome.code}` }, 409);
	}
	if (!outcome.duplicate) {
		const commentBody = body.success
			? `**ompk (${outcome.job.model}) — done**\n\n${body.output}`
			: `**ompk (${outcome.job.model}) — failed**\n\n${body.error ?? "unknown error"}\n\n${body.output}`;
		await deps.postComment(env.LINEAR_API_TOKEN, outcome.job.issueId, commentBody);
	}
	return json({ ok: true, duplicate: outcome.duplicate, job: redactJob(outcome.job) });
}

async function handleStatus(request: Request, env: Env, deps: WorkerDeps): Promise<Response> {
	if (!bearerAuthorized(request, env.STATUS_TOKEN)) return unauthorized();
	const url = new URL(request.url);
	const jobId = url.searchParams.get("jobId");
	if (jobId) {
		const job = await deps.queue(env).getJob(jobId);
		return job ? json(redactJob(job)) : json({ error: "not found" }, 404);
	}
	const jobs = await deps.queue(env).listJobs();
	return json({ jobs: jobs.map(redactJob) });
}

export function createWorker(deps: WorkerDeps): { fetch(request: Request, env: Env): Promise<Response> } {
	return {
		async fetch(request: Request, env: Env): Promise<Response> {
			const url = new URL(request.url);

			if (request.method === "POST" && url.pathname === "/webhook") {
				return handleWebhook(request, env, deps);
			}
			if (request.method === "GET" && url.pathname === "/poll") {
				return handlePoll(request, env, deps);
			}
			if (request.method === "POST" && url.pathname === "/result") {
				return handleResult(request, env, deps);
			}
			if (request.method === "GET" && url.pathname === "/status") {
				return handleStatus(request, env, deps);
			}
			if (url.pathname === "/") {
				return json({ ok: true, service: "ompk-linear-agent" });
			}
			return json({ error: "not found" }, 404);
		},
	};
}
