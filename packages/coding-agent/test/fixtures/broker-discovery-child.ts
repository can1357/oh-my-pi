/**
 * Started by broker-test-children.ts through a native shell, a native terminal and a
 * Worker's `Bun.spawn`, each time with the environment it inherits and nothing more. It runs
 * the SDK's credential discovery, which reads the auth broker the environment names unless the
 * process is a test child, and prints what it found as one line.
 */
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils";

const storage = await discoverAuthStorage();
try {
	const brokerKey = (await storage.keys.get("inherited-broker-provider")) ?? null;
	console.log(`DISCOVERY ${JSON.stringify({ testRuntime: isBunTestRuntime(), brokerKey })}`);
} finally {
	storage.close();
}
// A process that read the broker keeps its snapshot stream open; the report is all it owes.
process.exit(0);
