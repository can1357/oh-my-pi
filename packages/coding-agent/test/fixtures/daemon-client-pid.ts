/**
 * Child process for the daemon start-race test: prints `ready`, waits for one
 * stdin line (the parent's start barrier), connects with the process-shared
 * client (spawning the daemon if none answers), and prints the welcomed
 * daemon pid as JSON.
 */
import { closeDaemonClient, daemonClient } from "../../src/daemon/client";

process.stdout.write("ready\n");
for await (const _line of console) break;
try {
	const client = await daemonClient();
	process.stdout.write(`${JSON.stringify({ pid: client.welcome.daemon.pid })}\n`);
} catch (error) {
	process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
} finally {
	await closeDaemonClient();
}
process.exit(0);
