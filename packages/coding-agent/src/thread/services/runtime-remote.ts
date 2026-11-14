/**
 * Wire protocols and worker-side implementations of the per-root runtime
 * objects a subagent run receives by reference: the tree's {@link CostGate},
 * {@link EventBus}es, {@link ArtifactManager}, and main's {@link AgentStorage}.
 * The main-side halves live in `./runtime`.
 */
import type { AssistantMessageEventStream, ServiceTier, StoredAuthCredential } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type ArtifactManagerApi, writeArtifact } from "../../session/artifacts";
import type { AgentStorageApi, ModelPerfSample, ModelPerfStats } from "../../session/agent-storage";
import { type CostCapRefusal, CostCapError, type CostGateApi } from "../../session/cost-gate";
import { EventBus } from "../../utils/event-bus";
import type { RemoteObject, RpcMethod } from "../rpc";
import { localUnsubscribe, type WireCallback, type WireUnsubscribe } from "./support";

/** Remote-object kind of a session tree's cost gate. */
export const COST_GATE_KIND = "cost-gate";
/** Remote-object kind of an event bus. */
export const EVENT_BUS_KIND = "event-bus";
/** Remote-object kind of a session tree's artifact manager. */
export const ARTIFACT_MANAGER_KIND = "artifact-manager";
/** Remote-object kind of an open agent.db handle. */
export const AGENT_STORAGE_KIND = "agent-storage";

/** Protocol of kind {@link COST_GATE_KIND}. */
export type CostGateProtocol = {
	spent: RpcMethod<[], number>;
	check: RpcMethod<[], CostCapRefusal | undefined>;
	record: RpcMethod<[cost: number], void>;
	/**
	 * Subscribe `listener` to `session.maxCost` changes, each carrying whether a cap is set
	 * afterwards; returns whether one is set now. Main drops the subscription once the listener
	 * returns `false` (its worker gate was collected) or the worker exits.
	 */
	watchCap: RpcMethod<[listener: (capped: boolean) => boolean | Promise<boolean>], boolean>;
};

/** Protocol of kind {@link EVENT_BUS_KIND}. */
export type EventBusProtocol = {
	emit: RpcMethod<[channel: string, data: unknown], void>;
	on: RpcMethod<[channel: string, handler: WireCallback<[data: unknown]>], WireUnsubscribe>;
	/** Subscribe to listener-presence changes of `channel`; returns whether it has listeners now. */
	watch: RpcMethod<[channel: string, onChange: WireCallback<[present: boolean]>], boolean>;
};

/** Protocol of kind {@link ARTIFACT_MANAGER_KIND}. */
export type ArtifactManagerProtocol = {
	dir: RpcMethod<[], string>;
	allocateId: RpcMethod<[], number>;
	allocatePath: RpcMethod<[toolType: string], { id: string; path: string }>;
	exists: RpcMethod<[id: string], boolean>;
	listFiles: RpcMethod<[], string[]>;
	getPath: RpcMethod<[id: string], string | null>;
};

/** Protocol of kind {@link AGENT_STORAGE_KIND}. */
export type AgentStorageProtocol = {
	getCache: RpcMethod<[key: string], string | null>;
	setCache: RpcMethod<[key: string, value: string, expiresAtSec: number], void>;
	listAuthCredentials: RpcMethod<[provider: string | undefined, includeDisabled: boolean], StoredAuthCredential[]>;
	recordModelUsage: RpcMethod<[modelKey: string], void>;
	getModelUsageOrder: RpcMethod<[], string[]>;
	recordModelPerf: RpcMethod<
		[modelKey: string, sample: ModelPerfSample, serviceTier: ServiceTier | null | undefined],
		void
	>;
	getModelPerf: RpcMethod<[], Map<string, ModelPerfStats>>;
	claimNotice: RpcMethod<[key: string, expiresAtMs: number], boolean>;
};

/**
 * Worker-side {@link CostGateApi}: the spend total and cap live on main's gate. Whether a cap
 * is set is mirrored here by one watch on main, made on first use, so an uncapped tree (the
 * default) checks every request without a blocking call; a capped one asks main each time.
 */
export class RemoteCostGate implements CostGateApi {
	readonly #remote: RemoteObject<CostGateProtocol>;
	/** Main's {@link CostGateApi.capped}, kept current by the cap watch; `undefined` before it. */
	#capped: boolean | undefined;
	readonly #capListeners = new Set<() => void>();

	constructor(remote: RemoteObject<CostGateProtocol>) {
		this.#remote = remote;
	}

	get spent(): number {
		return this.#remote.callSync("spent");
	}

	get capped(): boolean {
		return this.#capped ?? this.#watchCap();
	}

	#watchCap(): boolean {
		// Weak: main holds the listener until the worker exits; a collected gate ends the watch.
		const gate = new WeakRef(this);
		this.#capped = this.#remote.callSync("watchCap", capped => {
			const target = gate.deref();
			if (!target) return false;
			target.#capped = capped;
			for (const listener of Array.from(target.#capListeners)) {
				try {
					listener();
				} catch (error) {
					logger.warn("Cost cap listener failed", { error: String(error) });
				}
			}
			return true;
		});
		return this.#capped;
	}

	/** Listeners run after {@link capped} has adopted the change. */
	onCapChange(onChange: () => void): () => void {
		if (this.#capped === undefined) this.#watchCap();
		this.#capListeners.add(onChange);
		return () => {
			this.#capListeners.delete(onChange);
		};
	}

	check(): CostCapRefusal | undefined {
		// No cap, no refusal: `CostGate.check` reads only the spend once a cap is set.
		if (!this.capped) return undefined;
		return this.#remote.callSync("check");
	}

	admit(): void {
		const refusal = this.check();
		if (refusal) throw new CostCapError(refusal);
	}

	/** Ordered ahead of any later {@link check} on the same link, so the next request sees the cost. */
	record(cost: number): void {
		if (!(cost > 0)) return;
		this.#remote.notify("record", cost);
	}

	meter(stream: AssistantMessageEventStream): AssistantMessageEventStream {
		stream.result().then(
			message => this.record(message.usage.cost.total),
			() => {},
		);
		return stream;
	}
}

/**
 * Worker-side view of a main-thread {@link EventBus}. It subclasses `EventBus` so every holder
 * typed `EventBus` (extension APIs, executor options, RPC mode) takes it unchanged.
 *
 * - `emit` forwards to main's bus as a notification, and drops frames for channels main has no
 *   listener on (task subagents stream every delta on `task:subagent:event`). Presence is learned
 *   with one sync call per channel and kept current by main's pushes; a listener added on main
 *   while a push is in flight misses the frames emitted meanwhile.
 * - `on` subscribes on main, so a frame reaches every listener exactly once wherever it was
 *   emitted; `clear` drops only this proxy's subscriptions.
 * - Two proxies of the same main bus are one object, so `emitSubagentFrame`'s identity check still
 *   prevents double delivery.
 */
export class RemoteEventBus extends EventBus {
	readonly #remote: RemoteObject<EventBusProtocol>;
	/** Whether main's bus has listeners, per channel this proxy emitted on or watches. */
	readonly #presence = new Map<string, boolean>();
	/** Live subscriptions this proxy made on main, per channel. */
	readonly #own = new Map<string, Set<() => void>>();
	readonly #watchers = new Map<string, Set<(present: boolean) => void>>();
	readonly #unsendable = new Set<string>();

	constructor(remote: RemoteObject<EventBusProtocol>) {
		super();
		this.#remote = remote;
	}

	#present(channel: string): boolean {
		if ((this.#own.get(channel)?.size ?? 0) > 0) return true;
		const known = this.#presence.get(channel);
		if (known !== undefined) return known;
		const present = this.#remote.callSync("watch", channel, next => {
			this.#presence.set(channel, next);
			for (const watcher of this.#watchers.get(channel) ?? []) watcher(next);
		});
		this.#presence.set(channel, present);
		return present;
	}

	override emit = (channel: string, data: unknown): void => {
		if (!this.#present(channel)) return;
		try {
			this.#remote.notify("emit", channel, data);
		} catch (error) {
			// An unsendable payload must not fail the emitter; report it once per channel.
			if (this.#unsendable.has(channel)) return;
			this.#unsendable.add(channel);
			logger.warn("Event bus frame could not cross to the main thread", { channel, error: String(error) });
		}
	};

	override on = (channel: string, handler: (data: unknown) => void): (() => void) => {
		const unsubscribe = localUnsubscribe(this.#remote.callSync("on", channel, data => handler(data)));
		let own = this.#own.get(channel);
		if (!own) {
			own = new Set();
			this.#own.set(channel, own);
		}
		const owner = own;
		const stop = (): void => {
			if (!owner.delete(stop)) return;
			unsubscribe();
		};
		owner.add(stop);
		return stop;
	};

	override hasListeners = (channel: string): boolean => this.#present(channel);

	override watchListeners = (channel: string, onChange: (present: boolean) => void): (() => void) => {
		this.#present(channel);
		let watchers = this.#watchers.get(channel);
		if (!watchers) {
			watchers = new Set();
			this.#watchers.set(channel, watchers);
		}
		watchers.add(onChange);
		return () => {
			this.#watchers.get(channel)?.delete(onChange);
		};
	};

	override clear = (): void => {
		for (const own of this.#own.values()) for (const stop of Array.from(own)) stop();
		this.#own.clear();
	};
}

/** Worker-side {@link ArtifactManagerApi}: ids and paths come from main; content is written here. */
export class RemoteArtifactManager implements ArtifactManagerApi {
	readonly #remote: RemoteObject<ArtifactManagerProtocol>;
	#dir: string | undefined;

	constructor(remote: RemoteObject<ArtifactManagerProtocol>) {
		this.#remote = remote;
	}

	get dir(): string {
		this.#dir ??= this.#remote.callSync("dir");
		return this.#dir;
	}

	allocateId(): number {
		return this.#remote.callSync("allocateId");
	}

	allocatePath(toolType: string): Promise<{ id: string; path: string }> {
		return this.#remote.call("allocatePath", toolType);
	}

	async save(content: string, toolType: string): Promise<string> {
		const { id, path } = await this.allocatePath(toolType);
		await writeArtifact(path, content);
		return id;
	}

	exists(id: string): Promise<boolean> {
		return this.#remote.call("exists", id);
	}

	listFiles(): Promise<string[]> {
		return this.#remote.call("listFiles");
	}

	getPath(id: string): Promise<string | null> {
		return this.#remote.call("getPath", id);
	}
}

/** Worker-side {@link AgentStorageApi}: every call runs on main's open agent.db. */
export class RemoteAgentStorage implements AgentStorageApi {
	readonly #remote: RemoteObject<AgentStorageProtocol>;
	/**
	 * Model resolution reads the usage order once per candidate list, a dozen times in one
	 * spawn; one blocking call answers a whole synchronous pass (dropped on the next macrotask
	 * or on a usage this worker records).
	 */
	#modelUsageOrder: string[] | undefined;

	constructor(remote: RemoteObject<AgentStorageProtocol>) {
		this.#remote = remote;
	}

	getCache(key: string): string | null {
		return this.#remote.callSync("getCache", key);
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#remote.notify("setCache", key, value, expiresAtSec);
	}

	listAuthCredentials(provider?: string, includeDisabled = false): StoredAuthCredential[] {
		return this.#remote.callSync("listAuthCredentials", provider, includeDisabled);
	}

	recordModelUsage(modelKey: string): void {
		this.#modelUsageOrder = undefined;
		this.#remote.notify("recordModelUsage", modelKey);
	}

	getModelUsageOrder(): string[] {
		if (!this.#modelUsageOrder) {
			this.#modelUsageOrder = this.#remote.callSync("getModelUsageOrder");
			setImmediate(() => {
				this.#modelUsageOrder = undefined;
			});
		}
		return this.#modelUsageOrder;
	}

	recordModelPerf(modelKey: string, sample: ModelPerfSample, serviceTier?: ServiceTier | null): Promise<void> {
		return this.#remote.call("recordModelPerf", modelKey, sample, serviceTier);
	}

	getModelPerf(): Map<string, ModelPerfStats> {
		return this.#remote.callSync("getModelPerf");
	}

	claimNotice(key: string, expiresAtMs: number): boolean {
		return this.#remote.callSync("claimNotice", key, expiresAtMs);
	}
}
