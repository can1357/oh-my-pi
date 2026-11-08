import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mergeIsolatedChanges } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

function patchResult(index: number, patchPath: string): SingleResult {
	return {
		index,
		id: `t${index}`,
		agent: "task",
		agentSource: "bundled",
		task: "edit one line",
		exitCode: 0,
		output: "",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 1,
		requests: 1,
		patchPath,
	};
}

describe("mergeIsolatedChanges patch mode", () => {
	// #18483: concurrent merge-backs touching one file each rewrote it from the
	// same preimage, so the last writer dropped the others' hunks while every
	// caller still reported "Applied patches: yes".
	it("lands every same-file patch when parallel tasks merge back concurrently", async () => {
		const workers = 16;
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-merge-"));
		tempDirs.push(repo);
		const file = path.join(repo, "shared.txt");
		const lines = Array.from({ length: workers * 10 }, (_, i) => `line ${i}`);
		await Bun.write(file, `${lines.join("\n")}\n`);
		await $`git init -q -b main && git config core.autocrlf false && git add shared.txt && git -c user.email=t@t -c user.name=t commit -qm base`
			.cwd(repo)
			.quiet();

		const results: SingleResult[] = [];
		for (let i = 0; i < workers; i++) {
			const edited = lines.with(i * 10 + 5, `edited by worker ${i}`);
			await Bun.write(file, `${edited.join("\n")}\n`);
			const patchPath = path.join(repo, `.git/p${i}.patch`);
			await Bun.write(patchPath, await $`git diff`.cwd(repo).quiet().text());
			results.push(patchResult(i, patchPath));
		}
		await $`git checkout -q shared.txt`.cwd(repo).quiet();

		const outcomes = await Promise.all(
			results.map(result => mergeIsolatedChanges({ result, repoRoot: repo, mergeMode: "patch" })),
		);

		const landed = (await Bun.file(file).text()).split("\n").filter(line => line.startsWith("edited by worker"));
		expect(landed).toHaveLength(workers);
		expect(outcomes.every(o => o.changesApplied && o.hadAnyChanges)).toBe(true);
	});
});
