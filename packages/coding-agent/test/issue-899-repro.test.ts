import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $ } from "bun";

describe("issue #899 — sync Git metadata reads survive interrupted JS filesystem access", () => {
	let tempDir: string;
	let headPath: string;
	let commit: string;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "issue-899-"));
		// A real repository: native reads resolve a ref only to an object present in the repository.
		await $`git init -q -b main && git -c user.name=T -c user.email=t@t -c commit.gpgsign=false commit -q --allow-empty -m init`
			.cwd(tempDir)
			.quiet();
		commit = (await $`git rev-parse HEAD`.cwd(tempDir).text()).trim();
		headPath = path.join(tempDir, ".git", "HEAD");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	test("VcsGitRepo.headSync remains authoritative when the old JS read path raises EINTR", () => {
		const realReadFileSync = fs.readFileSync;
		vi.spyOn(fs, "readFileSync").mockImplementation(((filePath: fs.PathOrFileDescriptor, options?: unknown) => {
			if (typeof filePath === "string" && filePath === headPath) {
				throw Object.assign(new Error("interrupted system call"), { code: "EINTR" });
			}
			return (realReadFileSync as (target: fs.PathOrFileDescriptor, opts?: unknown) => string | Buffer)(
				filePath,
				options,
			);
		}) as typeof fs.readFileSync);

		expect(vcs.requireGit(tempDir).headSync()).toMatchObject({
			kind: "ref",
			branch: "main",
			commit,
		});
	});
});
