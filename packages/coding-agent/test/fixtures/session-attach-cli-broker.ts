import * as fs from "node:fs";
import * as path from "node:path";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { DAEMON_BROKER_WORKER_ARG } from "../../src/cli/worker-selectors";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint, daemonRuntimeDir } from "../../src/launch/paths";
import { DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

const [projectDir, reportFile, stopFile, legacyBrokerCli] = process.argv.slice(2);
if (!projectDir || !reportFile || !stopFile) {
	throw new Error("usage: session-attach-cli-broker <projectDir> <reportFile> <stopFile> [legacyBrokerCli]");
}
const brokerCli = legacyBrokerCli ?? path.resolve(import.meta.dir, "../../src/cli.ts");
const runtimeDir = daemonRuntimeDir(projectDir);
const initializer = await createDaemonBrokerClient(projectDir);
initializer.close();
const broker = Bun.spawn([process.execPath, brokerCli, DAEMON_BROKER_WORKER_ARG], {
	cwd: projectDir,
	env: { ...process.env, [DAEMON_PROJECT_DIR_ENV]: projectDir, [DAEMON_RUNTIME_DIR_ENV]: runtimeDir },
	stdin: "ignore",
	stdout: "ignore",
	stderr: "pipe",
});
const deadline = Date.now() + 30_000;
while (!fs.existsSync(daemonBrokerEndpoint(runtimeDir))) {
	if (broker.exitCode !== null || Date.now() >= deadline) {
		broker.kill("SIGKILL");
		throw new Error(`Isolated broker did not publish: ${await new Response(broker.stderr).text()}`);
	}
	await Bun.sleep(20);
}
const client = await createDaemonBrokerClient(projectDir, { existingOnly: true });
const name = `mind-${crypto.randomUUID()}`;
const subscriptionId = `bootstrap-${crypto.randomUUID()}`;
const script = [
	"process.stdin.setRawMode?.(true);",
	'process.stdin.on("data", data => process.stdout.write(`OWNER-INPUT:${data.toString()}`));',
	'process.on("SIGUSR1", () => process.stdout.write("OWNER-REFRESH\\r\\n"));',
	'process.on("SIGWINCH", () => process.stdout.write("OWNER-RESIZE\\r\\n"));',
	"process.stdin.resume();",
	'process.on("SIGTERM", () => { process.stdout.write("OWNER-BANNER\\r\\n"); setTimeout(() => process.exit(42), 150); });',
	'process.on("SIGINT", () => process.exit(42));',
	'process.stdout.write("OWNER-READY\\r\\n");',
].join("\n");
const ready = Promise.withResolvers<void>();
let ownerOutput = "";
client.subscribeTerminal(subscriptionId, frame => {
	if (frame.event !== "terminal_output") return;
	ownerOutput += frame.data;
	if (ownerOutput.includes("OWNER-READY")) ready.resolve();
});
try {
	const capability = await client.request({ op: "ping" });
	if (capability.op !== "ping") throw new Error("expected broker capability response");
	const started = await client.request({
		op: "terminal_start",
		subscriptionId,
		spec: {
			name,
			application: process.execPath,
			args: ["-e", script],
			env: {},
			cwd: projectDir,
			pty: true,
			persist: true,
			detached: false,
			restart: "no",
		},
		columns: 100,
		rows: 30,
	});
	if (started.op !== "terminal_start") throw new Error("terminal_start did not start the owner");
	await withTimeout(ready.promise, 10_000, "fixture owner did not become ready");
	await client.request({ op: "terminal_detach", subscriptionId, name, id: started.daemon.id });
	fs.writeFileSync(
		reportFile,
		JSON.stringify({
			name,
			id: started.daemon.id,
			pid: started.daemon.pid,
			runtimeDir,
			brokerCli,
			brokerTerminalProtocol: capability.terminalProtocolVersion,
		}),
	);
	while (!fs.existsSync(stopFile)) await Bun.sleep(20);
} finally {
	try {
		await client.request({ op: "shutdown" });
	} catch {}
	client.close();
	await withTimeout(broker.exited, 10_000, "isolated broker did not stop").catch(() => broker.kill("SIGKILL"));
}
