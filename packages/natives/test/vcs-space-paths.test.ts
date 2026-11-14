import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vcsGitDiscover } from "../native/index.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const process = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return stdout.trimEnd();
}

async function repository() {
	const root = await mkdtemp(join(tmpdir(), "pi-natives-vcs-space-"));
	roots.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	await git(root, "config", "core.autocrlf", "false");
	await mkdir(join(root, "assets"));
	await writeFile(join(root, "assets", "old logo.png"), Uint8Array.from([0, 1, 2, 0, 3]));
	await git(root, "add", "-A");
	await git(root, "commit", "-m", "initial");
	return root;
}

// Space-containing filenames must survive a native diff -> native apply
// round-trip: the `diff --git` header cannot simply be split at the first
// space, or a binary change lands under a truncated or bogus path.
describe("native patch round-trips for paths with spaces", () => {
	test("applies a binary modification of a tracked space-named file", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		const changed = Uint8Array.from([9, 0, 8, 0, 7]);
		await writeFile(join(root, "assets", "old logo.png"), changed);

		const patch = await repo.diffText({ binary: true });
		expect(patch).toContain("diff --git a/assets/old logo.png b/assets/old logo.png");
		expect(patch).toContain("GIT binary patch");

		await git(root, "checkout", "-q", "--", "assets/old logo.png");
		await repo.applyPatch(patch, {});
		expect(new Uint8Array(await Bun.file(join(root, "assets", "old logo.png")).arrayBuffer())).toEqual(changed);
	});

	test("applies a no-index binary creation at its full space-named path", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		const created = Uint8Array.from([0, 4, 0, 5, 0]);
		await writeFile(join(root, "assets", "new logo.png"), created);

		const patch = await repo.diffNoIndex("/dev/null", join("assets", "new logo.png"), true);
		expect(patch).toContain("new file mode");
		expect(patch).toContain("GIT binary patch");

		// The synthetic-tree flow isolated tasks use: apply to a temporary
		// index seeded from HEAD and materialize the tree it describes.
		const indexPath = join(root, "synthetic.index");
		await repo.readTree("HEAD", indexPath);
		await repo.applyPatch(patch, { cached: true, indexPath });
		const tree = await repo.writeTree(indexPath);
		const listed = await git(root, "ls-tree", "-r", "--name-only", "-z", tree);
		expect(listed.split("\0")).toContain("assets/new logo.png");
		expect(listed).not.toContain("logo.png b/assets/new logo.png");
	});
});
