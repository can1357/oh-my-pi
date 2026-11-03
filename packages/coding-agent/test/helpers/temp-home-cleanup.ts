import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

export interface TempHomeState {
	tempDir: string;
	tempHomeDir: string;
}

/**
 * Returns a synchronous cleanup that removes a test's temp project and home directories. It does
 * not put HOME back: make the file or `describe` the owner of HOME with
 * `installEnvRestores(["HOME"])` from `utils/test/helpers/mock-restores`, which still puts it back
 * when an async `afterEach` times out and Bun skips `onTestFinished` and the later hooks.
 */
export function cleanupTempHome(getState: () => TempHomeState): () => void {
	return () => {
		const { tempDir, tempHomeDir } = getState();
		if (tempDir) {
			removeSyncWithRetries(tempDir);
		}
		if (tempHomeDir) {
			removeSyncWithRetries(tempHomeDir);
		}
	};
}
