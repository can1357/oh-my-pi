import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import { withTimeout } from "@oh-my-pi/pi-utils/async";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import type { ToolSession } from "../index";
import { ToolAbortError, ToolError } from "../tool-errors";
import {
	COMPUTER_WORKER_ARG,
	type ComputerRunOk,
	type ComputerSessionSnapshot,
	type ComputerWorkerInbound,
	type ComputerWorkerOutbound,
	type RunErrorPayload,
} from "./protocol";

const START_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 1_500;
const GRACE_MS = 750;
const SMOKE_TIMEOUT_MS = 5_000;
const RESTART_MESSAGE = "computer worker restarted; captures and ax refs were reset";

/** Runs desktop scripts and owns their persistent worker session. */
export interface ComputerController {
	run(
		code: string,
		timeoutMs: number,
		snapshot: ComputerSessionSnapshot,
		signal?: AbortSignal,
	): Promise<ComputerRunOk>;
	capabilities(): Promise<DesktopCapabilities | undefined>;
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

/** Creates an isolated computer worker handle. */
export type ComputerWorkerFactory = () => ComputerWorkerHandle;

interface PendingRun {
	resolve(value: ComputerRunOk): void;
	reject(error: unknown): void;
	signal?: AbortSignal;
	toolCalls: Map<string, AbortController>;
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

/** Spawns the computer worker through the active CLI host when available. */
export function spawnComputerWorker(): ComputerWorkerHandle {
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

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { name: "Error", message: String(error), isAbort: false, isToolError: false };
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
	#latestCapabilities?: DesktopCapabilities;
	#pending = new Map<string, PendingRun>();
	#nextId = 0;
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
	) {
		this.#session = session;
		this.#createWorker = createWorker;
		this.#timeouts = timeouts;
		this.#callSessionTool = callSessionTool;
	}

	async capabilities(): Promise<DesktopCapabilities | undefined> {
		return this.#latestCapabilities;
	}

	async run(
		code: string,
		timeoutMs: number,
		snapshot: ComputerSessionSnapshot,
		signal?: AbortSignal,
	): Promise<ComputerRunOk> {
		if (this.#closed) throw new ToolError("Computer session is closed");
		if (signal?.aborted) throw new ToolAbortError();
		await this.#start();
		if (signal?.aborted) throw new ToolAbortError();

		const id = `computer-${++this.#nextId}`;
		const { promise, resolve, reject } = Promise.withResolvers<ComputerRunOk>();
		const pending: PendingRun = { resolve, reject, signal, toolCalls: new Map() };
		this.#pending.set(id, pending);
		const abort = (): void => {
			this.#safeSend({ type: "abort", id });
			for (const controller of pending.toolCalls.values()) controller.abort(signal?.reason);
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });

		try {
			this.#worker?.send({ type: "run", id, code, timeoutMs, session: snapshot });
			return await this.#raceWithGrace(promise, timeoutMs);
		} finally {
			signal?.removeEventListener("abort", abort);
			this.#pending.delete(id);
		}
	}

	#start(): Promise<void> {
		if (this.#startPromise) return this.#startPromise;
		const started = Promise.withResolvers<void>();
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
		if (message.type === "result") {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			if (message.ok) {
				this.#latestCapabilities = message.payload.capabilities;
				pending.resolve(message.payload);
			} else {
				pending.reject(errorFromPayload(message.error));
			}
			return;
		}
		if (message.type === "tool-call") {
			void this.#dispatchToolCall(message);
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
			this.#safeSend({ type: "tool-reply", id: message.id, reply: { ok: false, error: toErrorPayload(error) } });
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
		await worker?.terminate().catch(() => undefined);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
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

/** Closes every computer session owned by an agent session. */
export async function releaseComputerSessionsForOwner(ownerId: string | undefined): Promise<void> {
	if (!ownerId) return;
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
