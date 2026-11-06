import * as path from "node:path";
import { getLogsDir, logger } from "@oh-my-pi/pi-utils";
import { startCpuProfile } from "./profiler";

/** Install only for the interactive host; repeated signals cannot overlap profiles. */
export function installSignalProfiler(): () => void {
	let active = false;
	const profile = async (): Promise<void> => {
		if (active) return;
		active = true;
		try {
			const session = await startCpuProfile();
			try {
				await Bun.sleep(30_000);
			} finally {
				const result = await session.stop();
				const file = path.join(getLogsDir(), `omp.${process.pid}.${Date.now()}.cpuprofile`);
				await Bun.write(file, result.data);
				logger.warn("ui.cpu-profile", { file });
			}
		} catch (error) {
			logger.warn("ui.cpu-profile-failed", { error: String(error) });
		} finally {
			active = false;
		}
	};
	const handler = (): void => {
		void profile();
	};
	process.on("SIGUSR2", handler);
	return () => process.off("SIGUSR2", handler);
}
