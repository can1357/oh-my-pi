/**
 * One omp-like caller of a task-isolation workspace, for the cooperating-process
 * races in `worktree-clear-isolation.test.ts`. It goes through the real entry
 * points — `ensureIsolation`, `cleanupIsolation`, `clearWorktrees`,
 * `withSandboxLock` — so it takes the sandbox lock exactly as omp does, and
 * answers each command on stdin with one `@@`-prefixed JSON line on stdout.
 *
 * Usage: `isolation-caller.ts <repo> <task id>`; commands `make <n>`, `check <n>`,
 * `teardown`, `clear`, and `race-lock <dir> <barrier> <log> <busy>`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { withSandboxLock } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { cleanupIsolation, ensureIsolation, type IsolationHandle } from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";

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
		} else if (command === "race-lock") {
			// Two of these, in two processes, contend for one sandbox's lock. Each
			// announces itself at a barrier and waits there for the other, so both
			// reach the lock together; then it logs entering and leaving a critical
			// section widened by real I/O. Under the lock the two sections run one
			// after the other, and the log never interleaves; without it, both are
			// inside at once.
			const [barrier, log, busy] = rest;
			if (!argument || !barrier || !log || !busy)
				throw new Error("race-lock needs a dir, barrier, log and busy dir");
			await fs.writeFile(path.join(barrier, `ready-${process.pid}`), "");
			while ((await fs.readdir(barrier)).filter(name => name.startsWith("ready-")).length < 2) {
				// Each look is real I/O, so this waits on the sibling without a timer.
			}
			await withSandboxLock(argument, "race", async () => {
				await fs.appendFile(log, `in ${process.pid}\n`);
				for (let index = 0; index < 80; index += 1) {
					await fs.writeFile(path.join(busy, `${process.pid}-${index}`), "");
				}
				await fs.appendFile(log, `out ${process.pid}\n`);
			});
			reply({ ok: true });
		} else {
			reply({ ok: false, error: `unknown command ${command}` });
		}
	} catch (error) {
		reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}
