/**
 * Single source of truth for gopk-clips filesystem locations. The in-session
 * ingest host, the standalone daemon, and the recall CLI all resolve through
 * here so they can never disagree about which capture root is polled or which
 * ledger is read and written.
 *
 * Precedence per path: an explicit override (a setting or a CLI flag) beats the
 * shared gopk-clips `config.json` the capture-side setup writes, which beats the
 * agent-dir default. Every result is `~`-expanded and made absolute, so neither
 * a tilde-prefixed nor a relative config value can resolve differently depending
 * on a process's working directory — which is what previously let the daemon's
 * `ingest.pid` lock and its host's capture root drift apart.
 *
 * Subpath import (not the pi-utils barrel): the barrel eagerly loads the
 * pi_natives native addon, which cannot bundle into the compiled
 * gopk-ingest.exe. See ./session-state.ts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils/dirs";

export interface GopkClipsPaths {
	/** Capture daemon root; the handoff drop is `<captureRoot>/journal-handoff`. */
	readonly captureRoot: string;
	/** Local SQLite activity ledger. */
	readonly ledgerPath: string;
}

/** Any subset of {@link GopkClipsPaths}; empty strings count as unset. */
export type GopkClipsPathOverrides = Partial<GopkClipsPaths>;

export interface GopkClipsCapturePolicy {
	readonly enabled: boolean;
	readonly ocrEnabled: boolean;
}

/** Expand a leading `~` so user-supplied paths behave like shell paths. */
export function expandHomePath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
	return value;
}

/** Well-known config.json shared with the gopk-clips capture side. */
export function sharedConfigPath(): string {
	if (process.platform === "win32") {
		const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
		return path.join(base, "gopk-clips", "config.json");
	}
	const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	return path.join(base, "gopk-clips", "config.json");
}

/** Path overrides from the shared config, or none when it is absent or unreadable. */
function readSharedConfig(): GopkClipsPathOverrides {
	try {
		const parsed = JSON.parse(fs.readFileSync(sharedConfigPath(), "utf8")) as GopkClipsPathOverrides;
		if (typeof parsed !== "object" || parsed === null) return {};
		return {
			...(typeof parsed.captureRoot === "string" ? { captureRoot: parsed.captureRoot } : {}),
			...(typeof parsed.ledgerPath === "string" ? { ledgerPath: parsed.ledgerPath } : {}),
		};
	} catch {
		return {};
	}
}

/** Read the shared capture consent fail-closed for the standalone ingester. */
export function resolveSharedGopkClipsCapturePolicy(): GopkClipsCapturePolicy {
	try {
		const parsed = JSON.parse(fs.readFileSync(sharedConfigPath(), "utf8")) as Record<string, unknown>;
		if (typeof parsed !== "object" || parsed === null) return { enabled: false, ocrEnabled: false };
		const consent = parsed.consent;
		if (typeof consent !== "object" || consent === null || Array.isArray(consent)) {
			return { enabled: false, ocrEnabled: false };
		}
		const record = consent as Record<string, unknown>;
		const current =
			record.policyVersion === "context-retention/v2" &&
			typeof record.acceptedAt === "string" &&
			Number.isFinite(Date.parse(record.acceptedAt)) &&
			typeof record.framesOptIn === "boolean" &&
			(record.ocrOptIn === undefined || typeof record.ocrOptIn === "boolean");
		const enabled = current && parsed.enabled === true;
		return {
			enabled,
			ocrEnabled: enabled && parsed.ocrEnabled === true && record.framesOptIn === true && record.ocrOptIn === true,
		};
	} catch {
		return { enabled: false, ocrEnabled: false };
	}
}

/**
 * Resolve both gopk-clips paths to absolute, `~`-expanded form. Extra
 * properties on `overrides` are ignored, so callers can pass a wider config
 * object straight through.
 */
export function resolveGopkClipsPaths(overrides: GopkClipsPathOverrides = {}): GopkClipsPaths {
	const shared = readSharedConfig();
	const agentRoot = path.join(getAgentDir(), "gopk-clips");
	const captureRoot = overrides.captureRoot || shared.captureRoot || path.join(agentRoot, "capture");
	const ledgerPath = overrides.ledgerPath || shared.ledgerPath || path.join(agentRoot, "activity-ledger.sqlite");
	return {
		captureRoot: path.resolve(expandHomePath(captureRoot)),
		ledgerPath: path.resolve(expandHomePath(ledgerPath)),
	};
}
