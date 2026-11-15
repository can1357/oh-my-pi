/**
 * Shared Antigravity CLI process bridge between the main thread and subagent workers.
 *
 * When >=9 subagents run concurrently, `SubagentWorkerPool` executes child
 * sessions inside Bun worker threads. This service forwards worker lease
 * acquisitions to the main thread's `sharedAgyPool` (loaded lazily on first
 * use) so compatible sessions across the `omp` OS process share one `agy acp`
 * subprocess per account and tool set.
 */
import {
	acquireMainThreadSharedAgyLease,
	setSharedAgyWorkerBridge,
	type SharedAgyBridgeLease,
	type SharedAgyBridgeRequest,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli-state";
import { logger } from "@oh-my-pi/pi-utils";
import { RequestError } from "@oh-my-pi/pi-utils/acp";
import type { ThreadId } from "../identity";
import { registerRpcError } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import { ignoreSettle, PeerCleanups } from "./support";

registerRpcError("RequestError", message => new RequestError(-32603, message));

interface BridgedAgyLeaseRequest extends SharedAgyBridgeRequest {
	onAborted: (reason: string) => void;
}

type BridgedConnection = SharedAgyBridgeLease["connection"];

interface BridgedAgyLeaseHandle {
	exited: Promise<number>;
	credentialVersion?: string;
	credentialExpires?: number;
	initialize: BridgedConnection["initialize"];
	newSession: BridgedConnection["newSession"];
	loadSession: BridgedConnection["loadSession"];
	closeSession: BridgedConnection["closeSession"];
	setSessionConfigOption: BridgedConnection["setSessionConfigOption"];
	prompt: BridgedConnection["prompt"];
	cancel: BridgedConnection["cancel"];
	close: () => void;
}

/** Boot globals of {@link antigravityCliThreadService}. */
export interface AntigravityCliServiceGlobals {
	readonly openSharedLease: (request: BridgedAgyLeaseRequest) => Promise<BridgedAgyLeaseHandle>;
}

const cleanups = new PeerCleanups("antigravity-cli");
const exitedPeers = new Set<ThreadId>();

function isAntigravityCliGlobals(value: unknown): value is AntigravityCliServiceGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "openSharedLease") === "function";
}

/** Routes subagent worker `antigravity-cli` leases to the main thread's shared `agy` pool. */
export const antigravityCliThreadService: ThreadService = {
	name: "antigravity-cli",

	globals(peer: WorkerPeer): AntigravityCliServiceGlobals {
		exitedPeers.delete(peer.threadId);
		return {
			openSharedLease: async request => {
				const lease = await acquireMainThreadSharedAgyLease({
					geminiDir: request.geminiDir,
					credentialVersion: request.credentialVersion,
					credentialExpires: request.credentialExpires,
					tools: request.tools,
					signal: request.signal,
					onCall: (name, args, conversationId) => request.onCall(name, args, conversationId),
					onUpdate: notification => {
						Promise.resolve(request.onUpdate(notification)).catch((error: unknown) =>
							logger.debug("Worker Antigravity CLI update listener failed", { error: String(error) }),
						);
					},
				});
				if (exitedPeers.has(peer.threadId)) {
					lease.close();
					throw new Error("Antigravity CLI worker exited before lease opened");
				}
				const stopTracking = cleanups.track(peer.threadId, () => lease.close());
				const notifyAbort = () => {
					const reason = lease.connection.signal.reason;
					const message = reason instanceof Error ? reason.message : String(reason ?? "ACP connection closed");
					ignoreSettle(request.onAborted(message));
				};
				lease.connection.signal.addEventListener("abort", notifyAbort, { once: true });
				if (lease.connection.signal.aborted) notifyAbort();
				return {
					exited: lease.exited,
					credentialVersion: lease.credentialVersion,
					credentialExpires: lease.credentialExpires,
					initialize: params => lease.connection.initialize(params),
					newSession: params => lease.connection.newSession(params),
					loadSession: params => lease.connection.loadSession(params),
					closeSession: params => lease.connection.closeSession(params),
					setSessionConfigOption: params => lease.connection.setSessionConfigOption(params),
					prompt: params => lease.connection.prompt(params),
					cancel: params => lease.connection.cancel(params),
					close: () => {
						lease.connection.signal.removeEventListener("abort", notifyAbort);
						stopTracking();
					},
				};
			},
		};
	},

	onWorkerExit(peer: WorkerPeer): void {
		exitedPeers.add(peer.threadId);
		cleanups.release(peer.threadId);
	},

	boot(globals: unknown): void {
		if (!isAntigravityCliGlobals(globals)) {
			throw new Error("antigravity-cli service: boot globals lack openSharedLease");
		}
		setSharedAgyWorkerBridge(async options => {
			const abort = new AbortController();
			const remote = await globals.openSharedLease({
				...options,
				onAborted: reason => abort.abort(new Error(reason)),
			});
			let closed = false;
			return {
				connection: {
					signal: abort.signal,
					initialize: params => remote.initialize(params),
					newSession: params => remote.newSession(params),
					loadSession: params => remote.loadSession(params),
					closeSession: params => remote.closeSession(params),
					setSessionConfigOption: params => remote.setSessionConfigOption(params),
					prompt: params => remote.prompt(params),
					cancel: params => remote.cancel(params),
				},
				exited: remote.exited,
				credentialVersion: remote.credentialVersion,
				credentialExpires: remote.credentialExpires,
				close: () => {
					if (closed) return;
					closed = true;
					abort.abort(new Error("Antigravity CLI session closed"));
					ignoreSettle(remote.close());
				},
			};
		});
	},
};
