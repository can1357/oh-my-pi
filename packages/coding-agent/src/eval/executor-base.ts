import { logger } from "@pk-nerdsaver-ai/pi-utils";
import { Settings } from "../config/settings";
import { OutputSink } from "../session/streaming-output";
import type { ToolSession } from "../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { isEvalTimeoutControlEvent } from "./bridge-timeout";
import type { JsStatusEvent } from "./js/shared/types";
import type { KernelDisplayOutput } from "./py/display";
import { registerPyToolBridge } from "./py/tool-bridge";

/**
 * Constructor for a language executor's cancellation error. Each backend
 * subclasses {@link Error} and carries a `timedOut` flag distinguishing a
 * deadline expiry from a plain abort.
 */
export type CancelledErrorClass = new (timedOut: boolean) => Error & { timedOut: boolean };

/** Managed-env values a kernel patch may carry (`null` clears, `undefined` skips). */
export type KernelEnvPatch = Record<string, string | null | undefined>;

/**
 * Options every kernel-backed language executor shares. Per-language option
 * interfaces structurally extend this; the base executor only reads these.
 */
export interface KernelExecutorBaseOptions {
	cwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	signal?: AbortSignal;
	onStatus?: (event: JsStatusEvent) => void;
	emitStatus?: (event: JsStatusEvent) => void;
	toolSession?: ToolSession;
	bridgeSessionId?: string;
	artifactId?: string;
	artifactPath?: string;
}

/** Normalised execution result produced by {@link executeWithKernelBase}. */
export interface KernelExecutionResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: KernelDisplayOutput[];
	stdinRequested: boolean;
}

/** Minimal kernel surface the base executor drives, satisfied by every backend kernel. */
export interface GenericKernel<TEnv> {
	execute(
		code: string,
		options: {
			cwd?: string;
			env?: TEnv;
			id: string;
			signal?: AbortSignal;
			timeoutMs?: number;
			onChunk: (text: string) => Promise<void> | void;
			onDisplay: (output: KernelDisplayOutput) => Promise<void> | void;
		},
	): Promise<{
		status: "ok" | "error";
		cancelled: boolean;
		timedOut: boolean;
		kernelKilled?: boolean;
		stdinRequested?: boolean;
	}>;
}

// ---------------------------------------------------------------------------
// Cancellation helpers
// ---------------------------------------------------------------------------

export function getExecutionDeadlineMs(options?: { deadlineMs?: number; timeoutMs?: number }): number | undefined {
	if (options?.deadlineMs !== undefined) return options.deadlineMs;
	if (options?.timeoutMs === undefined) return undefined;
	return Date.now() + options.timeoutMs;
}

export function getRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	return deadlineMs - Date.now();
}

export function isCancellationError(error: unknown, cancelledErrorClass: CancelledErrorClass): boolean {
	return (
		error instanceof cancelledErrorClass ||
		(typeof DOMException !== "undefined" &&
			error instanceof DOMException &&
			(error.name === "AbortError" || error.name === "TimeoutError")) ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
	);
}

export function isTimedOutCancellation(
	error: unknown,
	cancelledErrorClass: CancelledErrorClass,
	signal?: AbortSignal,
): boolean {
	if (error instanceof cancelledErrorClass) return error.timedOut;
	if (typeof DOMException !== "undefined" && error instanceof DOMException) return error.name === "TimeoutError";
	if (error instanceof Error && error.name === "TimeoutError") return true;
	const reason = signal?.reason;
	if (typeof DOMException !== "undefined" && reason instanceof DOMException) return reason.name === "TimeoutError";
	return reason instanceof Error ? reason.name === "TimeoutError" : false;
}

export async function waitForPromiseWithCancellation<T>(
	promise: Promise<T>,
	options: { signal?: AbortSignal; deadlineMs?: number },
	cancelledErrorClass: CancelledErrorClass,
): Promise<T> {
	if (options.signal?.aborted) {
		throw new cancelledErrorClass(isTimedOutCancellation(options.signal.reason, cancelledErrorClass, options.signal));
	}
	const remainingMs = getRemainingTimeoutMs(options.deadlineMs);
	if (remainingMs !== undefined && remainingMs <= 0) {
		throw new cancelledErrorClass(true);
	}
	if (!options.signal && remainingMs === undefined) {
		return await promise;
	}

	const { promise: resultPromise, resolve, reject } = Promise.withResolvers<T>();
	const cleanups: Array<() => void> = [];
	const finish = (cb: () => void): void => {
		while (cleanups.length > 0) cleanups.pop()?.();
		cb();
	};
	if (options.signal) {
		const onAbort = (): void =>
			finish(() =>
				reject(
					new cancelledErrorClass(
						isTimedOutCancellation(options.signal?.reason, cancelledErrorClass, options.signal),
					),
				),
			);
		options.signal.addEventListener("abort", onAbort, { once: true });
		cleanups.push(() => options.signal?.removeEventListener("abort", onAbort));
	}
	if (remainingMs !== undefined) {
		const timer = setTimeout(() => finish(() => reject(new cancelledErrorClass(true))), remainingMs);
		timer.unref();
		cleanups.push(() => clearTimeout(timer));
	}
	promise.then(
		value => finish(() => resolve(value)),
		err => finish(() => reject(err)),
	);
	return await resultPromise;
}

export function createCancelledKernelResult(output: string): KernelExecutionResult {
	const outputBytes = Buffer.byteLength(output, "utf-8");
	const outputLines = output.length > 0 ? 1 : 0;
	return {
		output,
		exitCode: undefined,
		cancelled: true,
		truncated: false,
		artifactId: undefined,
		totalLines: outputLines,
		totalBytes: outputBytes,
		outputLines,
		outputBytes,
		displayOutputs: [],
		stdinRequested: false,
	};
}

// ---------------------------------------------------------------------------
// Managed environment helpers
// ---------------------------------------------------------------------------

export const MANAGED_KERNEL_ENV_KEYS = [
	"PI_SESSION_FILE",
	"PI_ARTIFACTS_DIR",
	"PI_TOOL_BRIDGE_URL",
	"PI_TOOL_BRIDGE_TOKEN",
	"PI_TOOL_BRIDGE_SESSION",
	"PI_EVAL_LOCAL_ROOTS",
] as const;

interface ManagedKernelEnvOptions {
	sessionFile?: string;
	artifactsDir?: string;
	bridgeSessionId?: string;
	bridge?: { url: string; token: string };
	localRoots?: Record<string, string>;
}

export function buildManagedKernelEnvPatch(options: ManagedKernelEnvOptions): Record<string, string | null> {
	const localRoots = options.localRoots;
	return {
		PI_SESSION_FILE: options.sessionFile ?? null,
		PI_ARTIFACTS_DIR: options.artifactsDir ?? null,
		PI_TOOL_BRIDGE_URL: options.bridge?.url ?? null,
		PI_TOOL_BRIDGE_TOKEN: options.bridge?.token ?? null,
		PI_TOOL_BRIDGE_SESSION: options.bridge && options.bridgeSessionId ? options.bridgeSessionId : null,
		PI_EVAL_LOCAL_ROOTS: localRoots && Object.keys(localRoots).length > 0 ? JSON.stringify(localRoots) : null,
	};
}

export function buildManagedKernelEnv(options: ManagedKernelEnvOptions): Record<string, string> | undefined {
	const patch = buildManagedKernelEnvPatch(options);
	const env: Record<string, string> = {};
	let hasKeys = false;
	for (const key of MANAGED_KERNEL_ENV_KEYS) {
		const value = patch[key];
		if (value !== null) {
			env[key] = value;
			hasKeys = true;
		}
	}
	return hasKeys ? env : undefined;
}

export function attachSessionOwner(
	session: { ownerIds: Set<string>; hasFallbackOwner: boolean },
	sessionId: string,
	ownerId: string | undefined,
): void {
	if (ownerId !== undefined) {
		if (session.hasFallbackOwner) {
			session.ownerIds.delete(sessionId);
			session.hasFallbackOwner = false;
		}
		session.ownerIds.add(ownerId);
		return;
	}
	if (session.hasFallbackOwner || session.ownerIds.size === 0) {
		session.ownerIds.add(sessionId);
		session.hasFallbackOwner = true;
	}
}

// ---------------------------------------------------------------------------
// Base executor implementation
// ---------------------------------------------------------------------------

export interface ExecuteWithKernelBaseParams<
	TOptions extends KernelExecutorBaseOptions,
	TEnv extends KernelEnvPatch = Record<string, string | null>,
> {
	kernel: GenericKernel<TEnv>;
	code: string;
	options: TOptions | undefined;
	/** Prefix for the per-execution run id (e.g. `"py"`, `"rb"`, `"jl"`). */
	runIdPrefix: string;
	/** Human-readable language label used in the failure log line. */
	errorLogLabel: string;
	/**
	 * Julia surfaces eval-timeout control events through its normal status path,
	 * so they must NOT be filtered out the way the JS-status backends do.
	 */
	isJulia?: boolean;
	cancelledErrorClass: CancelledErrorClass;
	buildKernelEnvPatch: (options: TOptions) => TEnv;
	formatKernelTimeoutAnnotation: (executionTimeoutMs: number | undefined, kernelKilled: boolean) => string;
	formatTimeoutAnnotation: (executionTimeoutMs: number | undefined) => string | undefined;
	/**
	 * Override how the wall-clock deadline is derived from options. Defaults to
	 * {@link getExecutionDeadlineMs}; Julia passes the pre-computed `deadlineMs`
	 * straight through instead of re-deriving from `timeoutMs`.
	 */
	resolveDeadlineMs?: (options: TOptions | undefined) => number | undefined;
}

export async function executeWithKernelBase<
	TOptions extends KernelExecutorBaseOptions,
	TEnv extends KernelEnvPatch = Record<string, string | null>,
>(params: ExecuteWithKernelBaseParams<TOptions, TEnv>): Promise<KernelExecutionResult> {
	const {
		kernel,
		code,
		options,
		runIdPrefix,
		errorLogLabel,
		isJulia,
		cancelledErrorClass,
		buildKernelEnvPatch,
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
		resolveDeadlineMs,
	} = params;

	const settings = await Settings.init();
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});

	const displayOutputs: KernelDisplayOutput[] = [];
	const deadlineMs = (resolveDeadlineMs ?? getExecutionDeadlineMs)(options);
	let executionTimeoutMs: number | undefined;

	const collectDisplay = (output: KernelDisplayOutput): void => {
		if (output.type === "status") {
			options?.onStatus?.(output.event);
			if (!isJulia && isEvalTimeoutControlEvent(output.event)) return;
		}
		displayOutputs.push(output);
	};

	const emitStatus: (event: JsStatusEvent) => void =
		options?.emitStatus ?? (event => collectDisplay({ type: "status", event }));
	const runId = `${runIdPrefix}-${crypto.randomUUID()}`;
	const unregisterBridge =
		options?.toolSession && options?.bridgeSessionId
			? registerPyToolBridge(options.bridgeSessionId, runId, {
					toolSession: options.toolSession,
					signal: options.signal,
					emitStatus,
				})
			: null;

	try {
		const remainingMs = getRemainingTimeoutMs(deadlineMs);
		if (remainingMs !== undefined) {
			if (remainingMs <= 0) {
				throw new cancelledErrorClass(true);
			}
			executionTimeoutMs = remainingMs;
		}

		const result = await kernel.execute(code, {
			cwd: options?.cwd,
			env: buildKernelEnvPatch(options ?? ({} as TOptions)),
			id: runId,
			signal: options?.signal,
			timeoutMs: executionTimeoutMs,
			onChunk: text => sink.push(text),
			onDisplay: output => collectDisplay(output),
		});

		if (result.cancelled) {
			const annotation = result.timedOut
				? formatKernelTimeoutAnnotation(executionTimeoutMs ?? options?.idleTimeoutMs, result.kernelKilled ?? false)
				: undefined;
			const dumped = await sink.dump(annotation);
			return {
				exitCode: undefined,
				cancelled: true,
				truncated: dumped.truncated,
				output: dumped.output,
				artifactId: dumped.artifactId ?? undefined,
				totalLines: dumped.totalLines,
				totalBytes: dumped.totalBytes,
				outputLines: dumped.outputLines,
				outputBytes: dumped.outputBytes,
				displayOutputs,
				stdinRequested: !!result.stdinRequested,
			};
		}

		if (result.stdinRequested) {
			const dumped = await sink.dump("Kernel requested stdin; interactive input is not supported.");
			return {
				exitCode: 1,
				cancelled: false,
				truncated: dumped.truncated,
				output: dumped.output,
				artifactId: dumped.artifactId ?? undefined,
				totalLines: dumped.totalLines,
				totalBytes: dumped.totalBytes,
				outputLines: dumped.outputLines,
				outputBytes: dumped.outputBytes,
				displayOutputs,
				stdinRequested: true,
			};
		}

		const exitCode = result.status === "ok" ? 0 : 1;
		const dumped = await sink.dump();
		return {
			exitCode,
			cancelled: false,
			truncated: dumped.truncated,
			output: dumped.output,
			artifactId: dumped.artifactId ?? undefined,
			totalLines: dumped.totalLines,
			totalBytes: dumped.totalBytes,
			outputLines: dumped.outputLines,
			outputBytes: dumped.outputBytes,
			displayOutputs,
			stdinRequested: false,
		};
	} catch (err) {
		if (isCancellationError(err, cancelledErrorClass) || options?.signal?.aborted) {
			const timedOut = isTimedOutCancellation(err, cancelledErrorClass, options?.signal);
			const dumped = await sink.dump(
				timedOut ? formatTimeoutAnnotation(executionTimeoutMs ?? options?.idleTimeoutMs) : undefined,
			);
			return {
				exitCode: undefined,
				cancelled: true,
				truncated: dumped.truncated,
				output: dumped.output,
				artifactId: dumped.artifactId ?? undefined,
				totalLines: dumped.totalLines,
				totalBytes: dumped.totalBytes,
				outputLines: dumped.outputLines,
				outputBytes: dumped.outputBytes,
				displayOutputs,
				stdinRequested: false,
			};
		}
		const error = err instanceof Error ? err : new Error(String(err));
		logger.error(`${errorLogLabel} execution failed`, { error: error.message });
		throw error;
	} finally {
		unregisterBridge?.();
	}
}
