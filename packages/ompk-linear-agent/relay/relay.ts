#!/usr/bin/env bun
/**
 * Windows-side relay for the ompk Linear agent.
 *
 * Long-polls the Cloudflare Worker for queued jobs, runs each one through the
 * local `omp` CLI in headless mode (`--print --yolo --model <combo>`), and
 * posts the result back so the Worker can comment on the Linear issue.
 *
 * Security invariants:
 * - The child process is spawned WITHOUT a shell. The prompt and model are
 *   passed as literal argv entries, and the prompt rides behind a `--`
 *   positional separator, so Linear-controlled text can never be parsed as
 *   shell syntax or as `omp` flags.
 * - Jobs are executed only when their model is on the operator-configured
 *   allowlist (`OMPK_RELAY_MODELS`); everything else is reported back as a
 *   failure without spawning anything.
 * - Completions carry the lease fencing identity (`attemptId` + `leaseToken`)
 *   issued by the Worker's queue, so a stale relay cannot overwrite a newer
 *   attempt.
 *
 * Usage:
 *   WORKER_URL=https://ompk-linear-agent.pkkidking.workers.dev \
 *   RELAY_TOKEN=<the RELAY_TOKEN secret> \
 *   OMPK_RELAY_MODELS=qwen3.5plus,minimax-m3 \
 *   bun relay.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import { hostname } from "node:os";

const WORKER_URL = process.env.WORKER_URL ?? "https://ompk-linear-agent.pkkidking.workers.dev";
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const RELAY_NAME = process.env.RELAY_NAME ?? hostname();
const WORKSPACE_DIR = process.env.OMPK_RELAY_WORKSPACE ?? process.cwd();
const POLL_INTERVAL_MS = Number(process.env.OMPK_RELAY_POLL_MS ?? 5000);
const JOB_TIMEOUT_MS = Number(process.env.OMPK_RELAY_JOB_TIMEOUT_MS ?? 30 * 60 * 1000);
/**
 * Executable dispatched for each job. Resolved from PATH by CreateProcess /
 * execvp without any shell; override with an absolute path when `omp` is
 * installed behind a .cmd shim that direct spawn cannot resolve.
 */
const OMP_BIN = process.env.OMPK_RELAY_OMP_BIN ?? "omp";

export interface Job {
	id: string;
	issueId: string;
	issueIdentifier: string;
	model: string;
	prompt: string;
	status: string;
	createdAt: string;
	attemptId: string;
	leaseToken: string;
	/** Heartbeat cadence the Worker expects; two missed beats park the job. */
	heartbeatMs?: number;
}

export interface JobRunResult {
	success: boolean;
	output: string;
	error?: string;
}

/** Parse the operator's model allowlist; empty/missing means "allow nothing". */
export function parseAllowedModels(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0);
}

/**
 * Argv for one job. The `--` separator makes the prompt a positional even if
 * it begins with `-`; nothing here is ever interpreted by a shell.
 */
export function buildOmpArgs(model: string, prompt: string): string[] {
	return ["--print", "--yolo", "--model", model, "--", prompt];
}

export type SpawnFn = (
	command: string,
	args: readonly string[],
	options: { cwd: string; shell?: false },
) => ChildProcess;

/** Runs the job's prompt through `omp` headlessly — argv only, no shell. */
export function runOmp(
	model: string,
	prompt: string,
	spawnImpl: SpawnFn = spawn,
	timeoutMs: number = JOB_TIMEOUT_MS,
	onSpawn?: (child: ChildProcess) => void,
): Promise<JobRunResult> {
	const { promise, resolve } = Promise.withResolvers<JobRunResult>();
	const child = spawnImpl(OMP_BIN, buildOmpArgs(model, prompt), { cwd: WORKSPACE_DIR });
	onSpawn?.(child);

	let stdout = "";
	let stderr = "";
	const timer = setTimeout(() => {
		child.kill();
		resolve({ success: false, output: stdout, error: `timed out after ${timeoutMs}ms` });
	}, timeoutMs);

	child.stdout?.on("data", d => {
		stdout += d.toString();
	});
	child.stderr?.on("data", d => {
		stderr += d.toString();
	});
	child.on("error", err => {
		clearTimeout(timer);
		resolve({ success: false, output: stdout, error: err.message });
	});
	child.on("close", code => {
		clearTimeout(timer);
		resolve({ success: code === 0, output: stdout, error: code === 0 ? undefined : stderr || `exit code ${code}` });
	});
	return promise;
}

/**
 * Execute one job: allowlist gate first, then a shell-free spawn. A rejected
 * model never spawns a process and reports a non-sensitive failure.
 */
export async function executeJob(
	job: Pick<Job, "model" | "prompt">,
	allowedModels: readonly string[],
	spawnImpl: SpawnFn = spawn,
	timeoutMs: number = JOB_TIMEOUT_MS,
	onSpawn?: (child: ChildProcess) => void,
): Promise<JobRunResult> {
	if (!allowedModels.includes(job.model)) {
		return {
			success: false,
			output: "",
			error: "model is not on this relay's allowlist (OMPK_RELAY_MODELS)",
		};
	}
	return runOmp(job.model, job.prompt, spawnImpl, timeoutMs, onSpawn);
}

function authHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

async function pollJob(token: string): Promise<Job | null> {
	const res = await fetch(`${WORKER_URL}/poll?relay=${encodeURIComponent(RELAY_NAME)}`, {
		headers: authHeaders(token),
	});
	if (res.status === 204) return null;
	if (!res.ok) throw new Error(`poll failed: ${res.status} ${await res.text()}`);
	return (await res.json()) as Job;
}

async function submitResult(token: string, job: Job, result: JobRunResult): Promise<void> {
	const res = await fetch(`${WORKER_URL}/result`, {
		method: "POST",
		headers: { ...authHeaders(token), "Content-Type": "application/json" },
		body: JSON.stringify({
			jobId: job.id,
			attemptId: job.attemptId,
			leaseToken: job.leaseToken,
			...result,
		}),
	});
	if (!res.ok) throw new Error(`result submit failed: ${res.status} ${await res.text()}`);
}

const HEARTBEAT_FALLBACK_MS = 10 * 60_000;

/**
 * Fenced heartbeat. Returns false when the Worker rejects the fence (409):
 * the lease was reassigned or resolved, so this attempt must stop burning
 * tokens — the caller kills the child and skips the result submit.
 */
async function sendHeartbeat(token: string, job: Job): Promise<boolean> {
	const res = await fetch(`${WORKER_URL}/heartbeat`, {
		method: "POST",
		headers: { ...authHeaders(token), "Content-Type": "application/json" },
		body: JSON.stringify({ jobId: job.id, attemptId: job.attemptId, leaseToken: job.leaseToken }),
	});
	if (res.status === 409) return false;
	if (!res.ok) {
		// Network or Worker hiccup: keep running; the next beat may recover
		// and a reconcile-parked job is restored by any later fenced beat.
		console.error(`[${new Date().toISOString()}] heartbeat for ${job.id} failed: ${res.status}`);
	}
	return true;
}

/**
 * Startup attestation: this relay has no live children, so every job it
 * left parked in reconcile can be requeued (or dead-lettered on budget
 * exhaustion). Tolerates older Workers without the endpoint.
 */
async function announceStartup(token: string): Promise<void> {
	try {
		const res = await fetch(`${WORKER_URL}/reconcile`, {
			method: "POST",
			headers: { ...authHeaders(token), "Content-Type": "application/json" },
			body: JSON.stringify({ runner: RELAY_NAME, startupSweep: true }),
		});
		if (!res.ok) {
			console.error(`startup reconcile sweep skipped: ${res.status} ${await res.text()}`);
			return;
		}
		const summary = (await res.json()) as { resolved?: number; requeued?: number; deadLettered?: number };
		if (summary.resolved) {
			console.log(
				`startup reconcile sweep: ${summary.resolved} job(s) resolved (${summary.requeued ?? 0} requeued, ${summary.deadLettered ?? 0} dead-lettered)`,
			);
		}
	} catch (err) {
		console.error("startup reconcile sweep failed:", err instanceof Error ? err.message : err);
	}
}

async function runOnce(token: string, allowedModels: readonly string[]): Promise<boolean> {
	const job = await pollJob(token);
	if (!job) return false;

	console.log(`[${new Date().toISOString()}] running job ${job.id} (${job.issueIdentifier}, model=${job.model})`);
	let child: ChildProcess | undefined;
	let fenceLost = false;
	const cadence = job.heartbeatMs ?? HEARTBEAT_FALLBACK_MS;
	const beat = setInterval(() => {
		void sendHeartbeat(token, job).then(live => {
			if (live || fenceLost) return;
			fenceLost = true;
			console.error(`[${new Date().toISOString()}] lease for job ${job.id} was fenced off; killing runner`);
			child?.kill();
		});
	}, cadence);
	try {
		const result = await executeJob(job, allowedModels, spawn, JOB_TIMEOUT_MS, spawned => {
			child = spawned;
		});
		if (fenceLost) {
			console.error(`[${new Date().toISOString()}] job ${job.id} discarded: lease no longer held`);
			return true;
		}
		await submitResult(token, job, result);
		console.log(`[${new Date().toISOString()}] job ${job.id} ${result.success ? "succeeded" : "failed"}`);
	} finally {
		clearInterval(beat);
	}
	return true;
}

async function main(): Promise<void> {
	if (!RELAY_TOKEN) {
		console.error("RELAY_TOKEN is required (matches the Worker's RELAY_TOKEN secret)");
		process.exit(1);
	}
	const allowedModels = parseAllowedModels(process.env.OMPK_RELAY_MODELS);
	if (allowedModels.length === 0) {
		console.error("OMPK_RELAY_MODELS is required (comma-separated allowlist of model combo ids)");
		process.exit(1);
	}
	console.log(
		`ompk relay "${RELAY_NAME}" starting — polling ${WORKER_URL} every ${POLL_INTERVAL_MS}ms, ${allowedModels.length} allowed model(s)`,
	);
	await announceStartup(RELAY_TOKEN);
	for (;;) {
		try {
			const ranSomething = await runOnce(RELAY_TOKEN, allowedModels);
			if (!ranSomething) await Bun.sleep(POLL_INTERVAL_MS);
		} catch (err) {
			console.error("relay loop error:", err instanceof Error ? err.message : err);
			await Bun.sleep(POLL_INTERVAL_MS);
		}
	}
}

if (import.meta.main) {
	void main();
}
