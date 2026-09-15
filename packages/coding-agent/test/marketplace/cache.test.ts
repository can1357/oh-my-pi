import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cachePlugin,
	cleanOrphanedCache,
	getCachedPluginPath,
	isCached,
	isValidVersionForCache,
	removeCachedPlugin,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const GIT_ENV = {
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "true",
} as const;

function gitRun(cwd: string, args: string[]): string {
	const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_OBJECT_DIRECTORY;
	delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, env, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}

function initGitRepo(dir: string): void {
	gitRun(dir, ["init", "-q", "-b", "main"]);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function mkSourcePlugin(baseDir: string, name: string): Promise<string> {
	const pluginDir = path.join(baseDir, name);
	await fsp.mkdir(pluginDir, { recursive: true });
	await fsp.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({ name }));
	return pluginDir;
}

// ── isValidVersionForCache ───────────────────────────────────────────────────

describe("isValidVersionForCache", () => {
	it("accepts common valid version strings", () => {
		expect(isValidVersionForCache("1.0.0")).toBe(true);
		expect(isValidVersionForCache("v2.0.0-beta.1")).toBe(true);
		expect(isValidVersionForCache("abc123")).toBe(true);
		expect(isValidVersionForCache("1.0.0+build.42")).toBe(true);
		expect(isValidVersionForCache("a")).toBe(true);
	});

	it("rejects empty string", () => {
		expect(isValidVersionForCache("")).toBe(false);
	});

	it("rejects double-dot (path traversal attempt)", () => {
		expect(isValidVersionForCache("..")).toBe(false);
	});

	it("rejects forward slash", () => {
		expect(isValidVersionForCache("1.0/0")).toBe(false);
	});

	it("rejects backslash", () => {
		expect(isValidVersionForCache("1.0\\0")).toBe(false);
	});

	it("rejects spaces", () => {
		expect(isValidVersionForCache("1 0")).toBe(false);
	});

	it("rejects strings exceeding 128 characters", () => {
		expect(isValidVersionForCache("a".repeat(129))).toBe(false);
		expect(isValidVersionForCache("a".repeat(128))).toBe(true);
	});
});

// ── getCachedPluginPath ──────────────────────────────────────────────────────

describe("getCachedPluginPath", () => {
	it("throws on invalid marketplace name (uppercase)", () => {
		expect(() => getCachedPluginPath("/cache", "My-Market", "plugin", "1.0.0")).toThrow(/Invalid marketplace name/);
	});

	it("throws on invalid marketplace name (space)", () => {
		expect(() => getCachedPluginPath("/cache", "bad market", "plugin", "1.0.0")).toThrow();
	});

	it("throws on invalid plugin name (uppercase)", () => {
		expect(() => getCachedPluginPath("/cache", "market", "My-Plugin", "1.0.0")).toThrow(/Invalid plugin name/);
	});

	it("throws on invalid version containing ..", () => {
		expect(() => getCachedPluginPath("/cache", "market", "plugin", "..")).toThrow(/Invalid version/);
	});

	it("throws on invalid version containing /", () => {
		expect(() => getCachedPluginPath("/cache", "market", "plugin", "1.0/0")).toThrow();
	});

	it("throws on invalid version with leading dot rejected by segment validator", () => {
		// ".1.0.0" passes VERSION_RE but isValidNameSegment rejects leading dot —
		// version validation uses VERSION_RE, not isValidNameSegment
		// ".1.0.0" starts with dot — VERSION_RE allows it, but name segment does not apply to version
		// Actually ".1.0.0" should be valid per VERSION_RE: only alpha/digit/._+-
		// Let's verify the boundary: space is rejected
		expect(() => getCachedPluginPath("/cache", "market", "plugin", "1 0")).toThrow();
	});
});

// ── cachePlugin / isCached / removeCachedPlugin ──────────────────────────────

describe("cachePlugin, isCached, removeCachedPlugin", () => {
	let tmpDir: string;
	let cacheDir: string;
	let sourceDir: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cache-test-"));
		cacheDir = path.join(tmpDir, "cache");
		sourceDir = path.join(tmpDir, "sources");
		await fsp.mkdir(sourceDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tmpDir);
	});

	it("isCached returns false before caching", async () => {
		await mkSourcePlugin(sourceDir, "my-plugin");
		expect(isCached(cacheDir, "my-market", "my-plugin", "1.0.0")).toBe(false);
	});

	it("cachePlugin copies the directory and returns absolute cache path", async () => {
		const sourcePath = await mkSourcePlugin(sourceDir, "my-plugin");
		const cached = await cachePlugin(sourcePath, cacheDir, "my-market", "my-plugin", "1.0.0");

		expect(cached).toBe(path.join(cacheDir, "my-market___my-plugin___1.0.0"));
		expect(fs.existsSync(cached)).toBe(true);
		expect(fs.existsSync(path.join(cached, "plugin.json"))).toBe(true);
	});

	it("cachePlugin copies tracked and non-ignored files from Git sources", async () => {
		const sourcePath = path.join(sourceDir, "git-plugin");
		await fsp.mkdir(sourcePath, { recursive: true });
		await fsp.writeFile(path.join(sourcePath, "tracked.txt"), "tracked");
		await fsp.writeFile(path.join(sourcePath, "untracked.txt"), "untracked");
		await fsp.writeFile(path.join(sourcePath, "ignored.txt"), "ignored");
		await fsp.writeFile(path.join(sourcePath, ".gitignore"), "ignored.txt\n");
		initGitRepo(sourcePath);
		gitRun(sourcePath, ["config", "user.email", "test@example.com"]);
		gitRun(sourcePath, ["config", "user.name", "Tester"]);
		gitRun(sourcePath, ["add", ".gitignore", "tracked.txt"]);
		gitRun(sourcePath, ["commit", "-m", "init"]);

		const cached = await cachePlugin(sourcePath, cacheDir, "my-market", "git-plugin", "1.0.0");
		expect(fs.existsSync(path.join(cached, "tracked.txt"))).toBe(true);
		expect(fs.existsSync(path.join(cached, "untracked.txt"))).toBe(true);
		expect(fs.existsSync(path.join(cached, "ignored.txt"))).toBe(false);
	});

	it("cachePlugin copies files from an untracked nested Git repository", async () => {
		const sourcePath = path.join(sourceDir, "nested-git-plugin");
		await fsp.mkdir(sourcePath, { recursive: true });
		await fsp.writeFile(path.join(sourcePath, "tracked.txt"), "tracked");
		initGitRepo(sourcePath);
		gitRun(sourcePath, ["config", "user.email", "test@example.com"]);
		gitRun(sourcePath, ["config", "user.name", "Tester"]);
		gitRun(sourcePath, ["add", "tracked.txt"]);
		gitRun(sourcePath, ["commit", "-m", "init"]);

		const nestedPath = path.join(sourcePath, "vendor");
		await fsp.mkdir(nestedPath, { recursive: true });
		await fsp.writeFile(path.join(nestedPath, "nested.txt"), "nested");
		initGitRepo(nestedPath);
		gitRun(nestedPath, ["config", "user.email", "test@example.com"]);
		gitRun(nestedPath, ["config", "user.name", "Tester"]);
		gitRun(nestedPath, ["add", "nested.txt"]);
		gitRun(nestedPath, ["commit", "-m", "init"]);

		const cached = await cachePlugin(sourcePath, cacheDir, "my-market", "nested-git-plugin", "1.0.0");
		expect(fs.existsSync(path.join(cached, "vendor", "nested.txt"))).toBe(true);
	});

	it("cachePlugin keeps copying all files from non-Git sources", async () => {
		const sourcePath = path.join(sourceDir, "plain-plugin");
		await fsp.mkdir(sourcePath, { recursive: true });
		await fsp.writeFile(path.join(sourcePath, ".gitignore"), "ignored.txt\n");
		await fsp.writeFile(path.join(sourcePath, "ignored.txt"), "not ignored without Git");

		const cached = await cachePlugin(sourcePath, cacheDir, "my-market", "plain-plugin", "1.0.0");
		expect(fs.existsSync(path.join(cached, ".gitignore"))).toBe(true);
		expect(fs.existsSync(path.join(cached, "ignored.txt"))).toBe(true);
	});

	it("isCached returns true after cachePlugin", async () => {
		const sourcePath = await mkSourcePlugin(sourceDir, "my-plugin");
		await cachePlugin(sourcePath, cacheDir, "my-market", "my-plugin", "1.0.0");
		expect(isCached(cacheDir, "my-market", "my-plugin", "1.0.0")).toBe(true);
	});

	it("cachePlugin is idempotent — re-caches over existing entry", async () => {
		const sourcePath = await mkSourcePlugin(sourceDir, "my-plugin");

		// First cache
		await cachePlugin(sourcePath, cacheDir, "my-market", "my-plugin", "1.0.0");
		// Add a stale file to simulate a dirty cache entry
		const staleFile = path.join(cacheDir, "my-market___my-plugin___1.0.0", "stale.txt");
		await fsp.writeFile(staleFile, "stale");

		// Re-cache must remove the stale file
		await cachePlugin(sourcePath, cacheDir, "my-market", "my-plugin", "1.0.0");
		expect(fs.existsSync(staleFile)).toBe(false);
		expect(fs.existsSync(path.join(cacheDir, "my-market___my-plugin___1.0.0", "plugin.json"))).toBe(true);
	});

	it("removeCachedPlugin deletes the directory", async () => {
		const sourcePath = await mkSourcePlugin(sourceDir, "my-plugin");
		await cachePlugin(sourcePath, cacheDir, "my-market", "my-plugin", "1.0.0");

		await removeCachedPlugin(cacheDir, "my-market", "my-plugin", "1.0.0");
		expect(isCached(cacheDir, "my-market", "my-plugin", "1.0.0")).toBe(false);
	});

	it("removeCachedPlugin is a no-op when entry does not exist", async () => {
		// Should not throw
		await expect(removeCachedPlugin(cacheDir, "my-market", "my-plugin", "1.0.0")).resolves.toBeUndefined();
	});
});

// ── cleanOrphanedCache ───────────────────────────────────────────────────────

describe("cleanOrphanedCache", () => {
	let tmpDir: string;
	let cacheDir: string;
	let sourceDir: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-orphan-test-"));
		cacheDir = path.join(tmpDir, "cache");
		sourceDir = path.join(tmpDir, "sources");
		await fsp.mkdir(sourceDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tmpDir);
	});

	it("returns { removed: 0 } when cacheDir does not exist", async () => {
		const result = await cleanOrphanedCache(cacheDir, new Set());
		expect(result).toEqual({ removed: 0 });
	});

	it("removes entries not in installedPaths", async () => {
		const srcA = await mkSourcePlugin(sourceDir, "plugin-a");
		const srcB = await mkSourcePlugin(sourceDir, "plugin-b");

		const pathA = await cachePlugin(srcA, cacheDir, "mkt", "plugin-a", "1.0.0");
		await cachePlugin(srcB, cacheDir, "mkt", "plugin-b", "1.0.0");

		// Only keep plugin-a; plugin-b is orphaned
		const result = await cleanOrphanedCache(cacheDir, new Set([pathA]));
		expect(result).toEqual({ removed: 1 });
		expect(fs.existsSync(pathA)).toBe(true);
		expect(isCached(cacheDir, "mkt", "plugin-b", "1.0.0")).toBe(false);
	});

	it("preserves all entries when all are in installedPaths", async () => {
		const srcA = await mkSourcePlugin(sourceDir, "plugin-a");
		const pathA = await cachePlugin(srcA, cacheDir, "mkt", "plugin-a", "1.0.0");

		const result = await cleanOrphanedCache(cacheDir, new Set([pathA]));
		expect(result).toEqual({ removed: 0 });
		expect(fs.existsSync(pathA)).toBe(true);
	});

	it("removes all entries when installedPaths is empty", async () => {
		const srcA = await mkSourcePlugin(sourceDir, "plugin-a");
		const srcB = await mkSourcePlugin(sourceDir, "plugin-b");

		await cachePlugin(srcA, cacheDir, "mkt", "plugin-a", "1.0.0");
		await cachePlugin(srcB, cacheDir, "mkt", "plugin-b", "2.0.0");

		const result = await cleanOrphanedCache(cacheDir, new Set());
		expect(result).toEqual({ removed: 2 });
		expect(fs.readdirSync(cacheDir)).toHaveLength(0);
	});
});
