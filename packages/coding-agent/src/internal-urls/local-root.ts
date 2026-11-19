/**
 * Where a session's `local://` root lives. Dependency-free so the session manager can place
 * spills (`local://<N>.log`) there without importing the protocol handler.
 */
import * as os from "node:os";
import * as path from "node:path";

export interface LocalProtocolOptions {
	getArtifactsDir?: () => string | null;
	getSessionId?: () => string | null;
}

const WINDOWS_LOCAL_ROOT_MAX_CHARS = 180;

function safeSessionId(options: LocalProtocolOptions): string {
	const raw = options.getSessionId?.() ?? "session";
	const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return safe && safe !== "." && safe !== ".." ? safe : "session";
}

function shortLocalRoot(options: LocalProtocolOptions): string {
	// Derive the short root from the stable session id, never the artifact path,
	// so `SessionManager.moveTo()` and the resume-after-move flow keep finding
	// the same `local://` directory the session wrote pre-move.
	return path.join(os.tmpdir(), "omp-local", safeSessionId(options));
}

/** Resolve the session-scoped local:// root, shortening long Windows artifact paths before writes hit MAX_PATH. */
export function resolveLocalRoot(options: LocalProtocolOptions, platform: NodeJS.Platform = process.platform): string {
	const artifactsDir = options.getArtifactsDir?.();
	if (artifactsDir) {
		const candidate = path.resolve(artifactsDir, "local");
		if (platform === "win32" && candidate.length >= WINDOWS_LOCAL_ROOT_MAX_CHARS) {
			return shortLocalRoot(options);
		}
		return candidate;
	}

	return path.join(os.tmpdir(), "omp-local", safeSessionId(options));
}
