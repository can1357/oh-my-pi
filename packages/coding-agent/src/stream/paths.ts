import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDaemonRuntimeDir } from "@oh-my-pi/pi-utils";
import { canonicalProjectDir } from "../launch/paths";

/**
 * Resolve the Unix socket or Windows named pipe `omp stream` listens on for
 * one project directory. Shares the daemon broker's canonical-cwd hashing so
 * every omp process in the same directory agrees on the endpoint.
 *
 * With `create`, the runtime directory is created (streamer side); sessions
 * only connect and must not create it.
 */
export async function streamSocketEndpoint(projectDir: string, options?: { create?: boolean }): Promise<string> {
	const canonical = await canonicalProjectDir(projectDir);
	if (process.platform === "win32") {
		const key = Bun.hash.wyhash(canonical).toString(16).padStart(16, "0");
		return `\\\\.\\pipe\\omp-stream-${key}`;
	}
	const runtimeDir = getDaemonRuntimeDir(canonical);
	if (options?.create) await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	return path.join(runtimeDir, "stream.sock");
}
