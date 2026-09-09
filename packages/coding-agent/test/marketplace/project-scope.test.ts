/**
 * Tests for project-scope registry resolution contracts.
 *
 * resolveActiveProjectRegistryPath: walk-up, .git fallback, null return, canonical path.
 * listClaudePluginRoots: project entries shadow user entries for same plugin ID.
 *
 * Note: helpers.ts imports @oh-my-pi/pi-natives (Rust addon via glob).
 * This file imports from helpers.ts directly — the native addon IS present in the
 * test environment (verified: `bun run import-helpers.ts` succeeds).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearClaudePluginRootsCache,
	listClaudePluginRoots,
	resolveActiveProjectRegistryPath,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import type { InstalledPluginEntry } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import {
	addInstalledPlugin,
	buildPluginId,
	readInstalledPluginsRegistry,
	writeInstalledPluginsRegistry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEntry(installPath: string, scope: InstalledPluginEntry["scope"] = "user"): InstalledPluginEntry {
	return {
		scope,
		installPath,
		version: "1.0.0",
		installedAt: "2025-01-01T00:00:00.000Z",
		lastUpdated: "2025-01-01T00:00:00.000Z",
	};
}

// ── resolveActiveProjectRegistryPath ─────────────────────────────────────────

describe("resolveActiveProjectRegistryPath", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-proj-scope-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(tmpDir);
	});

	it("walk-up finds nearest .omp/ directory", async () => {
		// Layout: tmpDir/.omp/   +   tmpDir/sub/nested/  (cwd)
		// Resolver must climb from cwd → sub → tmpDir and find .omp/ there.
		fs.mkdirSync(path.join(tmpDir, ".omp"), { recursive: true });
		const cwd = path.join(tmpDir, "sub", "nested");
		fs.mkdirSync(cwd, { recursive: true });

		const result = await resolveActiveProjectRegistryPath(cwd);

		expect(result).toBe(path.join(tmpDir, ".omp", "plugins", "installed_plugins.json"));
	});

	it("walk-up stops at the nearest .omp/ — does not skip to a more distant one", async () => {
		// Layout: tmpDir/.omp/   +   tmpDir/sub/.omp/   +   tmpDir/sub/nested/  (cwd)
		// Resolver must stop at tmpDir/sub/.omp/, not climb further to tmpDir/.omp/.
		fs.mkdirSync(path.join(tmpDir, ".omp"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "sub", ".omp"), { recursive: true });
		const cwd = path.join(tmpDir, "sub", "nested");
		fs.mkdirSync(cwd, { recursive: true });

		const result = await resolveActiveProjectRegistryPath(cwd);

		expect(result).toBe(path.join(tmpDir, "sub", ".omp", "plugins", "installed_plugins.json"));
	});

	it("falls back to .git root when no .omp/ exists", async () => {
		// Layout: tmpDir/.git/   +   tmpDir/sub/  (cwd)
		// No .omp/ anywhere → second pass finds .git/ at tmpDir.
		// Returned path is relative to the .git root, not .git itself.
		fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
		const cwd = path.join(tmpDir, "sub");
		fs.mkdirSync(cwd, { recursive: true });

		const result = await resolveActiveProjectRegistryPath(cwd);

		expect(result).toBe(path.join(tmpDir, ".omp", "plugins", "installed_plugins.json"));
	});

	it("returns null when neither .omp/ nor .git/ found anywhere in the tree", async () => {
		// Start at the filesystem root — guaranteed to have no .omp/ or .git/ ancestors.
		const result = await resolveActiveProjectRegistryPath(path.sep);

		expect(result).toBeNull();
	});

	it("does not treat ~/.git as a project root (pass-2 home-dir guard)", async () => {
		// Simulate a dotfiles repo managed with a bare-git technique: ~/.git exists.
		// resolveActiveProjectRegistryPath must NOT return ~/.omp/.../installed_plugins.json.
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-proj-scope-home-"));
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		const fakeHomeGit = path.join(homeDir, ".git");
		await fs.promises.mkdir(fakeHomeGit, { recursive: true });
		const cwd = path.join(homeDir, "work");
		await fs.promises.mkdir(cwd, { recursive: true });
		try {
			const result = await resolveActiveProjectRegistryPath(cwd);
			const homeOmpPath = path.join(homeDir, ".omp", "plugins", "installed_plugins.json");
			expect(result).not.toBe(homeOmpPath);
			expect(result).toBeNull();
		} finally {
			removeSyncWithRetries(homeDir);
		}
	});

	it("canonical path — /repo and /repo/src resolve to the same registry file", async () => {
		// Both sub-directories of the same project must produce identical paths.
		fs.mkdirSync(path.join(tmpDir, ".omp"), { recursive: true });
		const src = path.join(tmpDir, "src");
		fs.mkdirSync(src, { recursive: true });

		const fromRoot = await resolveActiveProjectRegistryPath(tmpDir);
		const fromSrc = await resolveActiveProjectRegistryPath(src);

		expect(fromRoot).not.toBeNull();
		expect(fromRoot).toBe(fromSrc);
	});
});

// ── listClaudePluginRoots: project shadows user ───────────────────────────────

describe("listClaudePluginRoots — project shadows user", () => {
	let tmpHome: string;
	let tmpProject: string;
	/** Path where listClaudePluginRoots reads the user OMP registry. */
	let userRegPath: string;
	/** Path where listClaudePluginRoots reads the project registry (resolved from tmpProject). */
	let projectRegPath: string;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shadow-home-"));
		tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shadow-proj-"));

		// Create .omp/ in project so resolveActiveProjectRegistryPath finds it.
		fs.mkdirSync(path.join(tmpProject, ".omp", "plugins"), { recursive: true });

		userRegPath = path.join(tmpHome, ".omp", "plugins", "installed_plugins.json");
		fs.mkdirSync(path.dirname(userRegPath), { recursive: true });

		projectRegPath = path.join(tmpProject, ".omp", "plugins", "installed_plugins.json");
	});

	afterEach(() => {
		// Cache is keyed by home:projectPath — must clear between tests.
		clearClaudePluginRootsCache();
		removeSyncWithRetries(tmpHome);
		removeSyncWithRetries(tmpProject);
	});

	it("project entry shadows user entry when plugin IDs match", async () => {
		const pluginId = buildPluginId("shared-plugin", "test-mkt");

		// User registry has the plugin at a user-side install path.
		let userReg = await readInstalledPluginsRegistry(userRegPath);
		userReg = addInstalledPlugin(userReg, pluginId, makeEntry("/user/install/shared-plugin"));
		await writeInstalledPluginsRegistry(userRegPath, userReg);

		// Project registry has the same plugin ID at a project-side install path.
		let projReg = await readInstalledPluginsRegistry(projectRegPath);
		projReg = addInstalledPlugin(projReg, pluginId, makeEntry("/project/install/shared-plugin", "project"));
		await writeInstalledPluginsRegistry(projectRegPath, projReg);

		const { roots } = await listClaudePluginRoots(tmpHome, tmpProject);
		const matching = roots.filter(r => r.id === pluginId);

		// Exactly one entry survives — the user entry is suppressed.
		expect(matching).toHaveLength(1);
		expect(matching[0]?.path).toBe("/project/install/shared-plugin");
		expect(matching[0]?.scope).toBe("project");
	});
});
