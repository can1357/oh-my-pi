/**
 * The worker's side of every open side panel: one `chrome.runtime` port per panel ({@link PANEL_PORT}), request
 * routing to the handlers feature modules register, and event broadcast.
 */
import {
	PANEL_PORT,
	type PanelEvent,
	type PanelHandler,
	type PanelRequest,
	type PanelRequestOp,
	type PanelToWorker,
	type WorkerToPanel,
} from "../messages";

/** Narrows a panel request to the one op a handler serves. */
function isOp<Op extends PanelRequestOp>(request: PanelRequest, op: Op): request is Extract<PanelRequest, { op: Op }> {
	return request.op === op;
}

/** Connected side panels and the request handlers that serve them. */
export class PanelHub {
	/** Each connected panel's window; null until its `hello`. */
	readonly #ports = new Map<chrome.runtime.Port, number | null>();
	readonly #handlers = new Map<PanelRequestOp, (request: PanelRequest) => Promise<unknown>>();
	readonly #onHello: (port: chrome.runtime.Port, windowId: number) => void;

	/** `onHello` runs once per panel after it named its window, e.g. to send it the current state. */
	constructor(onHello: (port: chrome.runtime.Port, windowId: number) => void) {
		this.#onHello = onHello;
	}

	/** Serve a panel request op; one handler per op. */
	handle<Op extends PanelRequestOp>(op: Op, handler: PanelHandler<Op>): void {
		if (this.#handlers.has(op)) throw new Error(`panel request ${op} already has a handler`);
		this.#handlers.set(op, request =>
			isOp(request, op) ? handler(request) : Promise.reject(new Error(`misrouted panel request ${request.op}`)),
		);
	}

	/** Broadcast to every connected panel. */
	emit(event: PanelEvent): void {
		for (const port of this.#ports.keys()) send(port, { kind: "event", event });
	}

	/** Send one event to one panel. */
	emitTo(port: chrome.runtime.Port, event: PanelEvent): void {
		send(port, { kind: "event", event });
	}

	/** Whether any panel is connected. */
	get connected(): boolean {
		return this.#ports.size > 0;
	}

	/** Whether a panel is open in `windowId`. */
	hasPanel(windowId: number): boolean {
		for (const panelWindow of this.#ports.values()) if (panelWindow === windowId) return true;
		return false;
	}

	/** Accept `port` when it is a panel's. */
	accept(port: chrome.runtime.Port): void {
		if (port.name !== PANEL_PORT) return;
		this.#ports.set(port, null);
		port.onMessage.addListener((frame: PanelToWorker) => {
			if (frame.kind === "hello") {
				this.#ports.set(port, frame.windowId);
				this.#onHello(port, frame.windowId);
				return;
			}
			void this.#serve(port, frame.id, frame.request);
		});
		port.onDisconnect.addListener(() => {
			this.#ports.delete(port);
		});
	}

	async #serve(port: chrome.runtime.Port, id: number, request: PanelRequest): Promise<void> {
		const handler = this.#handlers.get(request.op);
		try {
			if (!handler) throw new Error(`no handler for panel request ${request.op}`);
			const result = await handler(request);
			send(port, { kind: "response", id, ok: true, result });
		} catch (error) {
			send(port, { kind: "response", id, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}
}

/** Post to a panel that may have closed meanwhile. */
function send(port: chrome.runtime.Port, frame: WorkerToPanel): void {
	try {
		port.postMessage(frame);
	} catch {
		// The panel closed; its onDisconnect removes it.
	}
}
