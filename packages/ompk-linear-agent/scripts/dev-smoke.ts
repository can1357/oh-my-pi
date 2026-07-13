#!/usr/bin/env bun
/**
 * Runtime smoke for the deployed-or-dev ompk-linear-agent Worker.
 *
 * Drives the REAL worker (e.g. `wrangler dev` on http://127.0.0.1:8787) over
 * HTTP, so the Durable Object queue, auth, and fencing run in workerd — the
 * layer unit tests cannot reach.
 *
 * Modes:
 * - Basic (always): health, webhook signature rejection, relay/status auth
 *   rejection, unknown-job 404.
 * - Full (when SMOKE_ISSUE_ID is set): signed webhook admission against a
 *   REAL Linear issue (use a scratch issue — completion posts a comment),
 *   concurrent poll exclusivity, stale-token fencing rejection (409),
 *   fenced completion, idempotent duplicate, and status redaction.
 *
 * Env:
 *   WORKER_URL              (default http://127.0.0.1:8787)
 *   LINEAR_WEBHOOK_SECRET   required — must match the worker's secret (.dev.vars)
 *   RELAY_TOKEN             required
 *   STATUS_TOKEN            required
 *   SMOKE_ISSUE_ID          optional — Linear issue id for the full path; the
 *                           issue must satisfy the dispatch policy (assignee,
 *                           project/model allowlists, Queue/Queued label)
 *
 * Never commit `.dev.vars`; it is wrangler's local secret store.
 */

const WORKER_URL = process.env.WORKER_URL ?? "http://127.0.0.1:8787";
const WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const STATUS_TOKEN = process.env.STATUS_TOKEN;
const SMOKE_ISSUE_ID = process.env.SMOKE_ISSUE_ID;

if (!WEBHOOK_SECRET || !RELAY_TOKEN || !STATUS_TOKEN) {
	console.error("LINEAR_WEBHOOK_SECRET, RELAY_TOKEN, and STATUS_TOKEN are required (match .dev.vars)");
	process.exit(1);
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
}

async function sign(body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(WEBHOOK_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function postWebhook(payload: unknown, deliveryId: string, badSignature = false): Promise<Response> {
	const body = JSON.stringify(payload);
	return fetch(`${WORKER_URL}/webhook`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"linear-signature": badSignature ? "0".repeat(64) : await sign(body),
			"linear-delivery": deliveryId,
		},
		body,
	});
}

async function basicChecks(): Promise<void> {
	const health = await fetch(`${WORKER_URL}/`);
	check("health endpoint responds", health.ok);

	const badSig = await postWebhook({ action: "update", type: "Issue", data: { id: "smoke" } }, "smoke-bad-sig", true);
	check("webhook rejects an invalid signature", badSig.status === 401);

	const pollNoAuth = await fetch(`${WORKER_URL}/poll?relay=smoke`, {
		headers: { authorization: "Bearer wrong" },
	});
	check("poll rejects a bad relay token", pollNoAuth.status === 401);

	const statusNoAuth = await fetch(`${WORKER_URL}/status`);
	check("status rejects a missing admin token", statusNoAuth.status === 401);

	const statusRelayToken = await fetch(`${WORKER_URL}/status`, {
		headers: { authorization: `Bearer ${RELAY_TOKEN}` },
	});
	check("status rejects the relay token", statusRelayToken.status === 401);

	const resultUnknown = await fetch(`${WORKER_URL}/result`, {
		method: "POST",
		headers: { authorization: `Bearer ${RELAY_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify({ jobId: "missing", attemptId: "a", leaseToken: "t", success: true, output: "" }),
	});
	check("result returns 404 for an unknown job", resultUnknown.status === 404);
}

interface LeasedJob {
	id: string;
	attemptId: string;
	leaseToken: string;
	prompt: string;
}

async function poll(): Promise<Response> {
	return fetch(`${WORKER_URL}/poll?relay=smoke`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } });
}

async function submitResult(body: unknown): Promise<Response> {
	return fetch(`${WORKER_URL}/result`, {
		method: "POST",
		headers: { authorization: `Bearer ${RELAY_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function fullChecks(issueId: string): Promise<void> {
	const delivery = `smoke-${crypto.randomUUID()}`;
	const admitted = await postWebhook({ action: "update", type: "Issue", data: { id: issueId } }, delivery);
	const admittedBody = (await admitted.json()) as { queued?: string; skipped?: string };
	check(
		"signed webhook admits the scratch issue",
		admitted.ok && admittedBody.queued !== undefined,
		`skipped=${admittedBody.skipped}`,
	);
	if (!admittedBody.queued) return;

	// Concurrent polls: exactly one may receive the single queued job.
	const [pollA, pollB] = await Promise.all([poll(), poll()]);
	const leases = [pollA, pollB].filter(res => res.status === 200);
	check("concurrent polls grant at most one lease", leases.length === 1, `statuses=${pollA.status},${pollB.status}`);
	if (leases.length !== 1) return;
	const job = (await leases[0]!.json()) as LeasedJob;

	const forged = await submitResult({
		jobId: job.id,
		attemptId: job.attemptId,
		leaseToken: "forged-token",
		success: true,
		output: "should never land",
	});
	check("fencing rejects a forged lease token with 409", forged.status === 409);

	const done = await submitResult({
		jobId: job.id,
		attemptId: job.attemptId,
		leaseToken: job.leaseToken,
		success: true,
		output: "smoke run OK",
	});
	check("fenced completion is accepted", done.status === 200);

	const duplicate = await submitResult({
		jobId: job.id,
		attemptId: job.attemptId,
		leaseToken: job.leaseToken,
		success: true,
		output: "smoke run OK",
	});
	const duplicateBody = (await duplicate.json()) as { duplicate?: boolean };
	check("duplicate completion is idempotent", duplicate.status === 200 && duplicateBody.duplicate === true);

	const status = await fetch(`${WORKER_URL}/status?jobId=${job.id}`, {
		headers: { authorization: `Bearer ${STATUS_TOKEN}` },
	});
	const statusText = await status.text();
	check(
		"status detail is redacted (no prompt/output/token)",
		status.status === 200 &&
			!statusText.includes(job.prompt.slice(0, 24)) &&
			!statusText.includes("smoke run OK") &&
			!statusText.includes(job.leaseToken),
	);
}

console.log(`smoke target: ${WORKER_URL}`);
await basicChecks();
if (SMOKE_ISSUE_ID) {
	await fullChecks(SMOKE_ISSUE_ID);
} else {
	console.log("SKIP  full webhook→poll→result→status path (set SMOKE_ISSUE_ID to a scratch Linear issue id)");
}
if (failures > 0) {
	console.error(`${failures} smoke check(s) failed`);
	process.exit(1);
}
console.log("smoke OK");
