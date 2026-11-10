/**
 * Subprocess-backed Python runner.
 *
 * Speaks NDJSON with `runner.py` over stdin/stdout. One subprocess per kernel
 * instance; sessions reuse a single subprocess across executions. Cancellation
 * writes `{"type":"interrupt","id":…}` naming the execution, then sends
 * `kill("SIGINT")`, which interrupts that cell with a `KeyboardInterrupt`.
 * Shutdown writes `{"type":"exit"}` and escalates to SIGTERM/SIGKILL on
 * timeout. When the sandbox applies to `eval`, the runner is launched contained
 * through `SandboxRuntime` (see `spawnContainedKernel` for signal mapping).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $env, $flag, isBunTestRuntime, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import { definedEnv } from "../../sandbox/env";
import { readSandboxConfig } from "../../sandbox/policy";
import { SandboxRuntime, type SandboxSpawnRequest } from "../../sandbox/runtime";
import {
	BaseKernel,
	getRemainingTimeMs,
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelProcess,
	type KernelStartOptions,
} from "../kernel-base";
import { type BackendProbeOptions, type BoundedProbeRunner, DEFAULT_PROBE_TIMEOUT_MS, probeCandidates } from "../probe";
import { stageRunnerScript } from "../runner-cache";
import type { ShadowPlan } from "../speculation/types";
import { PYTHON_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.py" with { type: "text" };
import {
	enumeratePythonRuntimes,
	filterEnv,
	type PythonRuntime,
	resolveExplicitPythonRuntime,
	resolvePythonRuntime,
} from "./runtime";
import { hostHasInheritableConsole, shouldDetachKernel, shouldHideKernelWindow } from "./spawn-options";
import type { PythonToolRequest } from "./executor";

export type {
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelRuntimeEnv,
	KernelShutdownOptions,
	KernelShutdownResult,
} from "../kernel-base";

const TRACE_IPC = $flag("PI_PYTHON_IPC_TRACE");

const SHUTDOWN_GRACE_MS = 1_000;
const STARTUP_TIMEOUT_MS = 10_000;
// How long to wait after SIGINT for the runner to emit `done`. If the cell is
// stuck in code that ignores Python signals (e.g. a C extension holding the
// GIL), we escalate to a full subprocess shutdown so the host queue unblocks
// instead of hanging the session forever. The grace window is intentionally
// generous: a clean interrupt is far preferable to losing the persistent
// kernel's state, so we only kill as a last-resort recovery path.
const INTERRUPT_ESCALATION_MS = 5_000;
/** Bounds interrupt escalation plus the three shutdown grace windows before ACP abandons a session. */
export const PYTHON_KERNEL_CANCEL_BUDGET_MS = INTERRUPT_ESCALATION_MS + 3 * SHUTDOWN_GRACE_MS;

const PYTHON_RESERVED_PRELUDE_EXPORTS: Record<string, true> = {
	__omp_tools__: true,
	_omp_prelude: true,
	AgentHandle: true,
	CompletionHandle: true,
	JudgmentBatch: true,
	JudgmentItem: true,
	WorkPool: true,
	agent: true,
	budget: true,
	completion: true,
	env: true,
	judge: true,
	judge_batch: true,
	log: true,
	output: true,
	phase: true,
	read: true,
	tool: true,
	wait: true,
	workpool: true,
	write: true,
};

export interface PythonKernelAvailability {
	ok: boolean;
	pythonPath?: string;
	reason?: string;
	/** The probed-working runtime, when one was found. */
	runtime?: PythonRuntime;
	/** Cancellation or an exhausted probe budget does not establish runtime unavailability. */
	transient?: boolean;
}

export interface PythonPreludeSource {
	name: string;
	exports: string[];
	source: string;
}

export interface PythonShadowSnapshot {
	revision: number;
	values: Readonly<Record<string, unknown>>;
	digest: string;
}

export interface PythonShadowPlan extends ShadowPlan {
	snapshot: PythonShadowSnapshot;
}

interface PythonKernelExecuteOptions extends KernelExecuteOptions {
	expectedShadowRevision?: number;
	expectedShadowDigest?: string;
}

// Retain definitive results for synchronous capability advertisement. Execution
// reuses only successes: failed probes are retried on an explicit invocation, so
// installing Python mid-session remains discoverable without restarting.
const availabilityCache = new Map<string, PythonKernelAvailability>();

function availabilityKey(cwd: string, interpreter?: string): string {
	return [
		path.resolve(cwd),
		interpreter ?? "",
		$env.PATH,
		$env.VIRTUAL_ENV,
		$env.CONDA_PREFIX,
		$env.HOME,
		$env.PYTHONPATH,
		$env.LD_LIBRARY_PATH,
	].join("\0");
}

/** Read the last definitive probe without spawning or awaiting interpreter discovery. */
export function getCachedPythonKernelAvailability(
	cwd: string,
	interpreter?: string,
): PythonKernelAvailability | undefined {
	return availabilityCache.get(availabilityKey(cwd, interpreter));
}

export async function checkPythonKernelAvailability(
	cwd: string,
	interpreter?: string,
	options?: { forceProbe?: boolean } & BackendProbeOptions,
): Promise<PythonKernelAvailability> {
	if (!options?.forceProbe && (isBunTestRuntime() || $flag("PI_PYTHON_SKIP_CHECK"))) {
		return { ok: true };
	}
	const resolvedCwd = path.resolve(cwd);
	const key = availabilityKey(resolvedCwd, interpreter);
	const cached = availabilityCache.get(key);
	if (!options?.forceProbe && cached?.ok) return cached;
	// Probe controls belong to one caller. Do not share an in-flight promise:
	// aborting one eval must not cancel a concurrent session's availability check.
	const result = await probePythonKernelAvailability(resolvedCwd, interpreter, options);
	if (!result.transient && !options?.signal?.aborted) availabilityCache.set(key, result);
	return result;
}

async function probePythonKernelAvailability(
	cwd: string,
	interpreter?: string,
	probeOpts?: BackendProbeOptions,
): Promise<PythonKernelAvailability> {
	try {
		const settings = await Settings.init();
		const { env } = settings.getShellConfig();
		const baseEnv = filterEnv(env);
		const runtimes = interpreter
			? [resolveExplicitPythonRuntime(interpreter, cwd, baseEnv)]
			: enumeratePythonRuntimes(cwd, baseEnv);
		if (runtimes.length === 0) {
			return { ok: false, reason: "Python executable not found on PATH" };
		}
		// While eval runs contained, a workspace-controlled interpreter (`.venv/bin/python`, a project
		// `python.interpreter`) must not execute on the host: probe the candidates inside the sandbox.
		// Ruled out by configuration: no lookup, the host probe runs exactly as before.
		const runProbe = evalSandboxRuledOut() ? undefined : await containedProbeRunner(cwd, runtimes);
		const result = await probeCandidates(
			runtimes.map(runtime => ({
				command: [runtime.pythonPath, "-c", "import sys;sys.exit(0)"],
				env: runtime.env,
				label: runtime.pythonPath,
			})),
			{ cwd, signal: probeOpts?.signal, timeoutMs: probeOpts?.timeoutMs, runProbe },
		);
		if (result.ok) {
			const runtime = runtimes[result.index];
			return { ok: true, pythonPath: runtime.pythonPath, runtime };
		}
		if (result.aborted) {
			return {
				ok: false,
				pythonPath: runtimes[0].pythonPath,
				reason: "Python availability probe was cancelled.",
				transient: true,
			};
		}
		return {
			ok: false,
			pythonPath: runtimes[0].pythonPath,
			reason: `No working Python interpreter found. Tried: ${result.failures.join("; ")}`,
			...(result.timedOut ? { transient: true } : {}),
		};
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err), transient: true };
	}
}

/**
 * Fingerprint of the sandbox policy an `eval` kernel for `cwd` starts under now; `undefined` when
 * it would run uncontained. Throws when the sandbox is required but unavailable (`fallback: block`).
 * When the effective configuration already rules containment out (sandbox off, or `eval` outside
 * its scope) this answers without awaiting, so the uncontained path keeps its exact ordering
 * between concurrent callers sharing a retained kernel.
 */
export function evalSandboxFingerprint(cwd: string): Promise<string | undefined> | undefined {
	if (evalSandboxRuledOut()) return undefined;
	return SandboxRuntime.for(cwd).then(runtime => (runtime.applies("eval") ? runtime.fingerprint() : undefined));
}

function evalSandboxRuledOut(): boolean {
	let settings: Settings;
	try {
		settings = Settings.instance;
	} catch {
		return false;
	}
	const config = readSandboxConfig(settings);
	return !config.enabled || !config.scope.includes("eval");
}

export class PythonKernel extends BaseKernel<PythonKernelExecuteOptions> {
	#installedPreludes = new Map<string, PythonPreludeSource>();

	/**
	 * @param pythonPath Interpreter executable this kernel runs on; reported as the runtime in eval state.
	 * @param sandbox Fingerprint of the sandbox policy the kernel runs contained under; `undefined` when uncontained.
	 */
	private constructor(
		id: string,
		readonly pythonPath: string,
		readonly sandbox: string | undefined,
	) {
		super(id, {
			languageName: "Python",
			traceIpc: TRACE_IPC,
			exitPayload: JSON.stringify({ type: "exit" }),
			interruptPayload: msgId => JSON.stringify({ type: "interrupt", id: msgId }),
			interruptEscalationMs: INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: SHUTDOWN_GRACE_MS,
			buildPayload: (code, msgId, opts) =>
				JSON.stringify({
					id: msgId,
					code,
					cwd: opts?.cwd,
					filename: opts?.filename,
					env: opts?.env,
					silent: opts?.silent ?? false,
					storeHistory: opts?.storeHistory ?? !(opts?.silent ?? false),
					expectedShadowRevision: opts?.expectedShadowRevision,
					expectedShadowDigest: opts?.expectedShadowDigest,
				}),
		});
	}

	/** Describe or invoke a tool defined in this retained Python kernel; cancelling it cancels an async tool's coroutine. */
	async invokeTool(request: PythonToolRequest, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		const id = options?.id ?? Snowflake.next();
		return await this.submitRequest(
			id,
			JSON.stringify({ type: "tool", id, ...request }),
			options,
			JSON.stringify({ type: "tool_cancel", id }),
		);
	}

	/** Synchronize enabled capability snippets before the next user cell. */
	async syncPreludes(
		preludes: readonly PythonPreludeSource[],
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<void> {
		const desired = new Map<string, PythonPreludeSource>();
		const exportOwners = new Map<string, string>();
		for (const prelude of preludes) {
			if (desired.has(prelude.name)) throw new Error(`Duplicate eval prelude name: ${prelude.name}`);
			for (const name of prelude.exports) {
				if (Object.hasOwn(PYTHON_RESERVED_PRELUDE_EXPORTS, name)) {
					throw new Error(`Eval prelude ${prelude.name} cannot replace reserved global ${name}`);
				}
				const owner = exportOwners.get(name);
				if (owner) throw new Error(`Eval preludes ${owner} and ${prelude.name} both export ${name}`);
				exportOwners.set(name, prelude.name);
			}
			desired.set(prelude.name, prelude);
		}

		const removedExports: string[] = [];
		const changed: PythonPreludeSource[] = [];
		for (const [name, installed] of this.#installedPreludes) {
			const next = desired.get(name);
			if (
				next &&
				next.source === installed.source &&
				next.exports.length === installed.exports.length &&
				next.exports.every((value, index) => value === installed.exports[index])
			) {
				continue;
			}
			removedExports.push(...installed.exports);
		}
		for (const [name, prelude] of desired) {
			const installed = this.#installedPreludes.get(name);
			if (
				installed &&
				prelude.source === installed.source &&
				prelude.exports.length === installed.exports.length &&
				prelude.exports.every((value, index) => value === installed.exports[index])
			) {
				continue;
			}
			changed.push(prelude);
		}
		if (removedExports.length === 0 && changed.length === 0) return;

		const source: string[] = [];
		if (removedExports.length > 0) {
			source.push(
				`for __omp_export in ${JSON.stringify(removedExports)}:\n    globals().pop(__omp_export, None)`,
				'globals().pop("__omp_export", None)',
			);
		}
		for (const prelude of changed) source.push(prelude.source);
		await this.executeWithBudget(source.join("\n"), signal, timeoutMs, "Python eval prelude sync");

		this.#installedPreludes.clear();
		for (const [name, prelude] of desired) {
			this.#installedPreludes.set(name, {
				name,
				exports: [...prelude.exports],
				source: prelude.source,
			});
		}
	}

	static async start(options: KernelStartOptions): Promise<PythonKernel> {
		const availability = await logger.time(
			"PythonKernel.start:availabilityCheck",
			checkPythonKernelAvailability,
			options.cwd,
			options.interpreter,
		);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Python kernel unavailable");
		}

		let runtime = availability.runtime;
		if (!runtime) {
			const { env: shellEnv } = (await Settings.init()).getShellConfig();
			runtime = options.interpreter
				? resolveExplicitPythonRuntime(options.interpreter, options.cwd, filterEnv(shellEnv))
				: resolvePythonRuntime(options.cwd, filterEnv(shellEnv));
		}
		const spawnEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(runtime.env)) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		for (const [key, value] of Object.entries(options.env ?? {})) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		spawnEnv.PYTHONUNBUFFERED = "1";
		spawnEnv.PYTHONIOENCODING = "utf-8";

		const scriptPath = await stageRunnerScript("omp-python-runner", "py", RUNNER_SCRIPT);
		// No sandbox lookup at all when the configuration rules containment out.
		const sandbox = evalSandboxRuledOut() ? undefined : await SandboxRuntime.for(options.cwd);
		const contained = sandbox?.applies("eval") === true;
		const kernel = new PythonKernel(
			Snowflake.next(),
			runtime.pythonPath,
			contained ? sandbox?.fingerprint() : undefined,
		);

		const argv = [runtime.pythonPath, "-u", scriptPath];
		if (sandbox && contained) {
			kernel.setProcess(
				await spawnContainedKernel(sandbox, {
					argv,
					cwd: options.cwd,
					env: spawnEnv,
					extraRead: await pythonReadRoots(runtime, scriptPath),
					extraWrite: options.sandboxExtraWrite,
				}),
			);
		} else {
			const proc = Bun.spawn(argv, {
				cwd: options.cwd,
				detached: shouldDetachKernel(process.platform),
				env: spawnEnv,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: shouldHideKernelWindow({
					platform: process.platform,
					hostHasInheritableConsole: hostHasInheritableConsole(),
				}),
			});
			kernel.setProcess(proc);
		}

		const startup = { signal: options.signal, deadlineMs: options.deadlineMs };
		const startupBudget = Math.min(getRemainingTimeMs(startup.deadlineMs) ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS);

		try {
			const initScript = buildInitScript(options.cwd, options.env);
			await kernel.executeWithBudget(initScript, startup.signal, startupBudget, "Python kernel init");
			await kernel.executeWithBudget(PYTHON_PRELUDE, startup.signal, startupBudget, "Python kernel prelude");
			return kernel;
		} catch (err) {
			await kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => {});
			throw err;
		}
	}

	/**
	 * Captures the runner's JSON-safe user namespace only when no Python cell is
	 * executing. Ineligible or malformed responses deliberately fall back.
	 */
	async snapshotUserNamespace(timeoutMs?: number): Promise<PythonShadowSnapshot | null> {
		const id = Snowflake.next();
		const frame = await this.requestControl(JSON.stringify({ type: "shadow_snapshot", id }), id, timeoutMs);
		if (
			frame.type !== "shadow_snapshot" ||
			frame.eligible !== true ||
			typeof frame.revision !== "number" ||
			typeof frame.digest !== "string"
		) {
			return null;
		}
		return { revision: frame.revision, digest: frame.digest, values: Object.freeze(frame.values ?? {}) };
	}

	/** Projects a candidate against an already-running, idle Python kernel. */
	async shadowPlan(code: string, timeoutMs?: number): Promise<PythonShadowPlan | null> {
		const id = Snowflake.next();
		const frame = await this.requestControl(JSON.stringify({ type: "shadow_plan", id, code }), id, timeoutMs);
		if (
			frame.type !== "shadow_plan" ||
			frame.eligible !== true ||
			typeof frame.revision !== "number" ||
			typeof frame.digest !== "string" ||
			!Array.isArray(frame.operations)
		) {
			return null;
		}
		return {
			snapshot: { revision: frame.revision, digest: frame.digest, values: Object.freeze(frame.values ?? {}) },
			operations: frame.operations,
			...(frame.controls && frame.controls.length > 0 ? { controls: frame.controls } : {}),
			...(frame.barrier ? { barrier: frame.barrier } : {}),
		};
	}

	/** Atomically starts a cell only if its retained shadow snapshot is still current. */
	async executeIfSnapshotMatches(
		code: string,
		snapshot: Pick<PythonShadowSnapshot, "revision" | "digest">,
		options?: KernelExecuteOptions,
	): Promise<KernelExecuteResult | null> {
		const result = await this.execute(code, {
			...options,
			expectedShadowRevision: snapshot.revision,
			expectedShadowDigest: snapshot.digest,
		});
		return result.admissionRejected ? null : result;
	}
}

function buildInitScript(cwd: string, env?: Record<string, string | undefined>): string {
	const envEntries = Object.entries(env ?? {}).filter(([, value]) => value !== undefined);
	const envPayload = Object.fromEntries(envEntries);
	return [
		"import os, sys",
		`__omp_cwd = ${JSON.stringify(cwd)}`,
		"os.chdir(__omp_cwd)",
		`__omp_env = ${JSON.stringify(envPayload)}`,
		"for __omp_key, __omp_val in __omp_env.items():\n    os.environ[__omp_key] = __omp_val",
		"if __omp_cwd not in sys.path:\n    sys.path.insert(0, __omp_cwd)",
	].join("\n");
}

/**
 * Directories the contained runner must read beyond the configured read roots: the staged runner
 * script (when there is one), the virtual environment, and the real interpreter installation
 * behind its symlinks (never the symlink's own parent, which can be `~/.local` or `/opt/homebrew`).
 */
async function pythonReadRoots(runtime: PythonRuntime, scriptPath?: string): Promise<string[]> {
	const roots = scriptPath ? [path.dirname(scriptPath)] : [];
	if (runtime.venvPath) roots.push(runtime.venvPath);
	try {
		roots.push(path.dirname(path.dirname(await fs.realpath(runtime.pythonPath))));
	} catch {
		// Unresolvable interpreter: the spawn reports it.
	}
	return roots;
}

/**
 * A probe runner that executes interpreter candidates inside the sandbox when it applies to `eval`
 * for `cwd`, so a workspace-controlled interpreter (`.venv/bin/python`, a project
 * `python.interpreter`) never runs on the host; `undefined` when probes run on the host as before.
 * Same bound/abort/result semantics as {@link runBoundedProbe}; no network.
 */
async function containedProbeRunner(
	cwd: string,
	runtimes: readonly PythonRuntime[],
): Promise<BoundedProbeRunner | undefined> {
	const sandbox = await SandboxRuntime.for(cwd);
	if (!sandbox.applies("eval")) return undefined;
	return async (command, { env, signal, timeoutMs }) => {
		if (signal?.aborted) return { exitCode: null, timedOut: false, aborted: true };
		const bound = Math.min(
			timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_PROBE_TIMEOUT_MS,
			DEFAULT_PROBE_TIMEOUT_MS,
		);
		const runtime = runtimes.find(candidate => candidate.pythonPath === command[0]);
		const child = await sandbox.spawn({
			argv: command,
			cwd,
			env: definedEnv(env),
			extraRead: runtime ? await pythonReadRoots(runtime) : undefined,
			network: "deny",
		});
		child.stdin.end();
		void new Response(child.stdout).arrayBuffer().catch(() => undefined);
		void new Response(child.stderr).arrayBuffer().catch(() => undefined);
		let timedOut = false;
		let aborted = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, bound);
		const onAbort = (): void => {
			aborted = true;
			child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const exitCode = await child.exited;
			return { exitCode: timedOut || aborted ? null : exitCode, timedOut, aborted };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	};
}

/**
 * Launch the runner contained and adapt it to the kernel's process surface. Termination maps to
 * the contained tree kill. SIGINT (cell interrupt) reaches the runner directly only on seatbelt,
 * where the reported pid is the runner itself (`/bin/sh` exec'd into Python, its own session).
 * Other backends report a wrapper pid (bwrap, processcontainer) whose signal disposition would
 * kill the tree, so there the interrupt is not delivered and the kernel's interrupt escalation
 * restarts the kernel after its grace window.
 */
async function spawnContainedKernel(sandbox: SandboxRuntime, request: SandboxSpawnRequest): Promise<KernelProcess> {
	const child = await sandbox.spawn(request);
	const status = sandbox.status();
	const directInterrupt = status.state === "active" && status.backend === "seatbelt";
	return {
		pid: child.pid,
		stdin: child.stdin,
		stdout: child.stdout,
		stderr: child.stderr,
		exited: child.exited,
		kill(signal) {
			if (signal !== "SIGINT") {
				child.kill();
				return;
			}
			if (!directInterrupt) {
				logger.debug("Sandboxed Python kernel cannot receive SIGINT; interrupt escalates to a restart", {
					backend: status.state === "active" ? status.backend : undefined,
				});
				return;
			}
			try {
				process.kill(child.pid, "SIGINT");
			} catch {
				// Already gone.
			}
		},
	};
}
