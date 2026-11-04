/**
 * One omp-like owner of a task-isolation sandbox, for the start-up recovery
 * tests. It materialises a sandbox the way an isolated task run does —
 * `ensureIsolation`, then the baseline recorded with its owner — optionally
 * writes work into it, says where it is on one `@@`-prefixed JSON line, and
 * then waits. The test kills it with SIGKILL to make a dead owner, or leaves
 * it running to make a live one.
 *
 * Usage: `isolation-owner.ts <repo> <task id> <session id> <clean|dirty>`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { captureIsolationBaseline, ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";

const [repo, id, sessionId, mode] = process.argv.slice(2);
if (!repo || !id || !sessionId || (mode !== "clean" && mode !== "dirty")) {
	throw new Error("Usage: isolation-owner.ts <repo> <task id> <session id> <clean|dirty>");
}

const handle = await ensureIsolation(repo, id, natives.IsoBackendKind.Rcopy);
await captureIsolationBaseline(handle.mergedDir, repo, undefined, { taskId: id, ownerSessionId: sessionId });
if (mode === "dirty") {
	await fs.writeFile(path.join(handle.mergedDir, "task-output.txt"), `work of ${id}\n`);
	await fs.appendFile(path.join(handle.mergedDir, "file.txt"), `changed by ${id}\n`);
}
process.stdout.write(`@@${JSON.stringify({ mergedDir: handle.mergedDir })}\n`);
// Stay alive until killed: the sandbox's owner is this process.
setInterval(() => {}, 1 << 30);
