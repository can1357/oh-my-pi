import type { IncomingRequestLease, IncomingRequestMatch, IncomingRequestsApi } from "../../a2a/incoming-requests";
import type { A2aIncomingRequest } from "../../a2a/rpc";
import type { RemoteObject } from "../rpc";
import type { IncomingRequestsProtocol } from "./a2a-incoming-protocol";

/** Worker proxy of main's {@link IncomingRequestsApi}. */
export class RemoteIncomingRequests implements IncomingRequestsApi {
	readonly #remote: RemoteObject<IncomingRequestsProtocol>;

	constructor(remote: RemoteObject<IncomingRequestsProtocol>) {
		this.#remote = remote;
	}

	note(request: A2aIncomingRequest): Promise<void> {
		return this.#remote.call("note", request);
	}

	consume(match: IncomingRequestMatch): Promise<IncomingRequestLease | undefined> {
		return this.#remote.call("consume", match);
	}

	confirm(leaseId: string): Promise<boolean> {
		return this.#remote.call("confirm", leaseId);
	}

	release(leaseId: string): Promise<boolean> {
		return this.#remote.call("release", leaseId);
	}

	discard(match: IncomingRequestMatch): Promise<void> {
		return this.#remote.call("discard", match);
	}

	list(to?: string): Promise<A2aIncomingRequest[]> {
		return this.#remote.call("list", to);
	}
}
