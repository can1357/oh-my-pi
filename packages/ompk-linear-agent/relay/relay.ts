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
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo, isIP, type Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
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
const NETWORK_GATEWAY_READY_TIMEOUT_MS = 10_000;
const NETWORK_GATEWAY_READY_RETRY_MS = 50;
const NETWORK_ANCHOR_MEMORY = "64m";
const NETWORK_ANCHOR_PIDS_LIMIT = 16;

export const SETUP_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
	"github.com:443",
	"api.github.com:443",
	"codeload.github.com:443",
	"objects.githubusercontent.com:443",
	"release-assets.githubusercontent.com:443",
	"raw.githubusercontent.com:443",
	"registry.npmjs.org:443",
	"registry.yarnpkg.com:443",
	"pypi.org:443",
	"files.pythonhosted.org:443",
	"crates.io:443",
	"index.crates.io:443",
	"static.crates.io:443",
]);

export const AGENT_ALLOWED_HOSTS: ReadonlySet<string> = new Set(["api.anthropic.com:443"]);

const MAX_CONNECT_HEADER_BYTES = 8192;
const CONNECT_HEADER_TIMEOUT_MS = 10_000;
const MAX_PROXY_SOCKETS = 128;

function ipv6Hextets(address: string): number[] | undefined {
	if (address.includes(".")) return undefined;
	const halves = address.toLowerCase().split("::");
	if (halves.length > 2) return undefined;
	const left = halves[0] ? halves[0].split(":").map(part => Number.parseInt(part, 16)) : [];
	const right = halves[1] ? halves[1].split(":").map(part => Number.parseInt(part, 16)) : [];
	const omitted = 8 - left.length - right.length;
	if (omitted < 0 || (halves.length === 1 && omitted !== 0)) return undefined;
	const hextets = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
	return hextets.length === 8 && hextets.every(part => Number.isInteger(part) && part >= 0 && part <= 0xffff)
		? hextets
		: undefined;
}

export function isPublicEgressAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const octets = address.split(".").map(Number);
		const [a, b, c] = octets;
		if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
		if (a === 0 || a === 10 || a === 127 || a! >= 224) return false;
		if (a === 100 && b! >= 64 && b! <= 127) return false;
		if (a === 169 && b === 254) return false;
		if (a === 172 && b! >= 16 && b! <= 31) return false;
		if (a === 192 && (b === 0 || (b === 88 && c === 99) || b === 168)) return false;
		if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
		if (a === 203 && b === 0) return false;
		return true;
	}
	if (isIP(address) !== 6) return false;
	const hextets = ipv6Hextets(address);
	if (!hextets) return false;
	const first = hextets[0]!;
	const second = hextets[1]!;
	if (first < 0x2000 || first > 0x3fff) return false;
	if (first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) return false;
	if (first === 0x2002) return false;
	if (first === 0x3fff && second < 0x1000) return false;
	return true;
}

async function resolvePublicHost(host: string): Promise<readonly string[]> {
	const resolved = await lookup(host, { all: true, verbatim: true });
	return resolved.map(entry => entry.address);
}

export interface EgressProxyHandle {
	readonly port: number;
	stop(): void;
}

export interface EgressProxyOptions {
	bindAddress?: string;
	connectUpstream?: typeof createConnection;
	resolveHost?: (host: string) => Promise<readonly string[]>;
	verifyRemoteAddress?: (socket: Socket, expectedAddress: string) => boolean;
}

/**
 * Start a CONNECT-only proxy for one execution phase. The default loopback
 * binding is safe for tests and explicit host-network use; container callers
 * opt into the private Podman bridge gateway address.
 */
export function startEgressProxy(
	phase: "setup" | "agent",
	options: EgressProxyOptions = {},
): Promise<EgressProxyHandle> {
	const allowedHosts = phase === "setup" ? SETUP_ALLOWED_HOSTS : AGENT_ALLOWED_HOSTS;
	const bindAddress = options.bindAddress ?? "127.0.0.1";
	const connectUpstream = options.connectUpstream ?? createConnection;
	const resolveHost = options.resolveHost ?? resolvePublicHost;
	const verifyRemoteAddress =
		options.verifyRemoteAddress ??
		((socket: Socket, expectedAddress: string): boolean =>
			socket.remoteAddress === expectedAddress || socket.remoteAddress === `::ffff:${expectedAddress}`);
	const sockets = new Set<Socket>();
	let stopped = false;
	let pendingConnections = 0;
	const { promise, resolve, reject } = Promise.withResolvers<EgressProxyHandle>();
	const server = createServer(clientSocket => {
		if (stopped || sockets.size + pendingConnections >= MAX_PROXY_SOCKETS) {
			clientSocket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		sockets.add(clientSocket);
		clientSocket.once("close", () => sockets.delete(clientSocket));
		clientSocket.once("error", () => undefined);
		clientSocket.setTimeout(CONNECT_HEADER_TIMEOUT_MS, () => clientSocket.destroy());
		let buffered = Buffer.alloc(0);

		const onData = (chunk: Buffer): void => {
			buffered = Buffer.concat([buffered, chunk]);
			const headerEnd = buffered.indexOf("\r\n\r\n");
			if (headerEnd < 0) {
				if (buffered.length > MAX_CONNECT_HEADER_BYTES) {
					clientSocket.removeListener("data", onData);
					clientSocket.write(
						"HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\n\r\n",
						() => clientSocket.destroy(),
					);
				}
				return;
			}
			clientSocket.removeListener("data", onData);
			clientSocket.setTimeout(0);
			const requestLineEnd = buffered.indexOf("\r\n");
			const requestLine = buffered.subarray(0, requestLineEnd).toString("ascii");
			const match = /^CONNECT ([^:\s]+):([1-9]\d{0,4}) HTTP\/1\.[01]$/.exec(requestLine);
			if (!match) {
				clientSocket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
				return;
			}
			const host = match[1]!.toLowerCase();
			const port = Number(match[2]);
			const target = `${host}:${port}`;
			if (!allowedHosts.has(target)) {
				clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
				return;
			}

			clientSocket.pause();
			pendingConnections += 1;
			let upstream: Socket | undefined;
			clientSocket.once("close", () => upstream?.destroy());
			void resolveHost(host)
				.then(addresses => {
					if (stopped || clientSocket.destroyed) return;
					if (addresses.length === 0 || addresses.some(address => !isPublicEgressAddress(address))) {
						clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
						return;
					}
					const approvedAddress = addresses[0]!;
					upstream = connectUpstream({ host: approvedAddress, port }, () => {
						if (
							stopped ||
							clientSocket.destroyed ||
							!upstream ||
							!verifyRemoteAddress(upstream, approvedAddress)
						) {
							upstream?.destroy();
							if (!clientSocket.destroyed) {
								clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
							}
							return;
						}
						clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
						const tail = buffered.subarray(headerEnd + 4);
						if (tail.length > 0) upstream.write(tail);
						upstream.pipe(clientSocket);
						clientSocket.pipe(upstream);
						clientSocket.resume();
					});
					sockets.add(upstream);
					upstream.once("close", () => {
						if (upstream) sockets.delete(upstream);
					});
					upstream.once("error", () => {
						if (upstream) sockets.delete(upstream);
						if (!clientSocket.destroyed) {
							clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
						}
					});
					if (stopped || clientSocket.destroyed) upstream.destroy();
				})
				.catch(() => {
					if (!stopped && !clientSocket.destroyed) {
						clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
					}
				})
				.finally(() => {
					pendingConnections -= 1;
				});
		};
		clientSocket.on("data", onData);
	});
	server.once("error", reject);
	server.listen(0, bindAddress, () => {
		const address = server.address() as AddressInfo;
		resolve({
			port: address.port,
			stop: () => {
				if (stopped) return;
				stopped = true;
				for (const socket of sockets) socket.destroy();
				sockets.clear();
				server.close();
			},
		});
	});
	return promise;
}

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
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
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
	network: string;
	egressProxyUrl?: string;
	noProxyHosts?: string;
	memory?: string;
	pidsLimit?: number;
	path?: string;
	home?: string;
	gitHooksDir?: string;
	name?: string;
}

export interface ContainerBrokerConfig {
	authenticatedGitBaseUrl?: string;
	fenceUrl: string;
	placeholderCredential?: string;
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
		`--network=${options.network}`,
		"--http-proxy=false",
		"--memory",
		options.memory ?? "4g",
		"--pids-limit",
		String(options.pidsLimit ?? CONTAINER_PIDS_LIMIT),
	];
	if (options.name) args.push("--name", options.name);
	if (mountGitHooks) {
		args.push("--volume", `${options.gitHooksDir ?? GIT_HOOKS_DIR}:${CONTAINER_GIT_HOOKS_DIR}:ro,z`);
	}
	appendContainerEnv(args, env);
	args.push(options.image);
	return args;
}

export function deriveContainerName(jobId: string, attemptId: string, phase: "setup" | "agent"): string {
	const safeAttempt = `${jobId}-${attemptId}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
	return `ompk-${safeAttempt}-${phase}`;
}

/**
 * Build a podman-compatible container argv for the untrusted agent phase.
 * Only the explicit fence/git/GitHub variables cross the container boundary.
 */
export function buildContainerArgs(
	job: Pick<Job, "model" | "prompt" | "source" | "githubToken" | "github">,
	workspace: string,
	env: NodeJS.ProcessEnv,
	options: ContainerRunOptions,
	broker?: ContainerBrokerConfig,
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
	if (options.egressProxyUrl) {
		containerEnv.HTTP_PROXY = options.egressProxyUrl;
		containerEnv.HTTPS_PROXY = options.egressProxyUrl;
		containerEnv.http_proxy = options.egressProxyUrl;
		containerEnv.https_proxy = options.egressProxyUrl;
	}
	if (options.noProxyHosts) {
		containerEnv.NO_PROXY = options.noProxyHosts;
		containerEnv.no_proxy = options.noProxyHosts;
	}
	if (broker) {
		containerEnv.OMPK_FENCE_URL = broker.fenceUrl;
		containerEnv.OMPK_BROKER_URL = broker.fenceUrl.slice(0, -"/fence-check".length);
		containerEnv.OMPK_BROKER_CREDENTIAL = broker.placeholderCredential;
		if (broker.authenticatedGitBaseUrl) {
			containerEnv.PATH = `${CONTAINER_GIT_HOOKS_DIR}:${containerEnv.PATH}`;
			if (job.github) {
				containerEnv.OMPK_GITHUB_REPO = `${job.github.owner}/${job.github.repo}`;
				containerEnv.OMPK_GITHUB_DEFAULT_BRANCH = job.github.defaultBranch;
			}
			containerEnv.GIT_CONFIG_COUNT = "2";
			containerEnv.GIT_CONFIG_KEY_1 = `url.${broker.authenticatedGitBaseUrl}.insteadOf`;
			containerEnv.GIT_CONFIG_VALUE_1 = "https://github.com/";
		}
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
	options: { cwd: string; shell?: false; env?: NodeJS.ProcessEnv; detached?: boolean },
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
	/** Awaitable container cleanup used for hard timeouts. */
	onTimeout?: () => Promise<void>;
	detached?: boolean;
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
		...(hooks.detached !== undefined ? { detached: hooks.detached } : {}),
	});
	hooks.onSpawn?.(child);

	let stdout = "";
	let stderr = "";
	let timedOut = false;
	const timeoutResult = (): JobRunResult => ({
		success: false,
		output: stdout,
		error: `timed out after ${timeoutMs}ms`,
		failureClass: "transient",
	});
	const timer = setTimeout(() => {
		timedOut = true;
		if (hooks.onTimeout) {
			void hooks
				.onTimeout()
				.catch(() => undefined)
				.then(() => resolve(timeoutResult()));
			return;
		}
		child.kill();
		resolve(timeoutResult());
	}, timeoutMs);

	child.stdout?.on("data", d => {
		stdout += d.toString();
	});
	child.stderr?.on("data", d => {
		stderr += d.toString();
	});
	child.on("error", err => {
		clearTimeout(timer);
		if (timedOut && hooks.onTimeout) return;
		resolve({ success: false, output: stdout, error: err.message, failureClass: "transient" });
	});
	child.on("close", code => {
		clearTimeout(timer);
		if (timedOut && hooks.onTimeout) return;
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
	/** Runtime process environment; container callers preserve Podman's host environment. */
	spawnEnv?: NodeJS.ProcessEnv;
	hookExists?: HookExistsFn;
	onSpawn?: (child: ChildProcess) => void;
	command?: string;
	args?: readonly string[];
	redactionToken?: string;
	nonZeroFailureClass?: "transient" | "permanent";
	onTimeout?: () => Promise<void>;
}

const SETUP_OUTPUT_LIMIT = 4096;

function setupFailureOutput(captured: string, wasTruncated: boolean): string {
	return wasTruncated ? `${captured}\n...[truncated]` : captured;
}

function forceKillChildTree(child: ChildProcess): void {
	if (process.platform !== "win32" && child.pid !== undefined) {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// Fall through when the child exited before its process group.
		}
	}
	child.kill("SIGKILL");
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
			env: options.spawnEnv ?? options.env ?? buildSetupHookEnv(),
			detached: process.platform !== "win32",
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
	let captured = "";
	let pending = "";
	let outputTruncated = false;
	let timedOut = false;
	const appendCaptured = (text: string): void => {
		const remaining = SETUP_OUTPUT_LIMIT - captured.length;
		if (remaining <= 0) {
			if (text.length > 0) outputTruncated = true;
			return;
		}
		captured += text.slice(0, remaining);
		if (text.length > remaining) outputTruncated = true;
	};
	const capture = (data: unknown): void => {
		pending += String(data);
		const secret = options.redactionToken;
		if (!secret) {
			appendCaptured(pending);
			pending = "";
			return;
		}
		for (;;) {
			const secretIndex = pending.indexOf(secret);
			if (secretIndex >= 0) {
				appendCaptured(pending.slice(0, secretIndex));
				appendCaptured("[redacted]");
				pending = pending.slice(secretIndex + secret.length);
				continue;
			}
			const safeLength = Math.max(0, pending.length - (secret.length - 1));
			appendCaptured(pending.slice(0, safeLength));
			pending = pending.slice(safeLength);
			return;
		}
	};
	const flushPending = (): void => {
		const secret = options.redactionToken;
		if (secret && pending.length > 0) {
			let prefixLength = Math.min(secret.length - 1, pending.length);
			while (prefixLength > 0 && !secret.startsWith(pending.slice(-prefixLength))) prefixLength -= 1;
			appendCaptured(pending.slice(0, pending.length - prefixLength));
			if (prefixLength > 0) appendCaptured("[redacted]");
		} else {
			appendCaptured(pending);
		}
		pending = "";
	};
	const failureOutput = (): string => {
		flushPending();
		return setupFailureOutput(captured, outputTruncated);
	};
	const timeoutResult = (): JobRunResult => ({
		success: false,
		output: failureOutput(),
		error: `setup hook .ompk/setup.sh timed out after ${timeoutMs}ms`,
		failureClass: "transient",
	});
	const timer = setTimeout(() => {
		timedOut = true;
		if (options.onTimeout) {
			void options
				.onTimeout()
				.catch(() => undefined)
				.then(() => resolve(timeoutResult()));
			return;
		}
		forceKillChildTree(child);
	}, timeoutMs);
	child.stdout?.on("data", capture);
	child.stderr?.on("data", capture);
	child.on("error", err => {
		clearTimeout(timer);
		if (timedOut) {
			if (!options.onTimeout) resolve(timeoutResult());
			return;
		}
		resolve({
			success: false,
			output: failureOutput(),
			error: `setup hook .ompk/setup.sh failed to start: ${err.message}`,
			failureClass: "transient",
		});
	});
	child.on("close", code => {
		clearTimeout(timer);
		if (timedOut) {
			if (!options.onTimeout) resolve(timeoutResult());
			return;
		}
		if (code === 0) {
			resolve(undefined);
			return;
		}
		resolve({
			success: false,
			output: failureOutput(),
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
	const containerEnv: NodeJS.ProcessEnv = {
		...env,
		PATH: options.path ?? CONTAINER_PATH,
		HOME: options.home ?? CONTAINER_HOME,
	};
	if (options.egressProxyUrl) {
		containerEnv.HTTP_PROXY = options.egressProxyUrl;
		containerEnv.HTTPS_PROXY = options.egressProxyUrl;
		containerEnv.http_proxy = options.egressProxyUrl;
		containerEnv.https_proxy = options.egressProxyUrl;
	}
	if (options.noProxyHosts) {
		containerEnv.NO_PROXY = options.noProxyHosts;
		containerEnv.no_proxy = options.noProxyHosts;
	}
	return [...buildContainerBaseArgs(workspace, containerEnv, options, false), "bash", ".ompk/setup.sh"];
}
async function forceRemoveContainer(name: string): Promise<void> {
	const subprocess = Bun.spawn([CONTAINER_BIN, "rm", "--force", name], {
		env: process.env,
		stdout: "ignore",
		stderr: "pipe",
	});
	const exitCode = await subprocess.exited;
	if (exitCode !== 0) {
		const error = subprocess.stderr ? await new Response(subprocess.stderr).text() : "";
		throw new Error(`container cleanup failed: ${error.trim() || `exit code ${exitCode}`}`);
	}
}

async function stopNamedContainer(name: string, runtimeChild: ChildProcess | undefined): Promise<void> {
	if (runtimeChild) forceKillChildTree(runtimeChild);
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await forceRemoveContainer(name);
			return;
		} catch (err) {
			lastError = err;
			if (attempt === 0) await Bun.sleep(100);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("container cleanup failed");
}

const NFT_BIN = process.env.OMPK_RELAY_NFT_BIN ?? "nft";

async function runChecked(command: readonly string[], errorPrefix: string): Promise<void> {
	const subprocess = Bun.spawn([...command], {
		env: process.env,
		stdout: "ignore",
		stderr: "pipe",
	});
	const exitCode = await subprocess.exited;
	if (exitCode === 0) return;
	const stderr = subprocess.stderr ? await new Response(subprocess.stderr).text() : "";
	throw new Error(`${errorPrefix}: ${stderr.trim() || `exit code ${exitCode}`}`);
}

async function removeNetwork(name: string): Promise<void> {
	await runChecked(
		[CONTAINER_BIN, "network", "rm", "--force", name],
		`failed to remove Podman network ${name}`,
	);
}

export function buildFirewallCommands(
	table: string,
	networkInterface: string,
	allowedPorts: readonly number[],
): readonly string[][] {
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(table)) throw new Error("invalid nftables table name");
	if (!/^[A-Za-z0-9_.:-]{1,32}$/.test(networkInterface)) throw new Error("invalid bridge interface name");
	if (
		allowedPorts.length === 0 ||
		allowedPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65_535)
	) {
		throw new Error("firewall requires valid active TCP ports");
	}
	const portSet = [...new Set(allowedPorts)].sort((a, b) => a - b).map(String);
	return [
		[NFT_BIN, "add", "table", "inet", table],
		[
			NFT_BIN,
			"add",
			"chain",
			"inet",
			table,
			"input",
			"{",
			"type",
			"filter",
			"hook",
			"input",
			"priority",
			"-5",
			";",
			"policy",
			"accept",
			";",
			"}",
		],
		[
			NFT_BIN,
			"add",
			"rule",
			"inet",
			table,
			"input",
			"iifname",
			networkInterface,
			"tcp",
			"dport",
			"{",
			...portSet.flatMap((port, index) => (index === 0 ? [port] : [",", port])),
			"}",
			"accept",
		],
		[NFT_BIN, "add", "rule", "inet", table, "input", "iifname", networkInterface, "drop"],
	];
}

export interface JobNetworkHandle {
	readonly name: string;
	readonly gatewayIp: string;
	readonly networkInterface: string;
	setAllowedPorts(ports: readonly number[]): Promise<void>;
	remove(): Promise<void>;
}

function recordField(record: Record<string, unknown>, ...keys: string[]): unknown {
	for (const key of keys) {
		if (key in record) return record[key];
	}
	return undefined;
}

export function deriveFirewallTableName(jobId: string, attemptId: string): string {
	const digest = createHash("sha256").update(`${jobId}\0${attemptId}`).digest("hex").slice(0, 24);
	return `ompk_${digest}`;
}

export function deriveJobNetworkName(jobId: string, attemptId: string): string {
	const readable = jobId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 24);
	const digest = createHash("sha256").update(`${jobId}\0${attemptId}`).digest("hex").slice(0, 16);
	return `ompk-${readable}-${digest}`;
}

export interface JobNetworkInspection {
	readonly gatewayIp: string;
	readonly networkInterface: string;
}

type CheckedCommandRunner = (command: readonly string[], errorPrefix: string) => Promise<void>;

export interface JobNetworkDependencies {
	runCommand?: CheckedCommandRunner;
	inspectNetwork?: (name: string) => Promise<JobNetworkInspection>;
	waitForGateway?: (gatewayIp: string) => Promise<void>;
	clearFirewall?: (table: string) => Promise<void>;
	forceRemoveAnchor?: (name: string) => Promise<void>;
	removeNetwork?: (name: string) => Promise<void>;
}

export interface NetworkGatewayWaitOptions {
	timeoutMs?: number;
	retryMs?: number;
	probe?: (gatewayIp: string) => Promise<boolean>;
	sleep?: (delayMs: number) => Promise<void>;
}

export function deriveNetworkAnchorName(jobId: string, attemptId: string): string {
	return `${deriveJobNetworkName(jobId, attemptId)}-anchor`;
}

/**
 * Materialize the internal bridge with an operator-trusted, inert container.
 * No host environment, workspace, credential, or host path crosses this argv.
 */
export function buildNetworkAnchorArgs(image: string, network: string, name: string): string[] {
	if (!image.trim()) throw new Error("network anchor requires a trusted container image");
	return [
		"run",
		"--detach",
		"--rm",
		"--stop-timeout=1",
		"--name",
		name,
		`--network=${network}`,
		"--http-proxy=false",
		"--read-only",
		"--cap-drop=all",
		"--security-opt=no-new-privileges",
		"--memory",
		NETWORK_ANCHOR_MEMORY,
		"--pids-limit",
		String(NETWORK_ANCHOR_PIDS_LIMIT),
		"--entrypoint=/bin/sh",
		image,
		"-c",
		"while :; do sleep 3600; done",
	];
}

function probeGatewayBind(gatewayIp: string): Promise<boolean> {
	return new Promise(resolve => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.listen(0, gatewayIp, () => {
			server.close(() => resolve(true));
		});
	});
}

export async function waitForNetworkGateway(
	gatewayIp: string,
	options: NetworkGatewayWaitOptions = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? NETWORK_GATEWAY_READY_TIMEOUT_MS;
	const retryMs = options.retryMs ?? NETWORK_GATEWAY_READY_RETRY_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(retryMs) || retryMs <= 0) {
		throw new Error("invalid network gateway readiness timing");
	}
	const probe = options.probe ?? probeGatewayBind;
	const sleep = options.sleep ?? Bun.sleep;
	const startedAt = Date.now();
	for (;;) {
		if (await probe(gatewayIp).catch(() => false)) return;
		const remainingMs = timeoutMs - (Date.now() - startedAt);
		if (remainingMs <= 0) {
			throw new Error(`Podman network gateway ${gatewayIp} did not become bindable within ${timeoutMs}ms`);
		}
		await sleep(Math.min(retryMs, remainingMs));
	}
}

async function inspectJobNetwork(name: string): Promise<JobNetworkInspection> {
	const inspect = Bun.spawn([CONTAINER_BIN, "network", "inspect", name], {
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await inspect.exited;
	if (exitCode !== 0) {
		const stderr = inspect.stderr ? await new Response(inspect.stderr).text() : "";
		throw new Error(`failed to inspect Podman network ${name}: ${stderr.trim() || `exit code ${exitCode}`}`);
	}
	const output = inspect.stdout ? await new Response(inspect.stdout).text() : "";
	const parsed: unknown = JSON.parse(output);
	if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== "object" || parsed[0] === null) {
		throw new Error(`Podman network ${name} returned invalid inspect data`);
	}
	const network = parsed[0] as Record<string, unknown>;
	const subnets = recordField(network, "subnets", "Subnets");
	const networkInterface = recordField(network, "network_interface", "NetworkInterface");
	if (!Array.isArray(subnets) || subnets.length === 0 || typeof subnets[0] !== "object" || subnets[0] === null) {
		throw new Error(`Podman network ${name} has no subnet`);
	}
	const gatewayIp = recordField(subnets[0] as Record<string, unknown>, "gateway", "Gateway");
	if (typeof gatewayIp !== "string" || !gatewayIp || typeof networkInterface !== "string" || !networkInterface) {
		throw new Error(`Podman network ${name} has no gateway or bridge interface`);
	}
	return { gatewayIp, networkInterface };
}

async function clearFirewallTable(table: string): Promise<void> {
	const deletion = Bun.spawn([NFT_BIN, "delete", "table", "inet", table], {
		env: process.env,
		stdout: "ignore",
		stderr: "ignore",
	});
	await deletion.exited.catch(() => undefined);
}

function cleanupError(message: string, failures: unknown[]): Error {
	if (failures.length === 1 && failures[0] instanceof Error) return failures[0];
	return new AggregateError(failures, message);
}

/** Create a fail-closed internal bridge, trusted anchor, and host-input firewall for one attempt. */
export async function createJobNetwork(
	jobId: string,
	attemptId: string,
	anchorImage: string,
	dependencies: JobNetworkDependencies = {},
): Promise<JobNetworkHandle> {
	const name = deriveJobNetworkName(jobId, attemptId);
	const anchorName = deriveNetworkAnchorName(jobId, attemptId);
	const firewallTable = deriveFirewallTableName(jobId, attemptId);
	const runCommand = dependencies.runCommand ?? runChecked;
	const inspectNetwork = dependencies.inspectNetwork ?? inspectJobNetwork;
	const waitForGateway = dependencies.waitForGateway ?? waitForNetworkGateway;
	const clearFirewall = dependencies.clearFirewall ?? clearFirewallTable;
	const forceRemoveAnchor =
		dependencies.forceRemoveAnchor ?? ((containerName: string) => stopNamedContainer(containerName, undefined));
	const removeCreatedNetwork = dependencies.removeNetwork ?? removeNetwork;
	let networkMayExist = false;
	let anchorMayExist = false;
	try {
		networkMayExist = true;
		await runCommand(
			[CONTAINER_BIN, "network", "create", "--internal", "--opt", "isolate=strict", name],
			`failed to create Podman network ${name}`,
		);
		const { gatewayIp, networkInterface } = await inspectNetwork(name);
		anchorMayExist = true;
		await runCommand(
			[CONTAINER_BIN, ...buildNetworkAnchorArgs(anchorImage, name, anchorName)],
			`failed to start trusted network anchor ${anchorName}`,
		);
		await waitForGateway(gatewayIp);

		const setAllowedPorts = async (ports: readonly number[]): Promise<void> => {
			await clearFirewall(firewallTable);
			try {
				for (const command of buildFirewallCommands(firewallTable, networkInterface, ports)) {
					await runCommand(command, `failed to fence Podman network ${name}`);
				}
			} catch (error) {
				await clearFirewall(firewallTable);
				throw error;
			}
		};
		let removal: Promise<void> | undefined;
		const remove = (): Promise<void> => {
			removal ??= (async () => {
				const failures: unknown[] = [];
				await clearFirewall(firewallTable).catch(error => failures.push(error));
				await forceRemoveAnchor(anchorName).catch(error => failures.push(error));
				await removeCreatedNetwork(name).catch(error => failures.push(error));
				if (failures.length > 0) throw cleanupError(`failed to clean Podman network ${name}`, failures);
			})();
			return removal;
		};
		return { name, gatewayIp, networkInterface, setAllowedPorts, remove };
	} catch (error) {
		if (anchorMayExist) await forceRemoveAnchor(anchorName).catch(() => undefined);
		if (networkMayExist) await removeCreatedNetwork(name).catch(() => undefined);
		throw error;
	}
}

const MAX_RECEIVE_PACK_COMMAND_BYTES = 64 * 1024;

export type ReceivePackInspection =
	| { ok: true; refs: readonly string[] }
	| { ok: false; status: 400 | 403; error: string };

/**
 * Inspect only the pkt-line command prefix of a git-receive-pack request.
 * The caller tees the body, so the accepted upload can still stream upstream.
 */
export async function inspectReceivePack(
	body: ReadableStream<Uint8Array>,
): Promise<ReceivePackInspection> {
	const reader = body.getReader();
	let buffered = Buffer.alloc(0);
	let offset = 0;
	let inspectedBytes = 0;
	const refs: string[] = [];
	try {
		for (;;) {
			while (buffered.length - offset < 4) {
				const next = await reader.read();
				if (next.done) return { ok: false, status: 400, error: "truncated receive-pack command list" };
				buffered = Buffer.concat([buffered.subarray(offset), Buffer.from(next.value)]);
				offset = 0;
			}
			const lengthText = buffered.subarray(offset, offset + 4).toString("ascii");
			if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) {
				return { ok: false, status: 400, error: "invalid receive-pack pkt-line length" };
			}
			const packetLength = Number.parseInt(lengthText, 16);
			if (packetLength === 0) {
				if (refs.length === 0) return { ok: false, status: 400, error: "receive-pack has no ref commands" };
				return { ok: true, refs };
			}
			if (packetLength < 4 || packetLength > MAX_RECEIVE_PACK_COMMAND_BYTES) {
				return { ok: false, status: 400, error: "invalid receive-pack packet length" };
			}
			while (buffered.length - offset < packetLength) {
				const next = await reader.read();
				if (next.done) return { ok: false, status: 400, error: "truncated receive-pack packet" };
				buffered = Buffer.concat([buffered.subarray(offset), Buffer.from(next.value)]);
				offset = 0;
			}
			const payload = buffered
				.subarray(offset + 4, offset + packetLength)
				.toString("utf8")
				.split("\0", 1)[0]!
				.trimEnd();
			offset += packetLength;
			inspectedBytes += packetLength;
			if (inspectedBytes > MAX_RECEIVE_PACK_COMMAND_BYTES) {
				return { ok: false, status: 400, error: "receive-pack command list is too large" };
			}
			const fields = payload.split(" ");
			if (fields.length !== 3 || fields[2] === "") {
				return { ok: false, status: 400, error: "invalid receive-pack ref command" };
			}
			const ref = fields[2]!;
			if (!/^refs\/heads\/ompk\/[^\s\0]+$/.test(ref)) {
				return { ok: false, status: 403, error: `push to ${ref} is outside refs/heads/ompk/*` };
			}
			refs.push(ref);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

export interface GitBrokerOptions {
	jobId: string;
	attemptId: string;
	leaseToken: string;
	workerFenceUrl: string;
	owner?: string;
	repo?: string;
	defaultBranch?: string;
	workerTokenUrl?: string;
	workerRelayToken?: string;
	bindAddress?: string;
	placeholderCredential?: string;
	fetchImpl?: typeof fetch;
}

export interface GitBrokerHandle extends ContainerBrokerConfig {
	readonly url: string;
	readonly port: number;
	stop(): Promise<void>;
}

function brokerAuthorized(request: Request, placeholderCredential: string): boolean {
	return (
		request.headers.get("authorization") ===
		`Basic ${btoa(`ompk-placeholder:${placeholderCredential}`)}`
	);
}

async function readBoundedRequestBody(request: Request, limit: number): Promise<string | null> {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) return null;
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
}

interface PullRequestInput {
	title: string;
	body: string;
	base: string;
	head: string;
	draft: boolean;
}

type PullRequestValidation =
	| { ok: true; input: PullRequestInput & { head: string } }
	| { ok: false; status: 400 | 403 | 413 | 415; error: string };

const PULL_REQUEST_FIELDS = new Set(["title", "body", "base", "head", "draft"]);
const MAX_PULL_REQUEST_REQUEST_BYTES = 70 * 1024;
const MAX_PULL_REQUEST_BODY_BYTES = 65_536;

function normalizeOmpkHead(rawHead: string): string | undefined {
	const head = rawHead.startsWith("refs/heads/") ? rawHead.slice("refs/heads/".length) : rawHead;
	const ref = `refs/heads/${head}`;
	if (!head.startsWith("ompk/") || head === "ompk/" || Buffer.byteLength(ref) > 1024) return undefined;
	if (ref.includes("..") || ref.includes("@{") || ref.includes("//") || ref.endsWith(".") || ref.endsWith("/")) {
		return undefined;
	}
	for (const character of ref) {
		const code = character.charCodeAt(0);
		if (code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character)) return undefined;
	}
	if (
		ref
			.split("/")
			.some(component => component.length === 0 || component.startsWith(".") || component.toLowerCase().endsWith(".lock"))
	) {
		return undefined;
	}
	return head;
}

async function validatePullRequest(
	request: Request,
	defaultBranch: string,
): Promise<PullRequestValidation> {
	const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/json") {
		return { ok: false, status: 415, error: "pull request body must be JSON" };
	}
	const rawBody = await readBoundedRequestBody(request, MAX_PULL_REQUEST_REQUEST_BYTES);
	if (rawBody === null) return { ok: false, status: 413, error: "pull request body is too large" };
	let payload: unknown;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return { ok: false, status: 400, error: "invalid pull request body" };
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return { ok: false, status: 400, error: "invalid pull request body" };
	}
	const record = payload as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== PULL_REQUEST_FIELDS.size || keys.some(key => !PULL_REQUEST_FIELDS.has(key))) {
		return { ok: false, status: 400, error: "unsupported pull request field" };
	}
	if (
		typeof record.title !== "string" ||
		typeof record.body !== "string" ||
		typeof record.base !== "string" ||
		typeof record.head !== "string" ||
		typeof record.draft !== "boolean"
	) {
		return { ok: false, status: 400, error: "invalid pull request fields" };
	}
	if (
		record.title.trim().length === 0 ||
		Buffer.byteLength(record.title) > 256 ||
		/[\0\r\n]/.test(record.title) ||
		Buffer.byteLength(record.body) > MAX_PULL_REQUEST_BODY_BYTES ||
		record.body.includes("\0")
	) {
		return { ok: false, status: 400, error: "invalid pull request title or body" };
	}
	if (record.base !== defaultBranch) {
		return { ok: false, status: 403, error: "base branch outside broker scope" };
	}
	const head = normalizeOmpkHead(record.head);
	if (!head) {
		return { ok: false, status: 403, error: "head branch outside refs/heads/ompk/*" };
	}
	return {
		ok: true,
		input: {
			title: record.title,
			body: record.body,
			base: record.base,
			head,
			draft: record.draft,
		},
	};
}

export async function startGitBroker(options: GitBrokerOptions): Promise<GitBrokerHandle> {
	const bindAddress = options.bindAddress ?? "127.0.0.1";
	const placeholderCredential = options.placeholderCredential ?? crypto.randomUUID();
	const fetchImpl = options.fetchImpl ?? fetch;
	const repoPrefix =
		options.owner && options.repo ? `/gh/${options.owner}/${options.repo}` : undefined;
	const fetchJitToken = async (): Promise<string> => {
		const relayToken = options.workerRelayToken?.trim();
		if (!options.workerTokenUrl || !relayToken) throw new Error("git token broker is not configured");
		const response = await fetchImpl(options.workerTokenUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${relayToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jobId: options.jobId,
				attemptId: options.attemptId,
				leaseToken: options.leaseToken,
			}),
		});
		if (!response.ok) throw new Error(`JIT token request failed with status ${response.status}`);
		const payload: unknown = await response.json().catch(() => null);
		if (
			typeof payload !== "object" ||
			payload === null ||
			!("token" in payload) ||
			typeof (payload as Record<string, unknown>).token !== "string" ||
			(payload as Record<string, unknown>).token === ""
		) {
			throw new Error("JIT token response was invalid");
		}
		return (payload as Record<string, string>).token;
	};

	const server = Bun.serve({
		hostname: bindAddress,
		port: 0,
		async fetch(request, bunServer): Promise<Response> {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/fence-check") {
				let response: Response;
				try {
					response = await fetchImpl(options.workerFenceUrl, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							jobId: options.jobId,
							attemptId: options.attemptId,
							leaseToken: options.leaseToken,
						}),
					});
				} catch {
					return new Response("fence check unavailable\n", { status: 502 });
				}
				return new Response(response.body, {
					status: response.status,
					headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
				});
			}
			if (request.method === "POST" && url.pathname === "/pull-request") {
				if (request.headers.get("x-ompk-placeholder") !== placeholderCredential) {
					return new Response("broker credential required\n", { status: 401 });
				}
				if (
					!options.owner ||
					!options.repo ||
					!options.defaultBranch ||
					!options.workerTokenUrl ||
					!options.workerRelayToken
				) {
					return new Response("pull request broker is not configured\n", { status: 503 });
				}
				const validation = await validatePullRequest(request, options.defaultBranch);
				if (!validation.ok) {
					return new Response(`${validation.error}\n`, { status: validation.status });
				}
				const { title, body, head, base, draft } = validation.input;
				let jitToken: string;
				try {
					jitToken = await fetchJitToken();
				} catch {
					return new Response("GitHub credential unavailable\n", { status: 502 });
				}
				let upstream: Response;
				try {
					upstream = await fetchImpl(
						`https://api.github.com/repos/${options.owner}/${options.repo}/pulls`,
						{
							method: "POST",
							headers: {
								Accept: "application/vnd.github+json",
								Authorization: `Bearer ${jitToken}`,
								"Content-Type": "application/json",
								"User-Agent": "ompk-relay",
								"X-GitHub-Api-Version": "2022-11-28",
							},
							body: JSON.stringify({ title, body, head, base, draft }),
						},
					);
				} catch {
					return new Response("GitHub pull request API unavailable\n", { status: 502 });
				}
				if (!upstream.ok) {
					return new Response(`GitHub pull request creation failed (${upstream.status})\n`, {
						status: 502,
					});
				}
				const result: unknown = await upstream.json().catch(() => null);
				const number =
					typeof result === "object" &&
					result !== null &&
					"number" in result &&
					Number.isSafeInteger((result as Record<string, unknown>).number) &&
					(result as Record<string, number>).number > 0
						? (result as Record<string, number>).number
						: undefined;
				if (!number) return new Response("GitHub pull request response was invalid\n", { status: 502 });
				return Response.json({
					number,
					url: `https://github.com/${options.owner}/${options.repo}/pull/${number}`,
					draft,
				});
			}
			const repoBase = repoPrefix
				? [`${repoPrefix}.git`, repoPrefix].find(base => url.pathname.startsWith(`${base}/`))
				: undefined;
			if (!repoBase) {
				return new Response("repository outside broker scope\n", { status: 403 });
			}
			if (!brokerAuthorized(request, placeholderCredential)) {
				return new Response("broker credential required\n", {
					status: 401,
					headers: { "WWW-Authenticate": 'Basic realm="ompk-git-broker"' },
				});
			}
			const suffix = url.pathname.slice(repoBase.length);
			const service = url.searchParams.get("service");
			const discovery =
				request.method === "GET" &&
				suffix === "/info/refs" &&
				(service === "git-upload-pack" || service === "git-receive-pack");
			const uploadPack = request.method === "POST" && suffix === "/git-upload-pack";
			const receivePack = request.method === "POST" && suffix === "/git-receive-pack";
			if (!discovery && !uploadPack && !receivePack) {
				return new Response("git operation outside broker scope\n", { status: 403 });
			}
			const upstreamPath = url.pathname.slice("/gh".length);
			let upstreamBody: ReadableStream<Uint8Array> | undefined;
			if (request.method === "POST") {
				if (!request.body) return new Response("request body required\n", { status: 400 });
				if (receivePack) {
					const [inspectionBody, forwardingBody] = request.body.tee();
					const inspection = await inspectReceivePack(inspectionBody);
					if (!inspection.ok) {
						await forwardingBody.cancel().catch(() => undefined);
						return new Response(`${inspection.error}\n`, { status: inspection.status });
					}
					upstreamBody = forwardingBody;
				} else {
					upstreamBody = request.body;
				}
			}
			bunServer.timeout(request, 0);
			let jitToken: string;
			try {
				jitToken = await fetchJitToken();
			} catch {
				return new Response("git credential unavailable\n", { status: 502 });
			}
			const headers = new Headers();
			headers.set("Authorization", `Basic ${btoa(`x-access-token:${jitToken}`)}`);
			headers.set("User-Agent", "git/ompk-relay");
			for (const header of ["content-type", "accept", "git-protocol"]) {
				const value = request.headers.get(header);
				if (value) headers.set(header, value);
			}
			let upstream: Response;
			try {
				upstream = await fetchImpl(`https://github.com${upstreamPath}${url.search}`, {
					method: request.method,
					headers,
					body: upstreamBody,
					redirect: "manual",
				});
			} catch {
				return new Response("git upstream unavailable\n", { status: 502 });
			}
			const responseHeaders = new Headers();
			for (const header of ["content-type", "cache-control", "location"]) {
				const value = upstream.headers.get(header);
				if (value) responseHeaders.set(header, value);
			}
			return new Response(upstream.body, {
				status: upstream.status,
				headers: responseHeaders,
			});
		},
	});
	const url = `http://${bindAddress}:${server.port}`;
	const authenticatedGitBaseUrl =
		repoPrefix === undefined
			? undefined
			: `http://ompk-placeholder:${encodeURIComponent(placeholderCredential)}@${bindAddress}:${server.port}/gh/`;
	return {
		url,
		port: server.port,
		authenticatedGitBaseUrl,
		placeholderCredential,
		fenceUrl: `${url}/fence-check`,
		stop: async () => {
			await server.stop(true);
		},
	};
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
	// Git normally records the pre-rewrite URL, but normalize it explicitly
	// before mounting the workspace so no credentialed rewrite can persist.
	await runGit(["remote", "set-url", "origin", cloneUrl], workspace, process.env, job.githubToken);
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

export interface RuntimeGitHooksHandle {
	readonly path: string;
	remove(): Promise<void>;
}

/**
 * Git does not preserve executable bits on every relay checkout (notably
 * Windows/NTFS). Copy the fixed helper set to a private host temp directory,
 * make it executable there, and mount that directory read-only in containers.
 */
export async function prepareRuntimeGitHooks(
	sourceDir: string = GIT_HOOKS_DIR,
): Promise<RuntimeGitHooksHandle> {
	const path = await mkdtemp(join(tmpdir(), "ompk-git-hooks-"));
	try {
		for (const name of ["pre-push", "gh"]) {
			const destination = join(path, name);
			await copyFile(join(sourceDir, name), destination);
			await chmod(destination, 0o500);
		}
	} catch (error) {
		await rm(path, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	return {
		path,
		remove: () => rm(path, { recursive: true, force: true }),
	};
}

/**
 * Child environment for one attempt: the fence triple (the pre-push guard's
 * credential — never the relay bearer token) plus a `core.hooksPath`
 * override injected through GIT_CONFIG_* so every git invocation in the
 * child tree runs the fence guard. The override shadows repo-local hooks
 * for the child, which is intended for a headless runner workspace.
 */
export function fenceEnv(job: Job, gitHooksDir: string = GIT_HOOKS_DIR): NodeJS.ProcessEnv {
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
		GIT_CONFIG_VALUE_0: gitHooksDir,
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
	let activeContainerName: string | undefined;
	let containerStop: Promise<void> | undefined;
	let jobNetwork: JobNetworkHandle | undefined;
	let phaseProxy: EgressProxyHandle | undefined;
	let broker: GitBrokerHandle | undefined;
	let runtimeGitHooks: RuntimeGitHooksHandle | undefined;
	const stopActive = (): Promise<void> => {
		if (activeContainerName) {
			containerStop ??= stopNamedContainer(activeContainerName, child).catch(err => {
				console.error(
					`[${new Date().toISOString()}] failed to remove container ${activeContainerName}: ${err instanceof Error ? err.message : err}`,
				);
			});
			return containerStop;
		}
		if (child) forceKillChildTree(child);
		return Promise.resolve();
	};
	const registerChild =
		(containerName?: string) =>
		(spawned: ChildProcess): void => {
			child = spawned;
			activeContainerName = containerName;
			containerStop = undefined;
			if (fenceLost) void stopActive();
		};
	const discardIfFenced = async (): Promise<boolean> => {
		if (!fenceLost) return false;
		await stopActive();
		console.error(`[${new Date().toISOString()}] job ${job.id} discarded: lease no longer held`);
		return true;
	};
	const cadence = job.heartbeatMs ?? HEARTBEAT_FALLBACK_MS;
	const beat = setInterval(() => {
		void sendHeartbeat(token, job).then(live => {
			if (live || fenceLost) return;
			fenceLost = true;
			console.error(`[${new Date().toISOString()}] lease for job ${job.id} was fenced off; killing runner`);
			void stopActive();
		});
	}, cadence);
	try {
		try {
			workspace = job.source === "github" ? await prepareGitHubWorkspace(job) : undefined;
			const executionWorkspace = workspace ?? WORKSPACE_DIR;
			const setupContainerName = deriveContainerName(job.id, job.attemptId, "setup");
			const agentContainerName = deriveContainerName(job.id, job.attemptId, "agent");
			let containerOptions: ContainerRunOptions | undefined;
			let result: JobRunResult;
			if (!allowedModels.includes(job.model)) {
				result = await executeJob(job, allowedModels, spawn, JOB_TIMEOUT_MS);
			} else {
				if (await discardIfFenced()) return true;
				let agentEnv = fenceEnv(job);
				if (CONTAINER_IMAGE) {
					runtimeGitHooks = await prepareRuntimeGitHooks();
					agentEnv = fenceEnv(job, runtimeGitHooks.path);
					jobNetwork = await createJobNetwork(job.id, job.attemptId, CONTAINER_IMAGE);
					containerOptions = {
						image: CONTAINER_IMAGE,
						network: jobNetwork.name,
						memory: CONTAINER_MEMORY,
						pidsLimit: CONTAINER_PIDS_LIMIT,
						gitHooksDir: runtimeGitHooks.path,
						noProxyHosts: jobNetwork.gatewayIp,
					};
					phaseProxy = await startEgressProxy("setup", {
						bindAddress: jobNetwork.gatewayIp,
					});
					await jobNetwork.setAllowedPorts([phaseProxy.port]);
				}
				const setupEnv = buildSetupHookEnv();
				const setupResult = await runSetupHook(executionWorkspace, {
					spawn,
					timeoutMs: SETUP_TIMEOUT_MS,
					env: setupEnv,
					onSpawn: registerChild(containerOptions ? setupContainerName : undefined),
					redactionToken: job.githubToken,
					...(containerOptions && jobNetwork && phaseProxy
						? {
								command: CONTAINER_BIN,
								args: buildContainerSetupArgs(executionWorkspace, setupEnv, {
									...containerOptions,
									name: setupContainerName,
									egressProxyUrl: `http://${jobNetwork.gatewayIp}:${phaseProxy.port}`,
								}),
								spawnEnv: process.env,
								nonZeroFailureClass: "transient" as const,
								onTimeout: () => stopNamedContainer(setupContainerName, child),
							}
						: {}),
				});
				activeContainerName = undefined;
				child = undefined;
				phaseProxy?.stop();
				phaseProxy = undefined;
				if (await discardIfFenced()) return true;
				if (setupResult !== undefined) {
					result = setupResult;
				} else if (containerOptions && jobNetwork) {
					phaseProxy = await startEgressProxy("agent", {
						bindAddress: jobNetwork.gatewayIp,
					});
					broker = await startGitBroker({
						jobId: job.id,
						attemptId: job.attemptId,
						leaseToken: job.leaseToken,
						workerFenceUrl: `${WORKER_URL}/fence-check`,
						bindAddress: jobNetwork.gatewayIp,
						...(job.source === "github" && job.github
							? {
									owner: job.github.owner,
									repo: job.github.repo,
									defaultBranch: job.github.defaultBranch,
									workerTokenUrl: `${WORKER_URL}/github-token`,
									workerRelayToken: token,
								}
							: {}),
					});
					await jobNetwork.setAllowedPorts([phaseProxy.port, broker.port]);
					result = await executeJob(job, allowedModels, spawn, JOB_TIMEOUT_MS, {
						onSpawn: registerChild(agentContainerName),
						command: CONTAINER_BIN,
						args: buildContainerArgs(
							job,
							executionWorkspace,
							agentEnv,
							{
								...containerOptions,
								name: agentContainerName,
								egressProxyUrl: `http://${jobNetwork.gatewayIp}:${phaseProxy.port}`,
							},
							broker,
						),
						cwd: WORKSPACE_DIR,
						nonZeroFailureClass: "transient",
						onTimeout: () => stopNamedContainer(agentContainerName, child),
						detached: process.platform !== "win32",
					});
				} else {
					result = await executeJob(job, allowedModels, spawn, JOB_TIMEOUT_MS, {
						onSpawn: registerChild(),
						env: agentEnv,
						cwd: workspace,
					});
				}
			}
			if (await discardIfFenced()) return true;
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
		if (containerStop) await containerStop;
		await broker?.stop().catch(() => undefined);
		phaseProxy?.stop();
		await jobNetwork?.remove().catch(err => {
			console.error(
				`[${new Date().toISOString()}] failed to remove network ${jobNetwork!.name}: ${err instanceof Error ? err.message : err}`,
			);
		});
		if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
		await runtimeGitHooks?.remove().catch(() => undefined);
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
