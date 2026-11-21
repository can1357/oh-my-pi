import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveActiveRepoContext, resolveActiveRepoContextSync } from "../../src/utils/active-repo-context";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-active-repo-"));
	roots.push(root);
	return root;
}

async function makeGitChild(root: string, name: string): Promise<string> {
	const child = path.join(root, name);
	await fs.mkdir(path.join(child, ".git", "refs", "heads"), { recursive: true });
	await fs.writeFile(path.join(child, ".git", "HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(path.join(child, ".git", "refs", "heads", "main"), "0".repeat(40) + "\n");
	return child;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveActiveRepoContext", () => {
	it("finds a single direct-child repo without requiring sorted entries", async () => {
		const root = await makeRoot();
		const child = await makeGitChild(root, "zeta-repo");
		await fs.writeFile(path.join(root, "alpha.txt"), "noise");

		const context = await resolveActiveRepoContext(root);
		expect(context?.repoRoot).toBe(path.resolve(child));
		expect(context?.relativeRepoRoot).toBe("zeta-repo");
		expect(resolveActiveRepoContextSync(root)?.repoRoot).toBe(path.resolve(child));
	});

	it("returns null when a second direct-child repo appears", async () => {
		const root = await makeRoot();
		await makeGitChild(root, "repo-a");
		await makeGitChild(root, "repo-b");

		expect(await resolveActiveRepoContext(root)).toBeNull();
		expect(resolveActiveRepoContextSync(root)).toBeNull();
	});

	it("skips the per-child scan on directories with too many entries", async () => {
		const root = await makeRoot();
		const child = await makeGitChild(root, "only-repo");
		// Above the scanner cap; a scratch directory like a temp folder must not
		// trigger thousands of .git stats on every session creation.
		for (let i = 0; i < 4100; i++) await fs.writeFile(path.join(root, `f${i}`), "");

		expect(await resolveActiveRepoContext(root)).toBeNull();
		expect(resolveActiveRepoContextSync(root)).toBeNull();
		// The repo marker is real; only the cap suppresses the scan.
		expect(await fs.stat(path.join(child, ".git", "HEAD"))).toBeDefined();
	});
});
