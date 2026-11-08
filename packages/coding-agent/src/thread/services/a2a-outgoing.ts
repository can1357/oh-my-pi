/**
 * The process-wide outgoing A2A registry across subagent worker links.
 *
 * Main exports its singleton by reference. Each worker installs a proxy as
 * `OutgoingRequests.global()` at boot; it does not allocate a registry.
 * Registrations made through a worker's link are tagged with that worker so
 * exit drops them and rejects a parked waiter. A wait's abort signal, combined
 * with the worker-exit signal, detaches only that waiter so a cancelled call
 * cannot leave a main-side callback, and a live owner registered elsewhere is
 * kept.
 */
import { OutgoingRequests } from "../../a2a/outgoing-requests";
import type { WorkerThreadLink } from "../protocol";
import type { RpcServe } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import { A2A_OUTGOING_KIND, type OutgoingRequestsProtocol } from "./a2a-outgoing-protocol";
import { RemoteOutgoingRequests } from "./a2a-outgoing-remote";

interface PeerState {
	dead: boolean;
	readonly exited: AbortController;
}

const peers = new Map<WorkerPeer["threadId"], PeerState>();

function mainInstance(): OutgoingRequests {
	const registry = OutgoingRequests.global();
	if (!(registry instanceof OutgoingRequests)) {
		throw new Error("Outgoing request registry must be a main-thread instance to bridge it into a worker");
	}
	return registry;
}

function serveOutgoing(
	threadId: WorkerPeer["threadId"],
	state: PeerState,
): RpcServe<OutgoingRequests, OutgoingRequestsProtocol> {
	const exited = state.exited.signal;
	return {
		register: (registry, request) => {
			if (state.dead) return Promise.reject(new Error("owner exited"));
			return registry.register(request, threadId);
		},
		// Hold the caller's signal until the wait settles. Releasing it early drops
		// the export, so a later abort never reaches main and the waiter dangles.
		wait: (registry, messageId, signal) => {
			const linked = new AbortController();
			const follow = (source: AbortSignal): (() => void) => {
				if (source.aborted) {
					if (!linked.signal.aborted) linked.abort(source.reason);
					return () => {};
				}
				const onAbort = (): void => {
					if (!linked.signal.aborted) linked.abort(source.reason);
				};
				source.addEventListener("abort", onAbort, { once: true });
				return () => source.removeEventListener("abort", onAbort);
			};
			const stopExit = follow(exited);
			const stopCaller = signal ? follow(signal) : undefined;
			// `held` keeps the mirrored signal (and its export) alive until settlement.
			const held = signal;
			return registry.wait(messageId, linked.signal).finally(() => {
				stopExit();
				stopCaller?.();
				void held;
			});
		},
		resolve: (registry, messageId, from, text) => registry.resolve(messageId, from, text),
		fail: (registry, messageId, reason) => registry.fail(messageId, reason),
		cancel: (registry, messageId) => registry.cancel(messageId),
		hasOwner: (registry, ownerId) => registry.hasOwner(ownerId),
	};
}

function installMain(peer: WorkerPeer): void {
	const state: PeerState = { dead: false, exited: new AbortController() };
	peers.set(peer.threadId, state);
	peer.link.exportClass<OutgoingRequests, OutgoingRequestsProtocol>(
		A2A_OUTGOING_KIND,
		(value): value is OutgoingRequests => value instanceof OutgoingRequests,
		serveOutgoing(peer.threadId, state),
	);
}

function onWorkerExit(peer: WorkerPeer): void {
	const state = peers.get(peer.threadId);
	peers.delete(peer.threadId);
	if (state) state.dead = true;
	state?.exited.abort(new Error("owner exited"));
	const registry = OutgoingRequests.global();
	if (registry instanceof OutgoingRequests) registry.dropHome(peer.threadId);
}

function installWorker(link: WorkerThreadLink): void {
	link.importClass<RemoteOutgoingRequests, OutgoingRequestsProtocol>(
		A2A_OUTGOING_KIND,
		remote => new RemoteOutgoingRequests(remote),
	);
}

function isRemote(value: unknown): value is RemoteOutgoingRequests {
	return value instanceof RemoteOutgoingRequests;
}

function bootWorker(globals: unknown): void {
	if (!isRemote(globals)) throw new Error("Malformed a2a outgoing thread globals");
	OutgoingRequests.installGlobal(globals);
}

/** Main's outgoing registry, proxied into each worker. Install before the executor. */
export const a2aOutgoingThreadService: ThreadService = {
	name: "a2a-outgoing",
	installMain,
	globals: () => mainInstance(),
	onWorkerExit,
	installWorker,
	boot: bootWorker,
};
