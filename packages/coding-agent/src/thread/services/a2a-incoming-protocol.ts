import type { IncomingRequestLease, IncomingRequestMatch } from "../../a2a/incoming-requests";
import type { A2aIncomingRequest } from "../../a2a/rpc";
import type { RpcMethod } from "../rpc";

export const A2A_INCOMING_KIND = "a2a-incoming-requests";

/** `IncomingRequestsApi` over the link; `home` is bound by the main handler, never the worker. */
export type IncomingRequestsProtocol = {
	note: RpcMethod<[request: A2aIncomingRequest], void>;
	consume: RpcMethod<[match: IncomingRequestMatch], IncomingRequestLease | undefined>;
	confirm: RpcMethod<[leaseId: string], boolean>;
	release: RpcMethod<[leaseId: string], boolean>;
	discard: RpcMethod<[match: IncomingRequestMatch], void>;
	list: RpcMethod<[to?: string], A2aIncomingRequest[]>;
};
