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
 * handed to the sink. Malformed files are deleted and replaced by a scrubbed
 * `<name>.json.rejected` diagnostic marker, so untrusted content is never
 * retained while operators can still see that a rejection occurred. Replays
 * after a crash between ingest and delete remain safe because the ledger deduplicates by clip identity.
 *
 * Unlike the screenpipe bridge, this host is not re-bound on agent session
 * transitions — each derivative carries the *capture* session id it was
 * recorded under, and the sink attributes evidence to that id.
 *
 * Exactly one host may run per ledger, and it is owned by the always-on
 * `gopk-ingest` daemon (see ./daemon.ts) — never by an `AgentSession`. The
 * handoff directory is a single-consumer queue: a second host would race the
 * daemon to `unlink` each file (splitting clips between them) and contend for
 * the ledger's SQLite write lock. Sessions that want activity data read the
 * ledger the daemon writes; they do not ingest.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
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
// Subpath imports (not the barrel): the pi-utils barrel eagerly loads the
// pi_natives native addon, which can't bundle into a compiled single-file exe
// (gopk-ingest.exe). dirs.ts / logger.ts are native-free, so importing narrowly
// keeps this module — and the standalone ingester built from it — self-contained.
import { getInstallId } from "@pk-nerdsaver-ai/pi-utils/dirs";
import * as logger from "@pk-nerdsaver-ai/pi-utils/logger";
import { type GopkClipsCapturePolicy, resolveGopkClipsPaths } from "./paths";
import { DENIED_APPLICATION_IDS, MAXIMUM_RAW_CLIP_RETENTION_MS } from "./policy-constants";

/** Reads the current shared capture consent for one queued derivative. */
export type GopkClipsCapturePolicyProvider = () => GopkClipsCapturePolicy;

export interface GopkClipsHostConfig {
	/**
	 * The capture daemon's root directory. The handoff drop lives at
	 * `<captureRoot>/journal-handoff`, and manifest / raw-clip pointers inside
	 * derivatives must resolve under this root or the sink rejects them.
	 * Unset defers to {@link resolveGopkClipsPaths} (shared config, then
	 * `<agentDir>/gopk-clips/capture`).
	 */
	readonly captureRoot?: string;
	/** Called immediately before each valid queued derivative enters the ingestion sink. */
	readonly capturePolicyProvider: GopkClipsCapturePolicyProvider;
	readonly pollIntervalMs: number;
	readonly cleanupIntervalMs: number;
	/** Test seam; unset defers to {@link resolveGopkClipsPaths}. */
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
	// Shared resolver: the daemon and the recall CLI derive the same absolute,
	// `~`-expanded paths from the same precedence chain.
	const { captureRoot, ledgerPath } = resolveGopkClipsPaths(config);
	const handoffDir = path.join(captureRoot, HANDOFF_DIR_NAME);
	fs.mkdirSync(handoffDir, { recursive: true });
	fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

	const ledger = new SqliteActivityLedger(ledgerPath);

	const sinkFor = (sessionId: string, capturePolicy: GopkClipsCapturePolicy): GopkActivitySink => {
		// The policy package currently names its local-persistence contract v1.
		// Rebuild both adapter records from the live shared policy for every
		// queued derivative so a sink can never retain revoked consent.
		const consent: ConsentRecord = {
			userId: installId,
			deviceId: installId,
			identityVerified: true,
			enabled: capturePolicy.enabled,
			scope: "device",
			remoteStorageEnabled: false,
			policyVersion: "context-retention/v1",
		};
		const policy: GopkClipIngestionPolicy = {
			enabled: capturePolicy.enabled,
			ocrEnabled: capturePolicy.ocrEnabled,
			allowedApplicationIds: [],
			deniedApplicationIds: [...DENIED_APPLICATION_IDS],
			maximumRawClipRetentionMs: MAXIMUM_RAW_CLIP_RETENTION_MS,
		};
		return createGopkActivitySink({
			ledger,
			consent,
			policy,
			capture: { userId: installId, deviceId: installId, sessionId },
			captureRoot,
			logger: hostLogger,
		});
	};
	const currentCapturePolicy = (): GopkClipsCapturePolicy => {
		try {
			const capturePolicy = config.capturePolicyProvider();
			if (capturePolicy?.enabled !== true) return { enabled: false, ocrEnabled: false };
			return { enabled: true, ocrEnabled: capturePolicy.ocrEnabled === true };
		} catch (error) {
			hostLogger.warn("gopk-clips host could not read current capture policy; ingestion disabled", {
				error: String(error),
			});
			return { enabled: false, ocrEnabled: false };
		}
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
				// Resolve consent only after parsing the queue item, immediately
				// before constructing its one-use sink. Missing, malformed, or
				// unreadable shared policy therefore fails this derivative closed.
				const capturePolicy = currentCapturePolicy();
				// The sink re-validates timestamps, attestation, path containment,
				// and re-redacts OCR to its 280-character cap. A derivative it
				// rejects is logged (and its raw clip deleted) inside it and still
				// returns normally, so the handoff is consumed; a thrown I/O or
				// ledger failure leaves the file for the next poll to retry.
				await sinkFor(derivative.sessionId, capturePolicy)(derivative);
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

	// Both passes swallow their own errors, but a rejection escaping one would
	// poison `inFlight` and — since rescheduling is chained off it — silently
	// stop the loop for the rest of the host's life. Absorb here so the next
	// tick is always scheduled.
	const guard = (pass: () => Promise<void>) => (): Promise<void> =>
		pass().catch(error => {
			hostLogger.warn("gopk-clips host pass threw", { error: String(error) });
		});
	const guardedPoll = guard(pollOnce);
	const guardedCleanup = guard(cleanupOnce);

	// Scheduled and explicit passes share `inFlight`, so queue consumers never
	// overlap however slow a pass runs; dispose awaits whichever pass is last.
	const schedulePoll = (): void => {
		if (stopped) return;
		pollTimer = setTimeout(() => {
			inFlight = inFlight.then(guardedPoll).then(schedulePoll);
		}, config.pollIntervalMs);
	};
	const scheduleCleanup = (): void => {
		if (stopped) return;
		cleanupTimer = setTimeout(() => {
			inFlight = inFlight.then(guardedCleanup).then(scheduleCleanup);
		}, config.cleanupIntervalMs);
	};

	// One immediate pass of each: drain anything a dead host left behind, and
	// purge raw clips that expired while nothing was running.
	inFlight = inFlight.then(guardedPoll).then(guardedCleanup);
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
		pollOnce(): Promise<void> {
			inFlight = inFlight.then(guardedPoll);
			return inFlight;
		},
		cleanupOnce(): Promise<void> {
			inFlight = inFlight.then(guardedCleanup);
			return inFlight;
		},
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
		await fsp.rm(filePath, { force: true });
		await fsp.writeFile(
			`${filePath}${REJECTED_SUFFIX}`,
			JSON.stringify({ rejectedAt: new Date().toISOString(), reason: "invalid handoff" }),
			{ flag: "wx" },
		);
		hostLogger.warn("gopk-clips host discarded malformed handoff and wrote a scrubbed diagnostic", {
			file: path.basename(filePath),
		});
	} catch (error) {
		// The raw handoff is removed before this path; diagnostic failure cannot
		// preserve user content.
		hostLogger.warn("gopk-clips host could not write rejected-handoff diagnostic", {
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
	const derivative = { ...record };
	if (!isValidOcrSnippet(derivative.ocrSnippet)) delete derivative.ocrSnippet;
	return derivative as unknown as GopkCapturedDerivative;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isValidOcrSnippet(value: unknown): value is string | undefined {
	return value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 280);
}
