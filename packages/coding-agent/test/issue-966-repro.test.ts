import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";

describe("issue #966 split commit restaging", () => {
	it("recreates split commits when one commit contains a newly created file", async () => {
		const packageRoot = path.join(import.meta.dir, "..");
		const script = `
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-issue-966-"));
try {
	await $\`git init --initial-branch=main\`.cwd(dir).quiet();
	await $\`git config user.email tester@example.com\`.cwd(dir).quiet();
	await $\`git config user.name Tester\`.cwd(dir).quiet();
	await fs.writeFile(path.join(dir, "tracked.txt"), "base\\n");
	await $\`git add tracked.txt\`.cwd(dir).quiet();
	await $\`git commit -m baseline\`.cwd(dir).quiet();
	const repo = vcs.requireGit(dir);
	await fs.writeFile(path.join(dir, "tracked.txt"), "base\\ntracked change\\n");
	await fs.writeFile(path.join(dir, "new-file.txt"), "sample data\\n");
	await repo.stageFiles([]);
	const originalStagedDiff = await repo.diffText({ cached: true });
	await repo.unstage([]);
	await repo.stageHunks([{ path: "new-file.txt", kind: "all" }], originalStagedDiff);
	const firstStage = await repo.changedFiles({ cached: true });
	if (!Bun.deepEquals(firstStage, ["new-file.txt"])) {
		throw new Error("unexpected first stage: " + JSON.stringify(firstStage));
	}
	await repo.commitCreate("feat: add new file", {});
	await repo.stageHunks([{ path: "tracked.txt", kind: "all" }], originalStagedDiff);
	const secondStage = await repo.changedFiles({ cached: true });
	if (!Bun.deepEquals(secondStage, ["tracked.txt"])) {
		throw new Error("unexpected second stage: " + JSON.stringify(secondStage));
	}
	await repo.commitCreate("fix: update tracked file", {});
	const log = (await $\`git log --format=%s -2\`.cwd(dir).text()).trim().split("\\n");
	if (!Bun.deepEquals(log, ["fix: update tracked file", "feat: add new file"])) {
		throw new Error("unexpected log: " + JSON.stringify(log));
	}
	const summary = await repo.statusSummary();
	if (!Bun.deepEquals(summary, { staged: 0, unstaged: 0, untracked: 0 })) {
		throw new Error("unexpected status: " + JSON.stringify(summary));
	}
} finally {
	await fs.rm(dir, { recursive: true, force: true });
}
`;
		const result = await $`bun --eval ${script}`.cwd(packageRoot).quiet().nothrow();
		expect(result.exitCode).toBe(0);
	});
});
