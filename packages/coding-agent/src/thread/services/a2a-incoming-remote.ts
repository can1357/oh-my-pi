import type { IncomingRequestMatch, IncomingRequestsApi } from "../../a2a/incoming-requests";
import type { A2aIncomingRequest } from "../../a2a/rpc";
import type { RemoteObject } from "../rpc";
import type { IncomingRequestsProtocol } from "./a2a-incoming-protocol";

export class RemoteIncomingRequests implements IncomingRequestsApi {
	readonly #remote: RemoteObject<IncomingRequestsProtocol>;

	constructor(remote: RemoteObject<IncomingRequestsProtocol>) {
		this.#remote = remote;
	}

	note(request: A2aIncomingRequest): Promise<void> {
		return this.#remote.call("note", request);
	}

	consume(match: IncomingRequestMatch): Promise<A2aIncomingRequest | undefined> {
		return this.#remote.call("consume", match);
	}

	list(to?: string): Promise<A2aIncomingRequest[]> {
		return this.#remote.call("list", to);
	}
}
