/**
 * Started as a Worker by broker-test-children.ts. A Worker has a JavaScript realm of its own,
 * which the test preload's changes to the test's realm never reach. It starts the discovery
 * child with Bun's default environment and reports what the child printed.
 */
import * as path from "node:path";

const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "broker-discovery-child.ts")], {
	stdout: "pipe",
	stderr: "inherit",
});
const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
postMessage({ output, exitCode });
