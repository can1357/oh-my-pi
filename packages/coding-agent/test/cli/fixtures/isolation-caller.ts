/**
 * One omp-like caller of a task-isolation workspace, for the cooperating-process
 * races in `worktree-clear-isolation.test.ts`. It goes through the real entry
 * points — `ensureIsolation`, `cleanupIsolation`, `clearWorktrees`,
 * `withSandboxLock` — so it takes the sandbox lock exactly as omp does, and
 * answers each command on stdin with one `@@`-prefixed JSON line on stdout.
 *
 * Usage: `isolation-caller.ts <repo> <task id>`; commands `make <n>`, `check <n>`,
 * `teardown`, `clear`, `hold-lock <dir> <signals>` and `probe-lock <dir> <signals>`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { withSandboxLock } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { cleanupIsolation, ensureIsolation, type IsolationHandle } from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import { acquireFileLock } from "@oh-my-pi/pi-utils";

/** Wait, by real I/O rather than a timer, until `name` exists in `signals`. */
async function awaitSignal(signals: string, name: string): Promise<void> {
	while (!(await fs.readdir(signals)).includes(name)) {
		// Waiting on the other process.
	}
}

const repo = process.argv[2];
const id = process.argv[3];
if (!repo || !id) throw new Error("Expected a repository and a task id");

// `clear` reports through console.log; the reply carries its report instead.
let printed = "";
console.log = (text?: unknown) => {
	printed = String(text);
};

let handle: IsolationHandle | undefined;

function reply(value: Record<string, unknown>): void {
	process.stdout.write(`@@${JSON.stringify(value)}\n`);
}

for await (const line of console) {
	const [command, argument, ...rest] = line.trim().split(" ");
	try {
		if (command === "make") {
			handle = await ensureIsolation(repo, id, natives.IsoBackendKind.Rcopy);
			await fs.writeFile(path.join(handle.mergedDir, "work.txt"), `work ${argument}\n`);
			reply({ ok: true, mergedDir: handle.mergedDir });
		} else if (command === "check") {
			if (!handle) throw new Error("nothing made");
			const work = await fs.readFile(path.join(handle.mergedDir, "work.txt"), "utf8").catch(() => null);
			reply({ ok: work === `work ${argument}\n`, work });
		} else if (command === "teardown") {
			if (!handle) throw new Error("nothing made");
			await cleanupIsolation(handle);
			handle = undefined;
			reply({ ok: true });
		} else if (command === "clear") {
			printed = "";
			const result = await clearWorktrees({ all: false, dryRun: false, json: true });
			reply({ ok: true, ...result, report: printed === "" ? null : JSON.parse(printed) });
		} else if (command === "hold-lock" || command === "probe-lock") {
			// The two halves of one check of the sandbox lock across processes. The
			// holder takes the lock the way omp does and keeps it until the prober
			// has looked; the prober waits until the holder is inside, then asks
			// for the same lock once, without waiting for it. A lock that excludes
			// across processes answers busy. One that does not lets the prober
			// take it. The answer depends on whether the holder holds the lock and
			// on nothing else: a stopped holder keeps its lock, and the prober never
			// waits on the holder, so no schedule can make either answer the other.
			const [signals] = rest;
			if (!argument || !signals) throw new Error(`${command} needs a dir and a signals dir`);
			if (command === "hold-lock") {
				await withSandboxLock(argument, "hold", async () => {
					await fs.writeFile(path.join(signals, "held"), "");
					await awaitSignal(signals, "probed");
				});
				reply({ ok: true });
			} else {
				await awaitSignal(signals, "held");
				let answer: "busy" | "acquired";
				try {
					(await acquireFileLock(argument, { retries: 1 })).release();
					answer = "acquired";
				} catch (error) {
					// Only contention is "busy". Any other failure is not evidence that
					// the holder holds the lock, and must not pass as it.
					if (!(error instanceof Error) || !error.message.startsWith("Failed to acquire lock")) throw error;
					answer = "busy";
				}
				await fs.writeFile(path.join(signals, "probed"), "");
				reply({ ok: true, answer });
			}
		} else {
			reply({ ok: false, error: `unknown command ${command}` });
		}
	} catch (error) {
		reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}
