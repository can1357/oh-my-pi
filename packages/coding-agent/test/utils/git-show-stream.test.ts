import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import * as git from "../../src/utils/git";

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

	test("reassembles the exact blob bytes", async () => {
		const chunks: Uint8Array[] = [];
		let length = 0;
		for await (const chunk of git.show.stream(repoDir, "HEAD:large.txt")) {
			chunks.push(chunk);
			length += chunk.length;
		}
		const actual = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			actual.set(chunk, offset);
			offset += chunk.length;
		}
		expect(actual).toEqual(new TextEncoder().encode(content));
	});

	test("rejects output beyond the completeness cap", async () => {
		const consume = async (): Promise<void> => {
			for await (const _chunk of git.show.stream(repoDir, "HEAD:large.txt", { maxOutputBytes: 128 })) {
				// Consumption is the contract: truncation must surface at iteration time.
			}
		};
		await expect(consume()).rejects.toThrow(git.GitOutputTruncatedError);
	});
});
