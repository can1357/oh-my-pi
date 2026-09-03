import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveExplicitSearchPaths } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GrepTool } from "../../src/tools/grep";

const testSettings = Settings.isolated();
const isWindows = process.platform === "win32";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: testSettings,
		...overrides,
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

describe.skipIf(isWindows)("resolveExplicitSearchPaths cross-tree degeneracy", () => {
	it("returns per-path targets when commonBasePath collapses to filesystem root", async () => {
		// Two real top-level directories that exist on every Unix host. Their only
		// shared ancestor is `/`. A naive shared-base scan would walk the entire
		// filesystem; the resolver must surface explicit `targets` so callers can
		// fan out instead.
		const cwd = os.tmpdir();
		const resolved = await resolveExplicitSearchPaths(["/tmp", "/usr"], cwd);

		expect(resolved).toBeDefined();
		if (!resolved) throw new Error("expected resolveExplicitSearchPaths to resolve");
		expect(resolved.basePath).toBe(path.parse(resolved.basePath).root);
		expect(resolved.targets).toBeDefined();
		const targetBases = (resolved.targets ?? []).map(target => target.basePath).sort();
		expect(targetBases).toEqual(["/tmp", "/usr"]);
	});
});

describe.skipIf(isWindows)("search with omitted paths", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-default-cwd-"));
		await Bun.write(path.join(cwd, "rooted.txt"), "default-needle here\n");
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("defaults to the workspace root when paths is omitted", async () => {
		const tool = new GrepTool(createTestSession(cwd));

		// Callers that omit `path` would otherwise be rejected at schema
		// validation with `path: Invalid input` and never run. Omission must
		// degrade to a workspace-root scan rather than fail the tool call.
		const result = await tool.execute("search-default-paths", { pattern: "default-needle" });

		const text = getText(result);
		const details = result.details as { fileCount?: number } | undefined;
		expect(text).toContain("default-needle here");
		expect(details?.fileCount).toBe(1);
	});

	it("defaults to the workspace root when path is an empty JSON array", async () => {
		const tool = new GrepTool(createTestSession(cwd));

		const result = await tool.execute("search-empty-paths", {
			pattern: "default-needle",
			path: "[]",
		});

		expect(getText(result)).toContain("default-needle here");
	});
});

describe.skipIf(isWindows)("search across unrelated filesystem trees", () => {
	let dirA: string;
	let dirB: string;
	let cwd: string;

	beforeEach(async () => {
		// Place fixtures in two unrelated top-level subtrees so their only shared
		// ancestor is the filesystem root. Without the multi-target fanout, the
		// search tool would scan from `/` and walk the entire filesystem.
		dirA = await fs.mkdtemp(path.join("/tmp", "pi-search-multi-A-"));
		dirB = await fs.mkdtemp(path.join("/var/tmp", "pi-search-multi-B-"));
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-multi-cwd-"));
		await Bun.write(path.join(dirA, "alpha.txt"), "shared-needle alpha\n");
		await Bun.write(path.join(dirB, "beta.txt"), "shared-needle beta\n");
	});

	afterEach(async () => {
		await Promise.all([removeWithRetries(dirA), removeWithRetries(dirB), removeWithRetries(cwd)]);
	});

	it("returns matches from both trees without rooting the scan at /", async () => {
		const tool = new GrepTool(createTestSession(cwd));

		const start = performance.now();
		const result = await tool.execute("search-cross-tree", {
			pattern: "shared-needle",
			path: `${dirA}; ${dirB}`,
		});
		const durationMs = performance.now() - start;

		const text = getText(result);
		const details = result.details as { fileCount?: number; matchCount?: number } | undefined;

		expect(text).toContain("shared-needle alpha");
		expect(text).toContain("shared-needle beta");
		expect(details?.fileCount).toBe(2);
		expect(details?.matchCount).toBe(2);
		// Defense-in-depth: a regression that re-roots the scan at `/` typically
		// takes seconds. Two-fixture targeted scans complete in well under a
		// second on every supported platform.
		expect(durationMs).toBeLessThan(5000);
	});
});

describe.skipIf(isWindows)("resolveExplicitSearchPaths shared non-root ancestor", () => {
	let parent: string;
	let repo: string;
	let cousinFile: string;

	beforeEach(async () => {
		parent = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-ancestor-"));
		repo = path.join(parent, "repo");
		await fs.mkdir(path.join(repo, "src"), { recursive: true });
		await Bun.write(path.join(repo, "src", "a.ts"), "alpha\n");
		cousinFile = path.join(parent, "homeish", ".gitconfig");
		await Bun.write(cousinFile, "[push]\n\tfollowTags = true\n");
	});

	afterEach(async () => {
		await removeWithRetries(parent);
	});

	it("fans out per-path targets instead of walking the unrequested ancestor", async () => {
		// `.` (the repo) and a file in a cousin tree only share `parent`, which the
		// caller never asked to search. Collapsing to a single walk rooted there
		// scans every unrelated sibling (the real-world case: `.` + `~/.gitconfig`
		// walks all of `$HOME` until the grep timeout). The resolver must surface
		// per-path targets so each scan stays bounded to a requested path.
		const resolved = await resolveExplicitSearchPaths([".", cousinFile], repo);
		expect(resolved).toBeDefined();
		if (!resolved) throw new Error("expected resolveExplicitSearchPaths to resolve");
		const targetBases = (resolved.targets ?? []).map(target => target.basePath).sort();
		expect(targetBases).toEqual([repo, cousinFile].sort());
	});

	it("keeps a single collapsed walk when the common ancestor is a requested scope", async () => {
		// `ast_edit` consumes the same targets and applies rewrites once per
		// target; a dir + nested-file input must stay a single walk by default or
		// overlapping targets would double-apply rewrites to the nested file.
		const resolved = await resolveExplicitSearchPaths([".", "src/a.ts"], repo);
		expect(resolved).toBeDefined();
		if (!resolved) throw new Error("expected resolveExplicitSearchPaths to resolve");
		expect(resolved.targets).toBeUndefined();
		expect(resolved.basePath).toBe(repo);
	});

	it("fans out nested plain files when the caller opts in via fanOutFileItems", async () => {
		const resolved = await resolveExplicitSearchPaths([".", "src/a.ts"], repo, undefined, true);
		expect(resolved).toBeDefined();
		if (!resolved) throw new Error("expected resolveExplicitSearchPaths to resolve");
		const targetBases = (resolved.targets ?? []).map(target => target.basePath).sort();
		expect(targetBases).toEqual([repo, path.join(repo, "src", "a.ts")].sort());
	});
});

describe.skipIf(isWindows)("search with explicit walker-pruned file targets", () => {
	let repo: string;

	beforeEach(async () => {
		repo = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-pruned-"));
		await fs.mkdir(path.join(repo, ".git"), { recursive: true });
		await Bun.write(path.join(repo, ".git", "config"), "[push]\n\tfollowTags = true\n");
		await Bun.write(path.join(repo, "readme.txt"), "no needle here\n");
	});

	afterEach(async () => {
		await removeWithRetries(repo);
	});

	it("matches inside an explicit .git/config target alongside a directory scope", async () => {
		// The directory walker prunes `.git` unconditionally, so folding the
		// explicit file into the walk's glob union silently returned 0 matches.
		// The file must be read directly as its own target.
		const tool = new GrepTool(createTestSession(repo));

		const result = await tool.execute("search-git-config", {
			pattern: "followTags",
			path: ".; .git/config",
		});
		const details = result.details as { matchCount?: number; files?: string[] } | undefined;
		expect(getText(result)).toContain("followTags = true");
		expect(details?.matchCount).toBe(1);
		expect(details?.files).toEqual([".git/config"]);
	});

	it("dedupes matches when a file target overlaps a directory target", async () => {
		await fs.mkdir(path.join(repo, "src"), { recursive: true });
		await Bun.write(path.join(repo, "src", "a.ts"), "needle-dup\n");
		const tool = new GrepTool(createTestSession(repo));

		const result = await tool.execute("search-overlap", {
			pattern: "needle-dup",
			path: ".; src/a.ts",
		});
		const details = result.details as { matchCount?: number } | undefined;
		expect(details?.matchCount).toBe(1);
	});
});
