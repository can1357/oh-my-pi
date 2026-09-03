/**
 * Subprocess-backed Python runner.
 *
 * Speaks NDJSON with `runner.py` over stdin/stdout. One subprocess per kernel
 * instance; sessions reuse a single subprocess across executions. Cancellation
 * is `kill("SIGINT")` which raises a real `KeyboardInterrupt` inside user
 * code. Shutdown writes `{"type":"exit"}` and escalates to SIGTERM/SIGKILL on
 * timeout.
 */
import * as path from "node:path";
import { $flag, isBunTestRuntime, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
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

export type { KernelDisplayOutput, PythonStatusEvent } from "./display";
export { renderKernelDisplay } from "./display";

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

export interface PythonKernelAvailability {
	ok: boolean;
	pythonPath?: string;
	reason?: string;
	/** The probed-working runtime, when one was found. */
	runtime?: PythonRuntime;
}

// Cache successful probes per resolved cwd + explicit interpreter: every cell
// otherwise pays one (or two — backend.isAvailable + ensureKernelAvailable)
// interpreter spawns even when the kernel is already hot. Failures are not
// cached so installing a Python mid-session is picked up on the next attempt.
const availabilityCache = new Map<string, Promise<PythonKernelAvailability>>();

export async function checkPythonKernelAvailability(
	cwd: string,
	interpreter?: string,
	options?: { forceProbe?: boolean } & BackendProbeOptions,
): Promise<PythonKernelAvailability> {
	if (!options?.forceProbe && (isBunTestRuntime() || $flag("PI_PYTHON_SKIP_CHECK"))) {
		return { ok: true };
	}
	const resolvedCwd = path.resolve(cwd);
	const key = `${resolvedCwd}\0${interpreter ?? ""}`;
	const cached = availabilityCache.get(key);
	if (cached) return await cached;
	// Probe controls belong to one caller. Do not share an in-flight promise:
	// aborting one eval must not cancel a concurrent session's availability check.
	const result = await probePythonKernelAvailability(resolvedCwd, interpreter, options);
	if (result.ok) availabilityCache.set(key, Promise.resolve(result));
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
		const result = await probeCandidates(
			runtimes.map(runtime => ({
				command: [runtime.pythonPath, "-c", "import sys;sys.exit(0)"],
				env: runtime.env,
				label: runtime.pythonPath,
			})),
			{ cwd, signal: probeOpts?.signal, timeoutMs: probeOpts?.timeoutMs },
		);
		if (result.ok) {
			const runtime = runtimes[result.index];
			return { ok: true, pythonPath: runtime.pythonPath, runtime };
		}
		if (result.aborted) {
			return { ok: false, pythonPath: runtimes[0].pythonPath, reason: "Python availability probe was cancelled." };
		}
		return {
			ok: false,
			pythonPath: runtimes[0].pythonPath,
			reason: `No working Python interpreter found. Tried: ${result.failures.join("; ")}`,
		};
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

export class PythonKernel extends BaseKernel {
	private constructor(id: string) {
		super(id, {
			languageName: "Python",
			traceIpc: TRACE_IPC,
			exitPayload: JSON.stringify({ type: "exit" }),
			interruptEscalationMs: INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: SHUTDOWN_GRACE_MS,
			buildPayload: (code, msgId, opts) =>
				JSON.stringify({
					id: msgId,
					code,
					cwd: opts?.cwd,
					env: opts?.env,
					silent: opts?.silent ?? false,
					storeHistory: opts?.storeHistory ?? !(opts?.silent ?? false),
				}),
		});
	}

	/** Describe or invoke a tool defined in this retained Python kernel. */
	async invokeTool(request: PythonToolRequest, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		const id = options?.id ?? Snowflake.next();
		return await this.submitRequest(id, JSON.stringify({ type: "tool", id, ...request }), options);
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
		const kernel = new PythonKernel(Snowflake.next());

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
