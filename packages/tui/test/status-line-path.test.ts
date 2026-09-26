import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SegmentContext } from "../src/status-line/segments";
import { renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";
import {
	__resetProjectDirCacheForTests,
	getProjectDir,
	pathIsWithin,
	removeSyncWithRetries,
	setProjectDir,
} from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const SCRATCH_ROOT_PREFIXES: readonly string[] = [
	os.tmpdir(),
	path.join(os.homedir(), "tmp"),
	"/tmp",
	"/var/tmp",
	"/private/tmp",
	"/private/var/tmp",
];
beforeAll(async () => {
	await initTheme();
});

function createPathContext(): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {
			path: {
				abbreviate: false,
				maxLength: 120,
				stripWorkPrefix: true,
			},
		},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		vim: null,
		collab: null,
		stream: null,
		recording: false,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: {
			branch: null,
			status: null,
			pr: null,
		},
		usage: null,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	setProjectDir(originalProjectDir);
});

function expectContentToContainPath(content: string, expected: string): void {
	if (process.platform === "win32") {
		expect(content.toLowerCase()).toContain(expected.toLowerCase());
		return;
	}
	expect(content).toContain(expected);
}

/** Get an existing 8.3 spelling without requiring the volume to create new aliases. */
function shortWindowsPath(inputPath: string): string | null {
	const kernel32 = dlopen("kernel32.dll", {
		GetShortPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
	});
	try {
		const input = Buffer.from(`${inputPath}\0`, "utf16le");
		const needed = kernel32.symbols.GetShortPathNameW(ptr(input), null, 0);
		if (!needed) return null;
		const output = Buffer.alloc(needed * 2);
		const written = kernel32.symbols.GetShortPathNameW(ptr(input), ptr(output), needed);
		return written > 0 && written < needed ? output.toString("utf16le", 0, written * 2) : null;
	} finally {
		kernel32.close();
	}
}

// `createFakeHome` needs a directory outside every scratch root, and the only
// location it can rely on is the checkout itself. `SCRATCH_ROOTS` in
// `status-line/segments.ts` is a module-load constant covering `/tmp`,
// `/var/tmp` and their `/private` twins, so a checkout inside one of them —
// a CI scratch workspace, or a clone under `/tmp` — makes the fake home look
// like scratch and renders the scratch icon instead of the folder icon. The
// constant is frozen at import time and `os.tmpdir()` is already mocked
// elsewhere in this file, so there is no seam to redirect it; the two tests
// that need a non-scratch home skip instead of asserting the wrong icon.
const CHECKOUT_IS_SCRATCH = SCRATCH_ROOT_PREFIXES.some(root => pathIsWithin(root, originalProjectDir));

function createFakeHome(): { home: string; projectsRoot: string } {
	const homeRoot = path.join(originalProjectDir, ".wt");
	fs.mkdirSync(homeRoot, { recursive: true });
	const home = fs.mkdtempSync(path.join(homeRoot, "omp-status-line-home-"));
	const projectsRoot = path.join(home, "Projects");
	fs.mkdirSync(projectsRoot, { recursive: true });
	vi.spyOn(os, "homedir").mockReturnValue(home);
	return { home, projectsRoot };
}

describe("status line path segment", () => {
	it.skipIf(process.platform !== "win32")("renders the long cwd when launched through an existing 8.3 alias", () => {
		const home = os.homedir();
		const shortHome = shortWindowsPath(home);
		// Some Windows volumes have no short names, including for the profile.
		if (!shortHome || shortHome.toLowerCase() === home.toLowerCase()) return;

		process.chdir(shortHome);
		__resetProjectDirCacheForTests();
		expect(process.cwd().toLowerCase()).toBe(shortHome.toLowerCase());

		const ctx = createPathContext();
		ctx.options.path = { abbreviate: false, maxLength: 1000, stripWorkPrefix: false };
		const label = Bun.stripANSI(renderSegment("path", ctx).content).toLowerCase();
		expect(label).toContain(home.toLowerCase());
		expect(label).not.toContain(shortHome.toLowerCase());

		setProjectDir(shortHome);
		expect(getProjectDir().toLowerCase()).toBe(home.toLowerCase());
	});

	it.skipIf(process.platform !== "win32")("abbreviates a raw 8.3 repository path only when enabled", () => {
		const home = os.homedir();
		const shortHome = shortWindowsPath(home);
		if (!shortHome || shortHome.toLowerCase() === home.toLowerCase()) return;

		const ctx = createPathContext();
		ctx.options.path = { abbreviate: true, maxLength: 1000, stripWorkPrefix: false };
		ctx.activeRepo = {
			cwd: shortHome,
			repoRoot: shortHome,
			relativeRepoRoot: ".",
			source: "single-direct-child-repo",
		};
		const label = Bun.stripANSI(renderSegment("path", ctx).content);
		expect(label).toContain("~");
		expect(label.toLowerCase()).not.toContain(shortHome.toLowerCase());
		expect(ctx.activeRepo.cwd).toBe(shortHome);

		ctx.options.path.abbreviate = false;
		expectContentToContainPath(Bun.stripANSI(renderSegment("path", ctx).content), shortHome);
	});

	it.skipIf(process.platform !== "win32")("keeps junction spelling in the displayed cwd", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-junction-"));
		const target = path.join(root, "target");
		const alias = path.join(root, "alias");
		try {
			fs.mkdirSync(target);
			fs.symlinkSync(target, alias, "junction");
			setProjectDir(alias);

			const ctx = createPathContext();
			ctx.options.path = { abbreviate: false, maxLength: 1000, stripWorkPrefix: false };
			const label = Bun.stripANSI(renderSegment("path", ctx).content);
			expect(path.basename(getProjectDir())).toBe("alias");
			expect(label).toContain("alias");
			expect(label).not.toContain(`${path.sep}target`);
		} finally {
			setProjectDir(originalProjectDir);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it.skipIf(CHECKOUT_IS_SCRATCH)("strips the Projects root for symlink-equivalent aliases", () => {
		if (process.platform === "win32") return;

		const { home, projectsRoot } = createFakeHome();

		const realProjectDir = fs.mkdtempSync(path.join(projectsRoot, "omp-status-line-"));
		const nestedDir = path.join(realProjectDir, "nested");
		const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-alias-"));
		const homeAlias = path.join(aliasRoot, "home-link");

		try {
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.symlinkSync(home, homeAlias, "dir");

			const aliasedDir = path.join(homeAlias, "Projects", path.basename(realProjectDir), "nested");
			setProjectDir(aliasedDir);

			const rendered = renderSegment("path", createPathContext());
			const expectedRelative = `${path.basename(realProjectDir)}${path.sep}nested`;

			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain(expectedRelative);
			expect(rendered.content).not.toContain("home-link");
			expect(rendered.content).not.toContain(`${path.sep}Projects${path.sep}`);
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(aliasRoot);
			removeSyncWithRetries(realProjectDir);
			removeSyncWithRetries(home);
		}
	});

	it("strips the scratch root and shows only the trailing folder inside the OS tmp dir", () => {
		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-scratch-"));
		try {
			setProjectDir(scratchDir);

			const rendered = renderSegment("path", createPathContext());
			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain(theme.icon.scratchFolder);
			expect(rendered.content).not.toContain(theme.icon.folder);
			// Display is just the scratch-relative tail — no leading tmpdir, no ancestor segments.
			expectContentToContainPath(rendered.content, path.basename(getProjectDir()));
			expect(rendered.content).not.toContain(os.tmpdir());
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(scratchDir);
		}
	});

	it("normalizes and classifies a project directory only once", () => {
		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-classify-"));
		try {
			setProjectDir(scratchDir);
			const realpath = vi.spyOn(fs, "realpathSync");
			renderSegment("path", createPathContext());
			renderSegment("path", createPathContext());

			const projectRealpaths = realpath.mock.calls.filter(
				([input]) => path.resolve(String(input)) === path.resolve(scratchDir),
			);
			expect(projectRealpaths).toHaveLength(1);
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(scratchDir);
		}
	});

	it("keeps nested subpaths visible under a scratch root", () => {
		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-scratch-nest-"));
		const nested = path.join(scratchDir, "sub", "deep");
		fs.mkdirSync(nested, { recursive: true });
		try {
			setProjectDir(nested);

			const rendered = renderSegment("path", createPathContext());
			const tail = `${path.basename(path.dirname(path.dirname(getProjectDir())))}${path.sep}sub${path.sep}deep`;
			expect(rendered.content).toContain(theme.icon.scratchFolder);
			expectContentToContainPath(rendered.content, tail);
			expect(rendered.content).not.toContain(os.tmpdir());
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(scratchDir);
		}
	});

	it("keeps the folder icon for scratch paths when stripWorkPrefix is disabled", () => {
		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-scratch-noprefix-"));
		try {
			setProjectDir(scratchDir);

			const ctx = createPathContext();
			ctx.options.path = { ...ctx.options.path, stripWorkPrefix: false };
			const rendered = renderSegment("path", ctx);
			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain(theme.icon.folder);
			expect(rendered.content).not.toContain(theme.icon.scratchFolder);
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(scratchDir);
		}
	});

	it.skipIf(CHECKOUT_IS_SCRATCH)("keeps the folder icon for paths outside any scratch root", () => {
		const { home, projectsRoot } = createFakeHome();
		const realProjectDir = fs.mkdtempSync(path.join(projectsRoot, "omp-status-line-real-"));
		try {
			setProjectDir(realProjectDir);

			const rendered = renderSegment("path", createPathContext());
			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain(theme.icon.folder);
			expect(rendered.content).not.toContain(theme.icon.scratchFolder);
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(realProjectDir);
			removeSyncWithRetries(home);
		}
	});

	it("renders the active nested repo suffix after the parent cwd", () => {
		const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-parent-"));
		const repoDir = path.join(parentDir, "pr-workspace");
		fs.mkdirSync(repoDir);
		try {
			setProjectDir(parentDir);
			const ctx = createPathContext();
			ctx.activeRepo = {
				cwd: parentDir,
				repoRoot: repoDir,
				relativeRepoRoot: "pr-workspace",
				source: "single-direct-child-repo",
			};

			const rendered = renderSegment("path", ctx);
			const expected = `${path.basename(getProjectDir())} ↳ pr-workspace`;
			expect(rendered.visible).toBe(true);
			expectContentToContainPath(rendered.content, expected);
			expect(rendered.content).not.toContain(os.tmpdir());
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(parentDir);
		}
	});

	it("keeps the active nested repo suffix visible when the parent path is truncated", () => {
		const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-parent-"));
		const repoDir = path.join(parentDir, "pr-workspace");
		fs.mkdirSync(repoDir);
		try {
			setProjectDir(parentDir);
			const ctx = createPathContext();
			ctx.options.path = { abbreviate: false, maxLength: 4, stripWorkPrefix: true };
			ctx.activeRepo = {
				cwd: parentDir,
				repoRoot: repoDir,
				relativeRepoRoot: "pr-workspace",
				source: "single-direct-child-repo",
			};

			const rendered = renderSegment("path", ctx);
			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain("↳ pr-workspace");
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(parentDir);
		}
	});
});

describe("status line path segment in a linked worktree", () => {
	function worktreeContext(
		worktree: { projectName: string; worktreeName: string } | null,
		branch: string | null,
	): SegmentContext {
		const ctx = createPathContext();
		ctx.worktree = worktree;
		ctx.git = { branch, status: null, pr: null };
		return ctx;
	}

	it("collapses to the project name and drops the worktree dir when it equals the branch", () => {
		const rendered = renderSegment("path", worktreeContext({ projectName: "pi", worktreeName: "xx" }, "xx"));
		const content = Bun.stripANSI(rendered.content);
		expect(rendered.visible).toBe(true);
		expect(content).toBe(`${theme.icon.worktree} pi`);
		// The base prefix, the worktree dir, and the folder icon are all gone.
		expect(content).not.toContain(".tree");
		expect(content).not.toContain("/xx");
		expect(content).not.toContain(theme.icon.folder);
	});

	it("keeps the worktree dir when it diverges from the branch", () => {
		const rendered = renderSegment("path", worktreeContext({ projectName: "pi", worktreeName: "wt-icon" }, "icon"));
		expect(Bun.stripANSI(rendered.content)).toBe(`${theme.icon.worktree} pi/wt-icon`);
	});

	it("keeps the worktree dir when no branch is shown", () => {
		const rendered = renderSegment("path", worktreeContext({ projectName: "pi", worktreeName: "xx" }, null));
		expect(Bun.stripANSI(rendered.content)).toBe(`${theme.icon.worktree} pi/xx`);
	});

	it("falls back to the on-disk path when stripWorkPrefix is disabled", () => {
		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-wt-noprefix-"));
		try {
			setProjectDir(scratchDir);
			const ctx = worktreeContext({ projectName: "pi", worktreeName: "xx" }, "xx");
			ctx.options.path = { ...ctx.options.path, stripWorkPrefix: false };
			const content = Bun.stripANSI(renderSegment("path", ctx).content);
			expect(content).not.toContain(theme.icon.worktree);
			expect(content).toContain(theme.icon.folder);
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(scratchDir);
		}
	});

	it("clamps a long worktree label to maxLength so overflow shrink works", () => {
		const ctx = worktreeContext({ projectName: "very-long-project-name", worktreeName: "feature" }, "other");
		ctx.options.path = { ...ctx.options.path, maxLength: 10 };
		const label = Bun.stripANSI(renderSegment("path", ctx).content).slice(theme.icon.worktree.length + 1);
		expect(label.length).toBeLessThanOrEqual(10);
		expect(label.startsWith("…")).toBe(true);
		expect(label.endsWith("feature")).toBe(true);
	});
});
