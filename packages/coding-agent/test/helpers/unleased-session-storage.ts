import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

/**
 * A writer that holds no session ownership lease: it appends to a session file
 * whoever else is writing it. It stands in for a writer this process cannot
 * see through the lease — another omp process, an older build, or an external
 * tool — in a test that has to run both writers in one process.
 */
export class UnleasedSessionStorage extends FileSessionStorage {
	override claimSession(): () => void {
		return () => {};
	}
}
