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
import { verifyGitHubSignature } from "./github";
import {
	type GitHubEventPayload,
	isSupportedGitHubEvent,
	isTrustedAssociation,
	isTrustedPermission,
	parseGitHubTrigger,
} from "./github-dispatch";
import type { IssueDetails } from "./linear";
import { deadLetterComment, reconcileComment, timingSafeEqual, verifyLinearSignature } from "./linear";
import type {
	AdmitOutcome,
	CompleteOutcome,
	HeartbeatOutcome,
	LeaseGrant,
	ReconcileDisposition,
	ReconcileOutcome,
	SweepResult,
} from "./queue-core";
import { DEFAULT_QUEUE_LIMITS } from "./queue-core";
import type { Env, GitHubJobTarget, Job, JobResult } from "./types";
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
	heartbeat(id: string, attemptId: string, leaseToken: string): Promise<HeartbeatOutcome>;
	sweep(): Promise<SweepResult>;
	resolveReconcile(
		id: string,
		opts: { requeue: boolean; reason: string; attemptId?: string; leaseToken?: string },
	): Promise<ReconcileOutcome>;
	resolveReconcileByRunner(
		runner: string,
		reason: string,
	): Promise<Array<{ job: Job; disposition: ReconcileDisposition }>>;
	refreshPrompt(
		issueId: string,
		prompt: string,
		dedupeKey: string,
	): Promise<
		{ ok: true; job: Job; applied: "immediate" | "staged" } | { ok: false; code: "no_active_job" | "duplicate" }
	>;
	checkFence(id: string, attemptId: string, leaseToken: string): Promise<{ valid: boolean }>;
	getJob(id: string): Promise<Job | null>;
	listJobs(): Promise<Job[]>;
}

export interface WorkerDeps {
	fetchIssue(token: string, issueId: string): Promise<IssueDetails>;
	postComment(token: string, issueId: string, body: string): Promise<void>;
	github?: {
		createInstallationToken(env: Env, installationId: string): Promise<{ token: string; expiresAt: string }>;
		fetchWorkItem(
			token: string,
			owner: string,
			repo: string,
			number: number,
			installationId: string,
			defaultBranch: string,
		): Promise<{ target: GitHubJobTarget; title: string; body: string }>;
		postComment(token: string, target: GitHubJobTarget, body: string): Promise<void>;
		getCollaboratorPermission(token: string, owner: string, repo: string, login: string): Promise<string | null>;
	};
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
	organizationId?: string;
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
async function postJobComment(env: Env, deps: WorkerDeps, job: Job, body: string): Promise<void> {
	if (job.source === "github") {
		if (!deps.github || !job.github) throw new Error("GitHub job dependencies are not configured");
		const installationToken = await deps.github.createInstallationToken(env, job.github.installationId);
		await deps.github.postComment(installationToken.token, job.github, body);
		return;
	}
	await deps.postComment(env.LINEAR_API_TOKEN, job.issueId, body);
}

async function handleGitHubWebhook(request: Request, env: Env, deps: WorkerDeps): Promise<Response> {
	const rawBody = await request.text();
	if (!(await verifyGitHubSignature(rawBody, request.headers.get("x-hub-signature-256"), env.GITHUB_WEBHOOK_SECRET))) {
		return unauthorized();
	}
	const eventName = request.headers.get("x-github-event") ?? "";
	const deliveryId = request.headers.get("x-github-delivery")?.trim() ?? "";
	if (!deliveryId) return json({ error: "missing GitHub delivery id" }, 400);
	if (!isSupportedGitHubEvent(eventName)) return json({ ok: true, skipped: "unsupported event" });

	let payload: GitHubEventPayload;
	try {
		payload = JSON.parse(rawBody) as GitHubEventPayload;
	} catch {
		return json({ error: "invalid payload" }, 400);
	}
	const installationId = payload.installation?.id === undefined ? "" : String(payload.installation.id);
	if (!installationId || !env.GITHUB_INSTALLATION_ID || installationId !== env.GITHUB_INSTALLATION_ID.trim()) {
		return json({ ok: true, skipped: "unauthorized installation" });
	}
	// Regular event deliveries abbreviate `installation` to `{id}`; the account
	// object only appears on installation.* events. Fall back to the repository
	// owner, which is present on every supported event.
	const accountLogin = payload.installation?.account?.login ?? payload.repository?.owner?.login;
	if (env.GITHUB_ACCOUNT_LOGIN && accountLogin?.toLowerCase() !== env.GITHUB_ACCOUNT_LOGIN.toLowerCase()) {
		return json({ ok: true, skipped: "unauthorized account" });
	}
	const handle = env.GITHUB_MENTION_HANDLE?.trim() || "ompk";
	const parsed = parseGitHubTrigger(eventName, payload, handle);
	if (!parsed.ok) return json({ ok: true, skipped: parsed.reason });
	if (!deps.github) return json({ error: "GitHub adapter is not configured" }, 503);
	if (!parsed.trigger.actor) return json({ ok: true, skipped: "missing actor" });

	const [owner, repo] = parsed.trigger.repo.split("/");
	if (!owner || !repo) return json({ error: "invalid repository" }, 400);
	let installationToken: { token: string; expiresAt: string };
	let permission: string | null;
	let workItem: { target: GitHubJobTarget; title: string; body: string };
	try {
		installationToken = await deps.github.createInstallationToken(env, installationId);
		permission = isTrustedAssociation(parsed.trigger.association)
			? null
			: await deps.github.getCollaboratorPermission(installationToken.token, owner, repo, parsed.trigger.actor);
		if (!isTrustedAssociation(parsed.trigger.association) && !isTrustedPermission(permission)) {
			return json({ ok: true, skipped: "requester is not authorized" });
		}
		workItem = await deps.github.fetchWorkItem(
			installationToken.token,
			owner,
			repo,
			parsed.trigger.number,
			installationId,
			payload.repository?.default_branch ?? "main",
		);
	} catch (err) {
		return json({ error: `GitHub API call failed: ${err instanceof Error ? err.message : "unknown"}` }, 502);
	}
	if (
		workItem.target.isPullRequest &&
		workItem.target.headRepo &&
		workItem.target.headRepo.toLowerCase() !== parsed.trigger.repo.toLowerCase()
	) {
		return json({ ok: true, skipped: "fork-originated execution is not supported" });
	}
	const model = env.GITHUB_MODEL?.trim() ?? "";
	if (!model) return json({ error: "GITHUB_MODEL is not configured" }, 503);
	const prompt = [
		`Repository: ${parsed.trigger.repo}`,
		`Target: ${parsed.trigger.kind} #${parsed.trigger.number}`,
		`URL: ${workItem.target.htmlUrl ?? "unavailable"}`,
		`Title: ${workItem.title}`,
		`Description: ${workItem.body}`,
		parsed.trigger.location ? `Review location: ${parsed.trigger.location}` : "",
		`Request: ${parsed.trigger.request}`,
	]
		.filter(Boolean)
		.join("\n\n")
		.trim();
	const issueId = `${parsed.trigger.repo}#${parsed.trigger.number}`;
	const job: Job = {
		id: crypto.randomUUID(),
		source: "github",
		issueId,
		issueIdentifier: issueId,
		model,
		prompt,
		status: "pending",
		createdAt: new Date().toISOString(),
		dedupeKey: `github:${parsed.trigger.dedupeId}`,
		attempts: 0,
		github: workItem.target,
	};
	const queue = deps.queue(env);
	const admitted = await queue.admit(job);
	if (admitted.accepted) return json({ ok: true, queued: admitted.jobId, target: issueId, model });
	if (admitted.reason === "active_job_exists") {
		const refreshed = await queue.refreshPrompt(issueId, prompt, job.dedupeKey);
		return refreshed.ok
			? json({ ok: true, refreshed: refreshed.applied, job: refreshed.job.id, target: issueId })
			: json({ ok: true, skipped: refreshed.code, target: issueId });
	}
	return json({ ok: true, skipped: admitted.reason ?? "not admitted", target: issueId });
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

	const prompt = `${issue.title}\n\n${issue.description ?? ""}`.trim();
	const job: Job = {
		id: crypto.randomUUID(),
		source: "linear",
		issueId: issue.id,
		issueIdentifier: issue.identifier,
		model: decision.model,
		prompt,
		status: "pending",
		createdAt: new Date().toISOString(),
		dedupeKey: decision.dedupeKey,
		attempts: 0,
		...(payload.organizationId ? { organizationId: payload.organizationId } : {}),
	};
	const admitted = await deps.queue(env).admit(job);
	if (admitted.accepted) {
		return json({ ok: true, queued: admitted.jobId, issue: issue.identifier, model: decision.model });
	}
	if (admitted.reason === "active_job_exists") {
		// The issue was revised while a job is active: attach the new prompt
		// instead of dropping the delivery (latest revision wins; in-flight
		// attempts keep the prompt they started with).
		const refreshed = await deps.queue(env).refreshPrompt(issue.id, prompt, decision.dedupeKey);
		if (refreshed.ok) {
			return json({ ok: true, refreshed: refreshed.applied, job: refreshed.job.id, issue: issue.identifier });
		}
		return json({ ok: true, skipped: refreshed.code, issue: issue.identifier });
	}
	return json({ ok: true, skipped: admitted.reason, issue: issue.identifier });
}

/**
 * Relay long-poll: parks silent leases (mirroring each to Linear), then
 * leases the next pending job (fenced) or returns 204. The grant carries
 * the heartbeat cadence the relay must sustain.
 */
async function handlePoll(request: Request, env: Env, deps: WorkerDeps): Promise<Response> {
	if (!bearerAuthorized(request, env.RELAY_TOKEN)) return unauthorized();
	const url = new URL(request.url);
	const relayName = url.searchParams.get("relay") ?? "unknown-relay";
	const queue = deps.queue(env);
	const { reconciled } = await queue.sweep();
	for (const job of reconciled) {
		try {
			await postJobComment(env, deps, job, reconcileComment(job));
		} catch (err) {
			// Best-effort mirror: the parked state is authoritative and visible
			// via /status; a Linear hiccup must not block job pickup.
			console.error(
				`reconcile comment failed for ${job.issueIdentifier}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
	const grant = await queue.lease(relayName);
	if (!grant) return new Response(null, { status: 204 });
	const { job, attemptId, leaseToken } = grant;
	const githubToken =
		job.source === "github" && deps.github && job.github
			? await deps.github.createInstallationToken(env, job.github.installationId)
			: undefined;
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
		...(job.source === "github" && job.github && githubToken
			? { github: job.github, githubToken: githubToken.token, githubTokenExpiresAt: githubToken.expiresAt }
			: {}),
		heartbeatMs: DEFAULT_QUEUE_LIMITS.heartbeatMs,
	});
}

interface ResultBody {
	jobId?: unknown;
	attemptId?: unknown;
	leaseToken?: unknown;
	success?: unknown;
	output?: unknown;
	error?: unknown;
	failureClass?: unknown;
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
		(body.error !== undefined && typeof body.error !== "string") ||
		(body.failureClass !== undefined && body.failureClass !== "transient" && body.failureClass !== "permanent")
	) {
		return json({ error: "invalid body" }, 400);
	}

	const outcome = await deps.queue(env).complete(body.jobId, body.attemptId, body.leaseToken, {
		success: body.success,
		output: body.output,
		error: body.error,
		failureClass: body.failureClass as "transient" | "permanent" | undefined,
	});
	if (!outcome.ok) {
		if (outcome.code === "not_found") return json({ error: "job not found" }, 404);
		return json({ error: `completion rejected: ${outcome.code}` }, 409);
	}
	if (outcome.retryScheduled) {
		// Scheduled retry: no terminal result exists yet, so nothing is
		// mirrored to the source system (context discipline: no per-retry noise).
		return json({ ok: true, retryScheduled: true, job: redactJob(outcome.job) });
	}
	if (!outcome.duplicate) {
		const commentBody = body.success
			? `**ompk (${outcome.job.model}) — done**\n\n${body.output}`
			: `**ompk (${outcome.job.model}) — failed**\n\n${outcome.job.result?.error ?? body.error ?? "unknown error"}\n\n${body.output}`;
		await postJobComment(env, deps, outcome.job, commentBody);
	}
	return json({ ok: true, duplicate: outcome.duplicate, job: redactJob(outcome.job) });
}

interface HeartbeatBody {
	jobId?: unknown;
	attemptId?: unknown;
	leaseToken?: unknown;
}

/** Fenced liveness signal from the relay; re-arms the lease or restores a reconcile-parked job. */
async function handleHeartbeat(request: Request, env: Env, deps: WorkerDeps): Promise<Response> {
	if (!bearerAuthorized(request, env.RELAY_TOKEN)) return unauthorized();
	let body: HeartbeatBody;
	try {
		body = (await request.json()) as HeartbeatBody;
	} catch {
		return json({ error: "invalid body" }, 400);
	}
	if (typeof body.jobId !== "string" || typeof body.attemptId !== "string" || typeof body.leaseToken !== "string") {
		return json({ error: "invalid body" }, 400);
	}
	const outcome = await deps.queue(env).heartbeat(body.jobId, body.attemptId, body.leaseToken);
	if (!outcome.ok) {
		if (outcome.code === "not_found") return json({ error: "job not found" }, 404);
		return json({ error: `heartbeat rejected: ${outcome.code}` }, 409);
	}
	return json({ ok: true, leaseExpiresAt: outcome.leaseExpiresAt, restored: outcome.restored });
}

interface ReconcileBody {
	jobId?: unknown;
	attemptId?: unknown;
	leaseToken?: unknown;
	requeue?: unknown;
	reason?: unknown;
	runner?: unknown;
	startupSweep?: unknown;
}

/**
 * Resolve reconcile-parked jobs once the prior runner's fate is confirmed.
 *
 * Authorization matrix:
 * - `{ runner, startupSweep: true }` — relay credential; the restarted relay
 *   attests it has no live children, so every job it owned is requeued (or
 *   dead-lettered on budget exhaustion).
 * - `{ jobId, attemptId, leaseToken, ... }` — fenced self-report; the fence
 *   proves the caller held the parked attempt.
 * - `{ jobId, ... }` without a fence — admin credential only (human
 *   confirmed termination out-of-band).
 *
 * Dead-lettered and failed dispositions post the last error plus recovery
 * action to the Linear issue.
 */
async function handleReconcile(request: Request, env: Env, deps: WorkerDeps): Promise<Response> {
	const relayAuth = bearerAuthorized(request, env.RELAY_TOKEN);
	const adminAuth = bearerAuthorized(request, env.STATUS_TOKEN);
	if (!relayAuth && !adminAuth) return unauthorized();
	let body: ReconcileBody;
	try {
		body = (await request.json()) as ReconcileBody;
	} catch {
		return json({ error: "invalid body" }, 400);
	}

	if (body.startupSweep === true) {
		if (!relayAuth) return unauthorized();
		if (typeof body.runner !== "string" || body.runner.length === 0) {
			return json({ error: "invalid body" }, 400);
		}
		const resolved = await deps
			.queue(env)
			.resolveReconcileByRunner(body.runner, `relay ${body.runner} restarted with no live jobs`);
		for (const { job, disposition } of resolved) {
			if (disposition === "requeued") continue;
			await postJobComment(env, deps, job, deadLetterComment(job, job.result?.error ?? "runner terminated"));
		}
		return json({
			ok: true,
			resolved: resolved.length,
			requeued: resolved.filter(r => r.disposition === "requeued").length,
			deadLettered: resolved.filter(r => r.disposition !== "requeued").length,
		});
	}

	if (typeof body.jobId !== "string") return json({ error: "invalid body" }, 400);
	const fenced = typeof body.attemptId === "string" && typeof body.leaseToken === "string";
	if (!fenced && !adminAuth) return unauthorized();
	const requeue = body.requeue !== false;
	const reason = typeof body.reason === "string" && body.reason.length > 0 ? body.reason : "runner terminated";
	const outcome = await deps.queue(env).resolveReconcile(body.jobId, {
		requeue,
		reason,
		...(fenced ? { attemptId: body.attemptId as string, leaseToken: body.leaseToken as string } : {}),
	});
	if (!outcome.ok) {
		if (outcome.code === "not_found") return json({ error: "job not found" }, 404);
		return json({ error: `reconcile rejected: ${outcome.code}` }, 409);
	}
	if (outcome.disposition !== "requeued") {
		await postJobComment(env, deps, outcome.job, deadLetterComment(outcome.job, outcome.job.result?.error ?? reason));
	}
	return json({ ok: true, disposition: outcome.disposition, job: redactJob(outcome.job) });
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

interface FenceCheckBody {
	jobId?: unknown;
	attemptId?: unknown;
	leaseToken?: unknown;
}

/**
 * Read-only fence introspection for branch-mutation guards (git pre-push).
 * Deliberately unauthenticated: the fence triple IS the credential, the
 * response leaks only validity, and the runner env must never carry relay
 * bearer tokens (it executes model-directed work).
 */
async function handleFenceCheck(request: Request, env: Env, deps: WorkerDeps): Promise<Response> {
	let body: FenceCheckBody;
	try {
		body = (await request.json()) as FenceCheckBody;
	} catch {
		return json({ error: "invalid body" }, 400);
	}
	if (typeof body.jobId !== "string" || typeof body.attemptId !== "string" || typeof body.leaseToken !== "string") {
		return json({ error: "invalid body" }, 400);
	}
	const { valid } = await deps.queue(env).checkFence(body.jobId, body.attemptId, body.leaseToken);
	return valid ? json({ valid: true }) : json({ valid: false }, 409);
}

export function createWorker(deps: WorkerDeps): { fetch(request: Request, env: Env): Promise<Response> } {
	return {
		async fetch(request: Request, env: Env): Promise<Response> {
			const url = new URL(request.url);

			if (request.method === "POST" && url.pathname === "/webhook") {
				return handleWebhook(request, env, deps);
			}
			if (request.method === "POST" && url.pathname === "/github/webhook") {
				return handleGitHubWebhook(request, env, deps);
			}
			if (request.method === "GET" && url.pathname === "/poll") {
				return handlePoll(request, env, deps);
			}
			if (request.method === "POST" && url.pathname === "/result") {
				return handleResult(request, env, deps);
			}
			if (request.method === "POST" && url.pathname === "/heartbeat") {
				return handleHeartbeat(request, env, deps);
			}
			if (request.method === "POST" && url.pathname === "/reconcile") {
				return handleReconcile(request, env, deps);
			}
			if (request.method === "POST" && url.pathname === "/fence-check") {
				return handleFenceCheck(request, env, deps);
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
