/**
 * Subprocess-backed Ruby runner.
 *
 * Speaks NDJSON with `runner.rb` over stdin/stdout. One subprocess per kernel
 * instance; sessions reuse a single subprocess across executions. Cancellation
 * is delivered as SIGINT (clean interrupt, kernel state preserved) and escalates
 * to a full shutdown only when the runner ignores it. Mirrors the Python kernel
 * (eval/py/kernel.ts); the IPC loop, lifecycle, and display rendering are shared
 * with it via BaseKernel.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $flag, isBunTestRuntime, logger, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import { $ } from "bun";
import { Settings } from "../../config/settings";
import { BaseKernel, getRemainingTimeMs, type KernelRuntimeEnv, type KernelStartOptions } from "../kernel-base";
import type { KernelDisplayOutput } from "../py/display";
import { hostHasInheritableConsole, shouldHideKernelWindow } from "../py/spawn-options";
import { RUBY_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.rb" with { type: "text" };
import {
	enumerateRubyRuntimes,
	filterEnv,
	type RubyRuntime,
	resolveExplicitRubyRuntime,
	resolveRubyRuntime,
} from "./runtime";

export type { KernelExecuteResult, KernelRuntimeEnv, KernelShutdownResult } from "../kernel-base";
export type { KernelDisplayOutput, PythonStatusEvent } from "../py/display";
export { renderKernelDisplay } from "../py/display";

const TRACE_IPC = $flag("PI_RUBY_IPC_TRACE");

// Cache the runner script on disk so the subprocess loads it normally. Cached
// per script hash so installs don't race across versions.
const RUNNER_CACHE_DIR = path.join(os.tmpdir(), "omp-ruby-runner");
let RUNNER_SCRIPT_PATH: string | null = null;

async function ensureRunnerScript(): Promise<string> {
	if (RUNNER_SCRIPT_PATH) return RUNNER_SCRIPT_PATH;
	await fs.promises.mkdir(RUNNER_CACHE_DIR, { recursive: true });
	const hash = Bun.hash(RUNNER_SCRIPT).toString(36);
	const target = path.join(RUNNER_CACHE_DIR, `runner-${hash}.rb`);
	if (!fs.existsSync(target)) {
		await Bun.write(target, RUNNER_SCRIPT);
	}
	RUNNER_SCRIPT_PATH = target;
	return target;
}

const SHUTDOWN_GRACE_MS = 1_000;
const STARTUP_TIMEOUT_MS = 10_000;
// How long to wait after SIGINT for the runner to emit `done` before escalating
// to a full subprocess shutdown so the host queue unblocks instead of hanging.
const INTERRUPT_ESCALATION_MS = 5_000;

export interface KernelExecuteOptions {
	id?: string;
	/** Runtime working directory applied immediately before this request executes. */
	cwd?: string;
	/** Managed runtime environment variables applied immediately before this request executes. */
	env?: KernelRuntimeEnv;
	signal?: AbortSignal;
	onChunk?: (text: string) => Promise<void> | void;
	onDisplay?: (output: KernelDisplayOutput) => Promise<void> | void;
	timeoutMs?: number;
	silent?: boolean;
	storeHistory?: boolean;
}

export interface RubyKernelAvailability {
	ok: boolean;
	rubyPath?: string;
	reason?: string;
	/** The probed-working runtime, when one was found. */
	runtime?: RubyRuntime;
}

// Cache successful probes per resolved cwd + explicit interpreter. Failures are
// not cached so installing Ruby mid-session is picked up on the next attempt.
const availabilityCache = new Map<string, Promise<RubyKernelAvailability>>();

export async function checkRubyKernelAvailability(cwd: string, interpreter?: string): Promise<RubyKernelAvailability> {
	if (isBunTestRuntime() || $flag("PI_RUBY_SKIP_CHECK")) {
		return { ok: true };
	}
	const resolvedCwd = path.resolve(cwd);
	const key = `${resolvedCwd}\0${interpreter ?? ""}`;
	const cached = availabilityCache.get(key);
	if (cached) return await cached;
	const probe = probeRubyKernelAvailability(resolvedCwd, interpreter);
	availabilityCache.set(key, probe);
	const result = await probe;
	if (!result.ok && availabilityCache.get(key) === probe) {
		availabilityCache.delete(key);
	}
	return result;
}

async function probeRubyKernelAvailability(cwd: string, interpreter?: string): Promise<RubyKernelAvailability> {
	try {
		const settings = await Settings.init();
		const { env } = settings.getShellConfig();
		const baseEnv = filterEnv(env);
		const runtimes = enumerateRubyRuntimes(cwd, baseEnv, interpreter);
		if (runtimes.length === 0) {
			return { ok: false, reason: "Ruby executable not found on PATH" };
		}
		const failures: string[] = [];
		for (const runtime of runtimes) {
			try {
				const probe = await $`${runtime.rubyPath} -e ${"exit 0"}`.quiet().nothrow().cwd(cwd).env(runtime.env);
				if (probe.exitCode === 0) {
					return { ok: true, rubyPath: runtime.rubyPath, runtime };
				}
				failures.push(`${runtime.rubyPath} (exit code ${probe.exitCode})`);
			} catch (err) {
				failures.push(`${runtime.rubyPath} (${err instanceof Error ? err.message : String(err)})`);
			}
		}
		return {
			ok: false,
			rubyPath: runtimes[0].rubyPath,
			reason: `No working Ruby interpreter found. Tried: ${failures.join("; ")}`,
		};
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

export class RubyKernel extends BaseKernel<KernelExecuteOptions> {
	private constructor(id: string) {
		super(id, {
			languageName: "Ruby",
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

	static async start(options: KernelStartOptions): Promise<RubyKernel> {
		const availability = await logger.time(
			"RubyKernel.start:availabilityCheck",
			checkRubyKernelAvailability,
			options.cwd,
			options.interpreter,
		);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Ruby kernel unavailable");
		}

		// Reuse the interpreter the availability probe selected. The fallback
		// computes a runtime only for the skip-check fast path (test runtime /
		// PI_RUBY_SKIP_CHECK), where no candidate was probed.
		let runtime = availability.runtime;
		if (!runtime) {
			const { env: shellEnv } = (await Settings.init()).getShellConfig();
			runtime = options.interpreter
				? resolveExplicitRubyRuntime(options.interpreter, options.cwd, filterEnv(shellEnv))
				: resolveRubyRuntime(options.cwd, filterEnv(shellEnv));
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
		const kernel = new RubyKernel(Snowflake.next());

		const proc = Bun.spawn([runtime.rubyPath, scriptPath], {
			cwd: options.cwd,
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
			await kernel.executeWithBudget(initScript, startup.signal, startupBudget, "Ruby kernel init");
			await kernel.executeWithBudget(RUBY_PRELUDE, startup.signal, startupBudget, "Ruby kernel prelude");
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
	// JSON string literals are valid Ruby string literals. Emit one
	// `ENV["k"] = "v"` per key — a `{"k":"v"}` object literal would parse as a
	// SYMBOL-keyed hash in Ruby (`:"k" => "v"`), which `ENV[]=` rejects.
	const lines = [`__omp_init_cwd = ${JSON.stringify(cwd)}`, "Dir.chdir(__omp_init_cwd) rescue nil"];
	for (const key in envPayload) {
		lines.push(`ENV[${JSON.stringify(key)}] = ${JSON.stringify(envPayload[key])}`);
	}
	lines.push("$LOAD_PATH.delete(__omp_init_cwd)", "$LOAD_PATH.unshift(__omp_init_cwd)");
	return lines.join("\n");
}
