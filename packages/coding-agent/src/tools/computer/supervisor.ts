import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { postmortem, untilAborted } from "@oh-my-pi/pi-utils";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import { closeDesktopEventTaps, desktopEscapeStops, forgetDesktopEscapeStops } from "@oh-my-pi/pi-natives/desktop";
import { withTimeout } from "@oh-my-pi/pi-utils/async";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import {
	type ApprovalContextSource,
	type ApprovalPolicy,
	resolveApproval,
	resolveApprovalFromContext,
} from "../approval";
import type { ToolSession } from "../index";
import { ToolAbortError, toWorkerErrorPayload } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	COMPUTER_WORKER_ARG,
	type ComputerEscapeScope,
	type ComputerRunOk,
	type ComputerSessionSnapshot,
	type ComputerWorkerInbound,
	type ComputerWorkerOutbound,
	type ControlVerdict,
	ESCAPE_AFTER_CALL_MESSAGE,
	ESCAPE_REFUSED_MESSAGE,
	ESCAPE_STOPPED_MESSAGE,
	type RunErrorPayload,
} from "./protocol";

const START_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 1_500;
const GRACE_MS = 750;
const SMOKE_TIMEOUT_MS = 5_000;
// A capabilities request only ensures the native session and reads a getter, but
// the first ensure may load the desktop addon, so it shares the start budget.
const CAPABILITIES_TIMEOUT_MS = 10_000;
const RESTART_MESSAGE = "computer worker restarted; captures and ax refs were reset";

/**
 * The user's `tools.approval["computer.control"]` policy. The approval mode never decides it: the default `yolo`
 * would hand the user's foreground to every headless run, so without an explicit entry the user is asked.
 */
function controlPolicy(context: ApprovalContextSource): ApprovalPolicy {
	const { userPolicies } = resolveApprovalFromContext(context);
	return resolveApproval({ name: "computer.control", approval: "exec" }, undefined, "always-ask", userPolicies).policy;
}

/** Runs desktop scripts and owns their persistent worker session. */
export interface ComputerController {
	run(
		code: string,
		timeoutMs: number,
		snapshot: ComputerSessionSnapshot,
		signal?: AbortSignal,
		context?: AgentToolContext,
	): Promise<ComputerRunOk>;
	revokeControl?(): Promise<void>;
	/** The owner's agent turn `turn` ended: let the display sleep now, keeping control, refs and the worker. */
	releaseDisplay?(turn: number): void;
	/**
	 * Turn `from` stopped for a dialog and went on as `turn`: a run of `from` active or starting holds the display
	 * again.
	 */
	resumeDisplay?(from: number, turn: number): void;
	/** The user's message acknowledges every Escape stop so far, lifting the refusal they set. */
	resumeAfterEscape?(): void;
	capabilities(snapshot: ComputerSessionSnapshot, signal?: AbortSignal): Promise<DesktopCapabilities | undefined>;
	close(): Promise<void>;
}

/** Minimal Bun worker lifecycle surface used by the supervisor. */
export interface ComputerWorkerHandle {
	send(message: ComputerWorkerInbound): void;
	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

/** Startup and shutdown deadlines for a computer worker. */
export interface ComputerSupervisorTimeouts {
	startMs: number;
	closeMs: number;
}

const DEFAULT_TIMEOUTS: ComputerSupervisorTimeouts = {
	startMs: START_TIMEOUT_MS,
	closeMs: CLOSE_TIMEOUT_MS,
};

/** Dispatches a tool call requested from desktop JavaScript. */
export type ComputerSessionToolCaller = (
	name: string,
	args: unknown,
	options: { session: ToolSession; signal?: AbortSignal; emitStatus?: () => void },
) => Promise<unknown>;

/** Native physical-Escape stop counts, read on the host so they outlive the worker that observed them. */
export interface ComputerEscapeStops {
	read(key: string): number;
	forget(key: string): void;
}

const NATIVE_ESCAPE_STOPS: ComputerEscapeStops = { read: desktopEscapeStops, forget: forgetDesktopEscapeStops };

/** Creates an isolated computer worker handle. */
export type ComputerWorkerFactory = () => ComputerWorkerHandle;

interface PendingRun {
	resolve(value: ComputerRunOk): void;
	reject(error: unknown): void;
	signal?: AbortSignal;
	toolCalls: Map<string, AbortController>;
	context?: AgentToolContext;
}

interface PendingCapabilities {
	resolve(value: DesktopCapabilities | undefined): void;
	reject(error: unknown): void;
}

function wrapWorker(worker: Worker): ComputerWorkerHandle {
	return {
		send(message) {
			worker.postMessage(message);
		},
		onMessage(handler) {
			const listener = (event: MessageEvent): void => handler(event.data as ComputerWorkerOutbound);
			worker.addEventListener("message", listener);
			return () => worker.removeEventListener("message", listener);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void =>
				handler(event.error instanceof Error ? event.error : new Error(event.message));
			const onMessageError = (event: MessageEvent): void =>
				handler(new Error(`Computer worker message error: ${String(event.data)}`));
			const onClose = (): void => handler(new Error("Computer worker exited"));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			worker.addEventListener("close", onClose);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
				worker.removeEventListener("close", onClose);
			};
		},
		async terminate() {
			worker.terminate();
		},
	};
}

let closesEventTapsAtExit = false;

/** Spawns the computer worker through the active CLI host when available. */
export function spawnComputerWorker(): ComputerWorkerHandle {
	if (!closesEventTapsAtExit) {
		closesEventTapsAtExit = true;
		// A macOS event tap the worker's session still holds when this process dies makes WindowServer deliver the
		// key the user is typing at that moment twice or more. Bun's process.exit runs no native exit hook, and the
		// worker's own exit handlers do not run when the main thread exits, so the taps are closed from here.
		postmortem.register("computer-event-taps", () => closeDesktopEventTaps(), { exitOnly: true });
	}
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [COMPUTER_WORKER_ARG] })
		: new Worker(new URL("./worker-entry.ts", import.meta.url).href, { type: "module" });
	return wrapWorker(worker);
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const error = payload.isAbort
		? new ToolAbortError(payload.message)
		: payload.isToolError
			? new ToolError(payload.message)
			: new Error(payload.message);
	error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

/** Supervises one lazy, crash-isolated computer worker per agent session. */
export class ComputerSupervisor implements ComputerController {
	readonly #session: ToolSession;
	readonly #createWorker: ComputerWorkerFactory;
	readonly #callSessionTool: ComputerSessionToolCaller;
	readonly #timeouts: ComputerSupervisorTimeouts;
	#worker?: ComputerWorkerHandle;
	#startPromise?: Promise<void>;
	#startReject?: (error: unknown) => void;
	#startResolve?: () => void;
	#pendingCapabilities = new Map<string, PendingCapabilities>();
	#pending = new Map<string, PendingRun>();
	#revocations = new Map<string, () => void>();
	/**
	 * Snapshots of runs waiting for the worker to start: a resume the worker gets before their `run` would find
	 * nothing to hold, so it moves them to the turn that went on here.
	 */
	readonly #startingRuns = new Set<ComputerSessionSnapshot>();
	#nextId = 0;
	#controlEpoch = 0;
	readonly #escapeStops: ComputerEscapeStops;
	/** Key the worker's native sessions count the user's Escape stops under. */
	readonly #escapeKey = `computer-${Snowflake.next()}`;
	/** Stops the user's latest message acknowledged; any more refuse every call. */
	#acknowledgedEscapeStops = 0;
	/** A worker was started, so its sessions may have counted stops under the key. */
	#started = false;
	#closed = false;
	#unsubscribeMessage?: () => void;
	#unsubscribeError?: () => void;

	constructor(
		session: ToolSession,
		createWorker: ComputerWorkerFactory = spawnComputerWorker,
		timeouts: ComputerSupervisorTimeouts = DEFAULT_TIMEOUTS,
		callSessionTool: ComputerSessionToolCaller = async () => {
			throw new ToolError("Computer session tool bridge is unavailable");
		},
		escapeStops: ComputerEscapeStops = NATIVE_ESCAPE_STOPS,
	) {
		this.#session = session;
		this.#createWorker = createWorker;
		this.#timeouts = timeouts;
		this.#callSessionTool = callSessionTool;
		this.#escapeStops = escapeStops;
	}

	/** Whether the user pressed Escape since their latest message; read live, so a stop no run reported still counts. */
	#escapeStopped(): boolean {
		return this.#started && this.#escapeStops.read(this.#escapeKey) > this.#acknowledgedEscapeStops;
	}

	#escapeScope(): ComputerEscapeScope {
		return { key: this.#escapeKey, acknowledged: this.#acknowledgedEscapeStops };
	}

	async capabilities(
		snapshot: ComputerSessionSnapshot,
		signal?: AbortSignal,
	): Promise<DesktopCapabilities | undefined> {
		if (this.#closed) throw new ToolError("Computer session is closed");
		if (this.#escapeStopped()) throw new ToolError(ESCAPE_REFUSED_MESSAGE);
		if (signal?.aborted) throw new ToolAbortError();
		await this.#start();
		if (signal?.aborted) throw new ToolAbortError();

		const id = `computer-cap-${++this.#nextId}`;
		const { promise, resolve, reject } = Promise.withResolvers<DesktopCapabilities | undefined>();
		this.#pendingCapabilities.set(id, { resolve, reject });
		const abort = (): void => reject(signal?.reason instanceof Error ? signal.reason : new ToolAbortError());
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		try {
			this.#safeSend({ type: "capabilities", id, session: snapshot, escape: this.#escapeScope() });
			const capabilities = await withTimeout(
				promise,
				CAPABILITIES_TIMEOUT_MS,
				"Timed out fetching computer capabilities",
			);
			// The worker checks for the user's Escape only during runs, so a stop while this was in flight is read here.
			if (this.#escapeStopped()) throw new ToolError(ESCAPE_REFUSED_MESSAGE);
			return capabilities;
		} finally {
			signal?.removeEventListener("abort", abort);
			this.#pendingCapabilities.delete(id);
		}
	}

	async run(
		code: string,
		timeoutMs: number,
		snapshot: ComputerSessionSnapshot,
		signal?: AbortSignal,
		context?: AgentToolContext,
	): Promise<ComputerRunOk> {
		if (this.#closed) throw new ToolError("Computer session is closed");
		if (this.#escapeStopped()) throw new ToolError(ESCAPE_REFUSED_MESSAGE);
		if (signal?.aborted) throw new ToolAbortError();
		const epoch = this.#controlEpoch;
		const session = { ...snapshot };
		this.#startingRuns.add(session);
		try {
			await this.#start();
		} finally {
			this.#startingRuns.delete(session);
		}
		if (signal?.aborted || epoch !== this.#controlEpoch) throw new ToolAbortError();

		const id = `computer-${++this.#nextId}`;
		const { promise, resolve, reject } = Promise.withResolvers<ComputerRunOk>();
		const pending: PendingRun = { resolve, reject, signal, context, toolCalls: new Map() };
		this.#pending.set(id, pending);
		const abort = (): void => {
			this.#safeSend({ type: "abort", id });
			for (const controller of pending.toolCalls.values()) controller.abort(signal?.reason);
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });

		try {
			this.#worker?.send({ type: "run", id, code, timeoutMs, session, escape: this.#escapeScope() });
			let result: ComputerRunOk;
			try {
				result = await this.#raceWithGrace(promise, timeoutMs);
			} catch (error) {
				// The worker's own stop report already carries what the stopped operation said.
				const reported =
					error instanceof Error &&
					(error.message.includes(ESCAPE_STOPPED_MESSAGE) || error.message.includes(ESCAPE_AFTER_CALL_MESSAGE));
				if (reported || !this.#escapeStopped()) throw error;
				// What the worker said went wrong (input that landed in part, a timeout) stays first; its abort adds nothing.
				const own = error instanceof Error && !(error instanceof ToolAbortError) ? error.message : undefined;
				throw new ToolError(own ? `${own}\n\n${ESCAPE_STOPPED_MESSAGE}` : ESCAPE_STOPPED_MESSAGE);
			}
			// The stop landed after the script finished, its input out: keep what it did, led by the user's stop.
			if (this.#escapeStopped()) {
				return { ...result, displays: [{ type: "text", text: ESCAPE_AFTER_CALL_MESSAGE }, ...result.displays] };
			}
			return result;
		} finally {
			signal?.removeEventListener("abort", abort);
			this.#pending.delete(id);
		}
	}

	#start(): Promise<void> {
		if (this.#startPromise) return this.#startPromise;
		const started = Promise.withResolvers<void>();
		this.#started = true;
		this.#startReject = started.reject;
		this.#startResolve = started.resolve;
		try {
			logger.debug("Starting computer worker");
			const worker = this.#createWorker();
			this.#worker = worker;
			this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
			this.#unsubscribeError = worker.onError(error => {
				void this.#workerFailed(error);
			});
		} catch (error) {
			started.reject(error);
		}
		this.#startPromise = withTimeout(
			started.promise,
			this.#timeouts.startMs,
			"Timed out starting computer worker",
		).catch(async error => {
			await this.#terminate(error);
			throw error;
		});
		return this.#startPromise;
	}

	#handleMessage(message: ComputerWorkerOutbound): void {
		if (message.type === "ready") {
			this.#startResolve?.();
			this.#startResolve = undefined;
			this.#startReject = undefined;
			return;
		}
		if (message.type === "control-revoked") {
			this.#revocations.get(message.id)?.();
			this.#revocations.delete(message.id);
			return;
		}
		if (message.type === "result") {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			for (const controller of pending.toolCalls.values())
				controller.abort(new ToolAbortError("Computer run ended"));
			this.#pending.delete(message.id);
			if (message.ok) pending.resolve(message.payload);
			else pending.reject(errorFromPayload(message.error));
			return;
		}
		if (message.type === "capabilities") {
			const pending = this.#pendingCapabilities.get(message.id);
			if (!pending) return;
			this.#pendingCapabilities.delete(message.id);
			if (message.ok) pending.resolve(message.capabilities);
			else pending.reject(errorFromPayload(message.error));
			return;
		}
		if (message.type === "control-request") {
			void this.#confirmControl(message);
			return;
		}
		if (message.type === "tool-call") {
			void this.#dispatchToolCall(message);
		}
	}

	async #confirmControl(message: Extract<ComputerWorkerOutbound, { type: "control-request" }>): Promise<void> {
		const pending = this.#pending.get(message.runId);
		if (!pending) return;
		const controller = new AbortController();
		pending.toolCalls.set(message.id, controller);
		const onAbort = (): void => controller.abort(pending.signal?.reason);
		if (pending.signal?.aborted) onAbort();
		else pending.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const context = pending.context ?? this.#session.getToolContext?.();
			const policy = controlPolicy(context ?? { settings: this.#session.settings });
			let verdict: ControlVerdict;
			if (policy === "allow") {
				verdict = "approved";
			} else if (policy === "deny") {
				verdict = "denied";
			} else if (!context?.ui || context.hasUI === false) {
				verdict = "no-ui";
			} else if (message.timeoutMs <= 0) {
				// The run has no time left to wait in; a prompt would close before anyone could answer it.
				verdict = "unanswered";
			} else {
				// The prompt closes before the run's deadline, so the script hears that nobody answered. The deadline
				// aborts the dialog rather than riding its `timeout` option: a timed-out TUI confirm picks its
				// highlighted option, which is Yes.
				const deadline = AbortSignal.timeout(message.timeoutMs);
				const signal = AbortSignal.any([controller.signal, deadline]);
				let approved = false;
				try {
					approved =
						!signal.aborted &&
						(await untilAborted(signal, () =>
							context.ui!.confirm(
								"Allow foreground computer control?",
								`${message.reason}\n\nFor this task only. Use the host interrupt to stop and revoke control. This does not authorize external side effects.`,
								{ signal },
							),
						)) === true;
				} catch (error) {
					if (!deadline.aborted || controller.signal.aborted) throw error;
				}
				verdict = approved ? "approved" : deadline.aborted ? "unanswered" : "denied";
			}
			if (controller.signal.aborted || this.#pending.get(message.runId) !== pending) verdict = "denied";
			this.#safeSend({ type: "tool-reply", id: message.id, reply: { ok: true, value: verdict } });
		} catch (error) {
			this.#safeSend({
				type: "tool-reply",
				id: message.id,
				reply: { ok: false, error: toWorkerErrorPayload(error) },
			});
		} finally {
			pending.toolCalls.delete(message.id);
			pending.signal?.removeEventListener("abort", onAbort);
		}
	}

	async revokeControl(): Promise<void> {
		this.#controlEpoch += 1;
		for (const pending of this.#pending.values()) {
			for (const controller of pending.toolCalls.values()) controller.abort(new ToolAbortError());
		}
		if (!this.#worker) return;
		const id = `computer-revoke-${++this.#nextId}`;
		const acknowledged = Promise.withResolvers<void>();
		this.#revocations.set(id, acknowledged.resolve);
		this.#safeSend({ type: "revoke-control", id });
		try {
			await withTimeout(acknowledged.promise, CLOSE_TIMEOUT_MS, "Timed out revoking computer control");
		} catch (error) {
			await this.#terminate(error);
		} finally {
			this.#revocations.delete(id);
		}
	}

	releaseDisplay(turn: number): void {
		this.#safeSend({ type: "release-display", turn });
	}

	resumeDisplay(from: number, turn: number): void {
		for (const starting of this.#startingRuns) if (starting.displayTurn === from) starting.displayTurn = turn;
		this.#safeSend({ type: "resume-display", from, turn });
	}

	resumeAfterEscape(): void {
		if (!this.#started) return;
		try {
			this.#acknowledgedEscapeStops = this.#escapeStops.read(this.#escapeKey);
		} catch {
			// An addon that cannot report the count (stale or missing) keeps the acknowledgement it had;
			// the user's message must still reach the session, and the next call surfaces the addon error.
		}
	}

	async #dispatchToolCall(message: Extract<ComputerWorkerOutbound, { type: "tool-call" }>): Promise<void> {
		const pending = this.#pending.get(message.runId);
		if (!pending) {
			this.#safeSend({
				type: "tool-reply",
				id: message.id,
				reply: {
					ok: false,
					error: { name: "ToolError", message: "No active run for tool call", isToolError: true, isAbort: false },
				},
			});
			return;
		}
		const controller = new AbortController();
		pending.toolCalls.set(message.id, controller);
		const onParentAbort = (): void => controller.abort(pending.signal?.reason);
		if (pending.signal?.aborted) onParentAbort();
		else pending.signal?.addEventListener("abort", onParentAbort, { once: true });
		try {
			const value = await this.#callSessionTool(message.name, message.args, {
				session: this.#session,
				signal: controller.signal,
				emitStatus: () => {},
			});
			this.#safeSend({ type: "tool-reply", id: message.id, reply: { ok: true, value } });
		} catch (error) {
			this.#safeSend({
				type: "tool-reply",
				id: message.id,
				reply: { ok: false, error: toWorkerErrorPayload(error) },
			});
		} finally {
			pending.toolCalls.delete(message.id);
			pending.signal?.removeEventListener("abort", onParentAbort);
		}
	}

	#safeSend(message: ComputerWorkerInbound): void {
		try {
			this.#worker?.send(message);
		} catch (error) {
			logger.debug("Computer worker send failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #raceWithGrace(promise: Promise<ComputerRunOk>, timeoutMs: number): Promise<ComputerRunOk> {
		const timeoutSignal = AbortSignal.timeout(timeoutMs + GRACE_MS);
		const timeout = Promise.withResolvers<never>();
		const onTimeout = (): void => timeout.reject(new ToolError(RESTART_MESSAGE));
		timeoutSignal.addEventListener("abort", onTimeout, { once: true });
		try {
			return await Promise.race([promise, timeout.promise]);
		} catch (error) {
			if (error instanceof ToolError && error.message === RESTART_MESSAGE) await this.#terminate(error);
			throw error;
		} finally {
			timeoutSignal.removeEventListener("abort", onTimeout);
		}
	}

	async #workerFailed(error: Error): Promise<void> {
		logger.warn("Computer worker failed", { error: error.message });
		await this.#terminate(error);
	}

	async #terminate(reason: unknown): Promise<void> {
		const worker = this.#worker;
		this.#worker = undefined;
		this.#startPromise = undefined;
		this.#startReject?.(reason);
		this.#startReject = undefined;
		this.#startResolve = undefined;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = undefined;
		this.#unsubscribeError?.();
		this.#unsubscribeError = undefined;
		for (const pending of this.#pending.values()) {
			for (const controller of pending.toolCalls.values()) controller.abort(reason);
			pending.reject(reason);
		}
		this.#pending.clear();
		for (const pending of this.#pendingCapabilities.values()) pending.reject(reason);
		this.#pendingCapabilities.clear();
		for (const resolve of this.#revocations.values()) resolve();
		this.#revocations.clear();
		await worker?.terminate().catch(() => undefined);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#started) {
			try {
				this.#escapeStops.forget(this.#escapeKey);
			} catch {
				// An addon without the Escape exports kept no count to drop; the worker must still close.
			}
		}
		const worker = this.#worker;
		if (!worker) return;
		const closed = Promise.withResolvers<void>();
		const unsubscribe = worker.onMessage(message => {
			if (message.type === "closed") closed.resolve();
		});
		try {
			worker.send({ type: "close" });
			await withTimeout(closed.promise, this.#timeouts.closeMs, "Timed out closing computer worker");
		} catch {
			// Forced termination below is the bounded close fallback.
		} finally {
			unsubscribe();
			await this.#terminate(new ToolError("Computer session closed"));
		}
	}
}

const ownedSupervisors = new Map<string, Set<ComputerController>>();
/** Per owner with agent turns: the turn in flight, or between turns the one that ended last, counted from 1. */
const ownerTurns = new Map<string, { turn: number; inFlight: boolean }>();

/** Registers a controller for owner-scoped session cleanup. */
export function registerComputerController(ownerId: string | undefined, controller: ComputerController): () => void {
	if (!ownerId) return () => {};
	const controllers = ownedSupervisors.get(ownerId) ?? new Set<ComputerController>();
	controllers.add(controller);
	ownedSupervisors.set(ownerId, controllers);
	return () => {
		controllers.delete(controller);
		if (controllers.size === 0) ownedSupervisors.delete(ownerId);
	};
}

/** Revoke task-scoped foreground ownership without resetting frames or the worker. */
export async function revokeComputerControlForOwner(ownerId: string | undefined): Promise<void> {
	if (!ownerId) return;
	await Promise.allSettled(
		Array.from(ownedSupervisors.get(ownerId) ?? [], controller => controller.revokeControl?.()),
	);
}

/**
 * An agent session's turn began, or went on after the user answered a dialog: computer runs keep the display awake
 * until {@link endComputerTurnForOwner}.
 */
export function beginComputerTurnForOwner(ownerId: string | undefined): void {
	if (!ownerId) return;
	const state = ownerTurns.get(ownerId);
	ownerTurns.set(ownerId, { turn: (state?.turn ?? 0) + 1, inFlight: true });
}

/**
 * The turn ended or stopped to wait for the user's answer: let the display sleep now instead of a grace period later.
 * Nothing else ends with the turn; its next computer request after the answer, or the next turn's first, holds the
 * display again.
 */
export function endComputerTurnForOwner(ownerId: string | undefined): void {
	const state = ownerId ? ownerTurns.get(ownerId) : undefined;
	if (!ownerId || !state?.inFlight) return;
	state.inFlight = false;
	for (const controller of ownedSupervisors.get(ownerId) ?? []) controller.releaseDisplay?.(state.turn);
}

/**
 * The turn went on after the dialog that ended it settled: later runs hold the display until the turn ends, and so
 * does a run of the turn that is still active, such as one whose control confirmation the dialog was.
 */
export function resumeComputerTurnForOwner(ownerId: string | undefined): void {
	const state = ownerId ? ownerTurns.get(ownerId) : undefined;
	if (!ownerId || !state || state.inFlight) return;
	const from = state.turn;
	state.turn = from + 1;
	state.inFlight = true;
	for (const controller of ownedSupervisors.get(ownerId) ?? []) controller.resumeDisplay?.(from, state.turn);
}

/**
 * The owner's agent turn in flight, if any. Without one (between turns, while a dialog waits for the user, in a
 * subagent, or SDK and eval use with no agent session), a computer run keeps the native grace period.
 */
export function computerTurnInFlight(ownerId: string | undefined): number | undefined {
	const state = ownerId ? ownerTurns.get(ownerId) : undefined;
	return state?.inFlight ? state.turn : undefined;
}

/** The user's next message lifts the refusal their Escape set on an agent session's computer use. */
export function resumeComputerUseForOwner(ownerId: string | undefined): void {
	if (!ownerId) return;
	for (const controller of ownedSupervisors.get(ownerId) ?? []) controller.resumeAfterEscape?.();
}

/** Closes every computer session owned by an agent session. */
export async function releaseComputerSessionsForOwner(ownerId: string | undefined): Promise<void> {
	if (!ownerId) return;
	ownerTurns.delete(ownerId);
	const controllers = ownedSupervisors.get(ownerId);
	if (!controllers) return;
	ownedSupervisors.delete(ownerId);
	await Promise.allSettled(Array.from(controllers, controller => controller.close()));
}

/** Verifies computer worker startup, messaging, and bounded shutdown. */
export async function smokeTestComputerWorker(
	timeoutMs = SMOKE_TIMEOUT_MS,
	createWorker: ComputerWorkerFactory = spawnComputerWorker,
): Promise<void> {
	const worker = createWorker();
	const waitFor = async (expected: ComputerWorkerOutbound["type"], failureMessage: string): Promise<void> => {
		const response = Promise.withResolvers<void>();
		const unsubscribeMessage = worker.onMessage(received => {
			if (received.type === expected) response.resolve();
			else if (received.type === "result" && !received.ok) response.reject(errorFromPayload(received.error));
		});
		const unsubscribeError = worker.onError(error => response.reject(error));
		try {
			await withTimeout(response.promise, timeoutMs, failureMessage);
		} finally {
			unsubscribeMessage();
			unsubscribeError();
		}
	};

	try {
		const pong = waitFor("pong", "Computer worker smoke ping timed out");
		worker.send({ type: "ping", id: `computer-smoke-${Snowflake.next()}` });
		await pong;
		const closed = waitFor("closed", "Computer worker smoke close timed out");
		worker.send({ type: "close" });
		await closed;
	} finally {
		await worker.terminate();
	}
}
