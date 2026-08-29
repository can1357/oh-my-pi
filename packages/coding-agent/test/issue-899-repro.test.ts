import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

describe("issue #899 — sync Git metadata reads survive interrupted JS filesystem access", () => {
	let tempDir: string;
	let headPath: string;
	const commit = "0123456789abcdef0123456789abcdef01234567";

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "issue-899-"));
		const gitDir = path.join(tempDir, ".git");
		await fsp.mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
		await fsp.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		await fsp.writeFile(path.join(gitDir, "refs", "heads", "main"), `${commit}\n`);
		headPath = path.join(gitDir, "HEAD");
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
