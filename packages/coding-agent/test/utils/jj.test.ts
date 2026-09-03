import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $which, removeWithRetries } from "@oh-my-pi/pi-utils";

describe("jj workspace detection", () => {
	let tmpDir: string | undefined;

	afterEach(async () => {
		if (tmpDir) {
			await removeWithRetries(tmpDir);
			tmpDir = undefined;
		}
	});

	async function createTempDir(): Promise<string> {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jj-utils-"));
		return tmpDir;
	}

	it("finds JJ workspace metadata from a nested cwd", async () => {
		const dir = await createTempDir();
		const nested = path.join(dir, "packages", "coding-agent");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(nested, { recursive: true });

		const workspace = vcs.jj(nested);
		expect(workspace?.root()).toBe(dir);
		expect(workspace).not.toBeNull();
	});

	it("does not treat a bare .jj directory as a workspace", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, ".jj"), { recursive: true });

		const workspace = vcs.jj(dir);
		expect(workspace?.root() ?? null).toBeNull();
		expect(workspace).toBeNull();
	});

	it("detects a non-default workspace whose .jj/repo is a file", async () => {
		const dir = await createTempDir();
		const secondary = path.join(dir, "ws2");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(path.join(secondary, ".jj", "working_copy"), { recursive: true });
		await fs.writeFile(path.join(secondary, ".jj", "repo"), path.join("..", "..", ".jj", "repo"));

		const workspace = vcs.jj(secondary);
		expect(workspace?.root()).toBe(secondary);
		expect(workspace).not.toBeNull();
	});
});

describe("isPureJjRepo", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	async function createTempDir(prefix: string): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	async function initGit(dir: string): Promise<void> {
		const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
		const exit = async (args: string[]) => {
			const proc = Bun.spawn(["git", "-C", dir, ...args], { env, stdout: "ignore", stderr: "pipe" });
			const code = await proc.exited;
			if (code !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
			}
		};
		await exit(["init", "-q", "-b", "main"]);
		await exit(["config", "user.email", "test@example.com"]);
		await exit(["config", "user.name", "Test"]);
	}

	it("flags a pure jj workspace with no colocated git", async () => {
		const dir = await createTempDir("omp-jj-pure-");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		expect(vcs.isPureJj(dir)).toBe(true);
	});

	it("treats a colocated jj-git workspace as non-pure", async () => {
		const dir = await createTempDir("omp-jj-colocated-");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await initGit(dir);
		expect(vcs.isPureJj(dir)).toBe(false);
	});

	it("returns false for a plain git checkout", async () => {
		const dir = await createTempDir("omp-jj-plaingit-");
		await initGit(dir);
		expect(vcs.isPureJj(dir)).toBe(false);
	});

	it("returns false when neither jj nor git metadata is present", async () => {
		const dir = await createTempDir("omp-jj-empty-");
		expect(vcs.isPureJj(dir)).toBe(false);
	});

	it("flags a jj workspace nested inside an unrelated git checkout as pure", async () => {
		const outer = await createTempDir("omp-jj-nested-outer-");
		await initGit(outer);
		const inner = path.join(outer, "nested");
		await fs.mkdir(path.join(inner, ".jj", "repo", "store"), { recursive: true });
		expect(vcs.isPureJj(inner)).toBe(true);
	});

	it("treats a nested git checkout under an outer jj workspace as non-pure", async () => {
		const outer = await createTempDir("omp-jj-nested-jj-outer-");
		await fs.mkdir(path.join(outer, ".jj", "repo", "store"), { recursive: true });
		const inner = path.join(outer, "vendor");
		await fs.mkdir(inner, { recursive: true });
		await initGit(inner);
		expect(vcs.isPureJj(inner)).toBe(false);
	});
});

const jjBinary = $which("jj");

describe.skipIf(!jjBinary)("native JJ workspace queries", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	async function createRepo(): Promise<string> {
		if (!jjBinary) throw new Error("jj skip guard failed");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jj-native-"));
		tempDirs.push(dir);
		const proc = Bun.spawn([jjBinary, "git", "init", "--colocate", "."], {
			cwd: dir,
			stdout: "ignore",
			stderr: "pipe",
		});
		if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
		return dir;
	}

	async function runJj(dir: string, args: string[]): Promise<void> {
		if (!jjBinary) throw new Error("jj skip guard failed");
		const proc = Bun.spawn([jjBinary, ...args], { cwd: dir, stdout: "ignore", stderr: "pipe" });
		if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
	}

	it("returns the working-copy bookmark selected by JJ", async () => {
		const dir = await createRepo();
		await runJj(dir, ["bookmark", "create", "feature"]);
		const workspace = vcs.jj(dir);
		expect(await workspace?.workingCopyLabel()).toBe("feature");
	});

	it("snapshots new files for status and changed-file queries", async () => {
		const dir = await createRepo();
		await Bun.write(path.join(dir, "new.txt"), "native jj\n");

		const workspace = vcs.jj(dir);
		expect(await workspace?.statusSummary()).toEqual({ staged: 0, unstaged: 0, untracked: 1 });
		expect(await workspace?.changedFiles([], true)).toEqual(["new.txt"]);
	});
});
