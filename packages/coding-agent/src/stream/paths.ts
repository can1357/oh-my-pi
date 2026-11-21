import * as path from "node:path";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getDaemonDir } from "@oh-my-pi/pi-utils";
import { canonicalProjectDir } from "../daemon/client";

/**
 * Resolve the local IPC endpoint `omp stream` listens on for one project
 * directory. Keyed on the canonical project dir so every omp process in the
 * same directory agrees on the endpoint.
 */
export async function streamSocketEndpoint(projectDir: string): Promise<string> {
	const key = Bun.hash
		.wyhash(await canonicalProjectDir(projectDir))
		.toString(16)
		.padStart(16, "0");
	return ipcEndpoint(path.join(getDaemonDir(), "streams", key), "stream");
}
