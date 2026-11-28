import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import {
	GitProtocolHandler,
	InternalUrlRouter,
	listGitTags,
	parseInternalUrl,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test Author",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test Author",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString("utf8")}`);
	}
	return proc.stdout.toString("utf8").trim();
}

let tempDir: string;
let repoDir: string;
let nonGitDir: string;
let initialSha: string;
let mainSecondSha: string;
let featureSha: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-protocol-"));
	repoDir = path.join(tempDir, "repo");
	nonGitDir = path.join(tempDir, "plain");
	await fs.mkdir(repoDir, { recursive: true });
	await fs.mkdir(nonGitDir, { recursive: true });

	git(repoDir, "init", "-b", "main");
	await Bun.write(path.join(repoDir, "README.md"), "# Demo\nhello\n");
	git(repoDir, "add", "README.md");
	git(repoDir, "commit", "-m", "Initial commit");
	initialSha = git(repoDir, "rev-parse", "HEAD");

	// Create lightweight, nested, and annotated tags.
	git(repoDir, "tag", "v0.1");
	git(repoDir, "tag", "v0.2");
	git(repoDir, "tag", "release/v1.0");
	git(repoDir, "tag", "-a", "v0.15", "-m", "Annotated v0.15");

	// Feature branch with a slash in its name.
	git(repoDir, "checkout", "-b", "feat/unified-selector");
	await Bun.write(path.join(repoDir, "feature.ts"), "export const feature = 1;\n");
	git(repoDir, "add", "feature.ts");
	git(repoDir, "commit", "-m", "Add unified selector");
	featureSha = git(repoDir, "rev-parse", "HEAD");

	// Return to main and add a commit so main and feat/unified-selector diverge.
	git(repoDir, "checkout", "main");
	await Bun.write(path.join(repoDir, "README.md"), "# Demo\nhello world\n");
	git(repoDir, "add", "README.md");
	git(repoDir, "commit", "-m", "Update README on main");
	mainSecondSha = git(repoDir, "rev-parse", "HEAD");

	// Point origin/HEAD at origin/main so defaultBranch() resolves "main".
	git(repoDir, "update-ref", "refs/remotes/origin/main", mainSecondSha);
	git(repoDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
});

afterEach(async () => {
	InternalUrlRouter.resetForTests();
	await removeWithRetries(tempDir);
});

describe("listGitTags", () => {
	it("reads loose, nested, and packed tags with deduplication and version-friendly ordering", async () => {
		const repo = vcs.requireGit(repoDir);
		// Pack existing refs (creates packed-refs with comments and ^ peeled lines for annotated v0.15).
		git(repoDir, "pack-refs", "--all");
		// Add a fresh loose tag and a duplicate loose tag alongside packed-refs.
		git(repoDir, "tag", "v0.16");
		await Bun.write(path.join(repo.info().commonDir, "refs", "tags", "v0.15"), `${initialSha}\n`);

		const tags = await listGitTags(repo);
		expect(tags).toContain("release/v1.0");
		expect(tags.filter(t => t === "v0.15")).toHaveLength(1);
		expect(tags.indexOf("v0.16")).toBeLessThan(tags.indexOf("v0.15"));
		expect(tags.indexOf("v0.15")).toBeLessThan(tags.indexOf("v0.2"));
		expect(tags.indexOf("v0.2")).toBeLessThan(tags.indexOf("v0.1"));
	});

	it("falls back to repo.tagsAt('HEAD') for reftable repositories", async () => {
		const fakeRepo = {
			info: () => ({
				repoRoot: repoDir,
				gitEntryPath: path.join(repoDir, ".git"),
				gitDir: path.join(repoDir, ".git"),
				commonDir: path.join(repoDir, ".git"),
				headPath: path.join(repoDir, ".git", "HEAD"),
				isReftable: true,
			}),
			tagsAt: async (rev: string) => (rev === "HEAD" ? ["v0.2", "v0.10"] : []),
		} as unknown as VcsGitRepo;

		const tags = await listGitTags(fakeRepo);
		expect(tags).toEqual(["v0.10", "v0.2"]);
	});
});

describe("GitProtocolHandler", () => {
	const handler = new GitProtocolHandler();

	it("exposes a non-empty promptDoc and registers on InternalUrlRouter", () => {
		const doc = handler.promptDoc();
		expect(doc).toContain("git://commit/<sha>");
		expect(doc).toContain("git://branch/<name>");
		expect(doc).toContain("git://tag/<name>");

		const router = InternalUrlRouter.instance();
		expect(router.canHandle("git://")).toBe(true);
		expect(router.canHandle("git://branch/feat/unified-selector")).toBe(true);
		expect(router.getHandler("git")).toBeInstanceOf(GitProtocolHandler);
	});

	it("resolves git://diff routes: uncommitted, staged vs unstaged split, and branch since base", async () => {
		const clean = await handler.resolve(parseInternalUrl("git://diff"), { cwd: repoDir });
		expect(clean.content).toContain("No changes.");

		await Bun.write(path.join(repoDir, "README.md"), "# Demo\nstaged edit\n");
		git(repoDir, "add", "README.md");
		await Bun.write(path.join(repoDir, "README.md"), "# Demo\nstaged edit\nunstaged edit\n");

		const all = await handler.resolve(parseInternalUrl("git://diff"), { cwd: repoDir });
		expect(all.content).toContain("+staged edit");
		expect(all.content).toContain("+unstaged edit");

		const staged = await handler.resolve(parseInternalUrl("git://diff/staged"), { cwd: repoDir });
		expect(staged.content).toContain("+staged edit");
		expect(staged.content).not.toContain("+unstaged edit");

		const unstaged = await handler.resolve(parseInternalUrl("git://diff/unstaged"), { cwd: repoDir });
		expect(unstaged.content).toContain("+unstaged edit");
		expect(unstaged.content).not.toContain("+staged edit");

		git(repoDir, "stash");
		git(repoDir, "checkout", "feat/unified-selector");
		const branch = await handler.resolve(parseInternalUrl("git://diff/main"), { cwd: repoDir });
		// Only the branch's own change since the merge base, not main's later README edit.
		expect(branch.content).toContain("feature.ts");
		expect(branch.content).not.toContain("README.md");
	});

	it("resolves bare git:// to HEAD, local branches, tags, and recent commits", async () => {
		const res = await handler.resolve(parseInternalUrl("git://"), { cwd: repoDir });
		expect(res.contentType).toBe("text/markdown");
		expect(res.immutable).toBe(false);
		expect(res.content).toContain("`main`");
		expect(res.content).toContain("`feat/unified-selector`");
		expect(res.content).toContain("`v0.15`");
		expect(res.content).toContain("`release/v1.0`");
		expect(res.content).toContain("Update README on main");
		expect(res.content).toContain("Initial commit");
	});

	it("resolves git://commit/<sha> with metadata, stats, patch, and immutability for 40-char SHAs", async () => {
		const fullRes = await handler.resolve(parseInternalUrl(`git://commit/${featureSha}`), { cwd: repoDir });
		expect(fullRes.immutable).toBe(true);
		expect(fullRes.content).toContain(featureSha);
		expect(fullRes.content).toContain("Test Author <test@example.com>");
		expect(fullRes.content).toContain("Add unified selector");
		expect(fullRes.content).toContain("`feature.ts` (+1 -0)");
		expect(fullRes.content).toContain("+export const feature = 1;");

		const headRes = await handler.resolve(parseInternalUrl("git://commit/HEAD"), { cwd: repoDir });
		expect(headRes.immutable).toBe(false);
		expect(headRes.content).toContain(mainSecondSha);
		expect(headRes.content).toContain("Update README on main");
	});

	it("resolves git://branch/<name> with slashed branch names, ahead/behind counts, and recent commits", async () => {
		const res = await handler.resolve(parseInternalUrl("git://branch/feat/unified-selector"), { cwd: repoDir });
		expect(res.immutable).toBe(false);
		expect(res.content).toContain("# Branch `feat/unified-selector`");
		expect(res.content).toContain("Compared to `main`: 1 ahead, 1 behind");
		expect(res.content).toContain(featureSha);
		expect(res.content).toContain("Add unified selector");

		const encodedRes = await handler.resolve(parseInternalUrl("git://branch/feat%2Funified-selector"), {
			cwd: repoDir,
		});
		expect(encodedRes.content).toContain("# Branch `feat/unified-selector`");
		expect(encodedRes.content).toContain(featureSha);

		const mainRes = await handler.resolve(parseInternalUrl("git://branch/main"), { cwd: repoDir });
		expect(mainRes.content).toContain("Status: current HEAD branch");
		expect(mainRes.content).toContain("Update README on main");
	});

	it("resolves git://tag/<name> for annotated, lightweight, and nested tags", async () => {
		const annotated = await handler.resolve(parseInternalUrl("git://tag/v0.15"), { cwd: repoDir });
		expect(annotated.immutable).toBe(false);
		expect(annotated.content).toContain("# Tag `v0.15`");
		expect(annotated.content).toContain(initialSha);
		expect(annotated.content).toContain("Initial commit");
		expect(annotated.content).toContain("`v0.15`");
		expect(annotated.content).toContain("`release/v1.0`");

		const nested = await handler.resolve(parseInternalUrl("git://tag/release/v1.0"), { cwd: repoDir });
		expect(nested.content).toContain("# Tag `release/v1.0`");
		expect(nested.content).toContain(initialSha);
	});

	it("falls back to resolving unknown host as a general git revision", async () => {
		const byHead = await handler.resolve(parseInternalUrl("git://HEAD"), { cwd: repoDir });
		expect(byHead.immutable).toBe(false);
		expect(byHead.content).toContain(mainSecondSha);

		const bySha = await handler.resolve(parseInternalUrl(`git://${initialSha}`), { cwd: repoDir });
		expect(bySha.immutable).toBe(true);
		expect(bySha.content).toContain("Initial commit");
	});

	it("returns clear errors for missing refs, missing targets, and non-git directories", async () => {
		await expect(handler.resolve(parseInternalUrl("git://commit/"), { cwd: repoDir })).rejects.toThrow(
			"expected git://commit/<rev>",
		);
		await expect(handler.resolve(parseInternalUrl("git://branch/nonexistent"), { cwd: repoDir })).rejects.toThrow(
			"Git branch not found: nonexistent",
		);
		await expect(handler.resolve(parseInternalUrl("git://tag/nonexistent"), { cwd: repoDir })).rejects.toThrow(
			"Git tag not found: nonexistent",
		);
		await expect(handler.resolve(parseInternalUrl("git://"), { cwd: nonGitDir })).rejects.toThrow(
			"requires a git repository",
		);
	});

	it("completes branches, commits, and tags, filtering by query and returning [] outside git", async () => {
		const all = await handler.complete("", { cwd: repoDir });
		expect(all.some(c => c.value === "branch/feat/unified-selector")).toBe(true);
		expect(all.some(c => c.value === "branch/main")).toBe(true);
		expect(all.some(c => c.value === `commit/${mainSecondSha.slice(0, 7)}`)).toBe(true);
		expect(all.some(c => c.value === "tag/v0.15")).toBe(true);
		expect(all.some(c => c.value === "tag/release/v1.0")).toBe(true);

		const filtered = await handler.complete("unified", { cwd: repoDir });
		expect(filtered.map(c => c.value)).toEqual(["branch/feat/unified-selector"]);

		const outside = await handler.complete("", { cwd: nonGitDir });
		expect(outside).toEqual([]);
	});

	it("resolves git:// URLs end-to-end through InternalUrlRouter", async () => {
		const res = await InternalUrlRouter.instance().resolve(`git://commit/${featureSha}`, { cwd: repoDir });
		expect(res.immutable).toBe(true);
		expect(typeof res.content).toBe("string");
		expect(res.content).toContain("Add unified selector");
	});
});
