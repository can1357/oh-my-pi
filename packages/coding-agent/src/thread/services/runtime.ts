/**
 * Per-root runtime objects a subagent run receives by reference, across
 * subagent worker links. Each crosses as a remote object (protocols and worker
 * classes in `./runtime-remote`); the root's job manager has its own service
 * (`./async-jobs`).
 *
 * - `"cost-gate"` — one spend total per session tree, on main. A worker's
 *   `check`/`admit`/`spent`/`capped` are sync calls; `record` (and `meter`,
 *   which records when the stream finishes) is a notification ordered ahead of
 *   the worker's next check, so a cost recorded in a worker trips main's cap
 *   for every thread's next request.
 * - `"event-bus"` — worker emits forward to main's bus; worker listeners
 *   subscribe on main. Frames for channels main has no listener on are dropped
 *   in the worker (see `RemoteEventBus`).
 * - `"artifact-manager"` — ids and paths are allocated on main (sync
 *   `allocateId`), so ids stay unique across the tree; workers write the
 *   content to the same paths. `dir` and the reserved-id scan stay main's.
 * - `"agent-storage"` — main's open agent.db. Worker settings mirrors return it
 *   from `getStorage()` (seeded by `./settings`), so model usage, MCP tool
 *   cache, fetch credentials, startup verdicts and perf samples read and write
 *   main's database; workers never open a second SQLite connection.
 *
 * Workpools stay worker-local: `WorkPoolRegistry.global()` is per thread. A
 * pool is created, driven, queried (eval `workpool()` bridge) and released by
 * its owner agent's session, which lives in exactly one thread, and its
 * dispatch spawns subagents from that thread. Its aggregate job and batch jobs
 * register on the root's `AsyncJobManager` like any job, so `proc://`, job
 * listings and the TUI see the pool's work without a main-side registry entry.
 */
import { CostCapError, CostGate } from "../../session/cost-gate";
import { ArtifactManager } from "../../session/artifacts";
import { AgentStorage } from "../../session/agent-storage";
import { EventBus } from "../../utils/event-bus";
import { registerRpcError, type RpcServe } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import {
	AGENT_STORAGE_KIND,
	type AgentStorageProtocol,
	ARTIFACT_MANAGER_KIND,
	type ArtifactManagerProtocol,
	COST_GATE_KIND,
	type CostGateProtocol,
	EVENT_BUS_KIND,
	type EventBusProtocol,
	RemoteAgentStorage,
	RemoteArtifactManager,
	RemoteCostGate,
	RemoteEventBus,
} from "./runtime-remote";
import { ignoreSettle, PeerCleanups } from "./support";

const SERVICE_NAME = "runtime";

registerRpcError("CostCapError", message => new CostCapError({ spent: 0, cap: 0, message }));

/** Listeners and subscriptions workers made on main's gates and buses. */
const cleanups = new PeerCleanups(SERVICE_NAME);

function serveCostGate(peer: WorkerPeer): RpcServe<CostGate, CostGateProtocol> {
	return {
		spent: gate => gate.spent,
		capped: gate => gate.capped,
		check: gate => gate.check(),
		record: (gate, cost) => gate.record(cost),
		onCapChange: (gate, listener) =>
			cleanups.track(
				peer.threadId,
				gate.onCapChange(() => ignoreSettle(listener())),
			),
	};
}

function serveEventBus(peer: WorkerPeer): RpcServe<EventBus, EventBusProtocol> {
	return {
		emit: (bus, channel, data) => bus.emit(channel, data),
		on: (bus, channel, handler) =>
			cleanups.track(
				peer.threadId,
				bus.on(channel, data => handler(data)),
			),
		watch: (bus, channel, onChange) => {
			cleanups.track(
				peer.threadId,
				bus.watchListeners(channel, present => ignoreSettle(onChange(present))),
			);
			return bus.hasListeners(channel);
		},
	};
}

const serveArtifactManager: RpcServe<ArtifactManager, ArtifactManagerProtocol> = {
	dir: manager => manager.dir,
	allocateId: manager => manager.allocateId(),
	allocatePath: (manager, toolType) => manager.allocatePath(toolType),
	exists: (manager, id) => manager.exists(id),
	listFiles: manager => manager.listFiles(),
	getPath: (manager, id) => manager.getPath(id),
};

const serveAgentStorage: RpcServe<AgentStorage, AgentStorageProtocol> = {
	getCache: (storage, key) => storage.getCache(key),
	setCache: (storage, key, value, expiresAtSec) => storage.setCache(key, value, expiresAtSec),
	listAuthCredentials: (storage, provider, includeDisabled) => storage.listAuthCredentials(provider, includeDisabled),
	recordModelUsage: (storage, modelKey) => storage.recordModelUsage(modelKey),
	getModelUsageOrder: storage => storage.getModelUsageOrder(),
	recordModelPerf: (storage, modelKey, sample, serviceTier) => storage.recordModelPerf(modelKey, sample, serviceTier),
	getModelPerf: storage => storage.getModelPerf(),
	claimNotice: (storage, key, expiresAtMs) => storage.claimNotice(key, expiresAtMs),
};

/**
 * Cost gate, event buses, artifact manager and agent storage for subagent workers; see the
 * module doc.
 */
export const runtimeThreadService: ThreadService = {
	name: SERVICE_NAME,
	installMain(peer) {
		const { link } = peer;
		link.exportClass<CostGate, CostGateProtocol>(
			COST_GATE_KIND,
			(value): value is CostGate => value instanceof CostGate,
			serveCostGate(peer),
		);
		link.exportClass<EventBus, EventBusProtocol>(
			EVENT_BUS_KIND,
			(value): value is EventBus => value instanceof EventBus,
			serveEventBus(peer),
		);
		link.exportClass<ArtifactManager, ArtifactManagerProtocol>(
			ARTIFACT_MANAGER_KIND,
			(value): value is ArtifactManager => value instanceof ArtifactManager,
			serveArtifactManager,
		);
		link.exportClass<AgentStorage, AgentStorageProtocol>(
			AGENT_STORAGE_KIND,
			(value): value is AgentStorage => value instanceof AgentStorage,
			serveAgentStorage,
		);
	},
	onWorkerExit: peer => cleanups.release(peer.threadId),
	installWorker(link) {
		link.importClass<RemoteCostGate, CostGateProtocol>(COST_GATE_KIND, remote => new RemoteCostGate(remote));
		link.importClass<RemoteEventBus, EventBusProtocol>(EVENT_BUS_KIND, remote => new RemoteEventBus(remote));
		link.importClass<RemoteArtifactManager, ArtifactManagerProtocol>(
			ARTIFACT_MANAGER_KIND,
			remote => new RemoteArtifactManager(remote),
		);
		link.importClass<RemoteAgentStorage, AgentStorageProtocol>(
			AGENT_STORAGE_KIND,
			remote => new RemoteAgentStorage(remote),
		);
	},
};
