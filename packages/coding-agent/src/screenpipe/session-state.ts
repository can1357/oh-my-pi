/**
 * Runtime host for the screenpipe activity bridge: assembles the local
 * activity ledger, the gopk sink, and the screenpipe client into a
 * {@link ScreenpipeBridgeRunner}, then starts polling. Everything stays on
 * this machine — the ledger is a local SQLite file under the agent dir, the
 * consent record is device-scoped with remote storage off, and the bridge
 * only ever reads already-redacted frame metadata from the local daemon.
 *
 * Built once per session when `screenpipe.enabled` is on (see
 * `AgentSession`); torn down in the session's `dispose()`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createGopkActivitySink,
	type GopkClipIngestionPolicy,
	SqliteActivityLedger,
} from "@pk-nerdsaver-ai/pi-activity-journal";
import type { ConsentRecord } from "@pk-nerdsaver-ai/pi-context-policy";
import {
	createFileCursorStore,
	ScreenpipeBridge,
	ScreenpipeBridgeRunner,
	ScreenpipeClient,
} from "@pk-nerdsaver-ai/pi-screenpipe-bridge";
import { getAgentDir, getInstallId, logger } from "@pk-nerdsaver-ai/pi-utils";

// Denied-app list and raw-clip retention live in a dependency-free module so
// the standalone ingester can share them without importing this screenpipe
// module (which pulls in the pi-utils barrel and its native addon).
import { DENIED_APPLICATION_IDS, MAXIMUM_RAW_CLIP_RETENTION_MS } from "../gopk-clips/policy-constants";

export interface ScreenpipeSessionConfig {
	readonly sessionId: string;
	readonly baseUrl: string;
	readonly pollIntervalMs: number;
	/** When set, keyframe hashes are recorded for snapshots contained in it. */
	readonly mediaRoot?: string;
}

export interface ScreenpipeSessionState {
	/** The session this bridge attributes captured activity to. */
	readonly sessionId: string;
	/** Stops the poll loop (awaiting any in-flight poll) and closes the ledger. */
	dispose(): Promise<void>;
}

/** Builds a bridge bound to `sessionId`. Injected so the manager is testable. */
export type ScreenpipeSessionFactory = (sessionId: string) => ScreenpipeSessionState;

/** Diagnostics sink for the manager; structurally satisfied by the pi-utils logger. */
export interface ScreenpipeManagerLogger {
	warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * Build the bridge stack and start polling. Throws when the capture
 * directory or ledger cannot be created — callers gate session startup on
 * that never propagating (see the try/catch at the construction site).
 */
export function createScreenpipeSessionState(config: ScreenpipeSessionConfig): ScreenpipeSessionState {
	const installId = getInstallId();
	const captureRoot = path.join(getAgentDir(), "screenpipe");
	fs.mkdirSync(captureRoot, { recursive: true });

	const consent: ConsentRecord = {
		userId: installId,
		deviceId: installId,
		identityVerified: true,
		enabled: true,
		scope: "device",
		remoteStorageEnabled: false,
		policyVersion: "context-retention/v1",
	};
	const policy: GopkClipIngestionPolicy = {
		enabled: true,
		ocrEnabled: false,
		allowedApplicationIds: [],
		deniedApplicationIds: [...DENIED_APPLICATION_IDS],
		maximumRawClipRetentionMs: MAXIMUM_RAW_CLIP_RETENTION_MS,
	};

	const ledger = new SqliteActivityLedger(path.join(captureRoot, "activity-ledger.sqlite"));
	let runner: ScreenpipeBridgeRunner;
	try {
		const sink = createGopkActivitySink({
			ledger,
			consent,
			policy,
			capture: { userId: installId, deviceId: installId, sessionId: config.sessionId },
			captureRoot,
			logger,
		});
		const bridge = new ScreenpipeBridge({
			frameSource: new ScreenpipeClient({ baseUrl: config.baseUrl, logger }),
			sink,
			cursorStore: createFileCursorStore(captureRoot),
			sessionId: config.sessionId,
			captureRoot,
			...(config.mediaRoot ? { mediaRoot: config.mediaRoot } : {}),
		});
		runner = new ScreenpipeBridgeRunner({ bridge, pollIntervalMs: config.pollIntervalMs, logger });
		runner.start();
	} catch (error) {
		ledger.close();
		throw error;
	}
	logger.info("screenpipe bridge started", {
		sessionId: config.sessionId,
		baseUrl: config.baseUrl,
		pollIntervalMs: config.pollIntervalMs,
		captureRoot,
		keyframeHashing: config.mediaRoot !== undefined,
	});

	let disposed: Promise<void> | undefined;
	return {
		sessionId: config.sessionId,
		dispose(): Promise<void> {
			disposed ??= runner.stop().finally(() => {
				ledger.close();
			});
			return disposed;
		},
	};
}

/**
 * Owns screenpipe capture across an `AgentSession`'s lifetime and keeps it bound
 * to the *current* session. A session's id changes on `newSession`, `fork`,
 * `branch`, `switchSession`, `freshSession`, and handoff; without re-binding, the
 * bridge would keep attributing post-transition screen activity — journal rows,
 * manifests, cursor progress — to the session that was active when it started.
 *
 * Strategy: full replacement (not partial mutation). {@link syncTo} disposes the
 * prior session's bridge *before* constructing the new one, so exactly one bridge
 * is ever live, no post-transition capture lands under the old session, and a
 * failed construction never leaves the old (wrong-session) bridge running. All
 * operations are serialized on a single queue, so repeated or overlapping
 * transitions can never leave duplicate pollers or timers behind. The device-level
 * cursor and ledger files are shared across sessions by design — the cursor is a
 * screenpipe-frame dedup marker, and each ledger row already carries its own
 * session id — so replacement continues frame progress without reprocessing while
 * still attributing new frames to the new session.
 */
export class ScreenpipeSessionManager {
	#factory: ScreenpipeSessionFactory;
	#logger: ScreenpipeManagerLogger;
	#active: ScreenpipeSessionState | undefined;
	#queue: Promise<void> = Promise.resolve();
	#disposed = false;

	constructor(factory: ScreenpipeSessionFactory, managerLogger: ScreenpipeManagerLogger = logger) {
		this.#factory = factory;
		this.#logger = managerLogger;
	}

	/** The session the live bridge is attributing capture to, if any. */
	get activeSessionId(): string | undefined {
		return this.#active?.sessionId;
	}

	/** The live bridge, if any. Exposed for lifecycle assertions in tests. */
	get activeState(): ScreenpipeSessionState | undefined {
		return this.#active;
	}

	/** Resolves once every queued transition/disposal has settled. */
	settled(): Promise<void> {
		return this.#queue;
	}

	/**
	 * Bind capture to `sessionId`, replacing any bridge bound to a different one.
	 * A no-op when already on `sessionId`. Serialized: the returned promise
	 * settles when this transition (dispose-old-then-start-new) completes.
	 */
	syncTo(sessionId: string): Promise<void> {
		this.#queue = this.#queue.then(async () => {
			if (this.#disposed) return;
			if (this.#active?.sessionId === sessionId) return;
			// Dispose the old bridge FIRST: a failed construction below must never
			// leave the previous session still capturing.
			await this.#disposeActive();
			try {
				this.#active = this.#factory(sessionId);
			} catch (error) {
				this.#active = undefined;
				this.#logger.warn("Failed to bind screenpipe bridge to session", {
					sessionId,
					error: String(error),
				});
			}
		});
		return this.#queue;
	}

	/** Permanently tear down capture. Idempotent; blocks further `syncTo`. */
	dispose(): Promise<void> {
		this.#queue = this.#queue.then(async () => {
			this.#disposed = true;
			await this.#disposeActive();
		});
		return this.#queue;
	}

	async #disposeActive(): Promise<void> {
		const state = this.#active;
		this.#active = undefined;
		if (!state) return;
		try {
			await state.dispose();
		} catch (error) {
			this.#logger.warn("Failed to dispose screenpipe session state", {
				sessionId: state.sessionId,
				error: String(error),
			});
		}
	}
}

/**
 * Production manager: rebuilds the full bridge stack (ledger → sink → client →
 * bridge → runner) for whichever session becomes current.
 */
export function createScreenpipeSessionManager(
	config: Omit<ScreenpipeSessionConfig, "sessionId">,
): ScreenpipeSessionManager {
	return new ScreenpipeSessionManager(sessionId => createScreenpipeSessionState({ ...config, sessionId }));
}
