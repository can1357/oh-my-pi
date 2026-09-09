import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

export interface TempHomeState {
	tempDir: string;
	tempHomeDir: string;
	originalHome: string | undefined;
}

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
