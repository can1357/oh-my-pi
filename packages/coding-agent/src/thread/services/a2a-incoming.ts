import { IncomingRequests } from "../../a2a/incoming-requests";
import type { WorkerThreadLink } from "../protocol";
import type { RpcServe } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import { A2A_INCOMING_KIND, type IncomingRequestsProtocol } from "./a2a-incoming-protocol";
import { RemoteIncomingRequests } from "./a2a-incoming-remote";

function mainInstance(): IncomingRequests {
	const registry = IncomingRequests.global();
	if (!(registry instanceof IncomingRequests)) {
		throw new Error("Incoming request registry must be a main-thread instance to bridge it into a worker");
	}
	return registry;
}

const serveIncoming: RpcServe<IncomingRequests, IncomingRequestsProtocol> = {
	note: (registry, request) => registry.note(request),
	consume: (registry, match) => registry.consume(match),
	list: (registry, to) => registry.list(to),
};

function installMain(peer: WorkerPeer): void {
	peer.link.exportClass<IncomingRequests, IncomingRequestsProtocol>(
		A2A_INCOMING_KIND,
		(value): value is IncomingRequests => value instanceof IncomingRequests,
		serveIncoming,
	);
}

function installWorker(link: WorkerThreadLink): void {
	link.importClass<RemoteIncomingRequests, IncomingRequestsProtocol>(
		A2A_INCOMING_KIND,
		remote => new RemoteIncomingRequests(remote),
	);
}

function bootWorker(globals: unknown): void {
	if (!(globals instanceof RemoteIncomingRequests)) throw new Error("Malformed a2a incoming thread globals");
	IncomingRequests.installGlobal(globals);
}

/** Share main's incoming ledger with workers before the executor starts. */
export const a2aIncomingThreadService: ThreadService = {
	name: "a2a-incoming",
	installMain,
	globals: () => mainInstance(),
	installWorker,
	boot: bootWorker,
};
