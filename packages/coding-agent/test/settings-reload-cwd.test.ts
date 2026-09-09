import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getProjectAgentDir, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

it("defaults model role storage to global", () => {
	expect(Settings.isolated({}).get("modelRoleStorage")).toBe("global");
});
it("applies project role mutations over active runtime overrides", () => {
	const settings = Settings.isolated({});
	settings.overrideModelRoles({ smol: "anthropic/runtime" });

	settings.setProjectModelRole("smol", "anthropic/project");
	expect(settings.getModelRole("smol")).toBe("anthropic/project");

	settings.clearProjectModelRole("smol");
	expect(settings.getModelRole("smol")).toBeUndefined();
});

it("reports effective model-role provenance across merge precedence", () => {
	const settings = Settings.isolated({});
	// Absent → default.
	expect(settings.getModelRoleProvenance("default")).toBe("default");

	// Global only → global.
	settings.setModelRole("default", "anthropic/global");
	expect(settings.getModelRoleProvenance("default")).toBe("global");

	// Project overrides global → project.
	settings.setProjectModelRole("default", "anthropic/project");
	expect(settings.getModelRoleProvenance("default")).toBe("project");

	// Runtime override trumps all persisted layers → runtime.
	settings.overrideModelRoles({ default: "anthropic/runtime" });
	expect(settings.getModelRoleProvenance("default")).toBe("runtime");

	// Clearing the project role restores the pre-edit runtime override
	// (captured and restored by clearProjectModelRole). Since the runtime
	// override was set by overrideModelRoles and then the project edit
	// captured+replaced it, clearing removes both the project value and
	// the captured override, falling back to global.
	settings.clearProjectModelRole("default");
	expect(settings.getModelRoleProvenance("default")).toBe("global");
});

it("distinguishes runtime provenance from global when raw values are identical", () => {
	const shared = "anthropic/claude-sonnet-4-5";
	const settings = Settings.isolated({});
	settings.setModelRole("default", shared);
	// No runtime override → global provenance.
	expect(settings.getModelRoleProvenance("default")).toBe("global");
	expect(settings.getModelRole("default")).toBe(shared);

	// Runtime override with the same raw value as global → runtime provenance.
	settings.overrideModelRoles({ default: shared });
	expect(settings.getModelRoleProvenance("default")).toBe("runtime");
	expect(settings.getModelRole("default")).toBe(shared);
});

it("reports overlay provenance for a null tombstone that blocks the global fallback after project clear", async () => {
	const testDir = path.join(os.tmpdir(), `provenance-null-${Snowflake.next()}`);
	const projectDir = path.join(testDir, "project");
	const overlayPath = path.join(testDir, "overlay.yml");
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(overlayPath, "modelRoles:\n  default: null\n");
	try {
		const settings = await Settings.loadIsolated({
			cwd: projectDir,
			agentDir: testDir,
			inMemory: true,
			configFiles: [overlayPath],
			overrides: { modelRoleStorage: "project" },
		});
		settings.setModelRole("default", "anthropic/global");
		settings.setProjectModelRole("default", "anthropic/project");

		// The overlay null tombstone suppresses the role in the merged view.
		expect(settings.getModelRole("default")).toBeUndefined();
		expect(settings.getModelRoleProvenance("default")).toBe("overlay");

		// Clearing the project role must not expose the global layer: the
		// overlay null is still the effective source.
		settings.clearProjectModelRole("default");
		expect(settings.getProjectModelRole("default")).toBeUndefined();
		expect(settings.getGlobalModelRole("default")).toBe("anthropic/global");
		expect(settings.getModelRole("default")).toBeUndefined();
		expect(settings.getModelRoleProvenance("default")).toBe("overlay");
	} finally {
		if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
	}
});

describe("Settings.reloadForCwd", () => {
	let settingsState: SettingsTestState | undefined;

	beforeEach(() => {
		settingsState = beginSettingsTest();
	});

	afterEach(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	it("re-resolves path-scoped settings against the new directory in place", async () => {
		const projectA = path.resolve("/tmp", `reload-a-${Snowflake.next()}`);
		const projectB = path.resolve("/tmp", `reload-b-${Snowflake.next()}`);
		const settings = Settings.isolated({
			enabledModels: [
				{ paths: [projectA], models: ["model-a"] },
				{ paths: [projectB], models: ["model-b"] },
			],
			// A plain (non-scoped) override must survive re-scoping.
			"compaction.enabled": false,
		});

		await settings.reloadForCwd(projectA);
		expect(settings.getCwd()).toBe(path.normalize(projectA));
		expect(settings.get("enabledModels")).toEqual(["model-a"]);
		expect(settings.get("compaction.enabled")).toBe(false);

		await settings.reloadForCwd(projectB);
		expect(settings.getCwd()).toBe(path.normalize(projectB));
		expect(settings.get("enabledModels")).toEqual(["model-b"]);
		// Non-scoped override is preserved across the switch.
		expect(settings.get("compaction.enabled")).toBe(false);
	});

	it("is a no-op when the target directory is already the active scope", async () => {
		const projectA = path.resolve("/tmp", `reload-noop-${Snowflake.next()}`);
		const settings = Settings.isolated({
			enabledModels: [{ paths: [projectA], models: ["model-a"] }],
		});

		await settings.reloadForCwd(projectA);
		expect(settings.get("enabledModels")).toEqual(["model-a"]);
		await settings.reloadForCwd(projectA);
		expect(settings.getCwd()).toBe(path.normalize(projectA));
		expect(settings.get("enabledModels")).toEqual(["model-a"]);
	});

	it("loads extra config overlays after project settings", async () => {
		const testDir = path.join(os.tmpdir(), "test-config-overlay", Snowflake.next());
		const projectDir = path.join(testDir, "project");
		const overlayPath = path.join(testDir, "overlay.yml");
		try {
			resetSettingsForTest();
			fs.mkdirSync(projectDir, { recursive: true });
			fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
			fs.writeFileSync(
				path.join(getProjectAgentDir(projectDir), "settings.json"),
				JSON.stringify({ compaction: { enabled: true } }),
			);
			fs.writeFileSync(overlayPath, "compaction:\n  enabled: false\n");

			const settings = await Settings.init({ cwd: projectDir, inMemory: true, configFiles: [overlayPath] });
			expect(settings.get("compaction.enabled")).toBe(false);

			settings.override("compaction.enabled", true);
			expect(settings.get("compaction.enabled")).toBe(true);
		} finally {
			resetSettingsForTest();
			if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
		}
	});

	it("rejects a missing --config overlay instead of silently ignoring it", async () => {
		const testDir = path.join(os.tmpdir(), "test-config-overlay-missing", Snowflake.next());
		try {
			resetSettingsForTest();
			fs.mkdirSync(testDir, { recursive: true });

			const missingPath = path.join(testDir, "nope.yml");
			await expect(Settings.init({ cwd: testDir, inMemory: true, configFiles: [missingPath] })).rejects.toThrow(
				`Config overlay not found: ${missingPath}`,
			);
		} finally {
			resetSettingsForTest();
			if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
		}
	});

	it("rejects a malformed --config overlay", async () => {
		const testDir = path.join(os.tmpdir(), "test-config-overlay-bad", Snowflake.next());
		const overlayPath = path.join(testDir, "bad.yml");
		try {
			resetSettingsForTest();
			fs.mkdirSync(testDir, { recursive: true });
			fs.writeFileSync(overlayPath, "compaction: [unclosed\n");

			await expect(Settings.init({ cwd: testDir, inMemory: true, configFiles: [overlayPath] })).rejects.toThrow(
				"Failed to parse config overlay",
			);
		} finally {
			resetSettingsForTest();
			if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
		}
	});

	describe("project layer (on disk)", () => {
		let testDir: string;
		let agentDir: string;
		let startDir: string;
		let scopedProject: string;
		let bareProject: string;

		beforeEach(() => {
			resetSettingsForTest();
			testDir = path.join(os.tmpdir(), "test-reload-cwd", Snowflake.next());
			agentDir = path.join(testDir, "agent");
			startDir = path.join(testDir, "start");
			scopedProject = path.join(testDir, "scoped");
			bareProject = path.join(testDir, "bare");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.mkdirSync(startDir, { recursive: true });
			fs.mkdirSync(bareProject, { recursive: true });
			// Only the scoped project ships a project-level settings file.
			fs.mkdirSync(getProjectAgentDir(scopedProject), { recursive: true });
			fs.writeFileSync(
				path.join(getProjectAgentDir(scopedProject), "settings.json"),
				JSON.stringify({ compaction: { enabled: false } }),
			);
		});

		afterEach(() => {
			resetSettingsForTest();
			if (fs.existsSync(testDir)) {
				removeSyncWithRetries(testDir);
			}
		});

		it("loads and drops project settings as the working directory changes", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			// No project file under startDir → schema default.
			expect(settings.get("compaction.enabled")).toBe(true);

			await settings.reloadForCwd(scopedProject);
			expect(settings.getCwd()).toBe(path.normalize(scopedProject));
			expect(settings.get("compaction.enabled")).toBe(false);

			// Moving to a project without settings drops the previous project's config.
			await settings.reloadForCwd(bareProject);
			expect(settings.getCwd()).toBe(path.normalize(bareProject));
			expect(settings.get("compaction.enabled")).toBe(true);
		});
		it("keeps failed project writes bound to their original cwd", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			settings.setProjectModelRole("default", "anthropic/project");
			const mkdirSpy = vi.spyOn(fs.promises, "mkdir").mockRejectedValueOnce(new Error("simulated save failure"));

			try {
				await expect(settings.reloadForCwd(bareProject)).rejects.toThrow("simulated save failure");
				expect(settings.getCwd()).toBe(path.normalize(startDir));
				expect(await Bun.file(path.join(bareProject, ".omp", "config.yml")).exists()).toBe(false);
			} finally {
				mkdirSpy.mockRestore();
			}

			await settings.flush();
			expect(YAML.parse(await Bun.file(path.join(startDir, ".omp", "config.yml")).text())).toEqual({
				modelRoles: { default: "anthropic/project" },
			});
		});

		it("writes project model roles only to the project YAML", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			const projectConfigPath = path.join(startDir, ".omp", "config.yml");
			const globalConfigPath = path.join(agentDir, "config.yml");

			settings.setProjectModelRole("default", "anthropic/claude-sonnet-4-5");
			await settings.flush();

			expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});
			expect(await Bun.file(globalConfigPath).exists()).toBe(false);
			const reloaded = await Settings.loadIsolated({ cwd: startDir, agentDir });
			expect(reloaded.getProjectModelRole("default")).toBe("anthropic/claude-sonnet-4-5");
		});
		it("does not copy unedited roles from other project settings providers", async () => {
			await Bun.write(
				path.join(scopedProject, ".omp", "settings.json"),
				JSON.stringify({ modelRoles: { default: "anthropic/external" } }),
			);
			const settings = await Settings.init({ cwd: scopedProject, agentDir });

			settings.setProjectModelRole("smol", "anthropic/project-smol");
			await settings.flush();

			expect(YAML.parse(await Bun.file(path.join(scopedProject, ".omp", "config.yml")).text())).toEqual({
				modelRoles: { smol: "anthropic/project-smol" },
			});
			expect(settings.getProjectModelRole("default")).toBe("anthropic/external");
		});

		it("reapplies only native model roles over normal project-provider precedence", async () => {
			await Bun.write(
				path.join(scopedProject, ".claude", "settings.json"),
				JSON.stringify({
					compaction: { enabled: true },
					modelRoles: { default: "anthropic/claude" },
				}),
			);
			await Bun.write(
				path.join(scopedProject, ".omp", "config.yml"),
				"compaction:\n  enabled: false\nmodelRoles:\n  default: anthropic/native\n",
			);

			const settings = await Settings.init({ cwd: scopedProject, agentDir });

			expect(settings.getModelRole("default")).toBe("anthropic/native");
			expect(settings.getProjectModelRole("default")).toBe("anthropic/native");
			expect(settings.get("compaction.enabled")).toBe(true);
		});

		it("merges concurrent role writes under the project file lock", async () => {
			const first = await Settings.loadIsolated({ cwd: startDir, agentDir });
			const second = await Settings.loadIsolated({ cwd: startDir, agentDir });
			first.setProjectModelRole("default", "anthropic/default");
			second.setProjectModelRole("smol", "anthropic/smol");

			await Promise.all([first.flush(), second.flush()]);

			expect(YAML.parse(await Bun.file(path.join(startDir, ".omp", "config.yml")).text())).toEqual({
				modelRoles: {
					default: "anthropic/default",
					smol: "anthropic/smol",
				},
			});
		});

		it("reports project roles over global role fallbacks", async () => {
			await Bun.write(path.join(agentDir, "config.yml"), "modelRoles:\n  default: anthropic/global\n");
			await Bun.write(path.join(scopedProject, ".omp", "config.yml"), "modelRoles:\n  default: anthropic/project\n");

			const settings = await Settings.init({ cwd: scopedProject, agentDir });

			expect(settings.getModelRole("default")).toBe("anthropic/project");
			expect(settings.getGlobalModelRole("default")).toBe("anthropic/global");
			expect(settings.getProjectModelRole("default")).toBe("anthropic/project");
			expect(settings.getModelRoleSource("default")).toBe("project");
		});

		it("falls back to the global role after reloading a project without config", async () => {
			await Bun.write(path.join(agentDir, "config.yml"), "modelRoles:\n  default: anthropic/global\n");
			await Bun.write(path.join(scopedProject, ".omp", "config.yml"), "modelRoles:\n  default: anthropic/project\n");
			const settings = await Settings.init({ cwd: scopedProject, agentDir });
			expect(settings.getModelRole("default")).toBe("anthropic/project");

			await settings.reloadForCwd(bareProject);

			expect(settings.getModelRole("default")).toBe("anthropic/global");
			expect(settings.getProjectModelRole("default")).toBeUndefined();
			expect(settings.getModelRoleSource("default")).toBe("global");
		});
		it("keeps JSON-backed project roles cleared across later assignments and reload", async () => {
			await Bun.write(path.join(agentDir, "config.yml"), "modelRoles:\n  default: anthropic/global\n");
			await Bun.write(
				path.join(scopedProject, ".omp", "settings.json"),
				JSON.stringify({ modelRoles: { default: "anthropic/project" } }),
			);
			const settings = await Settings.init({ cwd: scopedProject, agentDir });
			expect(settings.getModelRole("default")).toBe("anthropic/project");

			settings.clearProjectModelRole("default");
			settings.setProjectModelRole("smol", "anthropic/project-smol");
			await settings.flush();

			expect(settings.getModelRole("default")).toBe("anthropic/global");
			expect(YAML.parse(await Bun.file(path.join(scopedProject, ".omp", "config.yml")).text())).toEqual({
				modelRoles: { default: null, smol: "anthropic/project-smol" },
			});
			const reloaded = await Settings.loadIsolated({ cwd: scopedProject, agentDir });
			expect(reloaded.getModelRole("default")).toBe("anthropic/global");
			expect(reloaded.getProjectModelRole("default")).toBeUndefined();
			expect(reloaded.getProjectModelRole("smol")).toBe("anthropic/project-smol");
		});

		it("restores original runtime override on reloadForCwd after project role edit", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime");

			settings.setProjectModelRole("smol", "anthropic/project");
			expect(settings.getModelRole("smol")).toBe("anthropic/project");

			await settings.reloadForCwd(bareProject);
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime");
		});

		it("retains the first original across multiple project role edits in the same cwd", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			settings.overrideModelRoles({ smol: "anthropic/runtime" });

			settings.setProjectModelRole("smol", "anthropic/project-1");
			settings.setProjectModelRole("smol", "anthropic/project-2");
			expect(settings.getModelRole("smol")).toBe("anthropic/project-2");

			await settings.reloadForCwd(bareProject);
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime");
		});

		it("cloneForCwd receives original runtime overrides after project role edit", async () => {
			const settings = await Settings.loadIsolated({ cwd: startDir, agentDir });
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");
			expect(settings.getModelRole("smol")).toBe("anthropic/project");

			const cloned = await settings.cloneForCwd(bareProject);
			expect(cloned.getModelRole("smol")).toBe("anthropic/runtime");
			// Source instance keeps the project-edited override for its current cwd.
			expect(settings.getModelRole("smol")).toBe("anthropic/project");
		});

		it("does not delete a runtime override added after the project edit on reloadForCwd", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			// No runtime override initially — project edit captures nothing.
			settings.setProjectModelRole("smol", "anthropic/project");
			expect(settings.getModelRole("smol")).toBe("anthropic/project");

			// A runtime override appears later (e.g. env/CLI reload).
			settings.overrideModelRoles({ smol: "anthropic/runtime-late" });
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime-late");

			await settings.reloadForCwd(bareProject);
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime-late");
		});

		it("does not delete a runtime override added after the project edit on cloneForCwd", async () => {
			const settings = await Settings.loadIsolated({ cwd: startDir, agentDir });
			settings.setProjectModelRole("smol", "anthropic/project");

			settings.overrideModelRoles({ smol: "anthropic/runtime-late" });
			const cloned = await settings.cloneForCwd(bareProject);
			expect(cloned.getModelRole("smol")).toBe("anthropic/runtime-late");
		});
		it("keeps project override effective when editing the shadowed global fallback in project mode", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			settings.override("modelRoleStorage", "project");
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime");

			settings.setProjectModelRole("smol", "anthropic/project");
			expect(settings.getModelRole("smol")).toBe("anthropic/project");

			// Editing the global fallback must persist the global layer without
			// replacing the project-scoped runtime override.
			settings.setModelRole("smol", "anthropic/global");
			expect(settings.getModelRole("smol")).toBe("anthropic/project");
			expect(settings.getGlobalModelRole("smol")).toBe("anthropic/global");

			// Reloading to a project without config restores the original runtime override.
			await settings.reloadForCwd(bareProject);
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime");
		});

		it("updates runtime override on global fallback edit in global storage mode", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			// modelRoleStorage defaults to "global".
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");
			expect(settings.getModelRole("smol")).toBe("anthropic/project");

			// In global mode the existing behavior is preserved: the global edit
			// rewrites the runtime override, so the effective role switches.
			settings.setModelRole("smol", "anthropic/global");
			expect(settings.getModelRole("smol")).toBe("anthropic/global");
			expect(settings.getGlobalModelRole("smol")).toBe("anthropic/global");

			// The global edit replaced the project edit in the runtime slot, so
			// the captured original must NOT be restored — the global value survives.
			await settings.reloadForCwd(bareProject);
			expect(settings.getModelRole("smol")).toBe("anthropic/global");
		});
		it("cloneForCwd restores original runtime override after project edit and global fallback edit", async () => {
			const settings = await Settings.loadIsolated({ cwd: startDir, agentDir });
			settings.override("modelRoleStorage", "project");
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");
			settings.setModelRole("smol", "anthropic/global");

			const cloned = await settings.cloneForCwd(bareProject);
			expect(cloned.getModelRole("smol")).toBe("anthropic/runtime");
			// Source instance keeps the project-scoped override for its current cwd.
			expect(settings.getModelRole("smol")).toBe("anthropic/project");
		});
		it("updates runtime override after project clear and late runtime override on global edit", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			settings.override("modelRoleStorage", "project");
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");
			expect(settings.getModelRole("smol")).toBe("anthropic/project");

			settings.clearProjectModelRole("smol");
			expect(settings.getModelRole("smol")).toBeUndefined();

			// A late runtime override replaces the cleared slot.
			settings.overrideModelRoles({ smol: "anthropic/runtime-late" });
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime-late");

			// Global edit must update the runtime override because the project
			// role was cleared — the guard must not fire on the stale capture.
			settings.setModelRole("smol", "anthropic/global");
			expect(settings.getModelRole("smol")).toBe("anthropic/global");
			expect(settings.getGlobalModelRole("smol")).toBe("anthropic/global");

			// The global edit replaced the cleared slot, so the captured original
			// must NOT be restored — the global value survives.
			await settings.reloadForCwd(bareProject);
			expect(settings.getModelRole("smol")).toBe("anthropic/global");
		});

		it("updates runtime override on global edit after switching from global to project storage", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			// Start in global mode — a global edit updates the runtime override.
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setModelRole("smol", "anthropic/global-1");
			expect(settings.getModelRole("smol")).toBe("anthropic/global-1");

			// Switch to project storage — no project edit has captured anything,
			// so a global edit must still update the runtime override.
			settings.override("modelRoleStorage", "project");
			settings.setModelRole("smol", "anthropic/global-2");
			expect(settings.getModelRole("smol")).toBe("anthropic/global-2");
			expect(settings.getGlobalModelRole("smol")).toBe("anthropic/global-2");

			// No capture was made (no project edit), so the runtime override
			// was permanently updated by the global edits — reload keeps it.
			await settings.reloadForCwd(bareProject);
			expect(settings.getModelRole("smol")).toBe("anthropic/global-2");
		});
		it("preserves a late runtime override on reloadForCwd when the project edit was superseded", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");
			expect(settings.getModelRole("smol")).toBe("anthropic/project");

			settings.overrideModelRoles({ smol: "anthropic/runtime-late" });
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime-late");

			await settings.reloadForCwd(bareProject);
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime-late");
		});
		it("preserves a late runtime override on cloneForCwd when the project edit was superseded", async () => {
			const settings = await Settings.loadIsolated({ cwd: startDir, agentDir });
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");

			settings.overrideModelRoles({ smol: "anthropic/runtime-late" });
			const cloned = await settings.cloneForCwd(bareProject);
			expect(cloned.getModelRole("smol")).toBe("anthropic/runtime-late");
		});
		it("restores the original runtime override on reloadForCwd after clearing the project role without a late override", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");
			expect(settings.getModelRole("smol")).toBe("anthropic/project");

			settings.clearProjectModelRole("smol");
			expect(settings.getModelRole("smol")).toBeUndefined();

			await settings.reloadForCwd(bareProject);
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime");
		});
		it("restores the original runtime override on cloneForCwd after clearing the project role without a late override", async () => {
			const settings = await Settings.loadIsolated({ cwd: startDir, agentDir });
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");

			settings.clearProjectModelRole("smol");

			const cloned = await settings.cloneForCwd(bareProject);
			expect(cloned.getModelRole("smol")).toBe("anthropic/runtime");
		});
		it("preserves a same-valued late override on reloadForCwd", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");
			expect(settings.getModelRole("smol")).toBe("anthropic/project");

			// A late override with the same value as the project edit must
			// still invalidate the capture — value equality cannot be trusted.
			settings.overrideModelRoles({ smol: "anthropic/project" });
			expect(settings.getModelRole("smol")).toBe("anthropic/project");

			await settings.reloadForCwd(bareProject);
			expect(settings.getModelRole("smol")).toBe("anthropic/project");
		});
		it("preserves a same-valued late override on cloneForCwd", async () => {
			const settings = await Settings.loadIsolated({ cwd: startDir, agentDir });
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");

			settings.overrideModelRoles({ smol: "anthropic/project" });
			const cloned = await settings.cloneForCwd(bareProject);
			expect(cloned.getModelRole("smol")).toBe("anthropic/project");
		});
		it("restores the late override C after A→project B→late C→project D on reloadForCwd", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");
			expect(settings.getModelRole("smol")).toBe("anthropic/project");

			settings.overrideModelRoles({ smol: "anthropic/runtime-late" });
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime-late");

			settings.setProjectModelRole("smol", "anthropic/project-2");
			expect(settings.getModelRole("smol")).toBe("anthropic/project-2");

			await settings.reloadForCwd(bareProject);
			expect(settings.getModelRole("smol")).toBe("anthropic/runtime-late");
		});
		it("restores the late override C after A→project B→late C→project D on cloneForCwd", async () => {
			const settings = await Settings.loadIsolated({ cwd: startDir, agentDir });
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");

			settings.overrideModelRoles({ smol: "anthropic/runtime-late" });

			settings.setProjectModelRole("smol", "anthropic/project-2");

			const cloned = await settings.cloneForCwd(bareProject);
			expect(cloned.getModelRole("smol")).toBe("anthropic/runtime-late");
		});
		it("preserves global supersession of a cleared project role on reloadForCwd", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			settings.override("modelRoleStorage", "project");
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");
			settings.clearProjectModelRole("smol");
			expect(settings.getModelRole("smol")).toBeUndefined();

			// Global edit after clear supersedes the project edit.
			settings.setModelRole("smol", "anthropic/global");
			expect(settings.getModelRole("smol")).toBe("anthropic/global");

			await settings.reloadForCwd(bareProject);
			expect(settings.getModelRole("smol")).toBe("anthropic/global");
		});
		it("preserves global supersession of a cleared project role on cloneForCwd", async () => {
			const settings = await Settings.loadIsolated({ cwd: startDir, agentDir });
			settings.override("modelRoleStorage", "project");
			settings.overrideModelRoles({ smol: "anthropic/runtime" });
			settings.setProjectModelRole("smol", "anthropic/project");
			settings.clearProjectModelRole("smol");

			settings.setModelRole("smol", "anthropic/global");

			const cloned = await settings.cloneForCwd(bareProject);
			expect(cloned.getModelRole("smol")).toBe("anthropic/global");
		});
	});
});
