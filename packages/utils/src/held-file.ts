/**
 * Refuses overwriting a file this process holds open with locks (issue #15586).
 *
 * Writing over a live `agent.db` or its `-shm` destroys the store (a truncated
 * `-shm` also faults the connection's memory map), so tools that write
 * agent-chosen paths check here first.
 */
import { heldFileKind } from "@oh-my-pi/pi-natives/sqlite-locks";

/**
 * Throws an `EBUSY` error when `filePath` is a file this process holds open with
 * locks: a SQLite database or `-shm` of a live connection. Always passes outside Linux.
 */
export function assertNotHeldOpen(filePath: string): void {
	const kind = heldFileKind(filePath);
	if (!kind) return;
	const holder = kind === "locked" ? "a file lock" : "a SQLite connection";
	throw Object.assign(
		new Error(`EBUSY: '${filePath}' is held open by ${holder} in this process; overwriting it would destroy it`),
		{ code: "EBUSY", path: filePath },
	);
}
