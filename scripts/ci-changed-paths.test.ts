import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const SCRIPT = path.join(import.meta.dir, "ci-changed-paths.sh");
const ZERO = "0".repeat(40);
// Every case spawns git several times; a loaded machine takes seconds per fetch.
const TIMEOUT = 60_000;
const gitEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

let root: string;
let origin: string;
const sha: Record<string, string> = {};

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await $`git ${args}`.cwd(cwd).quiet().env(gitEnv)).text().trim();
}

async function commit(name: string, change: () => Promise<void>): Promise<void> {
	await change();
	await git(origin, "add", "-A");
	await git(origin, "commit", "-q", "-m", name);
	sha[name] = await git(origin, "rev-parse", "HEAD");
}

const write = (file: string, text: string) => Bun.write(path.join(origin, file), text);

/** A shallow, blob-less checkout of `ref`, as `actions/checkout` makes one. */
async function checkout(ref: string, depth: number): Promise<string> {
	const dir = await fs.mkdtemp(path.join(root, "checkout-"));
	await git(dir, "init", "-q");
	await git(dir, "remote", "add", "origin", `file://${origin}`);
	await git(dir, "fetch", "-q", "--no-tags", `--depth=${depth}`, "--filter=blob:none", "origin", ref);
	await git(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
	return dir;
}

async function run(cwd: string, event: string, args: string[], payload: object = {}) {
	const eventPath = path.join(cwd, "..", `${path.basename(cwd)}-event.json`);
	await Bun.write(eventPath, JSON.stringify(payload));
	const proc = Bun.spawn(["bash", SCRIPT, ...args], {
		cwd,
		env: { ...gitEnv, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, paths: stdout.split("\n").filter(Boolean), stdout: stdout.trim(), stderr };
}

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "ci-changed-paths-"));
	origin = path.join(root, "origin");
	await fs.mkdir(origin);
	await git(origin, "init", "-q", "-b", "main");
	// GitHub serves any reachable commit by SHA; a file:// remote needs this.
	await git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
	await commit("base", async () => {
		await write("sdk/go/a.go", "a\n");
		// A second file, so moving a.go away is not read as renaming sdk/go.
		await write("sdk/go/go.mod", "module x\n");
		await write("packages/x/a.ts", "a\n");
	});
	for (const [branch, change] of [
		["pr-sdk", () => write("sdk/go/a.go", "a\npr\n")],
		["pr-ts", () => write("packages/x/a.ts", "a\npr\n")],
		["pr-rename", () => git(origin, "mv", "sdk/go/a.go", "packages/x/a.go")],
	] as const) {
		await git(origin, "checkout", "-q", "-b", branch, sha.base);
		await commit(branch, async () => {
			await change();
		});
	}
	// The base branch moves on after the PRs fork, touching sdk/ itself.
	await git(origin, "checkout", "-q", "main");
	await commit("main-sdk", () => write("sdk/go/b.go", "b\n"));
	await commit("main-ts", () => write("packages/x/b.ts", "b\n"));
	// What GitHub checks out for a PR: refs/pull/N/merge, the PR merged into the base tip.
	for (const branch of ["pr-sdk", "pr-ts", "pr-rename"]) {
		await git(origin, "checkout", "-q", "--detach", "main");
		await git(origin, "merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch);
		await git(origin, "update-ref", `refs/pull/${branch}/merge`, "HEAD");
	}
	await git(origin, "checkout", "-q", "main");
}, TIMEOUT);

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("ci-changed-paths.sh on a pull request", () => {
	it("counts only the PR's own changes, never the base branch's commits since the fork point", async () => {
		const tsPr = await checkout("refs/pull/pr-ts/merge", 2);
		// main-sdk changed sdk/ after pr-ts forked; a diff from the fork point or
		// from the PR head would report sdk/go/b.go and wrongly run the SDK jobs.
		expect(await run(tsPr, "pull_request", ["sdk"])).toMatchObject({ exitCode: 0, paths: [] });
		expect(await run(tsPr, "pull_request", ["packages"])).toMatchObject({ exitCode: 0, paths: ["packages/x/a.ts"] });
		expect(await run(tsPr, "pull_request", ["--print-base"])).toMatchObject({ exitCode: 0, stdout: sha["main-ts"] });

		const sdkPr = await checkout("refs/pull/pr-sdk/merge", 2);
		expect(await run(sdkPr, "pull_request", ["sdk"])).toMatchObject({ exitCode: 0, paths: ["sdk/go/a.go"] });
	}, TIMEOUT);

	it("counts a file moved out of the pathspec", async () => {
		const renamePr = await checkout("refs/pull/pr-rename/merge", 2);
		expect(await run(renamePr, "pull_request", ["sdk"])).toMatchObject({ exitCode: 0, paths: ["sdk/go/a.go"] });
	}, TIMEOUT);

	it("answers unknown, so the caller runs, when the checkout cannot show the base", async () => {
		const tooShallow = await checkout("refs/pull/pr-sdk/merge", 1);
		const shallow = await run(tooShallow, "pull_request", ["sdk"]);
		expect(shallow.exitCode).toBe(3);
		expect(shallow.stderr).toContain("fetch-depth: 2");

		const notMerge = await checkout("pr-sdk", 2);
		expect(await run(notMerge, "pull_request", ["sdk"])).toMatchObject({ exitCode: 3, stdout: "" });
	}, TIMEOUT);
});

describe("ci-changed-paths.sh on a push", () => {
	it("counts every pushed commit, fetching a previous tip older than the shallow history", async () => {
		// Pushing main-sdk and main-ts together: `before` is base, beyond depth 2.
		const tip = await checkout("main", 2);
		const twoCommits = { before: sha.base, forced: false };
		expect(await run(tip, "push", ["sdk"], twoCommits)).toMatchObject({ exitCode: 0, paths: ["sdk/go/b.go"] });
		expect(await run(tip, "push", ["--print-base"], twoCommits)).toMatchObject({ exitCode: 0, stdout: sha.base });
		const lastOnly = { before: sha["main-sdk"], forced: false };
		expect(await run(tip, "push", ["sdk"], lastOnly)).toMatchObject({ exitCode: 0, paths: [] });
	}, TIMEOUT);

	it("answers unknown for a forced push, a new branch, or an event with no base", async () => {
		const tip = await checkout("main", 2);
		expect(await run(tip, "push", ["sdk"], { before: sha.base, forced: true })).toMatchObject({ exitCode: 3 });
		expect(await run(tip, "push", ["sdk"], { before: ZERO, forced: false })).toMatchObject({ exitCode: 3 });
		expect(await run(tip, "workflow_dispatch", ["sdk"])).toMatchObject({ exitCode: 3, stdout: "" });
	}, TIMEOUT);
});
