import * as path from "node:path";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../../tools";
import {
	buildManagedKernelEnv,
	buildManagedKernelEnvPatch,
	createCancelledKernelResult,
	executeWithKernelBase,
	getExecutionDeadlineMs,
	isCancellationError,
	isTimedOutCancellation,
	waitForPromiseWithCancellation,
} from "../executor-base";
import {
	createKernelSessionRegistry,
	type KernelSession,
	normalizeKernelSessionCwd,
	requireRemainingKernelTimeoutMs,
} from "../kernel-session-registry";
import { ensurePyToolBridge, type PyToolBridgeInfo } from "../py/tool-bridge";
import type { EvalDisplayOutput, EvalStatusEvent } from "../types";
import {
	checkJuliaKernelAvailability,
	JuliaKernel,
	type KernelExecuteOptions,
	type KernelExecuteResult,
} from "./kernel";
import { resolveExplicitJuliaRuntime } from "./runtime";

const SHUTDOWN_GRACE_MS = 1_000;

export interface JuliaExecutorOptions {
	cwd?: string;
	sessionId?: string;
	sessionFile?: string;
	artifactsDir?: string;
	localRoots?: Record<string, string>;
	interpreter?: string;
	onChunk?: (text: string) => void | Promise<void>;
	onStatus?: (event: EvalStatusEvent) => void;
	signal?: AbortSignal;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	kernelOwnerId?: string;
	reset?: boolean;
	toolSession?: ToolSession;
	bridge?: PyToolBridgeInfo;
	bridgeSessionId?: string;
	artifactId?: string;
}

export interface JuliaKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
}

export interface JuliaResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
	stdinRequested: boolean;
}

class JuliaExecutionCancelledError extends Error {
	constructor(readonly timedOut: boolean) {
		super(timedOut ? "Julia execution timed out" : "Julia execution cancelled");
		this.name = "JuliaExecutionCancelledError";
	}
}

function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	const resolved = resolveExplicitJuliaRuntime(interpreter, cwd, {}).juliaPath;
	try {
		return path.resolve(resolved);
	} catch {
		return resolved;
	}
}

function isJuliaCancellationError(error: unknown): boolean {
	return (
		isCancellationError(error, JuliaExecutionCancelledError) ||
		(!!error &&
			typeof error === "object" &&
			"name" in error &&
			(error.name === "AbortError" || error.name === "TimeoutError"))
	);
}

function isTimedOutJuliaCancellation(error: unknown, signal?: AbortSignal): boolean {
	return (
		isTimedOutCancellation(error, JuliaExecutionCancelledError, signal) ||
		(!!error && typeof error === "object" && "name" in error && error.name === "TimeoutError")
	);
}

async function waitForJuliaPromise<T>(
	promise: Promise<T>,
	options: Pick<JuliaExecutorOptions, "signal" | "deadlineMs">,
): Promise<T> {
	const deadlineMs =
		typeof options.deadlineMs === "number" && options.deadlineMs > Date.now() ? options.deadlineMs : undefined;
	return await waitForPromiseWithCancellation(
		promise,
		{ ...options, deadlineMs },
		JuliaExecutionCancelledError,
		isTimedOutJuliaCancellation,
	);
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	return requireRemainingKernelTimeoutMs(deadlineMs, JuliaExecutionCancelledError);
}

function formatTimeoutAnnotation(timeoutMs?: number): string | undefined {
	if (timeoutMs === undefined) return undefined;
	const rounded = (timeoutMs / 1000).toFixed(0);
	return `[cell timed out after ${rounded}s]`;
}

function formatKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	const explanation = kernelKilled ? "; active subprocess terminated to recover" : "; kernel is still running";
	if (timeoutMs === undefined) return `[execution timed out${explanation}]`;
	const rounded = (timeoutMs / 1000).toFixed(0);
	return `[execution timed out after ${rounded}s${explanation}]`;
}

function createCancelledJuliaResult(_timedOut: boolean, timeoutMs?: number): JuliaResult {
	const output = formatTimeoutAnnotation(timeoutMs) ?? "[execution cancelled]\n";
	return createCancelledKernelResult(output);
}

async function startKernel(cwd: string, options: JuliaExecutorOptions): Promise<JuliaKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	const env: Record<string, string | undefined> = buildManagedKernelEnv(options, { sparse: true }) ?? {};
	return await JuliaKernel.start({
		cwd,
		interpreter: options.interpreter,
		env,
		signal: options.signal,
		deadlineMs: options.deadlineMs,
	});
}

async function executeWithKernel(
	kernel: JuliaKernel,
	code: string,
	options: JuliaExecutorOptions | undefined,
): Promise<JuliaResult> {
	return executeWithKernelBase<JuliaExecutorOptions, Record<string, string | undefined>>({
		kernel,
		code,
		options,
		runIdPrefix: "jl",
		errorLogLabel: "Julia",
		isJulia: true,
		cancelledErrorClass: JuliaExecutionCancelledError,
		buildKernelEnvPatch: opts => buildManagedKernelEnvPatch(opts, { sparse: true }),
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
		resolveDeadlineMs: opts => opts?.deadlineMs,
	});
}

async function ensureKernelAvailable(cwd: string, options: JuliaExecutorOptions): Promise<void> {
	const availability = await waitForJuliaPromise(checkJuliaKernelAvailability(cwd, options.interpreter), options);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Julia kernel unavailable");
	}
}

async function ensureToolBridge(options: JuliaExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	try {
		options.bridge = await ensurePyToolBridge();
	} catch (err) {
		logger.warn("Failed to start Julia tool bridge", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

const sessionRegistry = createKernelSessionRegistry<
	JuliaKernel,
	JuliaExecutorOptions,
	JuliaResult,
	KernelSession<JuliaKernel>
>({
	languageLabel: "Julia",
	cancelledErrorClass: JuliaExecutionCancelledError,
	buildSessionKey: (sessionId, cwd, interpreter) => {
		const normalizedCwd = normalizeKernelSessionCwd(cwd);
		const normalizedInterpreter = normalizeExplicitInterpreter(normalizedCwd, interpreter);
		return `${sessionId}::${normalizedCwd}::${normalizedInterpreter}`;
	},
	createSession: session => session,
	startKernel,
	executeWithKernel,
	waitForStartup: waitForJuliaPromise,
	shutdownSession: (session, resetting) =>
		resetting ? session.kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }) : session.kernel.shutdown(),
	clearResetsOnDisposeAll: true,
	logBeforeReplacement: true,
	isCancellation: isJuliaCancellationError,
	isTimedOutCancellation: isTimedOutJuliaCancellation,
});

export async function disposeAllJuliaKernelSessions(): Promise<void> {
	await sessionRegistry.disposeAll();
}

export async function disposeJuliaKernelSessionsByOwner(ownerId: string): Promise<void> {
	await sessionRegistry.disposeByOwner(ownerId);
}

export async function executeJuliaWithKernel(
	kernel: JuliaKernel,
	code: string,
	options?: JuliaExecutorOptions,
): Promise<JuliaResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executeJulia(code: string, options?: JuliaExecutorOptions): Promise<JuliaResult> {
	const cwd = normalizeKernelSessionCwd(options?.cwd ?? getProjectDir());
	const deadlineMs =
		options?.deadlineMs !== undefined
			? options.deadlineMs
			: options?.timeoutMs !== undefined && options.timeoutMs > 0
				? getExecutionDeadlineMs(options)
				: undefined;
	const executionOptions: JuliaExecutorOptions = {
		...(options ?? {}),
		cwd,
		deadlineMs,
	};

	try {
		requireRemainingTimeoutMs(deadlineMs);
		if (executionOptions.signal?.aborted) {
			throw new JuliaExecutionCancelledError(
				isTimedOutJuliaCancellation(executionOptions.signal.reason, executionOptions.signal),
			);
		}
		await ensureKernelAvailable(cwd, executionOptions);
		await ensureToolBridge(executionOptions);
		return await sessionRegistry.executeOnSession(code, cwd, executionOptions);
	} catch (err) {
		if (isJuliaCancellationError(err) || executionOptions.signal?.aborted) {
			return createCancelledJuliaResult(isTimedOutJuliaCancellation(err, executionOptions.signal));
		}
		throw err;
	}
}
