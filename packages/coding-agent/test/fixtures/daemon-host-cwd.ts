/**
 * Stand-in CLI host for the daemon cwd test. Declares itself the worker host
 * entry (as `cli.ts` does), so the client spawns the daemon by re-entering this
 * file the way a compiled binary or source CLI would. In daemon mode it records
 * its cwd in the runtime dir before serving; in client mode it connects
 * (spawning the daemon) and prints the daemon pid as JSON.
 */
import * as path from "node:path";
import { declareWorkerHostEntry } from "@oh-my-pi/pi-utils";
import { closeDaemonClient, daemonClient } from "../../src/daemon/client";
import { daemonDir } from "../../src/daemon/paths";
import { DAEMON_WORKER_ARG } from "../../src/daemon/protocol";
import { startDaemonFromEnvironment } from "../../src/daemon/server";

declareWorkerHostEntry();
if (process.argv.includes(DAEMON_WORKER_ARG)) {
	await Bun.write(path.join(daemonDir(), "daemon-cwd"), process.cwd());
	await startDaemonFromEnvironment();
	process.exit(0);
}
try {
	const client = await daemonClient();
	process.stdout.write(`${JSON.stringify({ pid: client.welcome.daemon.pid })}\n`);
} catch (error) {
	process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
} finally {
	await closeDaemonClient();
}
process.exit(0);
