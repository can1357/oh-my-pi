/**
 * The panel's side of the {@link PANEL_PORT} port: request/response with ids and timeouts, worker events, and a
 * redial whenever the service worker restarts (MV3 workers are torn down when idle and on extension reload).
 */
import {
	PANEL_PORT,
	type PanelEvent,
	type PanelRequest,
	type PanelRequestMap,
	type PanelRequestOp,
	type PanelResult,
	type PanelToWorker,
	type WorkerToPanel,
} from "../messages";
import type { PanelWorker } from "./session";

/** Requests that wait on the user (pickers) or a process start get no deadline or a long one. */
const TIMEOUT_MS: Partial<Record<PanelRequestOp, number>> = {
	capture: 0,
	rpcOpen: 60_000,
	runShortcut: 60_000,
	exportGif: 180_000,
	teachStop: 60_000,
};
const DEFAULT_TIMEOUT_MS = 20_000;
const REDIAL_MIN_MS = 250;
const REDIAL_MAX_MS = 5_000;

interface Pending {
	resolve(result: unknown): void;
	reject(error: Error): void;
	timer: number | undefined;
}

/** Raised when a request could not be answered: timeout, worker restart, or a worker-side failure. */
export class WorkerRequestError extends Error {
	constructor(
		readonly op: PanelRequestOp,
		message: string,
	) {
		super(message);
		this.name = "WorkerRequestError";
	}
}

/** {@link PanelWorker} over a `chrome.runtime` port that reconnects for as long as the panel lives. */
export class WorkerClient implements PanelWorker {
	readonly #windowId: number;
	readonly #pending = new Map<number, Pending>();
	readonly #eventListeners = new Set<(event: PanelEvent) => void>();
	readonly #connectionListeners = new Set<(connected: boolean) => void>();
	#port: chrome.runtime.Port | null = null;
	#seq = 0;
	#redialDelay = REDIAL_MIN_MS;
	#redialTimer: number | undefined;
	#closed = false;

	constructor(windowId: number) {
		this.#windowId = windowId;
		this.#dial();
	}

	/** True while a port to the worker is open. */
	get connected(): boolean {
		return this.#port !== null;
	}

	request<Op extends PanelRequestOp>(op: Op, fields: PanelRequestMap[Op][0]): Promise<PanelResult<Op>> {
		if (this.#port === null && !this.#closed) this.#dial();
		const port = this.#port;
		if (port === null) return Promise.reject(new WorkerRequestError(op, "The omp extension worker is not running"));
		const id = ++this.#seq;
		const timeout = TIMEOUT_MS[op] ?? DEFAULT_TIMEOUT_MS;
		const promise = new Promise<unknown>((resolve, reject) => {
			const timer =
				timeout > 0
					? window.setTimeout(() => {
							this.#pending.delete(id);
							reject(new WorkerRequestError(op, `${op} timed out after ${Math.round(timeout / 1000)}s`));
						}, timeout)
					: undefined;
			this.#pending.set(id, { resolve, reject, timer });
		});
		// `{ op } & fields` is exactly the `PanelRequest` member for `Op`; TypeScript cannot correlate the two generically.
		const request = { op, ...fields } as PanelRequest;
		const frame: PanelToWorker = { kind: "request", id, request };
		try {
			port.postMessage(frame);
		} catch (error) {
			this.#settle(id)?.reject(new WorkerRequestError(op, error instanceof Error ? error.message : String(error)));
		}
		// The worker answers `Op` with `PanelResult<Op>`; the port carries it as JSON.
		return promise as Promise<PanelResult<Op>>;
	}

	onEvent(listener: (event: PanelEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => {
			this.#eventListeners.delete(listener);
		};
	}

	/** Port up/down transitions; a `true` after a `false` means the worker restarted and lost per-port state. */
	onConnection(listener: (connected: boolean) => void): () => void {
		this.#connectionListeners.add(listener);
		return () => {
			this.#connectionListeners.delete(listener);
		};
	}

	/** Stop redialing and drop the port (panel unload). */
	close(): void {
		this.#closed = true;
		window.clearTimeout(this.#redialTimer);
		this.#port?.disconnect();
		this.#drop("The panel closed");
	}

	#dial(): void {
		window.clearTimeout(this.#redialTimer);
		this.#redialTimer = undefined;
		let port: chrome.runtime.Port;
		try {
			port = chrome.runtime.connect({ name: PANEL_PORT });
		} catch {
			// Extension context invalidated (the extension was reloaded under this page): nothing to dial anymore.
			this.#closed = true;
			return;
		}
		this.#port = port;
		port.onMessage.addListener((frame: WorkerToPanel) => {
			this.#redialDelay = REDIAL_MIN_MS;
			this.#receive(frame);
		});
		port.onDisconnect.addListener(() => {
			// Reading lastError marks a refused connection as handled.
			void chrome.runtime.lastError;
			if (this.#port !== port) return;
			this.#drop("The omp extension worker restarted");
			if (this.#closed) return;
			this.#redialTimer = window.setTimeout(() => this.#dial(), this.#redialDelay);
			this.#redialDelay = Math.min(this.#redialDelay * 2, REDIAL_MAX_MS);
		});
		const hello: PanelToWorker = { kind: "hello", windowId: this.#windowId };
		port.postMessage(hello);
		for (const listener of this.#connectionListeners) listener(true);
	}

	#receive(frame: WorkerToPanel): void {
		if (frame.kind === "event") {
			for (const listener of this.#eventListeners) listener(frame.event);
			return;
		}
		const pending = this.#settle(frame.id);
		if (pending === undefined) return;
		if (frame.ok) pending.resolve(frame.result);
		else pending.reject(new Error(frame.error));
	}

	#settle(id: number): Pending | undefined {
		const pending = this.#pending.get(id);
		if (pending === undefined) return undefined;
		this.#pending.delete(id);
		window.clearTimeout(pending.timer);
		return pending;
	}

	#drop(reason: string): void {
		if (this.#port === null) return;
		this.#port = null;
		for (const id of [...this.#pending.keys()]) this.#settle(id)?.reject(new Error(reason));
		for (const listener of this.#connectionListeners) listener(false);
	}
}
