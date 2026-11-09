// Process fixture - the launcher is a real short-lived client: it starts a
// terminal daemon through the project broker, prints the result and exits, so
// the test can prove the owner outlives the process that launched it.
import { createDaemonBrokerClient } from "../../src/launch/client";

const [projectDir, runtimeDir, requestJson] = process.argv.slice(2);
if (!projectDir || !runtimeDir || !requestJson) {
	throw new Error("usage: session-owner-launcher <projectDir> <runtimeDir> <requestJson>");
}
const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
const result = await client.request(JSON.parse(requestJson));
process.stdout.write(JSON.stringify(result));
client.close();
