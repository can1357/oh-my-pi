/**
 * Tests for model-role Profiles: config loading, precedence, switching,
 * subagent role resolution, and backward compatibility.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { expandRoleAlias } from "../src/config/model-resolver";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const YAML = Bun.YAML;

describe("Profiles", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-profiles-test-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		resetSettingsForTest();
		await tempDir?.remove();
	});

	const configPath = () => path.join(agentDir, "config.yml");

	/** Write the global config.yml and load an isolated Settings for it. */
	async function loadWithConfig(settings: Record<string, unknown>): Promise<Settings> {
		await Bun.write(configPath(), YAML.stringify(settings, null, 2));
		return await Settings.loadIsolated({ cwd: projectDir, agentDir });
	}

	const BASE_CONFIG: Record<string, unknown> = {
		modelRoles: { default: "provider/base-main", smol: "provider/base-smol", slow: "provider/base-slow" },
		profiles: {
			cheap: {
				description: "Low-cost models",
				modelRoles: { default: "provider/cheap-main", smol: "provider/cheap-smol", slow: "provider/cheap-slow" },
			},
			normal: {
				description: "Balanced",
				modelRoles: { default: "provider/normal-main", smol: "provider/cheap-smol" },
			},
			advanced: {
				modelRoles: { default: "provider/adv-main", slow: "provider/adv-slow" },
			},
			"partial-only": {
				modelRoles: { smol: "provider/partial-smol" },
			},
		},
	};

	describe("configuration loading", () => {
		test("loads profiles and activeProfile from config.yml", async () => {
			const settings = await loadWithConfig({
				activeProfile: "local",
				profiles: {
					local: { description: "Only local models", modelRoles: { default: "ollama/qwen" } },
					research: { modelRoles: { slow: "provider/deep-research" } },
				},
			});
			expect(settings.getActiveProfile()).toBe("local");
			expect(settings.getProfile("local")?.description).toBe("Only local models");
			expect(settings.getProfile("research")?.modelRoles?.slow).toBe("provider/deep-research");
			expect(settings.getProfile("missing")).toBeUndefined();
		});

		test("arbitrary profile names work without a fixed limit", async () => {
			const settings = await loadWithConfig({
				profiles: {
					a: { modelRoles: { smol: "provider/1" } },
					b: { modelRoles: { smol: "provider/2" } },
					"with-dashes": { modelRoles: { smol: "provider/3" } },
					with_underscores: { modelRoles: { smol: "provider/4" } },
				},
				activeProfile: "with_underscores",
			});
			expect(settings.getActiveProfile()).toBe("with_underscores");
			expect(settings.getModelRole("smol")).toBe("provider/4");
		});

		test("inactive profiles do nothing", async () => {
			const settings = await loadWithConfig({ ...BASE_CONFIG, activeProfile: "" });
			expect(settings.getActiveProfile()).toBe("");
			expect(settings.getModelRole("default")).toBe("provider/base-main");
			expect(settings.getModelRole("smol")).toBe("provider/base-smol");
		});

		test("unknown activeProfile name falls through to base roles without error", async () => {
			const settings = await loadWithConfig({ ...BASE_CONFIG, activeProfile: "does-not-exist" });
			expect(settings.getActiveProfile()).toBe("");
			expect(settings.getModelRole("default")).toBe("provider/base-main");
		});

		test("empty profile (no modelRoles) is inert", async () => {
			const settings = await loadWithConfig({
				modelRoles: { default: "provider/base-main" },
				profiles: { empty: { description: "no roles" } },
				activeProfile: "empty",
			});
			expect(settings.getModelRole("default")).toBe("provider/base-main");
			expect(settings.isProfileActive()).toBe(false);
		});

		test("partial profile only overlays listed roles", async () => {
			const settings = await loadWithConfig({ ...BASE_CONFIG, activeProfile: "partial-only" });
			expect(settings.getModelRole("smol")).toBe("provider/partial-smol");
			expect(settings.getModelRole("default")).toBe("provider/base-main");
			expect(settings.getModelRole("slow")).toBe("provider/base-slow");
		});

		test("malformed profile values are skipped without crashing", async () => {
			const settings = await loadWithConfig({
				modelRoles: { default: "provider/base-main" },
				profiles: {
					bad: {
						modelRoles: { default: 42, smol: null, slow: "provider/ok" },
					},
				},
				activeProfile: "bad",
			});
			expect(settings.getModelRole("slow")).toBe("provider/ok");
			expect(settings.getModelRole("default")).toBe("provider/base-main");
		});
	});

	describe("precedence", () => {
		test("activeProfile overrides base modelRoles", async () => {
			const settings = await loadWithConfig({ ...BASE_CONFIG, activeProfile: "cheap" });
			expect(settings.getModelRole("default")).toBe("provider/cheap-main");
			expect(settings.getModelRole("smol")).toBe("provider/cheap-smol");
			expect(settings.getModelRole("slow")).toBe("provider/cheap-slow");
		});

		test("profile is a layer: base modelRoles are never rewritten", async () => {
			const settings = await loadWithConfig({ ...BASE_CONFIG, activeProfile: "cheap" });
			expect(settings.getGlobalModelRole("default")).toBe("provider/base-main");
			settings.set("activeProfile", "normal");
			expect(settings.getModelRole("default")).toBe("provider/normal-main");
			expect(settings.getGlobalModelRole("default")).toBe("provider/base-main");
		});

		test("runtime model-role overrides beat profile roles", async () => {
			const settings = await loadWithConfig({ ...BASE_CONFIG, activeProfile: "cheap" });
			settings.overrideModelRoles({ smol: "provider/explicit-smol" });
			expect(settings.getModelRole("smol")).toBe("provider/explicit-smol");
			// Roles the override does not touch still come from the profile.
			expect(settings.getModelRole("default")).toBe("provider/cheap-main");
			expect(settings.getModelRoleProvenance("smol")).toBe("runtime");
			expect(settings.getModelRoleProvenance("default")).toBe("profile");
		});

		test("config overlay beats profile roles", async () => {
			const overlayPath = tempDir.join("overlay.yml");
			await Bun.write(overlayPath, YAML.stringify({ modelRoles: { default: "provider/overlay-main" } }, null, 2));
			await Bun.write(configPath(), YAML.stringify({ ...BASE_CONFIG, activeProfile: "cheap" }, null, 2));
			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir, configFiles: [overlayPath] });
			expect(settings.getModelRole("default")).toBe("provider/overlay-main");
		});

		test("CLI --model-profile runtime override activates a profile for the run", async () => {
			const settings = await loadWithConfig({ ...BASE_CONFIG, activeProfile: "" });
			settings.override("activeProfile", "advanced");
			expect(settings.getActiveProfile()).toBe("advanced");
			expect(settings.getModelRole("default")).toBe("provider/adv-main");
			expect(settings.getModelRole("slow")).toBe("provider/adv-slow");
		});

		test("CLI --model-profile can override the persisted activeProfile", async () => {
			const settings = await loadWithConfig({ ...BASE_CONFIG, activeProfile: "cheap" });
			settings.override("activeProfile", "normal");
			expect(settings.getActiveProfile()).toBe("normal");
			expect(settings.getModelRole("default")).toBe("provider/normal-main");
			expect(settings.getGlobalModelRole("default")).toBe("provider/base-main");
		});
	});

	describe("switching", () => {
		test("cheap → normal → advanced → off updates effective roles without corrupting base", async () => {
			const settings = await loadWithConfig({ ...BASE_CONFIG, activeProfile: "cheap" });
			expect(settings.getModelRole("default")).toBe("provider/cheap-main");

			settings.set("activeProfile", "normal");
			expect(settings.getModelRole("default")).toBe("provider/normal-main");
			expect(settings.getModelRole("smol")).toBe("provider/cheap-smol");

			settings.set("activeProfile", "advanced");
			expect(settings.getModelRole("default")).toBe("provider/adv-main");
			expect(settings.getModelRole("slow")).toBe("provider/adv-slow");

			settings.set("activeProfile", "");
			expect(settings.getModelRole("default")).toBe("provider/base-main");
			expect(settings.getModelRole("smol")).toBe("provider/base-smol");
			expect(settings.getModelRole("slow")).toBe("provider/base-slow");
			expect(settings.isProfileActive()).toBe(false);
		});
	});

	describe("subagent role resolution", () => {
		test("@smol expands through the active profile's smol role", async () => {
			const settings = await loadWithConfig({ ...BASE_CONFIG, activeProfile: "cheap" });
			expect(expandRoleAlias("@smol", settings)).toBe("provider/cheap-smol");
		});

		test("@default expands through the active profile's default role", async () => {
			const settings = await loadWithConfig({ ...BASE_CONFIG, activeProfile: "advanced" });
			expect(expandRoleAlias("@default", settings)).toBe("provider/adv-main");
		});

		test("profile change is visible to role expansion immediately", async () => {
			const settings = await loadWithConfig({ ...BASE_CONFIG, activeProfile: "cheap" });
			expect(expandRoleAlias("@smol", settings)).toBe("provider/cheap-smol");
			settings.set("activeProfile", "normal");
			expect(expandRoleAlias("@smol", settings)).toBe("provider/cheap-smol"); // normal defines smol as cheap-smol
			settings.set("activeProfile", "");
			expect(expandRoleAlias("@smol", settings)).toBe("provider/base-smol");
		});
	});

	describe("project layer", () => {
		test("project activeProfile shadows global activeProfile", async () => {
			await Bun.write(
				configPath(),
				YAML.stringify(
					{
						activeProfile: "global-profile",
						profiles: {
							"global-profile": { modelRoles: { default: "provider/global-main" } },
							"project-profile": { modelRoles: { default: "provider/project-main" } },
						},
					},
					null,
					2,
				),
			);
			const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
			fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
			await Bun.write(projectConfigPath, YAML.stringify({ activeProfile: "project-profile" }, null, 2));
			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			expect(settings.getActiveProfile()).toBe("project-profile");
			expect(settings.getModelRole("default")).toBe("provider/project-main");
		});

		test("project profiles deep-merge with global profiles (global defs survive)", async () => {
			await Bun.write(
				configPath(),
				YAML.stringify({
					profiles: {
						shared: { modelRoles: { default: "provider/global-main" } },
					},
				}),
			);
			const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
			fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
			await Bun.write(
				projectConfigPath,
				YAML.stringify({
					activeProfile: "shared",
					profiles: {
						shared: { description: "project override keeps roles" },
					},
				}),
			);
			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			expect(settings.getActiveProfile()).toBe("shared");
			// Project record deep-merged with the global profile: the description
			// lands on the same profile object and its global modelRoles survive.
			expect(settings.getProfile("shared")?.description).toBe("project override keeps roles");
			expect(settings.getModelRole("default")).toBe("provider/global-main");
		});
	});

	describe("backward compatibility", () => {
		test("config without profiles behaves exactly as before", async () => {
			await Bun.write(
				configPath(),
				YAML.stringify({ modelRoles: { default: "provider/plain-main", smol: "provider/plain-smol" } }, null, 2),
			);
			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			expect(settings.getActiveProfile()).toBe("");
			expect(settings.getProfile("anything")).toBeUndefined();
			expect(settings.getModelRole("default")).toBe("provider/plain-main");
			expect(settings.getModelRole("smol")).toBe("provider/plain-smol");
			expect(expandRoleAlias("@smol", settings)).toBe("provider/plain-smol");
		});
	});
});
