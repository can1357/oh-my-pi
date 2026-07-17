import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface BridgeCursorStore {
	read(): Promise<number>;
	write(lastFrameId: number): Promise<void>;
}

/**
 * Tracks the highest screenpipe frame id already handed to the gopk sink, so
 * restarts don't re-import it. A missing cursor file means a first run and
 * reads as 0; a corrupt or invalid file throws instead, so a damaged cursor
 * fails the poll loudly rather than silently re-importing from frame 0.
 */
export function createFileCursorStore(captureRoot: string): BridgeCursorStore {
	const cursorPath = path.join(path.resolve(captureRoot), "cursor.json");
	return {
		async read(): Promise<number> {
			let raw: string;
			try {
				raw = await fs.readFile(cursorPath, "utf8");
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return 0;
				throw error;
			}
			const parsed: unknown = JSON.parse(raw);
			const lastFrameId =
				typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).lastFrameId : undefined;
			if (typeof lastFrameId !== "number" || !Number.isSafeInteger(lastFrameId) || lastFrameId < 0)
				throw new Error(`bridge cursor file is malformed: ${cursorPath}`);
			return lastFrameId;
		},
		async write(lastFrameId: number): Promise<void> {
			await fs.mkdir(path.dirname(cursorPath), { recursive: true });
			// Per-write random suffix: a PID alone collides when two stores in the
			// same process (e.g. two sessions sharing one capture root) write
			// concurrently — one writer would rename the other's half-written file.
			const temporaryPath = `${cursorPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
			try {
				await fs.writeFile(temporaryPath, JSON.stringify({ lastFrameId }));
				await fs.rename(temporaryPath, cursorPath);
			} catch (error) {
				await fs.rm(temporaryPath, { force: true }).catch(() => {});
				throw error;
			}
		},
	};
}
