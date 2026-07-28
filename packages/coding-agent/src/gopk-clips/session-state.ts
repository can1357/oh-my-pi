/**
 * Runtime host for the gopk-clips Context Mode handoff: polls a local
 * file-drop directory for sanitized activity derivatives written by the
 * gopk-clips capture daemon (`createJournalHandoffSink` on its side), ingests
 * them into the local activity ledger, and runs the raw-clip retention purge
 * on an interval. Everything stays on this machine — the ledger is a local
 * SQLite file under the agent dir, consent is device-scoped with remote
 * storage off, and only already-sanitized derivatives are ever accepted.
 *
 * Handoff contract: the daemon atomically drops `<name>.json` files (tmp-write
 * + rename) under `<captureRoot>/journal-handoff`. This host owns files from
 * the moment they appear — a file is deleted after its derivative has been
 * handed to the sink, and renamed to `<name>.json.rejected` when it cannot be
 * parsed or fails shape validation, so nothing disappears silently. Replays
 * after a crash between ingest and delete are safe: the ledger dedupes by
 * clip identity.
 *
 * Unlike the screenpipe bridge, this host is not re-bound on agent session
 * transitions — each derivative carries the *capture* session id it was
 * recorded under, and the sink attributes evidence to that id. One host per
 * `AgentSession` lifetime; built when `gopkClips.enabled` is on, torn down in
 * the session's `dispose()`.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createGopkActivitySink,
	type GopkActivitySink,
	type GopkCapturedDerivative,
	type GopkClipIngestionPolicy,
	runGopkClipCleanup,
	SqliteActivityLedger,
} from "@pk-nerdsaver-ai/pi-activity-journal";
import type { ConsentRecord } from "@pk-nerdsaver-ai/pi-context-policy";
import { getAgentDir, getInstallId, logger } from "@pk-nerdsaver-ai/pi-utils";
import { DENIED_APPLICATION_IDS, MAXIMUM_RAW_CLIP_RETENTION_MS } from "../screenpipe/session-state";

export interface GopkClipsHostConfig {
	/**
	 * The capture daemon's root directory. The handoff drop lives at
	 * `<captureRoot>/journal-handoff`, and manifest / raw-clip pointers inside
	 * derivatives must resolve under this root or the sink rejects them.
	 * Unset means `<agentDir>/gopk-clips/capture`.
	 */
	readonly captureRoot?: string;
	readonly pollIntervalMs: number;
	readonly cleanupIntervalMs: number;
	/** Test seam; defaults to `<agentDir>/gopk-clips/activity-ledger.sqlite`. */
	readonly ledgerPath?: string;
}

export interface GopkClipsHostState {
	/** Stops the poll and cleanup loops (awaiting any in-flight pass) and closes the ledger. */
	dispose(): Promise<void>;
	/** One deterministic handoff-directory pass; the scheduled loop calls the same code. */
	pollOnce(): Promise<void>;
	/** One deterministic retention pass; the scheduled loop calls the same code. */
	cleanupOnce(): Promise<void>;
}

/** Diagnostics sink; structurally satisfied by the pi-utils logger. */
export interface GopkClipsHostLogger {
	warn(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
}

const HANDOFF_DIR_NAME = "journal-handoff";
const REJECTED_SUFFIX = ".rejected";

/** Expand a leading `~` so user-supplied capture roots behave like shell paths. */
export function expandHomePath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
	return value;
}

/**
 * Build the host and start both loops. Throws when the handoff directory or
 * ledger cannot be created — callers gate session startup on that never
 * propagating (see the try/catch at the construction site).
 */
export function createGopkClipsHost(
	config: GopkClipsHostConfig,
	hostLogger: GopkClipsHostLogger = logger,
): GopkClipsHostState {
	const installId = getInstallId();
	const captureRoot = path.resolve(
		config.captureRoot ? expandHomePath(config.captureRoot) : path.join(getAgentDir(), "gopk-clips", "capture"),
	);
	const handoffDir = path.join(captureRoot, HANDOFF_DIR_NAME);
	fs.mkdirSync(handoffDir, { recursive: true });
	const ledgerPath = config.ledgerPath ?? path.join(getAgentDir(), "gopk-clips", "activity-ledger.sqlite");
	fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

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
		allowedApplicationIds: [],
		deniedApplicationIds: [...DENIED_APPLICATION_IDS],
		maximumRawClipRetentionMs: MAXIMUM_RAW_CLIP_RETENTION_MS,
	};

	const ledger = new SqliteActivityLedger(ledgerPath);
	// Sinks are keyed by the derivative's own capture session id: the sink
	// rejects any derivative whose session does not match its bound capture
	// session, and one daemon run may span several capture sessions.
	const sinks = new Map<string, GopkActivitySink>();
	const sinkFor = (sessionId: string): GopkActivitySink => {
		let sink = sinks.get(sessionId);
		if (!sink) {
			sink = createGopkActivitySink({
				ledger,
				consent,
				policy,
				capture: { userId: installId, deviceId: installId, sessionId },
				captureRoot,
				logger: hostLogger,
			});
			sinks.set(sessionId, sink);
		}
		return sink;
	};

	let stopped = false;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> = Promise.resolve();

	const pollOnce = async (): Promise<void> => {
		let entries: string[];
		try {
			entries = await fsp.readdir(handoffDir);
		} catch (error) {
			hostLogger.warn("gopk-clips host could not read handoff directory", { handoffDir, error: String(error) });
			return;
		}
		for (const entry of entries) {
			if (stopped) return;
			if (!entry.endsWith(".json")) continue; // skips *.json.tmp and *.rejected
			const filePath = path.join(handoffDir, entry);
			let raw: string;
			try {
				raw = await fsp.readFile(filePath, "utf8");
			} catch {
				continue; // deleted or still being renamed; next poll settles it
			}
			const derivative = parseDerivative(raw);
			if (!derivative) {
				await quarantine(filePath, hostLogger);
				continue;
			}
			try {
				// The sink re-validates timestamps, attestation, and path
				// containment; rejected derivatives are logged (and their raw
				// clips deleted) inside it. Either way the handoff file is
				// consumed — replaying a rejected derivative can never succeed.
				await sinkFor(derivative.sessionId)(derivative);
				await fsp.unlink(filePath);
			} catch (error) {
				hostLogger.warn("gopk-clips host failed to ingest derivative", {
					file: entry,
					error: String(error),
				});
			}
		}
	};

	const cleanupOnce = async (): Promise<void> => {
		try {
			const result = await runGopkClipCleanup(ledger, captureRoot, new Date().toISOString());
			if (result.deletedEvidenceIds.length > 0 || result.failures.length > 0) {
				hostLogger.info("gopk-clips raw-clip retention pass", {
					deleted: result.deletedEvidenceIds.length,
					failures: result.failures,
				});
			}
		} catch (error) {
			hostLogger.warn("gopk-clips raw-clip retention pass failed", { error: String(error) });
		}
	};

	// setTimeout chains (not setInterval) so passes never overlap, however slow
	// a pass runs; `inFlight` lets dispose await whichever pass is running.
	const schedulePoll = (): void => {
		if (stopped) return;
		pollTimer = setTimeout(() => {
			inFlight = inFlight.then(pollOnce).then(schedulePoll);
		}, config.pollIntervalMs);
	};
	const scheduleCleanup = (): void => {
		if (stopped) return;
		cleanupTimer = setTimeout(() => {
			inFlight = inFlight.then(cleanupOnce).then(scheduleCleanup);
		}, config.cleanupIntervalMs);
	};

	// One immediate pass of each: drain anything a dead host left behind, and
	// purge raw clips that expired while nothing was running.
	inFlight = inFlight.then(pollOnce).then(cleanupOnce);
	schedulePoll();
	scheduleCleanup();

	hostLogger.info("gopk-clips activity host started", {
		captureRoot,
		handoffDir,
		pollIntervalMs: config.pollIntervalMs,
		cleanupIntervalMs: config.cleanupIntervalMs,
	});

	let disposed: Promise<void> | undefined;
	return {
		pollOnce,
		cleanupOnce,
		dispose(): Promise<void> {
			disposed ??= (async () => {
				stopped = true;
				if (pollTimer) clearTimeout(pollTimer);
				if (cleanupTimer) clearTimeout(cleanupTimer);
				await inFlight.catch(() => {});
				ledger.close();
			})();
			return disposed;
		},
	};
}

async function quarantine(filePath: string, hostLogger: GopkClipsHostLogger): Promise<void> {
	try {
		await fsp.rename(filePath, `${filePath}${REJECTED_SUFFIX}`);
		hostLogger.warn("gopk-clips host quarantined malformed handoff file", { file: path.basename(filePath) });
	} catch (error) {
		hostLogger.warn("gopk-clips host could not quarantine handoff file", {
			file: path.basename(filePath),
			error: String(error),
		});
	}
}

/**
 * Validate untrusted handoff JSON into a well-typed derivative. Shape-only:
 * timestamp finiteness, attestation semantics, and pointer containment are
 * enforced again by the sink, which was written to receive untrusted input.
 */
export function parseDerivative(raw: string): GopkCapturedDerivative | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (!isNonEmptyString(record.clipId)) return undefined;
	if (!isNonEmptyString(record.sessionId)) return undefined;
	if (typeof record.sanitizedDigest !== "string") return undefined; // may legitimately be empty
	if (!isNonEmptyString(record.clipHash)) return undefined;
	if (!isNonEmptyString(record.localManifestPointer)) return undefined;
	const window = record.window as Record<string, unknown> | undefined;
	if (typeof window !== "object" || window === null) return undefined;
	if (!isNonEmptyString(window.startedAt) || !isNonEmptyString(window.endedAt)) return undefined;
	const appIdentity = record.appIdentity as Record<string, unknown> | undefined;
	if (typeof appIdentity !== "object" || appIdentity === null) return undefined;
	if (!isNonEmptyString(appIdentity.processName)) return undefined;
	if (appIdentity.browserOrigin !== undefined && typeof appIdentity.browserOrigin !== "string") return undefined;
	const attestation = record.sanitizationAttestation as Record<string, unknown> | undefined;
	if (typeof attestation !== "object" || attestation === null) return undefined;
	if (attestation.status !== "sanitized") return undefined;
	if (!isNonEmptyString(attestation.completedAt)) return undefined;
	if (!isNonEmptyString(attestation.sanitizerVersion)) return undefined;
	if (record.keyframeHash !== undefined && typeof record.keyframeHash !== "string") return undefined;
	if (record.rawClip !== undefined) {
		const rawClip = record.rawClip as Record<string, unknown>;
		if (typeof rawClip !== "object" || rawClip === null) return undefined;
		if (!isNonEmptyString(rawClip.localPointer) || !isNonEmptyString(rawClip.expiresAt)) return undefined;
	}
	return value as GopkCapturedDerivative;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
