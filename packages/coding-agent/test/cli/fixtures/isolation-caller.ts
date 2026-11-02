/**
 * One omp-like caller of a task-isolation workspace, for the cooperating-process
 * race in `worktree-clear-isolation.test.ts`. It goes through the real entry
 * points — `ensureIsolation`, `cleanupIsolation`, `clearWorktrees` — so it takes
 * the sandbox lock exactly as omp does, and answers each command on stdin with
 * one `@@`-prefixed JSON line on stdout.
 *
 * Usage: `isolation-caller.ts <repo> <task id>`; commands `make <n>`, `check <n>`,
 * `teardown`, `clear`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
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
	const [command, argument] = line.trim().split(" ");
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
		} else {
			reply({ ok: false, error: `unknown command ${command}` });
		}
	} catch (error) {
		reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}
