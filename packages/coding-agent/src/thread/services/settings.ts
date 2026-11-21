/**
 * Settings across subagent worker links.
 *
 * Main side: every {@link Settings} instance (the global one, a subagent overlay, an isolated or
 * grant-authority view) crosses by reference under kind `"settings"`. The worker decodes it to one
 * canonical {@link Settings.mirror} per main instance: an in-memory replica seeded with the main
 * instance's own layers (a mirror of an overlay is an overlay of its parent's mirror), kept live by
 * coalesced state pushes after every own-layer change on main.
 *
 * Write routing: the main instance is the single writer. Every write on a mirror itself (`set`,
 * `override`, `unset`, entries, members, pins, model roles) is replayed synchronously on its main
 * instance — exactly what an in-process subagent touching that shared object does — and the mirror
 * adopts the returned state before the call returns. `flush`, `reloadFromDisk`, `reloadForCwd` and
 * `cloneForCwd` run on main too. Overlays created from a mirror in the worker
 * (`overlay`, `createSubagentSettings`, `restoreOverlay`) are ordinary local overlays: their own
 * writes stay in the worker, and they read through to the mirror live.
 *
 * Storage: a mirror's `getStorage()` is its main instance's agent.db handle as a remote
 * `"agent-storage"` object (exported by `./runtime`), so workers read and write main's database
 * without opening a second connection; overlays of the mirror share it as usual.
 *
 * Boot globals also carry main's global instance (installed as the worker's `settings` singleton),
 * the instance driving process-wide effects, and a `watch` subscription for capability provider
 * switches and the active rule snapshot.
 */
import { logger } from "@oh-my-pi/pi-utils";
import {
	installProviderSwitches,
	onProviderSwitchesChange,
	type ProviderSwitches,
	providerSwitches,
} from "../../capability";
import { getActiveRules, onActiveRulesChange, type Rule, setActiveRules } from "../../capability/rule";
import { type AnySetting, bindEffects, effectsSettings, lookup as lookupSetting } from "../../config/registry";
import {
	isSettingsInitialized,
	Settings,
	type SettingsMirrorRefresh,
	type SettingsMirrorState,
	type SettingsMirrorWrite,
} from "../../config/settings";
import type { AgentStorageApi } from "../../session/agent-storage";
import type { ThreadId } from "../identity";
import type { WorkerThreadLink } from "../protocol";
import { RpcClosedError, type RpcMethod, type RpcServe } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";

/** Worker-side receiver of main-instance states; returns `false` once its mirror was collected. */
export type SettingsMirrorListener = (state: SettingsMirrorState) => boolean | Promise<boolean>;

/** What a new worker mirror needs: the main instance's state and, for an overlay, its parent. */
export interface SettingsMirrorSeed {
	readonly state: SettingsMirrorState;
	readonly parent: Settings | null;
	/** The main instance's agent.db handle; crosses as a remote `"agent-storage"` object (see `./runtime`). */
	readonly storage: AgentStorageApi | null;
}

/** Remote-object protocol (kind `"settings"`) a worker mirror speaks to its main-thread instance. */
export type SettingsMirrorProtocol = {
	/** Subscribe `listener` to state pushes and return the current state, atomically. */
	attach: RpcMethod<[listener: SettingsMirrorListener], SettingsMirrorSeed>;
	/** Replay a mirror write; sync on main. */
	write: RpcMethod<[write: SettingsMirrorWrite], SettingsMirrorState>;
	refresh: RpcMethod<[refresh: SettingsMirrorRefresh], SettingsMirrorState>;
	cloneForCwd: RpcMethod<[cwd: string], Settings>;
};

/** A main-thread snapshot tagged with a sequence number; receivers drop ones not newer than the last. */
export interface Sequenced<T> {
	readonly seq: number;
	readonly value: T;
}

/** Snapshots returned by {@link SettingsThreadGlobals.watch}. */
export interface SettingsWatchSnapshot {
	readonly switches: Sequenced<ProviderSwitches>;
	readonly rules: Sequenced<readonly Rule[]>;
}

/** Boot globals of {@link settingsThreadService}. */
export interface SettingsThreadGlobals {
	/** Main's global singleton, or `null` when main never initialized one. */
	readonly global: Settings | null;
	/** Instance driving main's process-wide effects, if any. */
	readonly effects: Settings | null;
	/** Subscribe to provider-switch and active-rule changes; resolves with the current snapshots. */
	readonly watch: (
		onSwitches: (switches: Sequenced<ProviderSwitches>) => void,
		onRules: (rules: Sequenced<readonly Rule[]>) => void,
	) => SettingsWatchSnapshot | Promise<SettingsWatchSnapshot>;
}

const KIND = "settings";

// ─────────────────────────────────────────────────────────────────────────────
// Main side
// ─────────────────────────────────────────────────────────────────────────────

/** Unsubscribers of every push subscription a worker holds, by worker. */
const peerSubscriptions = new Map<ThreadId, Set<() => void>>();

let switchesSeq = 0;
let rulesSeq = 0;
const switchWatchers = new Set<() => void>();
const rulesWatchers = new Set<() => void>();
let processHooksInstalled = false;

function subscriptionsOf(threadId: ThreadId): Set<() => void> {
	let subscriptions = peerSubscriptions.get(threadId);
	if (!subscriptions) {
		subscriptions = new Set();
		peerSubscriptions.set(threadId, subscriptions);
	}
	return subscriptions;
}

/** One process-wide hook per source, fanning out to every worker's watchers. */
function installProcessHooks(): void {
	if (processHooksInstalled) return;
	processHooksInstalled = true;
	onProviderSwitchesChange(() => {
		switchesSeq++;
		for (const watcher of Array.from(switchWatchers)) watcher();
	});
	onActiveRulesChange(() => {
		rulesSeq++;
		for (const watcher of Array.from(rulesWatchers)) watcher();
	});
}

/** `push` once per microtask, however many times the returned trigger runs in between. */
function coalesce(push: () => void): () => void {
	let queued = false;
	return () => {
		if (queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			push();
		});
	};
}

/** Settles one push to a worker function: a closed link or a dead receiver ends the subscription. */
function settlePush(result: unknown, stop: () => void): void {
	Promise.resolve(result).then(
		alive => {
			if (alive === false) stop();
		},
		(error: unknown) => {
			if (error instanceof RpcClosedError) stop();
			else logger.warn("Settings thread push failed", { error: String(error) });
		},
	);
}

/** Registers `watcher` in `watchers` for the lifetime of `subscriptions`' worker. */
function subscribe(subscriptions: Set<() => void>, watchers: Set<() => void>, watcher: () => void): () => void {
	const stop = (): void => {
		watchers.delete(watcher);
		subscriptions.delete(stop);
	};
	watchers.add(watcher);
	subscriptions.add(stop);
	return stop;
}

function settingById(id: string): AnySetting {
	const setting = lookupSetting(id);
	if (!setting) throw new Error(`Unknown setting ${id}`);
	return setting;
}

/** Replays a worker mirror's write on its main instance. */
function replayWrite(target: Settings, write: SettingsMirrorWrite): void {
	switch (write.op) {
		case "writeValue":
			return target.writeValue(settingById(write.id), write.value, write.layer);
		case "unsetGlobalValue":
			return target.unsetGlobalValue(settingById(write.id));
		case "writeEntry":
			return target.writeEntry(settingById(write.id), write.key, write.value);
		case "writeMember":
			return target.writeMember(settingById(write.id), write.item, { member: write.member });
		case "pinDefaultValue":
			return target.pinDefaultValue(settingById(write.id));
		case "clearOverrideValue":
			return target.clearOverrideValue(settingById(write.id));
		case "setModelRole":
			return target.setModelRole(write.role, write.modelId);
		case "setProjectModelRole":
			return target.setProjectModelRole(write.role, write.modelId);
		case "clearProjectModelRole":
			return target.clearProjectModelRole(write.role);
		case "overrideModelRoles":
			return target.overrideModelRoles(write.roles);
	}
}

/** Runs a worker mirror's disk or scope operation on its main instance. */
function runRefresh(target: Settings, refresh: SettingsMirrorRefresh): Promise<void> {
	switch (refresh.op) {
		case "flush":
			return target.flush();
		case "reloadFromDisk":
			return target.reloadFromDisk({ includeParents: refresh.includeParents });
		case "reloadForCwd":
			return target.reloadForCwd(refresh.cwd);
	}
}

/** Main-side implementation of {@link SettingsMirrorProtocol} for one worker. */
function serveSettings(subscriptions: Set<() => void>): RpcServe<Settings, SettingsMirrorProtocol> {
	return {
		attach: (target, listener) => {
			const stop = (): void => {
				unsubscribe();
				subscriptions.delete(stop);
			};
			const unsubscribe = target.onLayersChange(
				coalesce(() => {
					if (subscriptions.has(stop)) settlePush(listener(target.mirrorState()), stop);
				}),
			);
			subscriptions.add(stop);
			return { state: target.mirrorState(), parent: target.overlayParent() ?? null, storage: target.getStorage() };
		},
		write: (target, write) => {
			replayWrite(target, write);
			return target.mirrorState();
		},
		refresh: async (target, refresh) => {
			await runRefresh(target, refresh);
			return target.mirrorState();
		},
		cloneForCwd: (target, cwd) => target.cloneForCwd(cwd),
	};
}

function mainGlobals(peer: WorkerPeer): SettingsThreadGlobals {
	const subscriptions = subscriptionsOf(peer.threadId);
	return {
		global: isSettingsInitialized() ? Settings.instance : null,
		effects: effectsSettings() ?? null,
		watch: (onSwitches, onRules) => {
			installProcessHooks();
			const stopSwitches = subscribe(
				subscriptions,
				switchWatchers,
				coalesce(() => settlePush(onSwitches({ seq: switchesSeq, value: providerSwitches() }), stopSwitches)),
			);
			const stopRules = subscribe(
				subscriptions,
				rulesWatchers,
				coalesce(() => settlePush(onRules({ seq: rulesSeq, value: getActiveRules() }), stopRules)),
			);
			return {
				switches: { seq: switchesSeq, value: providerSwitches() },
				rules: { seq: rulesSeq, value: getActiveRules() },
			};
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker side
// ─────────────────────────────────────────────────────────────────────────────

function isSettingsOrNull(value: unknown): value is Settings | null {
	return value === null || value instanceof Settings;
}

function isSettingsThreadGlobals(value: unknown): value is SettingsThreadGlobals {
	return (
		typeof value === "object" &&
		value !== null &&
		isSettingsOrNull(Reflect.get(value, "global")) &&
		isSettingsOrNull(Reflect.get(value, "effects")) &&
		typeof Reflect.get(value, "watch") === "function"
	);
}

/** Builds the worker's canonical mirror for one main instance and subscribes it to pushes. */
function importSettings(link: WorkerThreadLink): void {
	link.importClass<Settings, SettingsMirrorProtocol>(KIND, remote => {
		// Weak: main holds the listener until its next push finds the mirror collected.
		const cell: { mirror?: WeakRef<Settings> } = {};
		const listener = (state: SettingsMirrorState): boolean => {
			const target = cell.mirror?.deref();
			if (!target) return false;
			target.applyMirrorState(state);
			return true;
		};
		const seed = remote.callSync("attach", listener);
		const instance = Settings.mirror(
			{
				write: write => remote.callSync("write", write),
				refresh: refresh => remote.call("refresh", refresh),
				cloneForCwd: cwd => remote.call("cloneForCwd", cwd),
				storage: seed.storage,
			},
			seed.state,
			seed.parent ?? undefined,
		);
		cell.mirror = new WeakRef(instance);
		return instance;
	});
}

async function bootWorker(globals: unknown): Promise<void> {
	if (!isSettingsThreadGlobals(globals)) throw new Error("settings thread service: malformed boot globals");
	if (globals.global) Settings.installGlobalMirror(globals.global);
	if (globals.effects && globals.effects !== globals.global) bindEffects(globals.effects);
	let lastSwitches = -1;
	let lastRules = -1;
	const onSwitches = (switches: Sequenced<ProviderSwitches>): void => {
		if (switches.seq <= lastSwitches) return;
		lastSwitches = switches.seq;
		installProviderSwitches(switches.value);
	};
	const onRules = (rules: Sequenced<readonly Rule[]>): void => {
		if (rules.seq <= lastRules) return;
		lastRules = rules.seq;
		setActiveRules(rules.value);
	};
	const current = await globals.watch(onSwitches, onRules);
	onSwitches(current.switches);
	onRules(current.rules);
}

/**
 * Settings, capability provider switches and active rules for subagent workers; see the module
 * doc for the mirror protocol and write routing.
 */
export const settingsThreadService: ThreadService = {
	name: KIND,
	installMain(peer) {
		peer.link.exportClass<Settings, SettingsMirrorProtocol>(
			KIND,
			(value): value is Settings => value instanceof Settings,
			serveSettings(subscriptionsOf(peer.threadId)),
		);
	},
	globals: mainGlobals,
	onWorkerExit(peer) {
		const subscriptions = peerSubscriptions.get(peer.threadId);
		peerSubscriptions.delete(peer.threadId);
		for (const stop of Array.from(subscriptions ?? [])) stop();
	},
	installWorker: importSettings,
	boot: bootWorker,
};
