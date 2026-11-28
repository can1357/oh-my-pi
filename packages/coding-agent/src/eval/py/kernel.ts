/**
 * Subprocess-backed Python runner.
 *
 * Speaks NDJSON with `runner.py` over stdin/stdout. One subprocess per kernel
 * instance; sessions reuse a single subprocess across executions. Cancellation
 * writes `{"type":"interrupt","id":…}` naming the execution, then sends
 * `kill("SIGINT")`, which interrupts that cell with a `KeyboardInterrupt`.
 * Shutdown writes `{"type":"exit"}` and escalates to SIGTERM/SIGKILL on
 * timeout.
 */
import * as path from "node:path";
import { $env, $flag, isBunTestRuntime, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import { registerOnBoard } from "../../daemon/client";
import {
	BaseKernel,
	getRemainingTimeMs,
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelStartOptions,
} from "../kernel-base";
import { type BackendProbeOptions, probeCandidates } from "../probe";
import { stageRunnerScript } from "../runner-cache";
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

/** Minimum interpreter version: the runner is UTF-8 source and the prelude uses `asyncio.to_thread`. */
const MIN_PYTHON_MINOR = 9;
const TOO_OLD_EXIT_BASE = 200;
/** Exits 0 on Python 3.9+, otherwise `200 + 10*major + minor` so the host can name the rejected version. */
const PYTHON_VERSION_PROBE = `import sys;v=sys.version_info;sys.exit(0 if v>=(3,${MIN_PYTHON_MINOR}) else ${TOO_OLD_EXIT_BASE}+min(v[0],3)*10+min(v[1],9))`;

function describePythonProbeExit(exitCode: number): string | undefined {
	const encoded = exitCode - TOO_OLD_EXIT_BASE;
	if (encoded < 20 || encoded > 39) return undefined;
	return `Python ${Math.floor(encoded / 10)}.${encoded % 10} is too old; 3.${MIN_PYTHON_MINOR}+ required`;
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
		const result = await probeCandidates(
			runtimes.map(runtime => ({
				command: [runtime.pythonPath, "-c", PYTHON_VERSION_PROBE],
				env: runtime.env,
				label: runtime.pythonPath,
				describeExit: describePythonProbeExit,
			})),
			{ cwd, signal: probeOpts?.signal, timeoutMs: probeOpts?.timeoutMs },
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

/** {@link PythonKernel.start} options. */
export interface PythonKernelStartOptions extends KernelStartOptions {
	/** Agent session the kernel process is listed under on the daemon board. */
	sessionId?: string;
}

export class PythonKernel extends BaseKernel {
	#installedPreludes = new Map<string, PythonPreludeSource>();

	/** @param pythonPath Interpreter executable this kernel runs on; reported as the runtime in eval state. */
	private constructor(
		id: string,
		readonly pythonPath: string,
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

	static async start(options: PythonKernelStartOptions): Promise<PythonKernel> {
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
		// UTF-8 mode: text-mode subprocess pipes otherwise decode with the ANSI code page on
		// Windows, and a decode error in CPython's pipe reader thread yields `stdout=None`.
		spawnEnv.PYTHONUTF8 = "1";

		const scriptPath = await stageRunnerScript("omp-python-runner", "py", RUNNER_SCRIPT);
		const kernel = new PythonKernel(Snowflake.next(), runtime.pythonPath);

		const proc = Bun.spawn([runtime.pythonPath, "-u", scriptPath], {
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
		const board = registerOnBoard({
			kind: "external",
			scope: { kind: "session", id: options.sessionId || `process-${process.pid}` },
			key: `python-eval:${proc.pid}`,
			label: `python eval (${path.basename(runtime.pythonPath)})`,
			pid: proc.pid,
		});
		// Exit covers every teardown path: shutdown, kill, and crashes.
		void proc.exited.finally(() => board.dispose());

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
