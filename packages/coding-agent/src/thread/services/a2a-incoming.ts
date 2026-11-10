/**
 * The process-wide incoming A2A ledger across subagent worker links.
 *
 * Main exports its singleton by reference. Each worker installs a proxy as
 * `IncomingRequests.global()` at boot; it does not allocate a ledger. Claims
 * made through a worker's link are tagged with that worker's thread id, so a
 * worker that exits before acknowledging its reply has exactly its leases
 * reopened by `dropHome`; a dead link rejects new claims and foreign
 * settlements. `confirm`/`release` bind the caller's home on main and never
 * trust a worker-supplied owner.
 */
import { IncomingRequests } from "../../a2a/incoming-requests";
import type { ThreadId } from "../../thread/identity";
import type { WorkerThreadLink } from "../protocol";
import type { RpcServe } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import { A2A_INCOMING_KIND, type IncomingRequestsProtocol } from "./a2a-incoming-protocol";
import { RemoteIncomingRequests } from "./a2a-incoming-remote";

interface PeerState {
	dead: boolean;
}

const peers = new Map<ThreadId, PeerState>();

function mainInstance(): IncomingRequests {
	const registry = IncomingRequests.global();
	if (!(registry instanceof IncomingRequests)) {
		throw new Error("Incoming request registry must be a main-thread instance to bridge it into a worker");
	}
	return registry;
}

function serveIncoming(threadId: ThreadId, state: PeerState): RpcServe<IncomingRequests, IncomingRequestsProtocol> {
	return {
		note: (registry, request) => registry.note(request),
		consume: (registry, match) => {
			if (state.dead) return Promise.reject(new Error("owner exited"));
			return registry.consume(match, threadId);
		},
		confirm: (registry, leaseId) => {
			if (state.dead) return Promise.resolve(false);
			return registry.confirm(leaseId, threadId);
		},
		release: (registry, leaseId) => {
			if (state.dead) return Promise.resolve(false);
			return registry.release(leaseId, threadId);
		},
		discard: (registry, match) => registry.discard(match),
		list: (registry, to) => registry.list(to),
	};
}

function installMain(peer: WorkerPeer): void {
	const state: PeerState = { dead: false };
	peers.set(peer.threadId, state);
	peer.link.exportClass<IncomingRequests, IncomingRequestsProtocol>(
		A2A_INCOMING_KIND,
		(value): value is IncomingRequests => value instanceof IncomingRequests,
		serveIncoming(peer.threadId, state),
	);
}

function onWorkerExit(peer: WorkerPeer): void {
	const state = peers.get(peer.threadId);
	peers.delete(peer.threadId);
	if (state) state.dead = true;
	const registry = IncomingRequests.global();
	if (registry instanceof IncomingRequests) registry.dropHome(peer.threadId);
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
	onWorkerExit,
	installWorker,
	boot: bootWorker,
};
