/**
 * Session artifacts for subagent outputs.
 *
 * When a session exists, writes agent outputs to a sibling directory.
 * Otherwise uses temp files that are cleaned up after execution.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Derive artifacts directory from session file path.
 *
 * /path/to/sessions/project/2026-01-01T14-28-11-636Z_uuid.jsonl
 *   → /path/to/sessions/project/2026-01-01T14-28-11-636Z_uuid/
 */
export function getArtifactsDir(sessionFile: string | null): string | null {
	if (!sessionFile) return null;
	// Strip .jsonl extension to get directory path
	if (sessionFile.endsWith(".jsonl")) {
		return sessionFile.slice(0, -6);
	}
	return sessionFile;
}

/**
 * Ensure artifacts directory exists.
 */
export function ensureArtifactsDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

/**
 * Generate artifact file paths for an agent run.
 */
export function getArtifactPaths(
	dir: string,
	agentName: string,
	index: number,
): { inputPath: string; outputPath: string; jsonlPath: string } {
	const base = `${agentName}_${index}`;
	return {
		inputPath: path.join(dir, `${base}.in.md`),
		outputPath: path.join(dir, `${base}.out.md`),
		jsonlPath: path.join(dir, `${base}.jsonl`),
	};
}

/**
 * Write artifacts for an agent run.
 */
export async function writeArtifacts(
	dir: string,
	agentName: string,
	index: number,
	input: string,
	output: string,
	jsonlEvents?: string[],
): Promise<{ inputPath: string; outputPath: string; jsonlPath?: string }> {
	ensureArtifactsDir(dir);

	const paths = getArtifactPaths(dir, agentName, index);

	// Write input
	await fs.promises.writeFile(paths.inputPath, input, "utf-8");

	// Write output
	await fs.promises.writeFile(paths.outputPath, output, "utf-8");

	// Write JSONL if events provided
	if (jsonlEvents && jsonlEvents.length > 0) {
		await fs.promises.writeFile(paths.jsonlPath, jsonlEvents.join("\n"), "utf-8");
		return paths;
	}

	return { inputPath: paths.inputPath, outputPath: paths.outputPath };
}

/**
 * Create a temporary artifacts directory.
 */
export function createTempArtifactsDir(runId?: string): string {
	const id = runId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const dir = path.join(os.tmpdir(), `omp-task-${id}`);
	ensureArtifactsDir(dir);
	return dir;
}

/**
 * Clean up temporary artifacts.
 */
export async function cleanupTempArtifacts(paths: string[]): Promise<void> {
	for (const p of paths) {
		try {
			await fs.promises.unlink(p);
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Clean up a temporary directory and its contents.
 */
export async function cleanupTempDir(dir: string): Promise<void> {
	try {
		await fs.promises.rm(dir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
}
