/**
 * Agent registry, awaits, lifecycle, IRC bus, and agent sessions across
 * subagent worker links.
 *
 * Main side, per worker:
 * - exports the main `AgentRegistry`, `AgentLifecycleManager`, and `IrcBus`
 *   by reference; the worker installs proxies as its globals (see
 *   `./agents-remote`). Forwarding subscriptions, awaits holds, and IRC waits
 *   a worker opens are tracked and dropped when it dies.
 * - exports a session bridge: the worker's publishers report sessions homed
 *   there (main keeps one `RemoteAgentSession` per open session, strongly,
 *   and retains the worker while any is open), and the worker's peer handles
 *   read and command sessions homed elsewhere through it.
 * - on worker death: adoptions carrying that worker's revivers are dropped
 *   (the next `ensureLive` cold-revives through the persisted factory), every
 *   registry ref holding a session homed there is detached and turns `parked`
 *   (session file on disk) or `aborted`, and the mirrors close, so in-flight
 *   commands reject with an error naming the worker.
 *
 * Worker side: proxies installed with `installGlobal`, the bridge handed to
 * peer handles, and a `SessionPublisher` for every session constructed here.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../../irc/bus";
import { type AdoptOptions, type AgentReviver, AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, type RegistryListener } from "../../registry/agent-registry";
import { PromptDroppedError, SessionBusyError } from "../../session/agent-session";
import type { WorkerThreadLink } from "../protocol";
import { installPeerBridge } from "../peer-agent-session";
import { RemoteAgentSession, SessionHostClient } from "../remote-agent-session";
import { registerRpcError, type RpcServe } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import { holdRemoteSession, onLocalSessionRegistered, releaseRemoteSession } from "../session-directory";
import { deleteTeamSessionBridge, setTeamSessionBridge } from "./team-bridge";
import {
	readSessionFields,
	SessionBridgeClient,
	type SessionBridgeProtocol,
	type SessionHostProtocol,
	type SessionOpened,
	toWireData,
} from "../session-mirror";
import { SESSION_HOST_SERVE, SessionPublisher } from "../session-publisher";
import {
	AGENT_LIFECYCLE_KIND,
	AGENT_REGISTRY_KIND,
	AGENT_SESSION_BRIDGE_KIND,
	AGENT_SESSION_HOST_KIND,
	type AgentLifecycleProtocol,
	type AgentRegistryProtocol,
	IRC_BUS_KIND,
	type IrcBusProtocol,
} from "./agents-protocol";
import { RemoteAgentLifecycle, RemoteAgentRegistry, RemoteIrcBus } from "./agents-remote";
import { trackWorkerSubscription } from "./support";

/** Boot globals of {@link agentsThreadService}: main's singletons and this worker's session bridge. */
export interface AgentsThreadGlobals {
	readonly registry: AgentRegistry;
	readonly lifecycle: AgentLifecycleManager;
	readonly bus: IrcBus;
	readonly bridge: MainSessionBridge;
}

function registerSessionErrors(): void {
	registerRpcError("PromptDroppedError", message => Object.assign(new PromptDroppedError(), { message }));
	registerRpcError("SessionBusyError", message => Object.assign(new SessionBusyError("continue"), { message }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main side
// ─────────────────────────────────────────────────────────────────────────────

interface OpenSession {
	readonly session: RemoteAgentSession;
	readonly release: () => void;
}

/**
 * Main-side endpoint of one worker's sessions: mirrors of the sessions homed
 * there, and the peer surface for sessions homed elsewhere. Also the
 * per-worker ledger of everything that must end when the worker dies.
 */
export class MainSessionBridge {
	readonly #peer: WorkerPeer;
	readonly #open = new Map<string, OpenSession>();
	readonly #subscriptions = new Set<() => void>();
	readonly #revivers = new Set<{ lifecycle: AgentLifecycleManager; id: string; revive: AgentReviver }>();
	onSessionClosed?: (session: object) => void;
	/** Aborts IRC waits the worker parked on main. */
	readonly exited = new AbortController();

	constructor(peer: WorkerPeer) {
		this.#peer = peer;
	}

	/** Worker the bridge serves. */
	get threadId(): WorkerPeer["threadId"] {
		return this.#peer.threadId;
	}

	/** Mirror of the open session `key` homed on this worker. */
	session(key: string): RemoteAgentSession | undefined {
		return this.#open.get(key)?.session;
	}

	/** A publisher opened a session: create and hold its canonical mirror. */
	opened(opened: SessionOpened): void {
		if (!(opened.host instanceof SessionHostClient)) throw new Error("Session opened without a host");
		const session = new RemoteAgentSession({
			key: opened.key,
			home: this.#peer.threadId,
			agentId: opened.agentId,
			host: opened.host,
			state: opened.state,
			messages: opened.messages,
			modelRegistry: opened.modelRegistry,
			asyncJobManager: opened.asyncJobManager,
		});
		holdRemoteSession(opened.key, session);
		this.#open.set(opened.key, { session, release: this.#peer.retain?.() ?? (() => {}) });
	}

	/** A publisher closed its session (dispose began). */
	closed(key: string, reason = "disposed"): void {
		const open = this.#open.get(key);
		if (!open) return;
		this.onSessionClosed?.(open.session);
		this.#open.delete(key);
		releaseRemoteSession(key);
		open.session.close(reason);
		open.release();
	}

	/**
	 * Keep `stop` until it runs or the worker dies; returns it marked sync so
	 * the worker can unsubscribe without a round trip of its own.
	 */
	track(stop: () => void): () => void {
		return trackWorkerSubscription(this.#subscriptions, stop);
	}

	/**
	 * Wrap a worker function as a main-side listener: delivery is async, and a
	 * failed delivery (closed link, collected receiver) ends the subscription.
	 */
	forward<A extends unknown[]>(
		deliver: (...args: A) => unknown,
		subscribe: (listener: (...args: A) => void) => () => void,
	): () => void {
		let stop: () => void = () => {};
		const listener = (...args: A): void => {
			Promise.resolve(deliver(...args)).catch(() => stop());
		};
		stop = this.track(subscribe(listener));
		return stop;
	}

	/** Live worker revivers adopted on main; test seam for ledger bounds. */
	get reviverCount(): number {
		return this.#revivers.size;
	}

	/**
	 * Record a reviver this worker handed to `lifecycle` for `id`; returns the adopt options
	 * to pass on, whose reviver holds the worker (and its idle shutdown off) while a revive
	 * runs there. The record is dropped when the adoption lets go of the reviver.
	 */
	adopted(lifecycle: AgentLifecycleManager, id: string, opts: AdoptOptions): AdoptOptions {
		const revive = opts.revive;
		if (!revive) return opts;
		const peer = this.#peer;
		const held: AgentReviver = async expected => {
			const release = peer.retain?.();
			try {
				return await revive(expected);
			} finally {
				release?.();
			}
		};
		const entry = { lifecycle, id, revive: held };
		this.#revivers.add(entry);
		const revivers = this.#revivers;
		const onReviverDropped = opts.onReviverDropped;
		return {
			...opts,
			revive: held,
			onReviverDropped: () => {
				revivers.delete(entry);
				onReviverDropped?.();
			},
		};
	}

	/** The worker died: see the module doc for the ordering. */
	exit(reason: string): void {
		this.exited.abort(new Error(`Subagent worker ${this.#peer.threadId} exited: ${reason}`));
		for (const stop of [...this.#subscriptions]) {
			try {
				stop();
			} catch (error) {
				logger.debug("Dropping a dead worker's subscription failed", { error: String(error) });
			}
		}
		const revivers = [...this.#revivers];
		this.#revivers.clear();
		for (const { lifecycle, id, revive } of revivers) lifecycle.forgetReviver(id, revive);
		const registry = AgentRegistry.global();
		for (const ref of registry.list()) {
			const session = ref.session;
			if (!(session instanceof RemoteAgentSession) || session.home !== this.#peer.threadId) continue;
			registry.detachSession(ref.id, ref);
			if (ref.status !== "aborted") registry.setStatus(ref.id, ref.sessionFile ? "parked" : "aborted", ref);
		}
		const why = `worker ${this.#peer.threadId} exited: ${reason}`;
		for (const key of [...this.#open.keys()]) this.closed(key, why);
	}
}

/** Publisher notifications for this worker's sessions, and peer reads/commands main routes to a session's home. */
function serveBridge(): RpcServe<MainSessionBridge, SessionBridgeProtocol> {
	return {
		opened: (bridge, opened) => bridge.opened(opened),
		patch: (bridge, key, patch) => bridge.session(key)?.applyPatch(patch),
		messages: (bridge, key, delta) => bridge.session(key)?.applyMessages(delta),
		event: (bridge, key, event) => bridge.session(key)?.applyEvent(event),
		runState: (bridge, key, state) => bridge.session(key)?.applyRunState(state),
		view: (bridge, key, state, entries) => bridge.session(key)?.applyView(state, entries),
		viewPatch: (bridge, key, patch) => bridge.session(key)?.applyViewPatch(patch),
		claimQueued: (bridge, key, ids) => bridge.session(key)?.claimQueued(ids) ?? [],
		entries: (bridge, key, delta) => bridge.session(key)?.applyEntries(delta),
		closed: (bridge, key) => bridge.closed(key),
		read: (_bridge, session, fields) => readSessionFields(session, fields),
		readMessages: (_bridge, session) => toWireData(session.messages),
		hasQueuedIrcFrom: (_bridge, session, from) => session.hasQueuedIrcFrom(from),
		subscribe: (bridge, session, listener) =>
			bridge.forward(listener, forward => session.subscribe(event => forward(toWireData(event)))),
		subscribeRunState: (bridge, session, listener) =>
			bridge.forward(listener, forward => session.subscribeRunState(forward)),
		prompt: (_bridge, session, text, options) => session.prompt(text, options),
		steer: (_bridge, session, text, images, options) => session.steer(text, images, options),
		abort: (_bridge, session, options) => session.abort(options),
		dispose: (_bridge, session, options) => session.dispose(options),
		deliverIrcMessage: (_bridge, session, msg) => session.deliverIrcMessage(msg),
		waitForIrcReplies: (_bridge, session) => session.waitForIrcReplies(),
		setWorkPoolYieldItems: (_bridge, session, items) => session.setWorkPoolYieldItems(items),
		emitIrcRelayObservation: (_bridge, session, record) => session.emitIrcRelayObservation(record),
	};
}

function serveRegistry(bridge: MainSessionBridge): RpcServe<AgentRegistry, AgentRegistryProtocol> {
	return {
		register: (registry, input) => registry.register(input),
		registerIfAvailable: (registry, input, expected) => registry.registerIfAvailable(input, expected),
		reopen: (registry, id, expected) => registry.reopen(id, expected),
		setHistory: (registry, id, history, expectedSessionFile) => registry.setHistory(id, history, expectedSessionFile),
		setStatus: (registry, id, status, expected) => registry.setStatus(id, status, expected),
		markResultAccepted: (registry, id, expected, responseAt) => registry.markResultAccepted(id, expected, responseAt),
		markTurnSettled: (registry, id, expected, summary) => registry.markTurnSettled(id, expected, summary),
		staleAcceptedRuns: registry => registry.staleAcceptedRuns(),
		setActivity: (registry, id, activity) => registry.setActivity(id, activity),
		attachSession: (registry, id, session, sessionFile, expected) =>
			registry.attachSession(id, session, sessionFile, expected),
		detachSession: (registry, id, expected) => registry.detachSession(id, expected),
		unregister: (registry, id, expected) => registry.unregister(id, expected),
		get: (registry, id) => registry.get(id),
		list: registry => registry.list(),
		listVisibleTo: (registry, id) => registry.listVisibleTo(id),
		isRunning: (registry, ref) => registry.isRunning(ref),
		subscribe: (registry, listener: RegistryListener) =>
			bridge.forward(listener, forward => registry.onChange(forward)),
		awaitsHold: (registry, waiter, awaited, options) => bridge.track(registry.awaits.hold(waiter, awaited, options)),
		awaitsBlocksOn: (registry, agent, target, sentAt) => registry.awaits.blocksOn(agent, target, sentAt),
		awaitsSubscribe: (registry, listener) => bridge.forward(listener, forward => registry.awaits.onChange(forward)),
	};
}

function serveLifecycle(bridge: MainSessionBridge): RpcServe<AgentLifecycleManager, AgentLifecycleProtocol> {
	return {
		adopt: (lifecycle, id, opts, expected) => lifecycle.adopt(id, bridge.adopted(lifecycle, id, opts), expected),
		has: (lifecycle, id, expected) => lifecycle.has(id, expected),
		reclaimDeadCorpse: (lifecycle, id, expected) => lifecycle.reclaimDeadCorpse(id, expected),
		manages: (lifecycle, registry) => lifecycle.manages(registry),
		isParking: (lifecycle, id, expected) => lifecycle.isParking(id, expected),
		canRevive: (lifecycle, ref) => lifecycle.canRevive(ref),
		park: (lifecycle, id) => lifecycle.park(id),
		ensureLive: (lifecycle, id) => lifecycle.ensureLive(id),
		release: (lifecycle, id, expected, options) => lifecycle.release(id, expected, options),
	};
}

function serveBus(bridge: MainSessionBridge): RpcServe<IrcBus, IrcBusProtocol> {
	return {
		send: (bus, msg) => bus.send(msg),
		sentSince: (bus, from, to, sinceTs) => bus.sentSince(from, to, sinceTs),
		unansweredSends: (bus, from, sinceTs) => bus.unansweredSends(from, sinceTs),
		// A wait parked by a dead worker must not swallow the next message for its agent.
		wait: (bus, agentId, filter, timeoutMs, signal, options) =>
			bus.wait(
				agentId,
				filter,
				timeoutMs,
				signal ? AbortSignal.any([signal, bridge.exited.signal]) : bridge.exited.signal,
				options,
			),
		take: (bus, agentId, from, filter) => bus.take(agentId, from, filter),
		unreadCount: (bus, agentId) => bus.unreadCount(agentId),
		recordReply: (bus, from, to) => bus.recordReply(from, to),
	};
}

const bridges = new Map<WorkerPeer["threadId"], MainSessionBridge>();

function installMain(peer: WorkerPeer): void {
	registerSessionErrors();
	const bridge = new MainSessionBridge(peer);
	bridges.set(peer.threadId, bridge);
	setTeamSessionBridge(peer, bridge);
	const { link } = peer;
	link.exportClass(
		AGENT_SESSION_BRIDGE_KIND,
		(value): value is MainSessionBridge => value instanceof MainSessionBridge,
		serveBridge(),
	);
	link.exportClass(
		AGENT_REGISTRY_KIND,
		(value): value is AgentRegistry => value instanceof AgentRegistry,
		serveRegistry(bridge),
	);
	link.exportClass(
		AGENT_LIFECYCLE_KIND,
		(value): value is AgentLifecycleManager => value instanceof AgentLifecycleManager,
		serveLifecycle(bridge),
	);
	link.exportClass(IRC_BUS_KIND, (value): value is IrcBus => value instanceof IrcBus, serveBus(bridge));
	link.importClass<SessionHostClient, SessionHostProtocol>(
		AGENT_SESSION_HOST_KIND,
		remote => new SessionHostClient(remote),
	);
}

function mainGlobals(peer: WorkerPeer): AgentsThreadGlobals {
	const bridge = bridges.get(peer.threadId);
	const registry = AgentRegistry.global();
	const lifecycle = AgentLifecycleManager.global();
	const bus = IrcBus.global();
	if (!bridge) throw new Error(`No agent session bridge for ${peer.threadId}`);
	if (
		!(registry instanceof AgentRegistry) ||
		!(lifecycle instanceof AgentLifecycleManager) ||
		!(bus instanceof IrcBus)
	) {
		throw new Error("Agent singletons must be main-thread instances to bridge them into a worker");
	}
	return { registry, lifecycle, bus, bridge };
}

function onWorkerExit(peer: WorkerPeer, reason: string): void {
	const bridge = bridges.get(peer.threadId);
	bridges.delete(peer.threadId);
	bridge?.exit(reason);
	deleteTeamSessionBridge(peer);
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker side
// ─────────────────────────────────────────────────────────────────────────────

function installWorker(link: WorkerThreadLink): void {
	registerSessionErrors();
	link.importClass<RemoteAgentRegistry, AgentRegistryProtocol>(
		AGENT_REGISTRY_KIND,
		remote => new RemoteAgentRegistry(remote),
	);
	link.importClass<RemoteAgentLifecycle, AgentLifecycleProtocol>(
		AGENT_LIFECYCLE_KIND,
		remote => new RemoteAgentLifecycle(remote),
	);
	link.importClass<RemoteIrcBus, IrcBusProtocol>(IRC_BUS_KIND, remote => new RemoteIrcBus(remote));
	link.importClass<SessionBridgeClient, SessionBridgeProtocol>(
		AGENT_SESSION_BRIDGE_KIND,
		remote => new SessionBridgeClient(remote),
	);
	link.exportClass<SessionPublisher, SessionHostProtocol>(
		AGENT_SESSION_HOST_KIND,
		(value): value is SessionPublisher => value instanceof SessionPublisher,
		SESSION_HOST_SERVE,
	);
}

interface WorkerAgentsGlobals {
	readonly registry: RemoteAgentRegistry;
	readonly lifecycle: RemoteAgentLifecycle;
	readonly bus: RemoteIrcBus;
	readonly bridge: SessionBridgeClient;
}

function isWorkerGlobals(value: unknown): value is WorkerAgentsGlobals {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "registry") instanceof RemoteAgentRegistry &&
		Reflect.get(value, "lifecycle") instanceof RemoteAgentLifecycle &&
		Reflect.get(value, "bus") instanceof RemoteIrcBus &&
		Reflect.get(value, "bridge") instanceof SessionBridgeClient
	);
}

let stopPublishing: (() => void) | undefined;

function bootWorker(globals: unknown): void {
	if (!isWorkerGlobals(globals)) throw new Error("Malformed agents thread globals");
	AgentRegistry.installGlobal(globals.registry);
	AgentLifecycleManager.installGlobal(globals.lifecycle);
	IrcBus.installGlobal(globals.bus);
	installPeerBridge(globals.bridge);
	stopPublishing?.();
	const bridge = globals.bridge;
	stopPublishing = onLocalSessionRegistered(session => {
		new SessionPublisher(session, bridge);
	});
}

/** Registry, awaits, lifecycle, IRC bus, and agent-session bridging; see the module doc. */
export const agentsThreadService: ThreadService = {
	name: "agents",
	installMain,
	globals: mainGlobals,
	onWorkerExit,
	installWorker,
	boot: bootWorker,
};
