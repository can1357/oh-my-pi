/**
 * The settings store: the single writer of every settings document — the main config of an agent
 * directory (`config.yml`/`config.yaml`) and a project's native `.omp/settings.json` +
 * `.omp/config.yml`. Every omp process opens, subscribes to, and writes those documents through a
 * {@link SettingsStore} peer; none of them touches the files. Having one writer per user is the
 * whole concurrency contract, so no file is ever locked: a save re-reads the file, merges the
 * pending paths into what it holds, and replaces it atomically, and writes staged meanwhile stay
 * pending for the next save. `--config` overlays and runtime overrides never reach the store; they
 * stay local to each process.
 *
 * The store also runs inside the per-user daemon, so this module depends on neither the settings
 * registry nor capability discovery (only the registry-free parser of native settings files): it
 * moves raw trees and leaves validating and merging them to its clients.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { pollFile } from "@oh-my-pi/pi-natives/file-poll";
import {
	getAgentDbPath,
	getLastChangelogVersionPath,
	getProjectAgentDir,
	isEnoent,
	isRecord,
	logger,
	MAIN_CONFIG_FILENAMES,
} from "@oh-my-pi/pi-utils";
import { stringifyYamlConfig } from "@oh-my-pi/pi-utils/yaml-config";
import { JSONC, YAML } from "bun";
import {
	NATIVE_PROVIDER_DISPLAY_NAME,
	NATIVE_PROVIDER_ID,
	readNativeSettingsFiles,
} from "../discovery/native-settings";
import { writeFileAtomically } from "../utils/atomic-file";
import {
	deleteByPath,
	getByPath,
	isPathPrefix,
	type RawSettings,
	setByPath,
	setOwn,
	settingValuesEqual,
} from "./raw-settings";
import { migrateRawSettings } from "./settings-migrations";
import {
	loadYamlSettings,
	quarantineInvalidYaml,
	readYamlGeneration,
	resolveYamlWritePath,
	unwrapYamlLoad,
	type YamlGeneration,
	type YamlLoadResult,
	yamlGenerationOf,
	yamlGenerationsMatch,
} from "./settings-yaml";

// ═══════════════════════════════════════════════════════════════════════════
// Protocol
// ═══════════════════════════════════════════════════════════════════════════

/** Identity of a settings document; the store resolves the path, and the keys it emits are resolved. */
export type SettingsDocKey = { kind: "global"; agentDir: string } | { kind: "project"; cwd: string };

/** One parsed project settings file and the provider that owns it. */
export interface ProjectSettingsItem {
	provider: string;
	path: string;
	data: RawSettings;
}

/** A global document: the main config path it reads and writes, and its tree, pending writes included. */
export interface GlobalDocState {
	configPath: string | null;
	settings: RawSettings;
}

/** A project document: its settings files in merge order, the native config's model roles (pending writes included), and parse warnings. */
export interface ProjectDocState {
	items: ProjectSettingsItem[];
	nativeModelRoles: unknown;
	warnings: string[];
}

/** One change to a document: set `value` at `segments`, or remove what is there (`remove`, or no value). */
export interface SettingsWrite {
	segments: string[];
	value?: unknown;
	remove?: boolean;
}

/** A document's state as one peer sees it; `acked` is the highest `write` seq of that peer the state includes. States are shared snapshots: never mutate one. */
export interface SettingsDocUpdate {
	doc: SettingsDocKey;
	state: GlobalDocState | ProjectDocState;
	acked: number;
}

/** Messages a peer sends the store. */
export type SettingsUp =
	| { t: "open"; id: string; doc: SettingsDocKey; mode: "read" | "write"; watch?: boolean }
	| { t: "close"; doc: SettingsDocKey }
	| { t: "watch"; doc: SettingsDocKey; watch: boolean }
	| { t: "write"; doc: SettingsDocKey; seq: number; writes: SettingsWrite[] }
	| { t: "flush"; id: string; doc: SettingsDocKey }
	| { t: "reload"; id: string; doc: SettingsDocKey };

/** Messages the store sends a peer: the answer to a request (`id`), or a pushed document update. */
export type SettingsDown =
	| { t: "reply"; id: string; doc?: SettingsDocUpdate; error?: string }
	| { t: "doc"; doc: SettingsDocUpdate };

/** One client of a {@link SettingsStore}: `handle` takes its messages, `send` delivers the store's. */
export interface SettingsStorePeer {
	send(message: SettingsDown): void;
	handle(message: SettingsUp): void;
}

/** `tree` with `writes` applied; always a copy. */
export function applySettingWrites(tree: RawSettings, writes: readonly SettingsWrite[]): RawSettings {
	const next = structuredClone(tree);
	for (const write of writes) {
		if (!isSegments(write.segments)) continue;
		applyValue(next, write.segments, write.remove ? undefined : structuredClone(write.value));
	}
	return next;
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Quiet period after the last write before a document is saved. */
const SAVE_DEBOUNCE_MS = 100;
/** Quiet period after the last config-file change before a watched document is re-read. */
const WATCH_DEBOUNCE_MS = 200;
/** Stat-poll interval of a watched document's files. */
const POLL_INTERVAL_MS = 500;
/** How long a project document nobody subscribes to stays loaded. */
const EVICT_IDLE_MS = 10 * 60_000;

type DocMode = "read" | "write";
/** How a re-read treats files that fail to load: `strict` throws, `keep` logs and keeps the last good state. */
type RefreshMode = "strict" | "keep";
type ReadableLoad = Extract<YamlLoadResult, { kind: "loaded" | "missing" }>;

/** A pending global write: its path, the config file generation it was made against, and the value it replaced. */
interface PendingMutation {
	segments: readonly string[];
	generation: YamlGeneration;
	base: unknown;
}

function isSegments(segments: unknown): segments is string[] {
	return Array.isArray(segments) && segments.length > 0 && segments.every(segment => typeof segment === "string");
}

/** Sets `value` at `segments` of `tree`; `undefined` removes what is there. */
function applyValue(tree: RawSettings, segments: readonly string[], value: unknown): void {
	if (value === undefined) deleteByPath(tree, segments);
	else setByPath(tree, segments, value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `result` when the file loaded or is missing.
 *
 * @throws Error naming `filePath` for an invalid or unreadable file.
 */
function readableLoad(filePath: string, result: YamlLoadResult): ReadableLoad {
	if (result.kind === "loaded" || result.kind === "missing") return result;
	unwrapYamlLoad(filePath, result);
	throw new Error(`Failed to load settings config ${filePath}`);
}

/**
 * Moves the invalid config at `filePath` aside, re-reading it first where a save would write it.
 * Returns only when that read finds the file valid again (the caller then reads it afresh).
 *
 * @throws Error naming the file and its backup, or the reason it could not be moved.
 */
async function quarantineInvalidConfig(filePath: string): Promise<void> {
	const writePath = await resolveYamlWritePath(filePath);
	const result = await loadYamlSettings(writePath);
	if (result.kind === "missing") {
		throw new Error(`Settings config was invalid and is now missing: ${filePath}; something else moved it aside`);
	}
	unwrapYamlLoad(filePath, result.kind === "invalid" ? await quarantineInvalidYaml(writePath, result) : result);
}

/**
 * Reads the config a save is about to replace at `writePath`. An invalid file is moved aside
 * first (`onQuarantine` gets the path it left), so the save can never truncate the only copy.
 *
 * @throws Error for an invalid (now quarantined) or unreadable file.
 */
async function loadForSave(
	filePath: string,
	writePath: string,
	onQuarantine: (target: string) => void,
	onLegacyChangelogVersion?: (version: string) => void,
): Promise<{ settings: RawSettings | null; generation: YamlGeneration }> {
	let result = await loadYamlSettings(writePath, onLegacyChangelogVersion);
	const generation = yamlGenerationOf(result);
	if (result.kind === "invalid") {
		result = await quarantineInvalidYaml(writePath, result);
		onQuarantine(writePath);
	}
	return { settings: unwrapYamlLoad(filePath, result), generation };
}

/** Text of `filePath`, uncached; `null` when it is absent or cannot be read. */
async function readOptional(filePath: string): Promise<string | null> {
	try {
		return await fs.promises.readFile(filePath, "utf8");
	} catch (error) {
		if (!isEnoent(error)) {
			logger.debug("Settings: unreadable settings file", { path: filePath, error: String(error) });
		}
		return null;
	}
}

/**
 * Whether the pending global change `mutation` at `segments` still applies to the config file read
 * as `current` at `generation`: the file is the generation the change was captured at, or holds the captured
 * value there apart from the subtrees at `written`, the paths the save writes itself. Those vouch for
 * their own subtrees: a whole record's captured value may hold a pending write of one of its entries, and an entry
 * of a record written whole was written at its latest value.
 */
function pendingChangeApplies(
	mutation: PendingMutation,
	segments: readonly string[],
	current: RawSettings,
	generation: YamlGeneration,
	written: readonly (readonly string[])[],
): boolean {
	if (mutation.generation.kind === "unreadable") return false;
	if (yamlGenerationsMatch(mutation.generation, generation)) return true;
	const onDisk: RawSettings = { value: getByPath(current, segments) };
	const captured: RawSettings = { value: mutation.base };
	for (const writtenPath of written) {
		if (isPathPrefix(writtenPath, segments)) return true;
		if (!isPathPrefix(segments, writtenPath)) continue;
		const inner = ["value", ...writtenPath.slice(segments.length)];
		deleteByPath(onDisk, inner);
		deleteByPath(captured, inner);
	}
	return settingValuesEqual(onDisk.value, captured.value);
}

/** The main config as one batch of writes found it: its generation, and its tree parsed on first use. */
class DiskView {
	readonly generation: YamlGeneration;
	#parsed: { root: unknown } | "unparseable" | undefined;

	constructor(filePath: string) {
		this.generation = readYamlGeneration(filePath);
	}

	/**
	 * Whether the file already holds `value` at `segments` (`undefined`: nothing there). An
	 * unparseable, unreadable, or legacy-shaped file reports false, and so does a value with no file.
	 */
	holds(segments: readonly string[], value: unknown): boolean {
		if (this.generation.kind === "missing") return value === undefined;
		if (this.generation.kind === "unreadable") return false;
		if (this.#parsed === undefined) {
			try {
				this.#parsed = { root: YAML.parse(this.generation.source) };
			} catch {
				this.#parsed = "unparseable";
			}
		}
		if (this.#parsed === "unparseable") return false;
		const { root } = this.#parsed;
		return settingValuesEqual(isRecord(root) ? getByPath(root, segments) : undefined, value);
	}
}

/** `overrides` deep-merged over `base`: keys in `overrides` order, then base-only keys; arrays replace. */
function mergeLegacySettings(base: RawSettings, overrides: RawSettings): RawSettings {
	const result: RawSettings = {};
	for (const key in overrides) {
		const override = overrides[key];
		if (override === undefined) continue;
		const baseValue = Object.hasOwn(base, key) ? base[key] : undefined;
		const merged = isRecord(override) && isRecord(baseValue) ? mergeLegacySettings(baseValue, override) : override;
		setOwn(result, key, merged);
	}
	for (const key in base) if (!Object.hasOwn(result, key)) setOwn(result, key, base[key]);
	return result;
}

/**
 * Settings older installs kept in agent.db's `settings` table: per-key JSON rows, or before that
 * one JSON blob in the `data` column of row 1. `null` when the database, the table, or its rows
 * are absent. Opens the database read-only, so reading never creates or alters it.
 */
function readLegacyDbSettings(dbPath: string): RawSettings | null {
	if (!fs.existsSync(dbPath)) return null;
	const db = new Database(dbPath, { readonly: true });
	try {
		db.run("PRAGMA busy_timeout = 5000");
		using infoStmt = db.prepare("PRAGMA table_info(settings)");
		const columns = new Set((infoStmt.all() as { name?: string }[]).map(column => column.name));
		if (columns.has("key") && columns.has("value")) {
			using rowsStmt = db.prepare("SELECT key, value FROM settings");
			const rows = rowsStmt.all() as { key: string; value: string }[];
			if (rows.length === 0) return null;
			const settings: RawSettings = {};
			for (const row of rows) {
				try {
					setOwn(settings, row.key, JSON.parse(row.value));
				} catch (error) {
					logger.warn("Settings: failed to parse legacy agent.db setting", { key: row.key, error: String(error) });
				}
			}
			return settings;
		}
		if (!columns.has("data")) return null;
		using blobStmt = db.prepare("SELECT data FROM settings WHERE id = 1");
		const row = blobStmt.get() as { data?: string } | null;
		if (!row?.data) return null;
		const parsed: unknown = JSON.parse(row.data);
		if (isRecord(parsed)) return parsed;
		logger.warn("Settings: ignoring non-object legacy agent.db settings", { path: dbPath });
		return null;
	} finally {
		db.close();
	}
}

/** Drops the legacy agent.db settings rows once config.yml holds them, so a deleted config never resurrects them. */
function clearLegacyDbSettings(dbPath: string): void {
	const db = new Database(dbPath, { readwrite: true });
	try {
		db.run("PRAGMA busy_timeout = 5000");
		db.run("DELETE FROM settings");
	} finally {
		db.close();
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Peers
// ═══════════════════════════════════════════════════════════════════════════

class Peer implements SettingsStorePeer {
	#sink: ((message: SettingsDown) => void) | undefined;
	#dispatch: (peer: Peer, message: SettingsUp) => void;

	constructor(sink: (message: SettingsDown) => void, dispatch: (peer: Peer, message: SettingsUp) => void) {
		this.#sink = sink;
		this.#dispatch = dispatch;
	}

	/** Whether the store removed this peer; nothing is delivered to it any more. */
	get closed(): boolean {
		return this.#sink === undefined;
	}

	send(message: SettingsDown): void {
		try {
			this.#sink?.(message);
		} catch (error) {
			// One broken sink must not cut a broadcast short for the other subscribers.
			logger.warn("Settings: failed to deliver a store message", { error: String(error) });
		}
	}

	handle(message: SettingsUp): void {
		this.#dispatch(this, message);
	}

	close(): void {
		this.#sink = undefined;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Documents
// ═══════════════════════════════════════════════════════════════════════════

/** One peer's subscription to a document. */
interface Subscription {
	/** Whether the peer asked for file watching, and so for every change of the state. */
	watch: boolean;
	/** Revision of the state last pushed to the peer or returned by its `open`; -1 before that. */
	revision: number;
	/** Whether the next push goes to the peer even if it does not watch: it carries its ack, or a change it caused. */
	due: boolean;
}

/**
 * What every document shares: its subscribers and their acks, the queue that runs its disk work one
 * operation at a time, the debounced save, coalesced pushes, and file watching. A subclass owns
 * the files: how they load, how writes stage, and how a save merges them.
 *
 * Pushes follow subscription intent. A changed state goes to every watching subscriber and to the
 * peer that caused the change (its write, the save of its writes, its reload); a peer that does not
 * watch never sees what another peer or an external edit changed until it asks or writes. A write
 * is always answered to its writer, changed state or not, since the push carries its ack.
 *
 * Writes apply to the live state at once and are saved later; everything that reads or writes the
 * files runs through the queue, so a save, a reload, and a watch read never interleave.
 */
abstract class SettingsDoc {
	readonly key: SettingsDocKey;
	#onIdle: (doc: SettingsDoc) => void;
	/** Subscribed peers. */
	#subscribers = new Map<Peer, Subscription>();
	/** Peers whose staged writes no save has taken yet. */
	#writers = new Set<Peer>();
	/** Peers whose writes the running save is writing. */
	#saving = new Set<Peer>();
	/** Peer whose reload is running. */
	#requester: Peer | undefined;
	/** Peers that caused what changed the state since it was last compared; they are owed it if it differs. */
	#causes = new Set<Peer>();
	/** Highest `write` seq processed per peer on this document. */
	#acked = new Map<Peer, number>();
	#tail: Promise<void> = Promise.resolve();
	/** Queued and running disk operations. */
	#ops = 0;
	#loaded = false;
	/** Whether a write-mode open ran, so one-time migration is done and writes may stage. */
	#writable = false;
	/** Writes waiting in the queue for a load; later writes line up behind them to keep their order. */
	#deferredWrites = 0;
	#disposed = false;
	#snapshot: GlobalDocState | ProjectDocState | undefined;
	/** Whether the live state may differ from {@link #snapshot}. */
	#stale = false;
	/** Bumped whenever {@link #snapshot} is replaced by a state that differs from it. */
	#revision = 0;
	#pushQueued = false;
	#saveTimer: NodeJS.Timeout | undefined;
	#watchers = 0;
	#polls: (() => void)[] = [];
	#watchTimer: NodeJS.Timeout | undefined;

	constructor(key: SettingsDocKey, onIdle: (doc: SettingsDoc) => void) {
		this.key = key;
		this.#onIdle = onIdle;
	}

	/** Whether writes are staged that no save has written yet. */
	abstract get pending(): boolean;
	/** Every file the document reads; missing ones are polled too, so their creation is seen. */
	abstract watchPaths(): string[];
	/**
	 * Replaces the state with the files' content. Write mode moves an invalid config aside and runs
	 * one-time migration.
	 *
	 * @throws Error when a config is invalid or unreadable; the state is left as it was.
	 */
	abstract load(mode: DocMode): Promise<void>;
	/** Finishes what a write-mode {@link load} does beyond reading, for a document loaded read-only. */
	abstract upgrade(): Promise<void>;
	/** Whether the files still hold the bytes the state was read from. */
	abstract unchanged(): Promise<boolean>;
	/**
	 * Saves pending writes (a failure leaves them pending and re-applied), then re-reads the files and
	 * adopts them; files that did not change are not parsed again.
	 *
	 * @throws Error in `strict` mode when a config is invalid or unreadable; the state is left as it was.
	 */
	abstract refresh(mode: RefreshMode): Promise<void>;
	/** Applies `writes` to the live state and marks them pending; false when every one was a no-op. */
	abstract stage(writes: readonly SettingsWrite[]): boolean;
	/**
	 * Writes the pending writes into the config file.
	 *
	 * @throws Error when the file cannot be read or written; the writes stay pending.
	 */
	abstract save(): Promise<void>;
	/** A copy of the live state that later writes never touch. */
	abstract snapshot(): GlobalDocState | ProjectDocState;

	get loaded(): boolean {
		return this.#loaded;
	}

	get subscribed(): boolean {
		return this.#subscribers.size > 0;
	}

	/** Whether no disk operation is queued or running. */
	get idle(): boolean {
		return this.#ops === 0;
	}

	/** The state as `peer` sees it. */
	update(peer: Peer): SettingsDocUpdate {
		return { doc: this.key, state: this.#current(), acked: this.#acked.get(peer) ?? 0 };
	}

	/** The state may have changed (a read was adopted): if it did, the peers it is due are told. */
	changed(): void {
		if (this.#requester) this.#causes.add(this.#requester);
		this.#stale = true;
		this.#schedulePush();
	}

	/** A save took the pending writes; call when it snapshots them. */
	saving(): void {
		for (const peer of this.#writers) this.#saving.add(peer);
		this.#writers.clear();
	}

	/** The save wrote them: a state it changed (an external edit merged in) is due their writers too. */
	saved(): void {
		for (const peer of this.#saving) this.#causes.add(peer);
		this.#saving.clear();
		if (!this.pending) this.#writers.clear();
		this.changed();
	}

	/** The save failed; its writes are pending again. */
	unsaved(): void {
		for (const peer of this.#saving) this.#writers.add(peer);
		this.#saving.clear();
	}

	/**
	 * The shared snapshot of the live state. A state that differs from the previous snapshot (ordered
	 * deep equality) is a new revision, due to every peer that caused a change since the last comparison.
	 */
	#current(): GlobalDocState | ProjectDocState {
		if (this.#snapshot === undefined || this.#stale) {
			this.#stale = false;
			const next = this.snapshot();
			if (this.#snapshot === undefined || !settingValuesEqual(this.#snapshot, next)) {
				this.#snapshot = next;
				this.#revision++;
				for (const peer of this.#causes) {
					const subscription = this.#subscribers.get(peer);
					if (subscription) subscription.due = true;
				}
			}
			this.#causes.clear();
		}
		return this.#snapshot;
	}

	/**
	 * Pushes the state, once per microtask however often it is asked, to each subscriber that is due
	 * it or that watches and holds an older revision. Nobody else is told.
	 */
	#schedulePush(): void {
		if (this.#pushQueued) return;
		this.#pushQueued = true;
		queueMicrotask(() => {
			this.#pushQueued = false;
			if (this.#disposed) return;
			this.#current();
			for (const [peer, subscription] of this.#subscribers) {
				if (!subscription.due && !(subscription.watch && subscription.revision !== this.#revision)) continue;
				const update = this.update(peer);
				subscription.due = false;
				subscription.revision = this.#revision;
				peer.send({ t: "doc", doc: update });
			}
		});
	}

	/** Loads or freshens the document for `peer`, subscribes it, and replies with the state. Opening again is idempotent. */
	open(peer: Peer, id: string, mode: DocMode, watch: boolean | undefined): void {
		void this.#exclusive(async () => {
			try {
				await this.#prepare(mode, true);
			} catch (error) {
				peer.send({ t: "reply", id, error: errorMessage(error) });
				return;
			}
			if (!peer.closed) {
				if (!this.#subscribers.has(peer)) this.#subscribers.set(peer, { watch: false, revision: -1, due: false });
				if (watch !== undefined) this.#setWatch(peer, watch);
			}
			const update = this.update(peer);
			const subscription = this.#subscribers.get(peer);
			if (subscription) subscription.revision = this.#revision;
			peer.send({ t: "reply", id, doc: update });
		});
	}

	/** Ends `peer`'s subscription and forgets its acks. */
	close(peer: Peer): void {
		this.#ordered(() => {
			this.#acked.delete(peer);
			this.#writers.delete(peer);
			this.#saving.delete(peer);
			this.#causes.delete(peer);
			const subscription = this.#subscribers.get(peer);
			if (subscription === undefined) return;
			this.#subscribers.delete(peer);
			if (subscription.watch) {
				this.#watchers--;
				this.#syncPolls();
			}
			if (this.#subscribers.size === 0 && this.#ops === 0) this.#onIdle(this);
		});
	}

	/** Turns file watching on or off for subscriber `peer`. */
	watch(peer: Peer, watch: boolean): void {
		this.#ordered(() => this.#setWatch(peer, watch));
	}

	/** Applies `writes` from `peer` and acks `seq` to it; a changed state also goes to the watching subscribers. */
	write(peer: Peer, seq: number, writes: readonly SettingsWrite[]): void {
		if (this.#disposed) return;
		if (this.#loaded && this.#writable && this.#deferredWrites === 0) {
			this.#apply(peer, seq, writes);
			return;
		}
		// Not open for writing yet: load (and migrate) first, so the write merges into the real config.
		this.#deferredWrites++;
		void this.#exclusive(async () => {
			try {
				await this.#prepare("write", false);
				this.#apply(peer, seq, writes);
			} catch (error) {
				logger.warn("Settings: dropped a write to a document that failed to load", {
					doc: this.key,
					error: String(error),
				});
			} finally {
				this.#deferredWrites--;
			}
		});
	}

	/** Resolves once every write staged so far is on disk. */
	flush(): Promise<void> {
		clearTimeout(this.#saveTimer);
		this.#saveTimer = undefined;
		return this.#exclusive(() => this.save());
	}

	/** {@link flush}, answered to `peer`. */
	requestFlush(peer: Peer, id: string): void {
		this.flush().then(
			() => peer.send(this.#loaded ? { t: "reply", id, doc: this.update(peer) } : { t: "reply", id }),
			(error: unknown) => peer.send({ t: "reply", id, error: errorMessage(error) }),
		);
	}

	/**
	 * Re-reads the files strictly: a failure is answered to `peer` and changes nothing; a state the
	 * read changed is pushed to `peer` and the watching subscribers.
	 */
	reload(peer: Peer, id: string): void {
		void this.#exclusive(async () => {
			this.#requester = peer;
			try {
				if (!this.#loaded) throw new Error("Settings document is not open");
				await this.refresh("strict");
			} catch (error) {
				peer.send({ t: "reply", id, error: errorMessage(error) });
				return;
			} finally {
				this.#requester = undefined;
			}
			peer.send({ t: "reply", id, doc: this.update(peer) });
		});
	}

	/** Stops timers and polls and drops every subscriber; pending writes are not saved. */
	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#saveTimer);
		this.#saveTimer = undefined;
		this.#subscribers.clear();
		this.#acked.clear();
		this.#writers.clear();
		this.#saving.clear();
		this.#causes.clear();
		this.#watchers = 0;
		this.#syncPolls();
	}

	/**
	 * Brings the document to a state an open may hand out. An open nobody else is subscribed to is a
	 * cold load (unless the files are untouched): nothing holds the last good state, so an invalid
	 * config fails it. With subscribers, a changed file is adopted and an invalid one keeps the
	 * last good state. Pending writes postpone any re-read to their save.
	 */
	async #prepare(mode: DocMode, freshen: boolean): Promise<void> {
		if (this.#disposed) throw new Error("Settings store is closed");
		let fresh = !freshen;
		if (freshen && this.#loaded && this.#subscribers.size === 0 && !this.pending) {
			fresh = await this.unchanged();
			if (!fresh) this.#loaded = false;
		}
		if (!this.#loaded) {
			this.#writable = false;
			await this.load(mode);
			this.#loaded = true;
			this.#writable = mode === "write";
			return;
		}
		if (mode === "write" && !this.#writable) {
			await this.upgrade();
			this.#writable = true;
			fresh = false;
		}
		if (!fresh && !this.pending) await this.refresh("keep");
	}

	#apply(peer: Peer, seq: number, writes: readonly SettingsWrite[]): void {
		if (this.stage(writes)) {
			this.#stale = true;
			if (!peer.closed) {
				this.#writers.add(peer);
				this.#causes.add(peer);
			}
			this.#queueSave();
		}
		if (!peer.closed && seq > (this.#acked.get(peer) ?? 0)) this.#acked.set(peer, seq);
		// The writer is told whatever the batch did: the push carries the ack that prunes its journal.
		const subscription = this.#subscribers.get(peer);
		if (subscription) subscription.due = true;
		this.#schedulePush();
	}

	#queueSave(): void {
		clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			this.#exclusive(() => this.save()).catch((error: unknown) => {
				logger.warn("Settings: background save failed", { error: String(error) });
			});
		}, SAVE_DEBOUNCE_MS);
	}

	/** Runs `op` after every disk operation queued before it. */
	#exclusive<T>(op: () => Promise<T>): Promise<T> {
		this.#ops++;
		const run = this.#tail.then(op);
		const settle = (): void => {
			if (--this.#ops === 0 && this.#subscribers.size === 0) this.#onIdle(this);
		};
		this.#tail = run.then(settle, settle);
		return run;
	}

	/** Runs `change` now, or behind the queued operations when there are any (an open still in flight comes first). */
	#ordered(change: () => void): void {
		if (this.#ops === 0) change();
		else void this.#exclusive(async () => change());
	}

	#setWatch(peer: Peer, watch: boolean): void {
		const subscription = this.#subscribers.get(peer);
		if (subscription === undefined || subscription.watch === watch) return;
		subscription.watch = watch;
		this.#watchers += watch ? 1 : -1;
		this.#syncPolls();
		// A peer that starts watching catches up on what it was not told meanwhile.
		if (watch) this.#schedulePush();
	}

	/** Polls the files while any subscriber watches. */
	#syncPolls(): void {
		if (this.#watchers > 0 && !this.#disposed) {
			if (this.#polls.length > 0) return;
			for (const file of this.watchPaths()) {
				this.#polls.push(pollFile(file, this.#scheduleWatchRead, POLL_INTERVAL_MS));
			}
			// The state was last read before the polls took their first stat, which is their baseline:
			// an edit in between raises no change. Read once more so it is not lost.
			this.#scheduleWatchRead();
			return;
		}
		for (const stop of this.#polls) stop();
		this.#polls = [];
		clearTimeout(this.#watchTimer);
		this.#watchTimer = undefined;
	}

	#scheduleWatchRead = (): void => {
		clearTimeout(this.#watchTimer);
		this.#watchTimer = setTimeout(() => {
			this.#watchTimer = undefined;
			if (this.#watchers === 0) return;
			this.#exclusive(() => this.refresh("keep")).catch((error: unknown) => {
				logger.warn("Settings: failed to apply on-disk config change", { error: String(error) });
			});
		}, WATCH_DEBOUNCE_MS);
		this.#watchTimer.unref();
	};
}

/** The main config of one agent directory: `config.yml`, or `config.yaml` when only that exists. */
class GlobalDoc extends SettingsDoc {
	#agentDir: string;
	/** The main config in use: the first candidate present, `config.yml` when there is none. */
	#configPath: string;
	/** The live tree: the file as last read or saved, plus every pending write. */
	#settings: RawSettings = {};
	/** Bytes of the config {@link #settings} was read from or saved as; `null` when there was no file. */
	#source: string | null = null;
	/** Pending writes by `JSON.stringify(segments)`, in the order they were first made. */
	#modified = new Map<string, PendingMutation>();
	/** Bumped by every staged write, so a re-read can tell a write landed while it was reading. */
	#mutations = 0;
	/** Where the invalid config a save moved aside lived; the next save recreates it there. */
	#quarantinedTarget: string | undefined;
	/** Retired `lastChangelogVersion` found in a config or a legacy source, for the marker file. */
	#legacyChangelogVersion: string | undefined;

	constructor(agentDir: string, onIdle: (doc: SettingsDoc) => void) {
		super({ kind: "global", agentDir }, onIdle);
		this.#agentDir = agentDir;
		this.#configPath = path.join(agentDir, MAIN_CONFIG_FILENAMES[0]);
	}

	override get pending(): boolean {
		return this.#modified.size > 0;
	}

	override watchPaths(): string[] {
		return MAIN_CONFIG_FILENAMES.map(filename => path.join(this.#agentDir, filename));
	}

	override snapshot(): GlobalDocState {
		return { configPath: this.#configPath, settings: structuredClone(this.#settings) };
	}

	override async load(mode: DocMode): Promise<void> {
		let read = await this.#readMain();
		if (mode === "write") {
			if (read.result.kind === "invalid") {
				await quarantineInvalidConfig(read.configPath);
				read = await this.#readMain();
			}
			if (read.result.kind === "missing") {
				await this.#migrateLegacy();
				read = await this.#readMain();
			}
		}
		const result = readableLoad(read.configPath, read.result);
		this.#quarantinedTarget = undefined;
		this.#adopt(read.configPath, result);
		if (mode === "write") await this.#seedLastChangelogVersionMarker();
	}

	override async upgrade(): Promise<void> {
		const { result } = await this.#readMain();
		if (result.kind === "missing" && this.#quarantinedTarget === undefined) await this.#migrateLegacy();
		await this.#seedLastChangelogVersionMarker();
	}

	override async unchanged(): Promise<boolean> {
		for (const filename of MAIN_CONFIG_FILENAMES) {
			const configPath = path.join(this.#agentDir, filename);
			let source: string;
			try {
				source = await fs.promises.readFile(configPath, "utf8");
			} catch (error) {
				if (isEnoent(error)) continue;
				return false;
			}
			return configPath === this.#configPath && source === this.#source;
		}
		return this.#source === null;
	}

	override async refresh(mode: RefreshMode): Promise<void> {
		for (;;) {
			try {
				await this.save();
			} catch (error) {
				// The failed writes stay pending for the next save and are re-applied over the tree read
				// below, so an unwritable config never blocks a reload or reverts them.
				logger.warn("Settings: reloading over unsaved changes", { error: String(error) });
			}
			const mutations = this.#mutations;
			if (await this.unchanged()) return;
			const read = await this.#readMain();
			if (mutations !== this.#mutations) continue;
			let result: ReadableLoad;
			try {
				result = readableLoad(read.configPath, read.result);
			} catch (error) {
				if (mode === "strict") throw error;
				logger.warn("Settings: keeping last good config; on-disk change failed to load", { error: String(error) });
				return;
			}
			// A config a save moved aside as invalid reads as missing until a save recreates it; the
			// live tree is its last good content.
			if (result.kind === "missing" && this.#quarantinedTarget !== undefined) return;
			this.#adopt(read.configPath, result);
			return;
		}
	}

	override stage(writes: readonly SettingsWrite[]): boolean {
		let disk: DiskView | undefined;
		let staged = false;
		for (const write of writes) {
			const { segments } = write;
			if (!isSegments(segments)) {
				logger.warn("Settings: ignored a write without a setting path", { doc: this.key });
				continue;
			}
			const value = write.remove ? undefined : write.value;
			const live = getByPath(this.#settings, segments);
			disk ??= new DiskView(this.#configPath);
			// Nothing to do when the live tree and the file both hold the value already; an externally
			// edited file does not, so the write is staged and the save merges as usual.
			if (settingValuesEqual(live, value) && disk.holds(segments, value)) continue;
			this.#modified.set(JSON.stringify(segments), {
				segments,
				generation: disk.generation,
				base: structuredClone(live),
			});
			applyValue(this.#settings, segments, structuredClone(value));
			this.#mutations++;
			staged = true;
		}
		return staged;
	}

	override async save(): Promise<void> {
		if (this.#modified.size === 0) return;
		const configPath = this.#configPath;
		const snapshot = [...this.#modified];
		this.#modified.clear();
		this.saving();

		try {
			await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
			const writePath = await resolveYamlWritePath(configPath, this.#quarantinedTarget);
			// Re-read to preserve external changes. If a save moved a malformed file aside, recover from
			// the live tree rather than recreating the config from only the pending paths.
			const loaded = await loadForSave(
				configPath,
				writePath,
				target => {
					this.#quarantinedTarget = target;
				},
				this.#captureChangelogVersion,
			);
			const current =
				loaded.settings ?? (this.#quarantinedTarget !== undefined ? structuredClone(this.#settings) : {});
			const writtenPaths: (readonly string[])[] = [];

			// Apply pending changes unless a newer file generation also changed that setting. Disjoint
			// external edits still merge. Values are copied: writes keep editing the live tree while
			// this save awaits the file.
			for (const [, mutation] of snapshot) {
				const { segments } = mutation;
				if (!pendingChangeApplies(mutation, segments, current, loaded.generation, writtenPaths)) {
					logger.warn("Settings: skipped stale change after external config edit", {
						path: configPath,
						setting: segments.join("."),
					});
					continue;
				}
				applyValue(current, segments, structuredClone(getByPath(this.#settings, segments)));
				writtenPaths.push(segments);
			}

			let source = loaded.generation.kind === "content" ? loaded.generation.source : null;
			if (writtenPaths.length > 0) {
				// Merging pending changes can reproduce the file exactly (a change reverted before the
				// debounce fired, an external edit that already holds the value): leave it untouched.
				const content = stringifyYamlConfig(current);
				if (content !== source) await writeFileAtomically(writePath, content);
				source = content;
			}
			this.#quarantinedTarget = undefined;

			// This save changed the file only at `writtenPaths`. A change staged after its snapshot at an
			// overlapping path (the same one, an entry of a record written whole, or the reverse) is
			// dropped once the file holds its live value; otherwise, unless an external edit already
			// conflicts with it, it is rebased onto the file just written, so the next save doesn't take
			// this write for such an edit.
			let writtenGeneration: YamlGeneration | undefined;
			for (const [key, mutation] of this.#modified) {
				const { segments } = mutation;
				if (!writtenPaths.some(other => isPathPrefix(other, segments) || isPathPrefix(segments, other))) continue;
				const written = getByPath(current, segments);
				if (settingValuesEqual(getByPath(this.#settings, segments), written)) {
					this.#modified.delete(key);
				} else if (pendingChangeApplies(mutation, segments, current, loaded.generation, writtenPaths)) {
					writtenGeneration ??= readYamlGeneration(configPath);
					this.#modified.set(key, { segments, generation: writtenGeneration, base: structuredClone(written) });
				}
			}

			// Adopt the file as saved, with every write still pending re-applied, so a live value never
			// regresses to its on-disk one.
			for (const { segments } of this.#modified.values()) {
				applyValue(current, segments, getByPath(this.#settings, segments));
			}
			this.#settings = current;
			this.#source = source;
			this.saved();
		} catch (error) {
			this.unsaved();
			logger.warn("Settings: save failed", { error: String(error) });
			// A quarantined file is now missing by our own action, not because something superseded
			// the mutation. Retry against that state.
			const retryGeneration = this.#quarantinedTarget !== undefined ? readYamlGeneration(configPath) : undefined;
			// Re-add the failed writes ahead of newer ones, which keep their own generation.
			const pending = new Map<string, PendingMutation>();
			for (const [key, mutation] of snapshot) {
				pending.set(key, retryGeneration ? { ...mutation, generation: retryGeneration } : mutation);
			}
			for (const [key, mutation] of this.#modified) pending.set(key, mutation);
			this.#modified = pending;
			throw error;
		}
	}

	#captureChangelogVersion = (version: string): void => {
		this.#legacyChangelogVersion ??= version;
	};

	/** Loads the first main config present; a missing result names `config.yml`. */
	async #readMain(): Promise<{ configPath: string; result: YamlLoadResult }> {
		for (const filename of MAIN_CONFIG_FILENAMES) {
			const configPath = path.join(this.#agentDir, filename);
			const result = await loadYamlSettings(configPath, this.#captureChangelogVersion);
			if (result.kind !== "missing") return { configPath, result };
		}
		return { configPath: path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]), result: { kind: "missing" } };
	}

	/** Makes a read the live tree, with every pending write re-applied, and tells the subscribers it is due. */
	#adopt(configPath: string, result: ReadableLoad): void {
		const settings = result.kind === "loaded" ? result.settings : {};
		for (const { segments } of this.#modified.values()) {
			applyValue(settings, segments, getByPath(this.#settings, segments));
		}
		this.#settings = settings;
		this.#configPath = configPath;
		this.#source = result.kind === "loaded" ? result.generation.source : null;
		// A config that loads again was recreated; a save writes it where it now lives.
		if (result.kind === "loaded") this.#quarantinedTarget = undefined;
		this.changed();
	}

	/**
	 * One-time migration for an agent directory with no main config: merges the legacy
	 * `settings.json` and agent.db settings rows into a new `config.yml`. The sources are retired
	 * (`settings.json.bak`, rows deleted) only once that file is written.
	 */
	async #migrateLegacy(): Promise<void> {
		let settings: RawSettings = {};
		let migrated = false;
		let migratedSettingsJson = false;

		const settingsJsonPath = path.join(this.#agentDir, "settings.json");
		try {
			const parsed: unknown = JSONC.parse(await fs.promises.readFile(settingsJsonPath, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = mergeLegacySettings(
					settings,
					migrateRawSettings(parsed as RawSettings, this.#captureChangelogVersion),
				);
				migrated = true;
				migratedSettingsJson = true;
			} else {
				logger.warn("Settings: ignoring non-object legacy settings.json", { path: settingsJsonPath });
			}
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Settings: failed to read legacy settings.json", {
					path: settingsJsonPath,
					error: String(error),
				});
			}
		}

		const dbPath = getAgentDbPath(this.#agentDir);
		let migratedDb = false;
		try {
			const dbSettings = readLegacyDbSettings(dbPath);
			if (dbSettings) {
				settings = mergeLegacySettings(settings, migrateRawSettings(dbSettings, this.#captureChangelogVersion));
				migrated = true;
				migratedDb = true;
			}
		} catch (error) {
			logger.warn("Settings: failed to read legacy agent.db settings", { error: String(error) });
		}

		if (!migrated || Object.keys(settings).length === 0) return;
		const configPath = path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
		try {
			await writeFileAtomically(await resolveYamlWritePath(configPath), stringifyYamlConfig(settings));
			logger.debug("Settings: migrated to config.yml", { path: configPath });
		} catch (error) {
			logger.warn("Settings: failed to write migrated config.yml", { path: configPath, error: String(error) });
			return;
		}

		if (migratedSettingsJson) {
			try {
				await fs.promises.rename(settingsJsonPath, `${settingsJsonPath}.bak`);
			} catch (error) {
				logger.warn("Settings: failed to archive settings.json after migration", {
					path: settingsJsonPath,
					error: String(error),
				});
			}
		}
		if (migratedDb) {
			try {
				clearLegacyDbSettings(dbPath);
			} catch (error) {
				logger.warn("Settings: failed to clear migrated agent.db settings", { error: String(error) });
			}
		}
	}

	/** Seeds the last-changelog-version marker from the retired config key; an existing marker wins. */
	async #seedLastChangelogVersionMarker(): Promise<void> {
		const legacy = this.#legacyChangelogVersion;
		if (!legacy) return;
		const markerPath = getLastChangelogVersionPath(this.#agentDir);
		try {
			if ((await Bun.file(markerPath).text()).trim()) return;
		} catch (error) {
			if (!isEnoent(error)) return;
		}
		try {
			await Bun.write(markerPath, legacy);
		} catch (error) {
			logger.warn("Settings: failed to seed last-changelog-version marker", { error: String(error) });
		}
	}
}

/** What one read of a project's settings files found. */
interface ProjectRead {
	config: YamlLoadResult;
	configSource: string | null;
	settingsSource: string | null;
	items: ProjectSettingsItem[];
	warnings: string[];
}

/** The native settings of one project: `.omp/settings.json` (read only) and `.omp/config.yml`. */
class ProjectDoc extends SettingsDoc {
	readonly cwd: string;
	#dir: string;
	#settingsPath: string;
	#configPath: string;
	/** The files as last read, in merge order; a save replaces the `config.yml` entry. */
	#items: ProjectSettingsItem[] = [];
	#warnings: string[] = [];
	/** The live `config.yml` tree: the file as last read or saved, plus every pending write. */
	#native: RawSettings = {};
	/** Pending writes by `JSON.stringify(segments)`. */
	#pending = new Map<string, readonly string[]>();
	/** Bumped by every staged write, so a re-read can tell a write landed while it was reading. */
	#mutations = 0;
	/** Where the invalid config a save moved aside lived; the next save recreates it there. */
	#quarantinedTarget: string | undefined;
	/** Bytes the state was read from or saved as; `null` for a file that was absent. */
	#settingsSource: string | null = null;
	#configSource: string | null = null;

	constructor(cwd: string, onIdle: (doc: SettingsDoc) => void) {
		super({ kind: "project", cwd }, onIdle);
		this.cwd = cwd;
		this.#dir = getProjectAgentDir(cwd);
		this.#settingsPath = path.join(this.#dir, "settings.json");
		this.#configPath = path.join(this.#dir, "config.yml");
	}

	override get pending(): boolean {
		return this.#pending.size > 0;
	}

	override watchPaths(): string[] {
		return [this.#settingsPath, this.#configPath];
	}

	override snapshot(): ProjectDocState {
		return structuredClone({
			items: this.#items,
			nativeModelRoles: getByPath(this.#native, ["modelRoles"]),
			warnings: this.#warnings,
		});
	}

	override async load(mode: DocMode): Promise<void> {
		let read = await this.#read();
		if (mode === "write" && read.config.kind === "invalid") {
			await quarantineInvalidConfig(this.#configPath);
			read = await this.#read();
		}
		const config = readableLoad(this.#configPath, read.config);
		this.#quarantinedTarget = undefined;
		this.#adopt(read, config);
	}

	override async upgrade(): Promise<void> {
		// Nothing migrates into a project config; the re-read that follows an upgrade is all it needs.
	}

	override async unchanged(): Promise<boolean> {
		const [settingsSource, configSource] = await Promise.all([
			readOptional(this.#settingsPath),
			readOptional(this.#configPath),
		]);
		return settingsSource === this.#settingsSource && configSource === this.#configSource;
	}

	override async refresh(mode: RefreshMode): Promise<void> {
		for (;;) {
			try {
				await this.save();
			} catch (error) {
				// The failed writes stay pending for the next save and are re-applied over the tree read below.
				logger.warn("Settings: reloading over unsaved changes", { error: String(error) });
			}
			const mutations = this.#mutations;
			if (await this.unchanged()) return;
			const read = await this.#read();
			if (mutations !== this.#mutations) continue;
			let config: ReadableLoad;
			try {
				config = readableLoad(this.#configPath, read.config);
				if (mode === "keep") {
					// A settings file that newly fails to parse would silently drop its values; keep
					// the last good state until it parses again or someone reloads explicitly.
					const fresh = read.warnings.filter(warning => !this.#warnings.includes(warning));
					if (fresh.length > 0) throw new Error(`Project settings failed to parse: ${fresh.join("; ")}`);
				}
			} catch (error) {
				if (mode === "strict") throw error;
				logger.warn("Settings: keeping last good config; on-disk change failed to load", { error: String(error) });
				return;
			}
			this.#adopt(read, config);
			return;
		}
	}

	override stage(writes: readonly SettingsWrite[]): boolean {
		let staged = false;
		for (const write of writes) {
			const { segments } = write;
			if (!isSegments(segments)) {
				logger.warn("Settings: ignored a write without a setting path", { doc: this.key });
				continue;
			}
			const value = write.remove ? undefined : write.value;
			if (settingValuesEqual(getByPath(this.#native, segments), value)) continue;
			applyValue(this.#native, segments, structuredClone(value));
			this.#pending.set(JSON.stringify(segments), segments);
			this.#mutations++;
			staged = true;
		}
		return staged;
	}

	override async save(): Promise<void> {
		if (this.#pending.size === 0) return;
		const snapshot = [...this.#pending];
		this.#pending.clear();
		this.saving();

		try {
			await fs.promises.mkdir(this.#dir, { recursive: true });
			const writePath = await resolveYamlWritePath(this.#configPath, this.#quarantinedTarget);
			const loaded = await loadForSave(this.#configPath, writePath, target => {
				this.#quarantinedTarget = target;
			});
			// A config a save moved aside reads as missing; recreate it from its last good content.
			const current =
				loaded.settings ?? (this.#quarantinedTarget !== undefined ? structuredClone(this.#native) : {});
			// Values are copied: writes keep editing the live tree while this save awaits the file.
			for (const [, segments] of snapshot) {
				applyValue(current, segments, structuredClone(getByPath(this.#native, segments)));
			}
			const content = stringifyYamlConfig(current);
			if (loaded.generation.kind !== "content" || loaded.generation.source !== content) {
				await writeFileAtomically(writePath, content);
			}
			this.#quarantinedTarget = undefined;

			const saved: ProjectSettingsItem = {
				provider: NATIVE_PROVIDER_ID,
				path: this.#configPath,
				data: structuredClone(current),
			};
			const index = this.#items.findIndex(item => item.path === this.#configPath);
			if (index === -1) this.#items.push(saved);
			else this.#items[index] = saved;
			// Writes staged since the snapshot stay live on top of the saved tree.
			for (const segments of this.#pending.values()) {
				applyValue(current, segments, getByPath(this.#native, segments));
			}
			this.#native = current;
			this.#configSource = content;
			this.saved();
		} catch (error) {
			this.unsaved();
			const pending = new Map<string, readonly string[]>(snapshot);
			for (const [key, segments] of this.#pending) pending.set(key, segments);
			this.#pending = pending;
			throw error;
		}
	}

	/** Reads both files uncached; `config.yml` is read once, so its item and its tree come from the same bytes. */
	async #read(): Promise<ProjectRead> {
		const [config, settingsSource] = await Promise.all([
			loadYamlSettings(this.#configPath),
			readOptional(this.#settingsPath),
		]);
		const configSource = config.kind === "loaded" ? config.generation.source : null;
		const { files, warnings } = await readNativeSettingsFiles(this.#dir, filePath =>
			Promise.resolve(filePath === this.#configPath ? configSource : settingsSource),
		);
		return {
			config,
			configSource,
			settingsSource,
			items: files.map(file => ({ provider: NATIVE_PROVIDER_ID, path: file.path, data: file.data })),
			warnings: warnings.map(warning => `[${NATIVE_PROVIDER_DISPLAY_NAME}] ${warning}`),
		};
	}

	/** Makes a read the live state, with every pending write re-applied, and tells the subscribers it is due. */
	#adopt(read: ProjectRead, config: ReadableLoad): void {
		let native: RawSettings;
		if (config.kind === "loaded") {
			native = config.settings;
			// A config that loads again was recreated; a save writes it where it now lives.
			this.#quarantinedTarget = undefined;
		} else {
			// A config a save moved aside reads as missing until a save recreates it; keep its last good content.
			native = this.#quarantinedTarget !== undefined ? this.#native : {};
		}
		if (native !== this.#native) {
			for (const segments of this.#pending.values()) {
				applyValue(native, segments, getByPath(this.#native, segments));
			}
		}
		this.#native = native;
		this.#items = read.items;
		this.#warnings = read.warnings;
		this.#settingsSource = read.settingsSource;
		this.#configSource = read.configSource;
		this.changed();
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Store
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The single writer of settings documents, serving every omp process of a user through peers.
 * Global documents stay loaded for the store's lifetime; a project document is dropped some time
 * after its last subscriber closes it.
 */
export class SettingsStore {
	/** Global documents by resolved agent directory. */
	#globals = new Map<string, GlobalDoc>();
	/** Project documents by resolved cwd. */
	#projects = new Map<string, ProjectDoc>();
	#peers = new Set<Peer>();
	/** Eviction timers of project documents nobody subscribes to. */
	#evictions = new Map<ProjectDoc, NodeJS.Timeout>();
	#disposed = false;

	/** Registers a client; `sink` receives what the store sends it. */
	addPeer(sink: (message: SettingsDown) => void): SettingsStorePeer {
		const peer = new Peer(sink, this.#dispatch);
		this.#peers.add(peer);
		return peer;
	}

	/** Drops a client and every subscription it holds; its pending writes are still saved. */
	removePeer(peer: SettingsStorePeer): void {
		if (!(peer instanceof Peer) || !this.#peers.delete(peer)) return;
		peer.close();
		for (const doc of this.#docs()) doc.close(peer);
	}

	/**
	 * Resolves once every write staged so far is on disk.
	 *
	 * @throws Error when a document could not be saved; the others are saved regardless.
	 */
	async flush(): Promise<void> {
		const results = await Promise.allSettled(this.#docs().map(doc => doc.flush()));
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
		}
	}

	/** Stops every timer and file poll and forgets every document; pending writes are not saved ({@link flush} first). */
	dispose(): void {
		this.#disposed = true;
		for (const timer of this.#evictions.values()) clearTimeout(timer);
		this.#evictions.clear();
		for (const doc of this.#docs()) doc.dispose();
		this.#globals.clear();
		this.#projects.clear();
		for (const peer of this.#peers) peer.close();
		this.#peers.clear();
	}

	#docs(): SettingsDoc[] {
		return [...this.#globals.values(), ...this.#projects.values()];
	}

	#dispatch = (peer: Peer, message: SettingsUp): void => {
		try {
			if (this.#disposed || peer.closed) throw new Error("Settings store is closed");
			switch (message.t) {
				case "open":
					this.#obtain(message.doc).open(peer, message.id, message.mode, message.watch);
					return;
				case "close":
					this.#find(message.doc)?.close(peer);
					return;
				case "watch":
					this.#find(message.doc)?.watch(peer, message.watch);
					return;
				case "write":
					this.#obtain(message.doc).write(peer, message.seq, message.writes);
					return;
				case "flush": {
					const doc = this.#find(message.doc);
					if (doc) doc.requestFlush(peer, message.id);
					else peer.send({ t: "reply", id: message.id });
					return;
				}
				case "reload": {
					const doc = this.#find(message.doc);
					if (doc) doc.reload(peer, message.id);
					else peer.send({ t: "reply", id: message.id, error: "Settings document is not open" });
					return;
				}
			}
		} catch (error) {
			logger.warn("Settings: store rejected a message", { type: message.t, error: String(error) });
			if ("id" in message) peer.send({ t: "reply", id: message.id, error: errorMessage(error) });
		}
	};

	/**
	 * The loaded or loading document `key` names, if there is one.
	 *
	 * @throws Error when `key` is malformed.
	 */
	#find(key: SettingsDocKey): SettingsDoc | undefined {
		if (key.kind === "global" && typeof key.agentDir === "string") {
			return this.#globals.get(path.resolve(key.agentDir));
		}
		if (key.kind === "project" && typeof key.cwd === "string") {
			return this.#projects.get(path.resolve(key.cwd));
		}
		throw new Error("Malformed settings document key");
	}

	/** {@link #find}, creating the document when it is new. */
	#obtain(key: SettingsDocKey): SettingsDoc {
		const existing = this.#find(key);
		if (existing) return existing;
		if (key.kind === "global") {
			const agentDir = path.resolve(key.agentDir);
			const doc = new GlobalDoc(agentDir, this.#onIdle);
			this.#globals.set(agentDir, doc);
			return doc;
		}
		const cwd = path.resolve(key.cwd);
		const doc = new ProjectDoc(cwd, this.#onIdle);
		this.#projects.set(cwd, doc);
		return doc;
	}

	/**
	 * A document has no subscriber and no disk work left. A project document that never loaded goes
	 * at once; a loaded one after {@link EVICT_IDLE_MS}, unless it is opened again or still holds
	 * writes it could not save.
	 */
	#onIdle = (doc: SettingsDoc): void => {
		if (this.#disposed || !(doc instanceof ProjectDoc)) return;
		clearTimeout(this.#evictions.get(doc));
		this.#evictions.delete(doc);
		if (!doc.loaded) {
			this.#drop(doc);
			return;
		}
		const timer = setTimeout(() => {
			this.#evictions.delete(doc);
			// A subscriber or queued work means the document comes back here when that ends.
			if (doc.subscribed || !doc.idle) return;
			if (doc.pending) {
				doc.flush().catch((error: unknown) => {
					logger.warn("Settings: unsaved project settings kept for retry", { error: String(error) });
				});
				return;
			}
			this.#drop(doc);
		}, EVICT_IDLE_MS);
		timer.unref();
		this.#evictions.set(doc, timer);
	};

	#drop(doc: ProjectDoc): void {
		doc.dispose();
		if (this.#projects.get(doc.cwd) === doc) this.#projects.delete(doc.cwd);
	}
}
