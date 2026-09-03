import { logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { OutputSink } from "../session/streaming-output";
import type { ToolSession } from "../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP, isEvalTimeoutControlEvent } from "./bridge-timeout";
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
	timedOutResolver?: (error: unknown, signal?: AbortSignal) => boolean,
): Promise<T> {
	if (options.signal?.aborted) {
		throw new cancelledErrorClass(
			timedOutResolver?.(options.signal.reason, options.signal) ??
				isTimedOutCancellation(options.signal.reason, cancelledErrorClass, options.signal),
		);
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
						timedOutResolver?.(options.signal?.reason, options.signal) ??
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

/**
 * Derived abort signal for the kernel, holding back an external abort while a
 * bridge call marked `deferExternalAbort` is in flight.
 *
 * Scope is deliberately narrow: only `kernel.execute` consumes
 * {@link BridgeAbortShield.signal}. Work dispatched through the tool bridge
 * keeps the caller's real signal so a turn cancel reaches spawned subagents
 * immediately — deferral protects the runtime, never the delegated work.
 */
interface BridgeAbortShield {
	signal: AbortSignal | undefined;
	abortRequested: boolean;
	timedOut: boolean;
	handleStatus?: (event: JsStatusEvent) => void;
	dispose?: () => void;
}

function createBridgeAbortShield(source: AbortSignal | undefined): BridgeAbortShield {
	const shield: BridgeAbortShield = {
		signal: undefined,
		abortRequested: false,
		timedOut: false,
	};
	if (!source) return shield;

	const controller = new AbortController();
	let pauseDepth = 0;
	let abortReason: unknown;
	let removeAbortListener: (() => void) | undefined;

	const requestAbort = (reason: unknown): void => {
		shield.abortRequested = true;
		shield.timedOut =
			shield.timedOut ||
			(typeof DOMException !== "undefined" && reason instanceof DOMException
				? reason.name === "TimeoutError"
				: reason instanceof Error && reason.name === "TimeoutError");
		abortReason = reason;
		if (pauseDepth > 0 || controller.signal.aborted) return;
		controller.abort(reason);
	};

	const onAbort = (): void => {
		const reason = source.reason;
		requestAbort(reason);
	};

	shield.signal = controller.signal;
	shield.handleStatus = (event: JsStatusEvent): void => {
		if (event.deferExternalAbort !== true) return;
		if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
			pauseDepth++;
			return;
		}
		if (event.op !== EVAL_TIMEOUT_RESUME_OP || pauseDepth === 0) return;
		pauseDepth--;
		if (shield.abortRequested && !controller.signal.aborted) controller.abort(abortReason);
	};
	shield.dispose = (): void => {
		removeAbortListener?.();
		removeAbortListener = undefined;
	};

	if (source.aborted) {
		requestAbort(source.reason);
	} else {
		source.addEventListener("abort", onAbort, { once: true });
		removeAbortListener = () => {
			source.removeEventListener("abort", onAbort);
		};
		if (source.aborted) {
			source.removeEventListener("abort", onAbort);
			removeAbortListener = undefined;
			requestAbort(source.reason);
		}
	}

	return shield;
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
interface ManagedKernelEnvPolicy {
	sparse?: boolean;
}

export function buildManagedKernelEnvPatch(options: ManagedKernelEnvOptions): Record<string, string | null>;
export function buildManagedKernelEnvPatch(
	options: ManagedKernelEnvOptions,
	policy: { sparse: true },
): Record<string, string | undefined>;
export function buildManagedKernelEnvPatch(
	options: ManagedKernelEnvOptions,
	policy?: ManagedKernelEnvPolicy,
): KernelEnvPatch {
	const localRoots = options.localRoots;
	if (policy?.sparse) {
		const patch: Record<string, string | undefined> = {};
		if (options.sessionFile) patch.PI_SESSION_FILE = options.sessionFile;
		if (options.artifactsDir) patch.PI_ARTIFACTS_DIR = options.artifactsDir;
		if (options.bridge) {
			patch.PI_TOOL_BRIDGE_URL = options.bridge.url;
			patch.PI_TOOL_BRIDGE_TOKEN = options.bridge.token;
			patch.PI_TOOL_BRIDGE_SESSION = options.bridgeSessionId ?? "";
		}
		if (localRoots) patch.PI_EVAL_LOCAL_ROOTS = JSON.stringify(localRoots);
		return patch;
	}
	return {
		PI_SESSION_FILE: options.sessionFile ?? null,
		PI_ARTIFACTS_DIR: options.artifactsDir ?? null,
		PI_TOOL_BRIDGE_URL: options.bridge?.url ?? null,
		PI_TOOL_BRIDGE_TOKEN: options.bridge?.token ?? null,
		PI_TOOL_BRIDGE_SESSION: options.bridge && options.bridgeSessionId ? options.bridgeSessionId : null,
		PI_EVAL_LOCAL_ROOTS: localRoots && Object.keys(localRoots).length > 0 ? JSON.stringify(localRoots) : null,
	};
}

export function buildManagedKernelEnv(
	options: ManagedKernelEnvOptions,
	policy?: ManagedKernelEnvPolicy,
): Record<string, string> | undefined {
	const patch = policy?.sparse
		? buildManagedKernelEnvPatch(options, { sparse: true })
		: buildManagedKernelEnvPatch(options);
	const env: Record<string, string> = {};
	let hasKeys = false;
	for (const key of MANAGED_KERNEL_ENV_KEYS) {
		const value = patch[key];
		if (typeof value === "string") {
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

/** Owner registry shared by every language's live/starting session records. */
export interface SessionOwners {
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

/**
 * Resolve the session key an owner's eval cell runs on, forking `reset` away
 * from shared kernels.
 *
 * Eval sessions are shared across agents by design (subagents inherit the
 * parent's eval session id), so honoring `reset` on a co-owned kernel would
 * destroy every other agent's state — including cells executing at that
 * moment. When the requester does not exclusively own the live base session,
 * its reset resolves to a deterministic per-owner fork key: the requester
 * starts a fresh private kernel while co-owners keep the shared one. Once
 * forked, the owner keeps resolving to its fork, and per-owner dispose reaps
 * the fork since the requester is its only registered owner.
 */
export function resolveOwnerScopedSessionKey(options: {
	baseKey: string;
	ownerId: string | undefined;
	reset: boolean;
	/** True when a live or starting session exists under `key`. */
	hasSession: (key: string) => boolean;
	/** Owner registry for the session under `key`, when inspectable. */
	getOwners: (key: string) => SessionOwners | undefined;
}): string {
	const { baseKey, ownerId } = options;
	if (ownerId === undefined) return baseKey;
	const forkKey = `${baseKey}\0fork\0${ownerId}`;
	if (options.hasSession(forkKey)) return forkKey;
	if (!options.reset) return baseKey;
	const base = options.getOwners(baseKey);
	if (!base) return baseKey;
	const exclusive = !base.hasFallbackOwner && base.ownerIds.size === 1 && base.ownerIds.has(ownerId);
	return exclusive ? baseKey : forkKey;
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
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	const executionTimeoutMs = remainingMs !== undefined && remainingMs > 0 ? remainingMs : undefined;
	// The wall-clock timeout must abort through the same shield the bridge
	// watches. A kernel-internal timer SIGINTs the runner but leaves in-flight
	// bridge calls (parallel() fan-outs of agent()/completion()/tool.*) blocked
	// in urllib worker threads; the runner then wedges in the pool's
	// shutdown(wait=True), never emits `done`, and the SIGINT escalation kills
	// the kernel — losing every variable. Expiring via the shield rejects those
	// bridge calls, so the workers unwind and the cell settles as a clean
	// KeyboardInterrupt. It also inherits critical-phase deferral: a timeout
	// landing mid-merge waits for the resume instead of settling the cell on
	// top of a half-applied git operation.
	const timeoutSignal = executionTimeoutMs !== undefined ? AbortSignal.timeout(executionTimeoutMs) : undefined;
	const abortSource =
		options?.signal && timeoutSignal
			? AbortSignal.any([options.signal, timeoutSignal])
			: (timeoutSignal ?? options?.signal);
	const abortShield = createBridgeAbortShield(abortSource);

	const collectDisplay = (output: KernelDisplayOutput): void => {
		if (output.type === "status") {
			abortShield.handleStatus?.(output.event);
			options?.onStatus?.(output.event);
			if (!isJulia && isEvalTimeoutControlEvent(output.event)) return;
		}
		displayOutputs.push(output);
	};

	const emitStatus: (event: JsStatusEvent) => void =
		options?.emitStatus ?? (event => collectDisplay({ type: "status", event }));
	const runId = `${runIdPrefix}-${crypto.randomUUID()}`;
	// Two aborts cross the bridge, and conflating them is what let a cancelled
	// turn keep working. Delegated work (above all the subagents `agent()`
	// spawns) gets the caller's real signal so it dies with the turn — shielding
	// it here made Python/Ruby/Julia fan-outs outlive a cancel indefinitely,
	// while JS cells, which never route through this shield, stopped fine. The
	// shielded signal only governs how long the host waits on a call, holding
	// the cell open across a critical phase (isolation worktree setup,
	// merge/cherry-pick) so a cancel can't settle it on top of a half-applied
	// git operation.
	const unregisterBridge =
		options?.toolSession && options?.bridgeSessionId
			? registerPyToolBridge(options.bridgeSessionId, runId, {
					toolSession: options.toolSession,
					signal: options.signal,
					shieldedSignal: abortShield.signal,
					emitStatus,
					abortRequested: () => {
						return abortShield.abortRequested;
					},
				})
			: null;

	try {
		if (remainingMs !== undefined && remainingMs <= 0) {
			throw new cancelledErrorClass(true);
		}

		const result = await kernel.execute(code, {
			cwd: options?.cwd,
			env: buildKernelEnvPatch(options ?? ({} as TOptions)),
			id: runId,
			signal: abortShield.signal,
			onChunk: text => sink.push(text),
			onDisplay: output => collectDisplay(output),
		});

		if (result.cancelled || abortShield.abortRequested) {
			const timedOut = result.timedOut || abortShield.timedOut;
			const annotation = timedOut
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
		if (isCancellationError(err, cancelledErrorClass) || abortShield.abortRequested || abortShield.signal?.aborted) {
			const timedOut = abortShield.timedOut || isTimedOutCancellation(err, cancelledErrorClass, abortShield.signal);
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
		await sink.dispose();
		unregisterBridge?.();
		abortShield.dispose?.();
	}
}
