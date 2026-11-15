import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type Extension, extensionCapability } from "@oh-my-pi/pi-coding-agent/capability/extension";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";
import { SYMLINKS_USABLE } from "../helpers/symlink-support";

function manifest(name: string): string {
	return JSON.stringify({ name, description: `Manifest for ${name}` });
}

// Both extension-manifest walkers (`native` in builtin.ts, `gemini` in gemini.ts) look for
// `extensions/<dir>/gemini-extension.json`. Sharing an extension package between checkouts
// is done by linking it into that `extensions` dir, and `readdir(withFileTypes)` reports the
// entry as a link rather than a directory, so both walkers dropped it with no item and no
// warning before the fix.
describe("extension manifest discovery through linked directories", () => {
	let root: string;
	let project: string;
	let home: string;
	let shared: string;
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		clearFsCache();
		originalHome = process.env.HOME;
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-symlinks-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		shared = path.join(root, "shared");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		await Promise.all([
			fs.mkdir(path.join(home, ".omp", "agent", "extensions"), { recursive: true }),
			fs.mkdir(path.join(home, ".gemini", "extensions"), { recursive: true }),
			fs.mkdir(shared, { recursive: true }),
			fs.mkdir(path.join(project, ".git"), { recursive: true }),
		]);
		initializeWithSettings(await Settings.init({ inMemory: true, cwd: project }));
	});

	afterEach(async () => {
		resetSettingsForTest();
		clearFsCache();
		vi.restoreAllMocks();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("OMP_PROFILE", originalOmpProfileEnv);
		restoreEnvValue("PI_PROFILE", originalPiProfileEnv);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
		__resetDirsFromEnvForTests();
		await removeWithRetries(root);
	});

	describe("native provider", () => {
		let extensionsDir: string;

		beforeEach(() => {
			extensionsDir = path.join(home, ".omp", "agent", "extensions");
		});

		test.skipIf(!SYMLINKS_USABLE)("discovers an extension package linked into the extensions dir", async () => {
			const packageDir = path.join(shared, "linked-extension");
			await fs.mkdir(packageDir, { recursive: true });
			await fs.writeFile(path.join(packageDir, "gemini-extension.json"), manifest("linked-extension"));
			const linkPath = path.join(extensionsDir, "linked-extension");
			await fs.symlink(packageDir, linkPath, "dir");

			const result = await loadCapability<Extension>(extensionCapability.id, {
				cwd: project,
				providers: ["native"],
			});

			const linked = result.items.find(item => item.path === linkPath);
			expect(linked?.name).toBe("linked-extension");
			expect(linked?.manifest.description).toBe("Manifest for linked-extension");
			expect(linked?.level).toBe("user");
		});

		// The fix accepts a link so the manifest probe can look through it. A link to a file
		// has no `gemini-extension.json` inside, so it must stay rejected rather than turning
		// every link into a candidate.
		test.skipIf(!SYMLINKS_USABLE)("rejects an extensions dir entry linked to a file", async () => {
			const manifestFile = path.join(shared, "loose-manifest.json");
			await fs.writeFile(manifestFile, manifest("file-link"));
			await fs.symlink(manifestFile, path.join(extensionsDir, "file-link"), "file");

			const result = await loadCapability<Extension>(extensionCapability.id, {
				cwd: project,
				providers: ["native"],
			});

			expect(result.items).toHaveLength(0);
		});
	});

	describe("gemini provider", () => {
		let extensionsDir: string;

		beforeEach(() => {
			extensionsDir = path.join(home, ".gemini", "extensions");
		});

		test.skipIf(!SYMLINKS_USABLE)("discovers an extension package linked into the extensions dir", async () => {
			const packageDir = path.join(shared, "gemini-linked-extension");
			await fs.mkdir(packageDir, { recursive: true });
			await fs.writeFile(path.join(packageDir, "gemini-extension.json"), manifest("gemini-linked-extension"));
			const linkPath = path.join(extensionsDir, "gemini-linked-extension");
			await fs.symlink(packageDir, linkPath, "dir");

			const result = await loadCapability<Extension>(extensionCapability.id, {
				cwd: project,
				providers: ["gemini"],
			});

			const linked = result.items.find(item => item.path === linkPath);
			expect(linked?.name).toBe("gemini-linked-extension");
			expect(linked?.manifest.description).toBe("Manifest for gemini-linked-extension");
			expect(linked?.level).toBe("user");
		});

		test.skipIf(!SYMLINKS_USABLE)("rejects an extensions dir entry linked to a file", async () => {
			const manifestFile = path.join(shared, "gemini-loose-manifest.json");
			await fs.writeFile(manifestFile, manifest("gemini-file-link"));
			await fs.symlink(manifestFile, path.join(extensionsDir, "gemini-file-link"), "file");

			const result = await loadCapability<Extension>(extensionCapability.id, {
				cwd: project,
				providers: ["gemini"],
			});

			expect(result.items).toHaveLength(0);
		});
	});
});
