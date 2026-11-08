/**
 * Worker-side proxy of the main-owned outgoing A2A registry, installed with
 * `installGlobal` at worker boot (see `./a2a-outgoing`).
 *
 * Async methods use `call`. `hasOwner` is synchronous on main, so it is a
 * `callSync` round trip and lifecycle checks can use it without a turn.
 */
import { type OutgoingRequest, type OutgoingRequestsApi } from "../../a2a/outgoing-requests";
import type { RemoteObject } from "../rpc";
import type { OutgoingRequestsProtocol } from "./a2a-outgoing-protocol";

/** Worker proxy of main's {@link OutgoingRequestsApi}. */
export class RemoteOutgoingRequests implements OutgoingRequestsApi {
	readonly #remote: RemoteObject<OutgoingRequestsProtocol>;

	constructor(remote: RemoteObject<OutgoingRequestsProtocol>) {
		this.#remote = remote;
	}

	register(request: OutgoingRequest): Promise<void> {
		return this.#remote.call("register", request);
	}

	wait(messageId: string, signal?: AbortSignal): Promise<string> {
		return this.#remote.call("wait", messageId, signal);
	}

	resolve(messageId: string, from: string, text: string): Promise<boolean> {
		return this.#remote.call("resolve", messageId, from, text);
	}

	fail(messageId: string, reason: string): Promise<boolean> {
		return this.#remote.call("fail", messageId, reason);
	}

	cancel(messageId: string): Promise<boolean> {
		return this.#remote.call("cancel", messageId);
	}

	hasOwner(ownerId: string): boolean {
		return this.#remote.callSync("hasOwner", ownerId);
	}
}
