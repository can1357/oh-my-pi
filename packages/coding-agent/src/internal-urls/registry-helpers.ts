/**
 * Shared helpers for internal-url protocol handlers that resolve IDs against
 * registered agent sessions.
 */
import { AgentRegistry } from "../registry/agent-registry";

const extraArtifactsDirs = new Set<string>();

export function registerArtifactsDir(dir: string): () => void {
	extraArtifactsDirs.add(dir);
	return () => {
		extraArtifactsDirs.delete(dir);
	};
}

export function resetRegisteredArtifactDirsForTests(): void {
	extraArtifactsDirs.clear();
}

/**
 * Snapshot of artifacts dirs for every registered session, deduped.
 *
 * Prefers `sessionManager.getArtifactsDir()` because subagents adopt their
 * parent's `ArtifactManager` and report the parent's dir there; dedup then
 * collapses parent + N subagents (the whole agent tree) to one entry. Falls
 * back to the raw session file (with the `.jsonl` suffix stripped) when no
 * live session reference is attached.
 */
export function artifactsDirsFromRegistry(): string[] {
	const dirs: string[] = [];
	const addDir = (dir: string | null | undefined) => {
		if (!dir) return;
		if (!dirs.includes(dir)) dirs.push(dir);
	};
	for (const ref of AgentRegistry.global().list()) {
		addDir(ref.session?.sessionManager.getArtifactsDir() ?? (ref.sessionFile ? ref.sessionFile.slice(0, -6) : null));
	}
	for (const dir of extraArtifactsDirs) addDir(dir);
	return dirs;
}
