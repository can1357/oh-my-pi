/**
 * Remote-object protocol of the main-owned outgoing A2A registry, as spoken by
 * a worker's proxy (see `./a2a-outgoing`).
 */
import type { OutgoingRequest } from "../../a2a/outgoing-requests";
import type { RpcMethod } from "../rpc";

/** Remote-object kind of the main {@link OutgoingRequests}. */
export const A2A_OUTGOING_KIND = "a2a-outgoing-requests";

/** `OutgoingRequestsApi` over the link. `wait`'s signal cancels only that call. */
export type OutgoingRequestsProtocol = {
	register: RpcMethod<[request: OutgoingRequest], void>;
	wait: RpcMethod<[messageId: string, signal?: AbortSignal], string>;
	resolve: RpcMethod<[messageId: string, from: string, text: string], boolean>;
	fail: RpcMethod<[messageId: string, reason: string], boolean>;
	cancel: RpcMethod<[messageId: string], boolean>;
	hasOwner: RpcMethod<[ownerId: string], boolean>;
};
