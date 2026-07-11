/**
 * Subprocess-backed Julia runner.
 *
 * The IPC loop, lifecycle, and display rendering are shared with the Python and
 * Ruby runners via BaseKernel; this module supplies the Julia binary, runner
 * script, and the runner's TSV/Base64 wire protocol.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $flag, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import { $ } from "bun";
import { Settings } from "../../config/settings";
import { BaseKernel, getRemainingTimeMs, type KernelStartOptions } from "../kernel-base";
import type { KernelDisplayOutput } from "../py/display";
import { hostHasInheritableConsole, shouldHideKernelWindow } from "../py/spawn-options";
import { JULIA_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.jl" with { type: "text" };
import {
	enumerateJuliaRuntimes,
	filterEnv,
	type JuliaRuntime,
	resolveExplicitJuliaRuntime,
	resolveJuliaRuntime,
} from "./runtime";

export type { KernelExecuteResult, KernelRuntimeEnv } from "../kernel-base";
export { renderKernelDisplay } from "../py/display";
export type { KernelDisplayOutput };

const TRACE_IPC = $flag("PI_JULIA_IPC_TRACE");

// Cache the runner script on disk so the subprocess loads it normally. Cached
// per script hash so installs don't race across versions.
const RUNNER_CACHE_DIR = path.join(os.tmpdir(), "omp-julia-runner");
let RUNNER_SCRIPT_PATH: string | null = null;

async function ensureRunnerScript(): Promise<string> {
	if (RUNNER_SCRIPT_PATH) return RUNNER_SCRIPT_PATH;
	await fs.promises.mkdir(RUNNER_CACHE_DIR, { recursive: true });
	const hash = Bun.hash(RUNNER_SCRIPT).toString(36);
	const target = path.join(RUNNER_CACHE_DIR, `runner-${hash}.jl`);
	if (!fs.existsSync(target)) {
		await Bun.write(target, RUNNER_SCRIPT);
	}
	RUNNER_SCRIPT_PATH = target;
	return target;
}

const SHUTDOWN_GRACE_MS = 1_000;
const STARTUP_TIMEOUT_MS = 15_000; // Julia compile/warmup can be slightly slower
const INTERRUPT_ESCALATION_MS = 5_000;

export interface KernelExecuteOptions {
	id?: string;
	cwd?: string;
	env?: Record<string, string | undefined>;
	silent?: boolean;
	storeHistory?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
	onChunk?: (text: string) => void | Promise<void>;
	onDisplay?: (output: KernelDisplayOutput) => void | Promise<void>;
}

export interface JuliaKernelAvailability {
	ok: boolean;
	juliaPath?: string;
	runtime?: JuliaRuntime;
	reason?: string;
}

// Cache successful probes per resolved cwd + explicit interpreter. Failures are
// not cached so installing Julia mid-session is picked up on the next attempt.
const availabilityCache = new Map<string, Promise<JuliaKernelAvailability>>();

export async function checkJuliaKernelAvailability(
	cwd: string,
	interpreter?: string,
): Promise<JuliaKernelAvailability> {
	const cacheKey = `${path.resolve(cwd)}::${interpreter ?? ""}`;
	let cached = availabilityCache.get(cacheKey);
	if (!cached) {
		cached = probeJuliaKernelAvailability(cwd, interpreter);
		availabilityCache.set(cacheKey, cached);
	}
	const result = await cached;
	if (!result.ok) {
		availabilityCache.delete(cacheKey);
	}
	return result;
}

async function probeJuliaKernelAvailability(cwd: string, interpreter?: string): Promise<JuliaKernelAvailability> {
	const { env: shellEnv } = (await Settings.init()).getShellConfig();
	const baseEnv = filterEnv(shellEnv);
	const runtimes = enumerateJuliaRuntimes(cwd, baseEnv, interpreter);

	if (runtimes.length === 0) {
		return {
			ok: false,
			reason: "Julia executable not found on PATH. Please install Julia (https://julialang.org/).",
		};
	}

	const failures: string[] = [];
	for (const runtime of runtimes) {
		try {
			const probe = await $`${runtime.juliaPath} -e "exit(0)"`.quiet().nothrow().cwd(cwd).env(runtime.env);
			if (probe.exitCode === 0) {
				return { ok: true, juliaPath: runtime.juliaPath, runtime };
			}
			failures.push(`${runtime.juliaPath} (exit code ${probe.exitCode})`);
		} catch (err) {
			failures.push(`${runtime.juliaPath} (${err instanceof Error ? err.message : String(err)})`);
		}
	}

	return {
		ok: false,
		juliaPath: runtimes[0].juliaPath,
		reason: `No working Julia interpreter found. Tried: ${failures.join("; ")}`,
	};
}

export class JuliaKernel extends BaseKernel<KernelExecuteOptions> {
	private constructor(id: string) {
		super(id, {
			languageName: "Julia",
			traceIpc: TRACE_IPC,
			exitPayload: "exit",
			interruptEscalationMs: INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: SHUTDOWN_GRACE_MS,
			buildPayload: (code, msgId, opts) => {
				// Convert arguments into a TSV / Base64 payload.
				const cwdB64 = Buffer.from(opts?.cwd ?? "").toString("base64");
				const silentVal = opts?.silent ? "1" : "0";
				const storeHistVal = opts?.storeHistory !== false && !opts?.silent ? "1" : "0";

				// Format environment variables as key1_b64:val1_b64 key2_b64:val2_b64
				const envPairs: string[] = [];
				if (opts?.env) {
					for (const key in opts.env) {
						const val = opts.env[key];
						if (val !== undefined) {
							const k_b64 = Buffer.from(key).toString("base64");
							const v_b64 = Buffer.from(val).toString("base64");
							envPairs.push(`${k_b64}:${v_b64}`);
						}
					}
				}
				const envPairsStr = envPairs.join(" ");
				const codeB64 = Buffer.from(code).toString("base64");

				return `run\t${msgId}\t${cwdB64}\t${silentVal}\t${storeHistVal}\t${envPairsStr}\t${codeB64}`;
			},
		});
	}

	static async start(options: KernelStartOptions): Promise<JuliaKernel> {
		const availability = await checkJuliaKernelAvailability(options.cwd, options.interpreter);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Julia kernel unavailable");
		}

		let runtime = availability.runtime;
		if (!runtime) {
			const { env: shellEnv } = (await Settings.init()).getShellConfig();
			runtime = options.interpreter
				? resolveExplicitJuliaRuntime(options.interpreter, options.cwd, filterEnv(shellEnv))
				: resolveJuliaRuntime(options.cwd, filterEnv(shellEnv));
		}
		const spawnEnv: Record<string, string> = {};
		for (const key in runtime.env) {
			const value = runtime.env[key];
			if (typeof value === "string") spawnEnv[key] = value;
		}
		for (const key in options.env) {
			const value = options.env[key];
			if (typeof value === "string") spawnEnv[key] = value;
		}

		const scriptPath = await ensureRunnerScript();
		const kernel = new JuliaKernel(Snowflake.next());

		const proc = Bun.spawn(
			[runtime.juliaPath, "--startup-file=no", "--history-file=no", "--color=no", "--project=@.", scriptPath],
			{
				cwd: options.cwd,
				env: spawnEnv,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: shouldHideKernelWindow({
					platform: process.platform,
					hostHasInheritableConsole: hostHasInheritableConsole(),
				}),
			},
		);
		kernel.setProcess(proc);

		const startup = { signal: options.signal, deadlineMs: options.deadlineMs };
		const startupBudget = Math.min(getRemainingTimeMs(startup.deadlineMs) ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS);

		try {
			const initScript = buildInitScript(options.cwd, options.env);
			await kernel.executeWithBudget(initScript, startup.signal, startupBudget, "Julia kernel init");
			await kernel.executeWithBudget(JULIA_PRELUDE, startup.signal, startupBudget, "Julia kernel prelude");
			return kernel;
		} catch (err) {
			await kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => {});
			throw err;
		}
	}
}

function buildInitScript(cwd: string, env?: Record<string, string | undefined>): string {
	const envPayload: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (value !== undefined) envPayload[key] = value;
	}
	const lines = [
		`__omp_init_cwd = String(Base64.base64decode("${Buffer.from(cwd).toString("base64")}"))`,
		"try cd(__omp_init_cwd) catch; end",
	];
	for (const key in envPayload) {
		const k_b64 = Buffer.from(key).toString("base64");
		const v_b64 = Buffer.from(envPayload[key]).toString("base64");
		lines.push(`ENV[String(Base64.base64decode("${k_b64}"))] = String(Base64.base64decode("${v_b64}"))`);
	}
	// Avoid modifying LOAD_PATH if not necessary, but if needed, prepend cwd
	lines.push("if !(__omp_init_cwd in LOAD_PATH); pushfirst!(LOAD_PATH, __omp_init_cwd); end");
	return lines.join("\n");
}
