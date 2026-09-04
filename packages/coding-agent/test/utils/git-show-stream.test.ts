import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $ } from "bun";

describe("git show byte stream", () => {
	let repoDir: string;
	const content = `${Array.from({ length: 2_000 }, (_, index) => `line ${index} 🚀`).join("\n")}\n`;

	beforeAll(async () => {
		repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-show-stream-"));
		await $`git init --initial-branch=main`.cwd(repoDir).quiet();
		await $`git config user.name "Test User"`.cwd(repoDir).quiet();
		await $`git config user.email "test@example.com"`.cwd(repoDir).quiet();
		await Bun.write(path.join(repoDir, "large.txt"), content);
		await $`git add large.txt`.cwd(repoDir).quiet();
		await $`git commit -m fixture`.cwd(repoDir).quiet();
	});

	afterAll(async () => {
		await fs.rm(repoDir, { recursive: true, force: true });
	});

	test("returns the exact blob without truncation", async () => {
		const result = await vcs.requireGit(repoDir).showBlob("HEAD:large.txt");
		expect(result.data).toEqual(Buffer.from(content));

		expect(result.truncated).toBe(false);
	});

	test("returns the bounded prefix and reports truncation", async () => {
		const result = await vcs.requireGit(repoDir).showBlob("HEAD:large.txt", 128);
		expect(result.data).toEqual(Buffer.from(content).subarray(0, 128));

		expect(result.truncated).toBe(true);
	});
});
