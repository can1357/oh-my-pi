/**
 * Integration layer for shared-state replication: resolves configuration,
 * assembles the enabled domains, and owns the lifecycle of the sync engine plus
 * the object-store session replicator.
 *
 * Everything here is opt-in. `state.sync.enabled` defaults to `false`, and
 * {@link createStateSyncRuntime} returns `undefined` in that case without
 * touching the filesystem or constructing a database handle — so a default
 * install pays nothing for this subsystem existing.
 */

import * as path from "node:path";
import {
	getAgentDir,
	getConfigRootDir,
	getInstallId,
	getSessionsDir,
	getStateSyncDbPath,
	isEnoent,
	logger,
	postmortem,
} from "@oh-my-pi/pi-utils";
import { AgentStorage } from "../session/agent-storage";
import { drainBlobUploads, setDefaultBlobObjectStore } from "../session/blob-store";
import { StateBrokerClient } from "./client";
import { createCommandUsageDomain } from "./domains/command-usage";
import { createConfigDomain } from "./domains/config";
import { createHistoryDomain } from "./domains/history";
import { createModelUsageDomain } from "./domains/model-usage";
import { createSessionsDomain, localSessionRelForEntry, readRemoteSessionIndex } from "./domains/sessions";
import { createTitlesDomain } from "./domains/titles";
import { type ObjectStore, resolveObjectStore, type SettingsLike } from "./object-store";
import { type ReplicatedDomain, StateSyncStore } from "./replica";
import { SessionReplicator } from "./session-replicator";
import { StateSyncEngine } from "./sync";
import { STATE_DOMAIN_IDS, type StateDomainId } from "./wire";

/** Resolved broker endpoint for the state surface. */
export interface StateBrokerConfig {
	url: string;
	token: string;
}

/**
 * Resolve the state-broker endpoint.
 *
 * Precedence mirrors `resolveAuthBrokerConfig` in
 * `packages/ai/src/auth-broker/discover.ts`, then falls back to the auth-broker
 * settings: the state surface is served by the same `omp auth-broker serve`
 * listener behind the same bearer token, so a single URL/token pair configures
 * both. A deployment that wants them split can still set `state.broker.*`
 * explicitly.
 */
export async function resolveStateBrokerConfig(
	settings: SettingsLike,
	resolveConfigValue: (raw: string) => Promise<string | undefined>,
): Promise<StateBrokerConfig | undefined> {
	const rawUrl =
		process.env.OMP_STATE_BROKER_URL ||
		process.env.OMP_AUTH_BROKER_URL ||
		optString(settings, "state.broker.url") ||
		optString(settings, "auth.broker.url");
	if (!rawUrl) return undefined;

	const rawToken =
		process.env.OMP_STATE_BROKER_TOKEN ||
		process.env.OMP_AUTH_BROKER_TOKEN ||
		optString(settings, "state.broker.token") ||
		optString(settings, "auth.broker.token");

	const url = (await resolveConfigValue(rawUrl))?.trim();
	if (!url) return undefined;

	// `!command` indirection is honored for the token, matching how the auth
	// broker resolves its own credential.
	let token = rawToken ? (await resolveConfigValue(rawToken))?.trim() : undefined;
	token ||= await readAuthBrokerTokenFile();
	if (!token) {
		logger.warn("state broker URL configured but no token resolved; state sync disabled", { url });
		return undefined;
	}
	return { url, token };
}

async function readAuthBrokerTokenFile(): Promise<string | undefined> {
	try {
		const raw = await Bun.file(path.join(getConfigRootDir(), "auth-broker.token")).text();
		return raw.trim() || undefined;
	} catch (error) {
		if (!isEnoent(error)) logger.debug("auth-broker token file unreadable", { error: String(error) });
		return undefined;
	}
}

function optString(settings: SettingsLike, key: string): string | undefined {
	const value = settings.get(key);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Process-wide session replicator, published once replication starts.
 *
 * A service-locator rather than a constructor argument because the consumer is
 * `SessionManager.open()`, a static reached from the picker, `--resume`, and
 * ACP alike; threading a replicator through every one of those call paths would
 * touch far more surface than the fetch itself. Mirrors the existing
 * `setDefaultBlobObjectStore` precedent.
 */
let activeReplicator: SessionReplicator | undefined;

/**
 * Download a session body that exists only on another machine.
 *
 * Called before a session file is read, so remote-only sessions become
 * resumable from every entry point rather than only the picker. A no-op when
 * replication is off, when the file is already local, or when the path is not
 * in the remote index — so the common case costs one stat.
 *
 * Never throws: a session that cannot be fetched must surface as the normal
 * "missing session" path, not as a crash during resume.
 */
export async function fetchRemoteSessionIfMissing(filePath: string): Promise<void> {
	const replicator = activeReplicator;
	if (!replicator) return;
	try {
		if (await Bun.file(filePath).exists()) return;
		const sessionsDir = getSessionsDir();
		const rel = path.relative(sessionsDir, path.resolve(filePath));
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
		const posixRel = rel.split(path.sep).join("/");
		const entry = readRemoteSessionIndex(sessionsDir).find(item => item.rel === posixRel);
		if (!entry) return;
		// The index row carries the project id the publisher CONFIRMED for this
		// body, so ownership is never re-derived from the encoded directory name.
		await replicator.ensureLocal(posixRel, { projectId: entry.projectId, relCwd: entry.relCwd });
	} catch (error) {
		logger.debug("remote session fetch skipped", { filePath, error: String(error) });
	}
}

/**
 * Live replication runtime. Owns the sync engine, the cursor database, and the
 * optional object-store session replicator.
 */
export class StateSyncRuntime {
	readonly #engine: StateSyncEngine;
	readonly #store: StateSyncStore;
	readonly #replicator: SessionReplicator | undefined;

	constructor(engine: StateSyncEngine, store: StateSyncStore, replicator: SessionReplicator | undefined) {
		this.#engine = engine;
		this.#store = store;
		this.#replicator = replicator;
	}

	/**
	 * Object-store session replicator, when bulk replication is configured.
	 * Callers hook `scheduleUpload` to the session write path and `ensureLocal`
	 * to resume.
	 */
	get sessionReplicator(): SessionReplicator | undefined {
		return this.#replicator;
	}

	start(): void {
		this.#engine.start();
	}

	/**
	 * Bounded wait for the first push/pull cycle. See
	 * {@link StateSyncEngine.waitForFirstCycle}.
	 */
	async waitForFirstCycle(timeoutMs: number): Promise<void> {
		await this.#engine.waitForFirstCycle(timeoutMs);
	}

	/**
	 * Flush every pending local change to the broker and object store. Called on
	 * graceful shutdown so the last turn of a conversation is replicated.
	 *
	 * Blob uploads are included: they are detached from the session write path,
	 * so without this an exit mid-upload replicates a session body whose
	 * attachment reference no other machine can resolve.
	 */
	async drain(): Promise<void> {
		await Promise.allSettled([this.#engine.drain(), this.#replicator?.drain(), drainBlobUploads()]);
	}

	async stop(): Promise<void> {
		await this.#engine.stop();
		this.#store.close();
	}
}

/**
 * Process-wide replication runtime, plus its teardown registration.
 *
 * Replication has to be running BEFORE the first session is resolved. Startup
 * decides whether a session even exists by listing local sessions, and it opens
 * the chosen one immediately; a runtime created later cannot retroactively make
 * a remote-only session listable or fetch its body, and the `BlobStore` the
 * first session already built would never receive its object-store backing.
 */
let activeRuntime: StateSyncRuntime | undefined;
let cancelTeardownHook: (() => void) | undefined;

/**
 * Budget for the shutdown flush. Replication is best-effort: a broker that has
 * gone away must not hold the process open, since anything unflushed is picked
 * up by the next run's first sync cycle.
 */
const STATE_SYNC_DRAIN_BUDGET_MS = 2_000;

/**
 * Budget for the initial exchange that startup may wait on before it resolves a
 * session. Long enough for a round-trip to a healthy broker, short enough that
 * an unreachable one costs a noticeable pause rather than a hang.
 */
const STATE_SYNC_STARTUP_BUDGET_MS = 3_000;

/**
 * Wait for replication's first cycle, bounded, so callers about to READ
 * replicated state do not race the initial exchange.
 *
 * No-op when replication is disabled or not started, which is the default. Only
 * the paths that resolve an existing session need this — a fresh session reads
 * nothing replicated, so gating every launch on a network round-trip would be
 * latency for nothing.
 */
export async function awaitInitialStateSync(): Promise<void> {
	await activeRuntime?.waitForFirstCycle(STATE_SYNC_STARTUP_BUDGET_MS);
}

/** The running replication runtime, if replication is enabled and started. */
export function activeStateSync(): StateSyncRuntime | undefined {
	return activeRuntime;
}

/**
 * Resolve configuration, start replication, and publish it process-wide.
 *
 * Safe and cheap to call unconditionally: it returns `undefined` without
 * touching disk or the network when `state.sync.enabled` is not `true`.
 * Idempotent — a second call returns the already-running runtime.
 *
 * Teardown is registered here rather than left to the caller because every mode
 * (interactive, print, rpc, acp) needs the same flush, and a signal or a
 * `process.exit` can end any of them. {@link stopStateSync} is the explicit
 * path for a mode that shuts down gracefully.
 */
export async function startStateSync(opts: CreateStateSyncOptions): Promise<StateSyncRuntime | undefined> {
	if (activeRuntime) return activeRuntime;
	const runtime = await createStateSyncRuntime(opts);
	if (!runtime) return undefined;
	activeRuntime = runtime;
	runtime.start();
	cancelTeardownHook = postmortem.register("state-sync", async () => {
		await stopStateSync();
	});
	return runtime;
}

/**
 * Flush and release the running runtime. Bounded, never throws, and idempotent
 * so the graceful path and the postmortem hook cannot double-drain or wedge
 * shutdown behind an unreachable broker.
 */
export async function stopStateSync(): Promise<void> {
	const runtime = activeRuntime;
	if (!runtime) return;
	activeRuntime = undefined;
	cancelTeardownHook?.();
	cancelTeardownHook = undefined;
	activeReplicator = undefined;
	await Promise.race([runtime.drain(), Bun.sleep(STATE_SYNC_DRAIN_BUDGET_MS)]).catch(error =>
		logger.debug("state sync drain failed", { error: String(error) }),
	);
	await runtime.stop().catch(error => logger.debug("state sync stop failed", { error: String(error) }));
}

/**
 * Domains whose contents are filtered by project, and which therefore have to
 * be re-scanned when the set of synced projects changes.
 */
const PROJECT_SCOPED_DOMAINS: readonly StateDomainId[] = ["history", "titles", "sessions"];

/**
 * Rewind the project-scoped replication cursors so the next sync re-scans and
 * re-pulls from scratch.
 *
 * Required when a project's sync flag flips on, because both cursors are
 * *watermarks over data that was filtered at the time it was observed*:
 *
 * - inbound: a delta containing an unsynced project's rows is consumed and the
 *   `seq` advances even though `applyRemote` declined every row. Without a
 *   rewind, enabling that project later never sees the rows the broker already
 *   handed us.
 * - outbound: `changedSince` never returns unsynced rows, so the `rev`
 *   watermark still moves past them as newer synced rows are pushed. Without a
 *   rewind, the newly enabled project's existing local history never uploads.
 *
 * Rewinding is safe and cheap: every merge is last-writer-wins and idempotent,
 * so a full re-scan converges to the same state.
 */
export function resetProjectScopedCursors(agentDir: string = getAgentDir()): void {
	let store: StateSyncStore | undefined;
	try {
		store = new StateSyncStore(getStateSyncDbPath(agentDir));
		for (const domain of PROJECT_SCOPED_DOMAINS) {
			store.set(domain, { inboundSeq: 0, outboundRev: 0 });
		}
	} catch (error) {
		// No cursor db yet (sync never ran) is the common case, and a failure here
		// only costs a backfill — never correctness of the local store.
		logger.debug("state sync cursor reset skipped", { error: String(error) });
	} finally {
		store?.close();
	}
}

export interface CreateStateSyncOptions {
	settings: SettingsLike;
	resolveConfigValue: (raw: string) => Promise<string | undefined>;
	agentDir?: string;
}

/**
 * Assemble the replication runtime, or `undefined` when replication is off or
 * unconfigured. Never throws: a misconfigured broker degrades to local-only
 * operation with one warning, because losing sync must never prevent a session
 * from starting.
 */
export async function createStateSyncRuntime(opts: CreateStateSyncOptions): Promise<StateSyncRuntime | undefined> {
	const { settings } = opts;
	if (settings.get("state.sync.enabled") !== true) return undefined;

	try {
		const config = await resolveStateBrokerConfig(settings, opts.resolveConfigValue);
		if (!config) return undefined;

		const agentDir = opts.agentDir ?? getAgentDir();
		const enabled = selectDomains(settings);
		if (enabled.length === 0) {
			logger.warn("state sync enabled but state.sync.domains is empty; nothing to replicate");
			return undefined;
		}

		const objectStore = await resolveObjectStore(settings, opts.resolveConfigValue);
		const sessionsDir = getSessionsDir(agentDir);

		// The cursor store must exist before the domains AND before the body
		// replicator: the config and sessions domains use it to remember
		// publications so deletions become tombstones, and the replicator uses it
		// to remember which local snapshot each uploaded object holds.
		const syncStore = new StateSyncStore(getStateSyncDbPath(agentDir));
		const replicator =
			objectStore && settings.get("objects.sessions") !== false
				? new SessionReplicator({ store: objectStore, sessionsDir, sync: syncStore })
				: undefined;

		attachBlobObjectStore(settings, objectStore);
		// Publish before any session is opened so a remote-only session picked on
		// this run is fetchable rather than only on the next one.
		activeReplicator = replicator;

		const scanned = await buildDomains(enabled, agentDir, sessionsDir, syncStore);
		// Body replication rides along with the sessions index scan.
		const domains = replicator
			? scanned.map(domain => (domain.id === "sessions" ? withBodyUploads(domain, replicator) : domain))
			: scanned;
		const client = new StateBrokerClient({ url: config.url, token: config.token });
		const intervalMs = settings.get("state.sync.intervalMs");
		const engine = new StateSyncEngine({
			client,
			domains,
			store: syncStore,
			intervalMs: typeof intervalMs === "number" ? intervalMs : undefined,
		});

		logger.info("state sync enabled", {
			url: config.url,
			domains: domains.map(d => d.id),
			objects: objectStore ? "s3" : "off",
		});
		return new StateSyncRuntime(engine, syncStore, replicator);
	} catch (error) {
		logger.warn("state sync initialization failed; continuing local-only", { error: String(error) });
		return undefined;
	}
}

/**
 * Give every subsequently-constructed session blob store its remote backing so
 * externalized images resolve on a machine that never saw the original paste.
 *
 * Attached **download-only**: blob bytes are session attachments, and whether
 * they may leave this machine depends on the owning session's project. Reading
 * is always safe (a hash is only learnable from a session you already hold), so
 * `SessionManager` opts its own store into uploading via
 * `BlobStore.setUploadEnabled` once it knows its project's sync state.
 */
function attachBlobObjectStore(settings: SettingsLike, objectStore: ObjectStore | undefined): void {
	if (!objectStore || settings.get("objects.blobs") === false) return;
	setDefaultBlobObjectStore(objectStore, { upload: false });
}
/**
 * Wrap the `sessions` domain so every session the index scan reports as changed
 * also gets its body queued for upload.
 *
 * Driving uploads from the domain scan rather than hooking `SessionManager`'s
 * several write paths has two properties worth the indirection: the index and
 * the bodies are derived from one consistent scan (so the picker can never
 * advertise a session whose body was never queued), and the project filtering
 * the domain already performs is inherited for free — an unsynced project's
 * bodies are never even enumerated.
 *
 * Upload latency becomes one sync cycle instead of immediate, which is the
 * right trade for a replicated archive; the shutdown drain flushes the tail.
 */
function withBodyUploads(domain: ReplicatedDomain, replicator: SessionReplicator): ReplicatedDomain {
	return {
		id: domain.id,
		changedSince(afterRev, limit) {
			const entries = domain.changedSince(afterRev, limit);
			for (const entry of entries) {
				const local = localSessionRelForEntry(entry);
				if (local) replicator.scheduleUpload(local.rel, local.projectId);
			}
			// Index-driven scheduling alone strands a body whose transfer failed
			// after its metadata push, since the cursor has already moved past it.
			// The reconcile pass is throttled and self-tracking, so this is a cheap
			// no-op on most cycles.
			replicator.maybeReconcile();
			return entries;
		},
		applyRemote(entries) {
			domain.applyRemote(entries);
		},
		drain: () => Promise.all([domain.drain?.(), replicator.drain()]).then(() => undefined),
	};
}

function selectDomains(settings: SettingsLike): StateDomainId[] {
	const configured = settings.get("state.sync.domains");
	if (!Array.isArray(configured)) return [...STATE_DOMAIN_IDS];
	const wanted = new Set(configured.filter((v): v is string => typeof v === "string"));
	return STATE_DOMAIN_IDS.filter(id => wanted.has(id));
}

async function buildDomains(
	enabled: readonly StateDomainId[],
	agentDir: string,
	sessionsDir: string,
	syncStore: StateSyncStore,
): Promise<ReplicatedDomain[]> {
	// AgentStorage is a per-path singleton the runtime has already opened by the
	// time sync starts, so `open()` resolves to the live handle rather than a
	// second connection to agent.db.
	const agentStorage =
		enabled.includes("model-usage") || enabled.includes("command-usage") ? await AgentStorage.open() : undefined;

	const domains: ReplicatedDomain[] = [];
	for (const id of enabled) {
		switch (id) {
			case "history":
				domains.push(createHistoryDomain());
				break;
			case "titles":
				domains.push(createTitlesDomain());
				break;
			case "model-usage":
				domains.push(createModelUsageDomain(agentStorage));
				break;
			case "command-usage":
				domains.push(createCommandUsageDomain(agentStorage, getInstallId()));
				break;
			case "config":
				// The sync store doubles as the config domain's memory of what it
				// has published, which is the only way a live file enumeration can
				// notice a DELETION and emit a tombstone for it.
				domains.push(createConfigDomain(agentDir, syncStore));
				break;
			case "sessions":
				// Same reason as `config`: without the published-key ledger a deleted
				// session has no representation on the wire, and this replica pulls
				// its own stale row back as a remote-only stub.
				domains.push(createSessionsDomain(sessionsDir, syncStore));
				break;
		}
	}
	return domains;
}
