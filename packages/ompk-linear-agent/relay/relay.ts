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
import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_URL = process.env.WORKER_URL ?? "https://ompk-linear-agent.pkkidking.workers.dev";
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const RELAY_NAME = process.env.RELAY_NAME ?? hostname();
const WORKSPACE_DIR = process.env.OMPK_RELAY_WORKSPACE ?? process.cwd();
const GITHUB_WORKSPACE_ROOT = process.env.OMPK_RELAY_GITHUB_ROOT ?? join(WORKSPACE_DIR, "github-workspaces");
const POLL_INTERVAL_MS = Number(process.env.OMPK_RELAY_POLL_MS ?? 5000);
const JOB_TIMEOUT_MS = Number(process.env.OMPK_RELAY_JOB_TIMEOUT_MS ?? 30 * 60 * 1000);
/**
 * Executable dispatched for each job. Resolved from PATH by CreateProcess /
 * execvp without any shell; override with an absolute path when `omp` is
 * installed behind a .cmd shim that direct spawn cannot resolve.
 */
const OMP_BIN = process.env.OMPK_RELAY_OMP_BIN ?? "omp";
const CONTAINER_IMAGE = process.env.OMPK_RELAY_CONTAINER_IMAGE?.trim();
const CONTAINER_BIN = process.env.OMPK_RELAY_CONTAINER_BIN ?? "podman";
const CONTAINER_MEMORY = process.env.OMPK_RELAY_CONTAINER_MEMORY ?? "4g";
const CONTAINER_PIDS_LIMIT = 2048;
const SETUP_TIMEOUT_MS = Number(process.env.OMPK_RELAY_SETUP_TIMEOUT_MS ?? 10 * 60 * 1000);
const CONTAINER_HOME = "/tmp/ompk-home";
const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CONTAINER_GIT_HOOKS_DIR = "/opt/ompk/git-hooks";

export interface Job {
	id: string;
	source?: "linear" | "github";
	issueId: string;
	issueIdentifier: string;
	model: string;
	prompt: string;
	status: string;
	createdAt: string;
	attemptId: string;
	leaseToken: string;
	github?: {
		owner: string;
		repo: string;
		number: number;
		headRef?: string;
		defaultBranch: string;
	};
	/** Ephemeral installation token returned only in the poll response. */
	githubToken?: string;
	/** Heartbeat cadence the Worker expects; two missed beats park the job. */
	heartbeatMs?: number;
}


export interface JobRunResult {
	success: boolean;
	output: string;
	error?: string;
	/**
	 * Retry taxonomy: `transient` failures (timeout, spawn error, model not
	 * runnable on THIS relay) may be requeued with backoff by the queue;
	 * `permanent` (non-zero omp exit — deterministic by default) is
	 * terminal. Successes carry no class.
	 */
	failureClass?: "transient" | "permanent";
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
const CONTAINER_AGENT_ENV_KEYS = [
	"OMPK_FENCE_URL",
	"OMPK_FENCE_JOB",
	"OMPK_FENCE_ATTEMPT",
	"OMPK_FENCE_TOKEN",
	"GH_TOKEN",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
	"GIT_CONFIG_KEY_1",
	"GIT_CONFIG_VALUE_1",
] as const;

const SETUP_ENV_KEYS = [
	"PATH",
	"HOME",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"SHELL",
	"USER",
	"USERNAME",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;

export interface ContainerRunOptions {
	image: string;
	memory?: string;
	pidsLimit?: number;
	path?: string;
	home?: string;
	gitHooksDir?: string;
}

function appendContainerEnv(args: string[], env: NodeJS.ProcessEnv): void {
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) args.push("--env", `${key}=${value}`);
	}
}

function buildContainerBaseArgs(
	workspace: string,
	env: NodeJS.ProcessEnv,
	options: ContainerRunOptions,
	mountGitHooks: boolean,
): string[] {
	const home = options.home ?? CONTAINER_HOME;
	const args = [
		"run",
		"--rm",
		"--volume",
		`${workspace}:/workspace:Z`,
		"--workdir",
		"/workspace",
		"--tmpfs",
		`${home}:rw,mode=700`,
		"--network=host",
		"--memory",
		options.memory ?? "4g",
		"--pids-limit",
		String(options.pidsLimit ?? CONTAINER_PIDS_LIMIT),
	];
	if (mountGitHooks) {
		args.push("--volume", `${options.gitHooksDir ?? GIT_HOOKS_DIR}:${CONTAINER_GIT_HOOKS_DIR}:ro,z`);
	}
	appendContainerEnv(args, env);
	args.push(options.image);
	return args;
}

/**
 * Build a podman-compatible container argv for the untrusted agent phase.
 * Only the explicit fence/git/GitHub variables cross the container boundary.
 */
export function buildContainerArgs(
	job: Pick<Job, "model" | "prompt">,
	workspace: string,
	env: NodeJS.ProcessEnv,
	options: ContainerRunOptions,
): string[] {
	const containerEnv: NodeJS.ProcessEnv = {
		PATH: options.path ?? CONTAINER_PATH,
		HOME: options.home ?? CONTAINER_HOME,
	};
	for (const key of CONTAINER_AGENT_ENV_KEYS) {
		const value = env[key];
		if (value !== undefined) containerEnv[key] = value;
	}
	if (containerEnv.GIT_CONFIG_VALUE_0 !== undefined) {
		containerEnv.GIT_CONFIG_VALUE_0 = CONTAINER_GIT_HOOKS_DIR;
	}
	return [
		...buildContainerBaseArgs(workspace, containerEnv, options, true),
		"omp",
		...buildOmpArgs(job.model, job.prompt),
	];
}

/** Environment for repo-declared setup: system/network basics, never tokens. */
export function buildSetupHookEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of SETUP_ENV_KEYS) {
		const value = source[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

export type SpawnFn = (
	command: string,
	args: readonly string[],
	options: { cwd: string; shell?: false; env?: NodeJS.ProcessEnv },
) => ChildProcess;

export interface RunHooks {
	onSpawn?: (child: ChildProcess) => void;
	/** Full child environment (replaces, not merges; spread process.env in). */
	env?: NodeJS.ProcessEnv;
	/** Optional per-job checkout directory for GitHub work. */
	cwd?: string;
	/** Command/argv override used by feature-flagged container execution. */
	command?: string;
	args?: readonly string[];
	/** Container runtime exits are retryable infrastructure failures. */
	nonZeroFailureClass?: "transient" | "permanent";
}

/** Runs the job's prompt through `omp` headlessly — argv only, no shell. */
export function runOmp(
	model: string,
	prompt: string,
	spawnImpl: SpawnFn = spawn,
	timeoutMs: number = JOB_TIMEOUT_MS,
	hooks: RunHooks = {},
): Promise<JobRunResult> {
	const { promise, resolve } = Promise.withResolvers<JobRunResult>();
	const child = spawnImpl(hooks.command ?? OMP_BIN, hooks.args ?? buildOmpArgs(model, prompt), {
		cwd: hooks.cwd ?? WORKSPACE_DIR,
		...(hooks.env ? { env: hooks.env } : {}),
	});
	hooks.onSpawn?.(child);

	let stdout = "";
	let stderr = "";
	const timer = setTimeout(() => {
		child.kill();
		resolve({ success: false, output: stdout, error: `timed out after ${timeoutMs}ms`, failureClass: "transient" });
	}, timeoutMs);

	child.stdout?.on("data", d => {
		stdout += d.toString();
	});
	child.stderr?.on("data", d => {
		stderr += d.toString();
	});
	child.on("error", err => {
		clearTimeout(timer);
		resolve({ success: false, output: stdout, error: err.message, failureClass: "transient" });
	});
	child.on("close", code => {
		clearTimeout(timer);
		if (code === 0) {
			resolve({ success: true, output: stdout });
			return;
		}
		// A clean non-zero exit is deterministic until proven otherwise:
		// retrying a failing contract burns tokens without new information.
		resolve({
			success: false,
			output: stdout,
			error: stderr || `exit code ${code}`,
			failureClass: hooks.nonZeroFailureClass ?? "permanent",
		});
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
	hooks: RunHooks = {},
): Promise<JobRunResult> {
	if (!allowedModels.includes(job.model)) {
		// Capacity/config mismatch, not a property of the work: another
		// relay (or this one, reconfigured) may run it after backoff.
		return {
			success: false,
			output: "",
			error: "model is not on this relay's allowlist (OMPK_RELAY_MODELS)",
			failureClass: "transient",
		};
	}
	return runOmp(job.model, job.prompt, spawnImpl, timeoutMs, hooks);
}
export type HookExistsFn = (path: string) => Promise<boolean>;

export interface SetupHookRunOptions {
	spawn?: SpawnFn;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	hookExists?: HookExistsFn;
	onSpawn?: (child: ChildProcess) => void;
	command?: string;
	args?: readonly string[];
	redactionToken?: string;
	nonZeroFailureClass?: "transient" | "permanent";
}

function setupFailureOutput(stdout: string, stderr: string, secret: string | undefined): string {
	const combined = [stdout, stderr].filter(part => part.length > 0).join("\n");
	const scrubbed = secret ? combined.replaceAll(secret, "[redacted]") : combined;
	const limit = 4096;
	return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}\n...[truncated]` : scrubbed;
}

/**
 * Run a repo-declared setup hook when present. Success/missing returns
 * undefined; failures return a ready-to-submit job result.
 */
export async function runSetupHook(
	workspace: string,
	options: SetupHookRunOptions = {},
): Promise<JobRunResult | undefined> {
	const hookPath = join(workspace, ".ompk", "setup.sh");
	const hookExists = options.hookExists ?? (path => Bun.file(path).exists());
	if (!(await hookExists(hookPath))) return undefined;

	const spawnImpl = options.spawn ?? spawn;
	const timeoutMs = options.timeoutMs ?? SETUP_TIMEOUT_MS;
	const command = options.command ?? "bash";
	const args = options.args ?? [".ompk/setup.sh"];
	let child: ChildProcess;
	try {
		child = spawnImpl(command, args, {
			cwd: workspace,
			env: options.env ?? buildSetupHookEnv(),
		});
	} catch (err) {
		return {
			success: false,
			output: "",
			error: `setup hook .ompk/setup.sh failed to start: ${err instanceof Error ? err.message : String(err)}`,
			failureClass: "transient",
		};
	}
	options.onSpawn?.(child);

	const { promise, resolve } = Promise.withResolvers<JobRunResult | undefined>();
	let stdout = "";
	let stderr = "";
	const timer = setTimeout(() => {
		child.kill();
		resolve({
			success: false,
			output: setupFailureOutput(stdout, stderr, options.redactionToken),
			error: `setup hook .ompk/setup.sh timed out after ${timeoutMs}ms`,
			failureClass: "transient",
		});
	}, timeoutMs);
	child.stdout?.on("data", data => {
		stdout += data.toString();
	});
	child.stderr?.on("data", data => {
		stderr += data.toString();
	});
	child.on("error", err => {
		clearTimeout(timer);
		resolve({
			success: false,
			output: setupFailureOutput(stdout, stderr, options.redactionToken),
			error: `setup hook .ompk/setup.sh failed to start: ${err.message}`,
			failureClass: "transient",
		});
	});
	child.on("close", code => {
		clearTimeout(timer);
		if (code === 0) {
			resolve(undefined);
			return;
		}
		resolve({
			success: false,
			output: setupFailureOutput(stdout, stderr, options.redactionToken),
			error: `setup hook .ompk/setup.sh failed with exit code ${code}`,
			failureClass: options.nonZeroFailureClass ?? "permanent",
		});
	});
	return promise;
}

function buildContainerSetupArgs(
	workspace: string,
	env: NodeJS.ProcessEnv,
	options: ContainerRunOptions,
): string[] {
	const containerEnv = {
		...env,
		PATH: options.path ?? CONTAINER_PATH,
		HOME: options.home ?? CONTAINER_HOME,
	};
	return [...buildContainerBaseArgs(workspace, containerEnv, options, false), "bash", ".ompk/setup.sh"];
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

export type RunGitFn = (
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	redactionToken?: string,
) => Promise<void>;

export interface MirrorDependencies {
	runGit?: RunGitFn;
	mirrorExists?: (path: string) => Promise<boolean>;
	makeDir?: (path: string) => Promise<void>;
	warn?: (message: string) => void;
}

/** Stable, filesystem-safe bare mirror location for one GitHub repository. */
export function deriveMirrorPath(root: string, owner: string, repo: string): string {
	const name = `${owner}-${repo}.git`.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(root, ".mirrors", name);
}

/**
 * Refresh/create a mirror, degrading to an ordinary clone when any cache
 * operation fails. A mirror is only an optimization, never a job dependency.
 */
export async function tryPrepareRepoMirror(
	mirror: string,
	cloneUrl: string,
	env: NodeJS.ProcessEnv,
	redactionToken: string | undefined,
	dependencies: MirrorDependencies = {},
): Promise<string | undefined> {
	const runGitImpl = dependencies.runGit ?? runGit;
	const mirrorExists = dependencies.mirrorExists ?? (path => Bun.file(join(path, "HEAD")).exists());
	const makeDir =
		dependencies.makeDir ??
		(async path => {
			await mkdir(path, { recursive: true });
		});
	const warn = dependencies.warn ?? (message => console.error(message));
	try {
		await makeDir(dirname(mirror));
		if (await mirrorExists(mirror)) {
			await runGitImpl(["remote", "update", "--prune"], mirror, env, redactionToken);
		} else {
			await runGitImpl(["clone", "--mirror", cloneUrl, mirror], dirname(mirror), env, redactionToken);
		}
		return mirror;
	} catch (err) {
		const rawMessage = err instanceof Error ? err.message : String(err);
		const message = redactionToken ? rawMessage.replaceAll(redactionToken, "[redacted]") : rawMessage;
		warn(`[${new Date().toISOString()}] GitHub mirror cache unavailable; using full clone: ${message}`);
		return undefined;
	}
}
/** Workspace clones detach from the mirror so later pruning cannot break them. */
export function buildWorkspaceCloneArgs(
	cloneUrl: string,
	workspace: string,
	mirror: string | undefined,
): string[] {
	return [
		"clone",
		"--origin",
		"origin",
		...(mirror ? ["--reference-if-able", mirror, "--dissociate"] : []),
		cloneUrl,
		workspace,
	];
}
export interface CloneFallbackDependencies {
	runGit?: RunGitFn;
	removeWorkspace?: (path: string) => Promise<void>;
	warn?: (message: string) => void;
}

/** Retry without the cache when a referenced clone exposes mirror damage. */
export async function cloneWorkspaceWithMirrorFallback(
	cloneUrl: string,
	workspace: string,
	mirror: string | undefined,
	cwd: string,
	env: NodeJS.ProcessEnv,
	redactionToken: string | undefined,
	dependencies: CloneFallbackDependencies = {},
): Promise<void> {
	const runGitImpl = dependencies.runGit ?? runGit;
	const removeWorkspace =
		dependencies.removeWorkspace ??
		(async path => {
			await rm(path, { recursive: true, force: true });
		});
	const warn = dependencies.warn ?? (message => console.error(message));
	if (!mirror) {
		await runGitImpl(buildWorkspaceCloneArgs(cloneUrl, workspace, undefined), cwd, env, redactionToken);
		return;
	}
	try {
		await runGitImpl(buildWorkspaceCloneArgs(cloneUrl, workspace, mirror), cwd, env, redactionToken);
	} catch (err) {
		const rawMessage = err instanceof Error ? err.message : String(err);
		const message = redactionToken ? rawMessage.replaceAll(redactionToken, "[redacted]") : rawMessage;
		warn(`[${new Date().toISOString()}] GitHub reference clone failed; retrying full clone: ${message}`);
		await removeWorkspace(workspace);
		await runGitImpl(buildWorkspaceCloneArgs(cloneUrl, workspace, undefined), cwd, env, redactionToken);
	}
}



async function runGit(
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	redactionToken?: string,
): Promise<void> {
	const process = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const exitCode = await process.exited;
	if (exitCode !== 0) {
		const rawError = process.stderr ? await new Response(process.stderr).text() : "";
		const error = redactionToken ? rawError.replaceAll(redactionToken, "[redacted]") : rawError;
		throw new Error(`git ${args[0] ?? "command"} failed: ${error.trim() || `exit code ${exitCode}`}`);
	}
}

async function prepareGitHubWorkspace(job: Job): Promise<string> {
	if (!job.github || !job.githubToken) throw new Error("GitHub job is missing repository credentials");
	const workspace = join(
		GITHUB_WORKSPACE_ROOT,
		`${job.github.owner}-${job.github.repo}-${job.id}`.replace(/[^A-Za-z0-9._-]/g, "_"),
	);
	await mkdir(GITHUB_WORKSPACE_ROOT, { recursive: true });
	await rm(workspace, { recursive: true, force: true });
	const gitEnv = {
		...process.env,
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `url.https://x-access-token:${job.githubToken}@github.com/.insteadOf`,
		GIT_CONFIG_VALUE_0: "https://github.com/",
	};
	const cloneUrl = `https://github.com/${job.github.owner}/${job.github.repo}.git`;
	const mirror = await tryPrepareRepoMirror(
		deriveMirrorPath(GITHUB_WORKSPACE_ROOT, job.github.owner, job.github.repo),
		cloneUrl,
		gitEnv,
		job.githubToken,
	);
	await cloneWorkspaceWithMirrorFallback(
		cloneUrl,
		workspace,
		mirror,
		GITHUB_WORKSPACE_ROOT,
		gitEnv,
		job.githubToken,
	);
	if (job.github.headRef) {
		await runGit(["checkout", "-B", job.github.headRef, `origin/${job.github.headRef}`], workspace, gitEnv, job.githubToken);
	} else {
		const branch = `ompk/issue-${job.github.number}-${job.id.slice(0, 8)}`;
		await runGit(["checkout", "-B", branch, `origin/${job.github.defaultBranch}`], workspace, gitEnv, job.githubToken);
	}
	return workspace;
}

/** Hooks directory shipped next to the relay; contains the pre-push fence guard. */
const GIT_HOOKS_DIR = fileURLToPath(new URL("git-hooks/", import.meta.url)).replace(/[\\/]+$/, "");

/**
 * Child environment for one attempt: the fence triple (the pre-push guard's
 * credential — never the relay bearer token) plus a `core.hooksPath`
 * override injected through GIT_CONFIG_* so every git invocation in the
 * child tree runs the fence guard. The override shadows repo-local hooks
 * for the child, which is intended for a headless runner workspace.
 */
export function fenceEnv(job: Job): NodeJS.ProcessEnv {
	const githubAuth =
		job.source === "github" && job.githubToken
			? {
					GH_TOKEN: job.githubToken,
					GIT_CONFIG_COUNT: "2",
					GIT_CONFIG_KEY_1: `url.https://x-access-token:${job.githubToken}@github.com/.insteadOf`,
					GIT_CONFIG_VALUE_1: "https://github.com/",
				}
			: {
					GIT_CONFIG_COUNT: "1",
				};
	return {
		...process.env,
		OMPK_FENCE_URL: `${WORKER_URL}/fence-check`,
		OMPK_FENCE_JOB: job.id,
		OMPK_FENCE_ATTEMPT: job.attemptId,
		OMPK_FENCE_TOKEN: job.leaseToken,
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: GIT_HOOKS_DIR,
		...githubAuth,
	};
}

/** Remove the ephemeral installation token from any relay-reported text. */
export function scrubJobResult(result: JobRunResult, secret: string | undefined): JobRunResult {
	if (!secret) return result;
	return {
		...result,
		output: result.output.replaceAll(secret, "[redacted]"),
		...(result.error !== undefined ? { error: result.error.replaceAll(secret, "[redacted]") } : {}),
	};
}

async function runOnce(token: string, allowedModels: readonly string[]): Promise<boolean> {
	const job = await pollJob(token);
	if (!job) return false;

	console.log(`[${new Date().toISOString()}] running job ${job.id} (${job.issueIdentifier}, model=${job.model})`);
	let child: ChildProcess | undefined;
	let fenceLost = false;
	let workspace: string | undefined;
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
		try {
			workspace = job.source === "github" ? await prepareGitHubWorkspace(job) : undefined;
			const executionWorkspace = workspace ?? WORKSPACE_DIR;
			const agentEnv = fenceEnv(job);
			const containerOptions: ContainerRunOptions | undefined = CONTAINER_IMAGE
				? {
						image: CONTAINER_IMAGE,
						memory: CONTAINER_MEMORY,
						pidsLimit: CONTAINER_PIDS_LIMIT,
						gitHooksDir: GIT_HOOKS_DIR,
					}
				: undefined;
			let result: JobRunResult;
			if (!allowedModels.includes(job.model)) {
				result = await executeJob(job, allowedModels, spawn, JOB_TIMEOUT_MS);
			} else {
				const setupEnv = buildSetupHookEnv();
				const setupResult = await runSetupHook(executionWorkspace, {
					spawn,
					timeoutMs: SETUP_TIMEOUT_MS,
					env: setupEnv,
					onSpawn: spawned => {
						child = spawned;
					},
					redactionToken: job.githubToken,
					...(containerOptions
						? {
								command: CONTAINER_BIN,
								args: buildContainerSetupArgs(executionWorkspace, setupEnv, containerOptions),
								nonZeroFailureClass: "transient" as const,
							}
						: {}),
				});
				if (fenceLost) {
					console.error(`[${new Date().toISOString()}] job ${job.id} discarded: lease no longer held`);
					return true;
				}
				result =
					setupResult ??
					(await executeJob(job, allowedModels, spawn, JOB_TIMEOUT_MS, {
						onSpawn: spawned => {
							child = spawned;
						},
						...(containerOptions
							? {
									command: CONTAINER_BIN,
									args: buildContainerArgs(job, executionWorkspace, agentEnv, containerOptions),
									cwd: WORKSPACE_DIR,
									nonZeroFailureClass: "transient" as const,
								}
							: {
									env: agentEnv,
									cwd: workspace,
								}),
					}));
			}
			if (fenceLost) {
				console.error(`[${new Date().toISOString()}] job ${job.id} discarded: lease no longer held`);
				return true;
			}
			await submitResult(token, job, scrubJobResult(result, job.githubToken));
			console.log(`[${new Date().toISOString()}] job ${job.id} ${result.success ? "succeeded" : "failed"}`);
		} catch (err) {
			const result: JobRunResult = {
				success: false,
				output: "",
				error: err instanceof Error ? err.message : "GitHub workspace preparation failed",
				failureClass: "transient",
			};
			if (!fenceLost) await submitResult(token, job, scrubJobResult(result, job.githubToken));
		}
	} finally {
		clearInterval(beat);
		if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
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
