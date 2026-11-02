import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

export interface TempHomeState {
	tempDir: string;
	tempHomeDir: string;
	originalHome: string | undefined;
}

/**
 * Returns a synchronous put-back of HOME that also removes the temp dirs. Pass it to a
 * synchronous `afterEach`, or register it with `onTestFinished` from `beforeEach` when an
 * async `afterEach` must still see the temp home. Never call it after an await: a timed-out
 * hook that resumes later would put HOME back during another test.
 */
export function cleanupTempHome(getState: () => TempHomeState): () => void {
	return () => {
		const { tempDir, tempHomeDir, originalHome } = getState();
		if (tempDir) {
			removeSyncWithRetries(tempDir);
		}
		if (tempHomeDir) {
			removeSyncWithRetries(tempHomeDir);
		}
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
	};
}
