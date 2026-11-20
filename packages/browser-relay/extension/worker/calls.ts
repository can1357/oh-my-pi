/**
 * Extension → relay calls (`call` / `callResult`): numbered requests the side panel makes of the relay over one link
 * epoch, answered within the same epoch.
 */
import type { ExtToRelayMessage, PanelCall, RelayToExtMessage } from "../../../coding-agent/src/tools/browser/relay/protocol";

/** How long the relay may take to answer a call before it fails. */
export const RELAY_CALL_TIMEOUT_MS = 15_000;

interface PendingCall {
	resolve(result: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

/** Pending relay calls of one link epoch, settled by its `callResult`s and failed when it ends. */
export class RelayCalls {
	readonly #pending = new Map<number, PendingCall>();
	readonly #timeoutMs: number;
	#nextId = 1;

	constructor(timeoutMs = RELAY_CALL_TIMEOUT_MS) {
		this.#timeoutMs = timeoutMs;
	}

	/** Send `call` through `send`, which reports whether the link took it; resolves with the relay's result. */
	start(call: PanelCall, send: (message: ExtToRelayMessage) => boolean): Promise<unknown> {
		const id = this.#nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		if (!send({ t: "call", id, call })) {
			reject(new Error("omp relay is not connected"));
			return promise;
		}
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`omp relay did not answer ${call.op} within ${this.#timeoutMs / 1000}s`));
		}, this.#timeoutMs);
		this.#pending.set(id, { resolve, reject, timer });
		return promise;
	}

	/** Settle the call a relay `callResult` answers; results for unknown ids (timed out, other epoch) are dropped. */
	settle(message: Extract<RelayToExtMessage, { t: "callResult" }>): void {
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.ok) pending.resolve(message.result);
		else pending.reject(new Error(message.error ?? "omp relay call failed"));
	}

	/** Fail every pending call: the epoch they went out on ended, so no answer can come. */
	failAll(reason: string): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.#pending.clear();
	}
}
