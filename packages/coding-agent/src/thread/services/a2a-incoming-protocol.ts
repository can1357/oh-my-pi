import type { IncomingRequestMatch } from "../../a2a/incoming-requests";
import type { A2aIncomingRequest } from "../../a2a/rpc";
import type { RpcMethod } from "../rpc";

export const A2A_INCOMING_KIND = "a2a-incoming-requests";

export type IncomingRequestsProtocol = {
	note: RpcMethod<[request: A2aIncomingRequest], void>;
	consume: RpcMethod<[match: IncomingRequestMatch], A2aIncomingRequest | undefined>;
	list: RpcMethod<[to?: string], A2aIncomingRequest[]>;
};
