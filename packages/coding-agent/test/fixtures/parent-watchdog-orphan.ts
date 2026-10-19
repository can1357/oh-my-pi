/**
 * Two-role fixture for `startParentWatchdog`.
 *
 * - `child`: arms the watchdog against its parent, reports `armed`, then pins
 *   its main thread in a synchronous loop — the shape of an onnxruntime
 *   `session.run` that starves every main-loop timer (issue #14340).
 * - default (middle): spawns the child, prints its pid, waits for `armed`, then
 *   SIGKILLs itself so the child is orphaned mid-loop.
 */
import { startParentWatchdog } from "../../src/subprocess/parent-watchdog";

const BLOCK_MS = 20_000;

if (process.argv[2] === "child") {
	startParentWatchdog(process.ppid);
	process.stdout.write("armed\n");
	const end = Date.now() + BLOCK_MS;
	while (Date.now() < end) {}
	process.stdout.write("survived\n");
} else {
	const child = Bun.spawn([process.execPath, import.meta.path, "child"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "inherit",
	});
	process.stdout.write(`${child.pid}\n`);
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let output = "";
	while (!output.includes("armed")) {
		const { value, done } = await reader.read();
		if (done) break;
		output += decoder.decode(value);
	}
	// Exit with a distinct code (not SIGKILL, and not Windows' TerminateProcess
	// code 1) when the child died before arming, so the test can tell a broken
	// fixture from a reaped orphan.
	if (!output.includes("armed")) process.exit(2);
	process.kill(process.pid, "SIGKILL");
}
