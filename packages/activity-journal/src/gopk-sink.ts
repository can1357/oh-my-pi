import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ConsentRecord } from "@pk-nerdsaver-ai/pi-context-policy";
import { type GopkClipAnalysis, type GopkClipIngestionPolicy, ingestGopkClip } from "./gopk-clips";
import type { ActivityLedger } from "./ledger";
import { purgeExpiredRawClips, type RawClipCleanupResult, type RawClipRemover } from "./retention";

export interface GopkCapturedDerivative {
	readonly clipId: string;
	readonly sessionId: string;
	readonly window: { readonly startedAt: string; readonly endedAt: string };
	readonly appIdentity: { readonly processName: string; readonly browserOrigin?: string };
	readonly sanitizedDigest: string;
	readonly sanitizationAttestation: {
		readonly status: "sanitized";
		readonly completedAt: string;
		readonly sanitizerVersion: string;
	};
	readonly clipHash: string;
	readonly keyframeHash?: string;
	readonly localManifestPointer: string;
	readonly rawClip?: { readonly localPointer: string; readonly expiresAt: string };
}

/**
 * Structural so hosts can route sink diagnostics through their own logging
 * facility; defaults to `console.warn`.
 */
export interface GopkSinkLogger {
	warn(message: string, context?: Record<string, unknown>): void;
}

export interface GopkSinkOptions {
	readonly ledger: ActivityLedger;
	readonly consent: ConsentRecord | undefined;
	readonly policy: GopkClipIngestionPolicy;
	readonly capture: {
		readonly userId: string;
		readonly deviceId: string;
		readonly sessionId: string;
		readonly projectId?: string;
	};
	readonly captureRoot: string;
	readonly logger?: GopkSinkLogger;
}

export type GopkActivitySink = (derivative: GopkCapturedDerivative) => Promise<void>;

export function createGopkActivitySink(options: GopkSinkOptions): GopkActivitySink {
	const captureRoot = path.resolve(options.captureRoot);
	const rawClipRemover = createConstrainedRawClipRemover(captureRoot);
	const logger: GopkSinkLogger = options.logger ?? console;
	return async derivative => {
		if (derivative.sessionId !== options.capture.sessionId) {
			logger.warn("gopk activity sink rejected derivative: capture session mismatch");
			return;
		}
		if (derivative.sanitizationAttestation.status !== "sanitized") {
			logger.warn("gopk activity sink rejected derivative: sanitization was not attested");
			return;
		}
		if (!(await isContainedPathReal(derivative.localManifestPointer, captureRoot))) {
			logger.warn("gopk activity sink rejected derivative: manifest path escapes capture root");
			return;
		}
		if (derivative.rawClip && !(await isContainedPathReal(derivative.rawClip.localPointer, captureRoot))) {
			logger.warn("gopk activity sink rejected derivative: raw clip path escapes capture root");
			return;
		}
		const startedAtMs = Date.parse(derivative.window.startedAt);
		const endedAtMs = Date.parse(derivative.window.endedAt);
		const completedAtMs = Date.parse(derivative.sanitizationAttestation.completedAt);
		const rawExpiresAtMs = derivative.rawClip ? Date.parse(derivative.rawClip.expiresAt) : undefined;
		if (
			[startedAtMs, endedAtMs, completedAtMs].some(timestamp => !Number.isFinite(timestamp)) ||
			(rawExpiresAtMs !== undefined && !Number.isFinite(rawExpiresAtMs))
		) {
			logger.warn("gopk activity sink rejected derivative: invalid timestamp");
			return;
		}
		const startedAt = new Date(startedAtMs).toISOString();
		const endedAt = new Date(endedAtMs).toISOString();
		const completedAt = new Date(completedAtMs).toISOString();
		const rawExpiresAt = rawExpiresAtMs === undefined ? undefined : new Date(rawExpiresAtMs).toISOString();

		const processName = derivative.appIdentity.processName.trim().toLowerCase();
		const analysis: GopkClipAnalysis = {
			clipId: `${derivative.sessionId}:${derivative.clipId}`,
			window: { startedAt, endedAt },
			application: { id: processName, category: inferAppCategory(processName) },
			redaction: { status: "redacted", completedAt },
			redactedDigest: derivative.sanitizedDigest,
			activityCategory: "unknown",
			confidence: "medium",
			confidenceReason: `Sanitized by ${derivative.sanitizationAttestation.sanitizerVersion}`,
			clipHash: derivative.clipHash,
			...(derivative.keyframeHash ? { keyframeHash: derivative.keyframeHash } : {}),
			localPointer: derivative.localManifestPointer,
			...(derivative.rawClip && rawExpiresAt
				? { rawClip: { localPointer: derivative.rawClip.localPointer, expiresAt: rawExpiresAt } }
				: {}),
		};
		const result = ingestGopkClip({
			capture: options.capture,
			consent: options.consent,
			policy: options.policy,
			analysis,
			ingestedAt: new Date().toISOString(),
			ledger: options.ledger,
		});
		if (result.status === "rejected") {
			if (result.rawClipToDelete) {
				try {
					await rawClipRemover.remove(result.rawClipToDelete);
				} catch {
					logger.warn("gopk activity sink could not delete rejected raw clip");
				}
			}
			logger.warn("gopk activity sink rejected derivative", {
				reason: result.reason,
				rawClipToDelete: result.rawClipToDelete,
			});
		}
	};
}

export function createConstrainedRawClipRemover(captureRoot: string): RawClipRemover {
	const root = path.resolve(captureRoot);
	return {
		async remove(localPointer: string): Promise<void> {
			const resolved = path.resolve(localPointer);
			if (!(await isContainedPathReal(resolved, root))) throw new Error("raw clip path escapes capture root");
			try {
				await fs.unlink(resolved);
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
				throw error;
			}
		},
	};
}

export function runGopkClipCleanup(
	ledger: ActivityLedger,
	captureRoot: string,
	now: string,
): Promise<RawClipCleanupResult> {
	return purgeExpiredRawClips(ledger, createConstrainedRawClipRemover(captureRoot), now);
}

async function isContainedPathReal(localPointer: string, captureRoot: string): Promise<boolean> {
	try {
		const root = await fs.realpath(captureRoot);
		let resolved: string;
		try {
			resolved = await fs.realpath(localPointer);
		} catch (error) {
			if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
				throw error;
			}
			const parent = await fs.realpath(path.dirname(localPointer));
			resolved = path.join(parent, path.basename(localPointer));
		}
		return resolved.startsWith(`${root}${path.sep}`);
	} catch {
		return false;
	}
}

function inferAppCategory(processName: string): string {
	switch (processName.trim().toLowerCase()) {
		case "code":
		case "cursor":
		case "windsurf":
			return "editor";
		case "firefox":
		case "chrome":
		case "msedge":
			return "browser";
		case "windowsterminal":
		case "powershell":
		case "wezterm":
			return "terminal";
		default:
			return "other";
	}
}
