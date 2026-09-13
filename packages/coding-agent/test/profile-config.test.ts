/**
 * Agent-managed profile configuration tests: the structured write path
 * (Settings.setProfile / removeProfile / setActiveProfile / describeProfiles).
 *
 * Coverage: create/update/delete at global and project scope, partial
 * updates preserving sibling fields, base modelRoles preservation, YAML
 * preservation of unrelated keys, active-profile deletion safety, runtime
 * activation not persisting, validation rejections, reload after write, and
 * /profile + --model-profile visibility of agent-created profiles.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { expandRoleAlias } from "../src/config/model-resolver";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { activateProfile, profilePickerEntries } from "../src/slash-commands/helpers/profile-command";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const YAML = Bun.YAML;

/** Shape asserted against parsed on-disk YAML in this suite. */
interface ParsedConfig {
	profiles?: Record<string, { description?: string; modelRoles?: Record<string, string> }>;
	modelRoles?: Record<string, string>;
	activeProfile?: string;
}

describe("agent-managed profile configuration", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-profile-agent-");
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

	const globalConfigPath = () => path.join(agentDir, "config.yml");
	const projectConfigPath = () => path.join(projectDir, ".omp", "config.yml");

	async function load(initialGlobal: Record<string, unknown> = {}) {
		await Bun.write(globalConfigPath(), YAML.stringify(initialGlobal, null, 2));
		return await Settings.loadIsolated({ cwd: projectDir, agentDir });
	}

	describe("setProfile — create", () => {
		test("creates a global profile and persists it to config.yml", async () => {
			const s = await load({ modelRoles: { default: "prov/base" } });
			const stored = await s.setProfile("global", "cheap", {
				description: "Low cost",
				modelRoles: { default: "prov/cheap-main", smol: "prov/cheap-smol" },
			});
			expect(stored.modelRoles?.default).toBe("prov/cheap-main");

			// Post-write verification through the real settings path.
			s.reloadFromDisk();
			await s.reloadFromDisk();
			expect(s.getProfile("cheap")?.description).toBe("Low cost");
			expect(s.getModelRole("default")).toBe("prov/base"); // inactive: base wins

			const onDisk = <ParsedConfig>YAML.parse(await Bun.file(globalConfigPath()).text());
			expect(onDisk.profiles!.cheap.modelRoles!.default).toBe("prov/cheap-main");
		});

		test("creates a project-scoped profile in .omp/config.yml", async () => {
			const s = await load({});
			await s.setProfile("project", "repo-only", { modelRoles: { slow: "prov/repo-slow" } });

			const onDisk = <ParsedConfig>YAML.parse(await Bun.file(projectConfigPath()).text());
			expect(onDisk.profiles!["repo-only"].modelRoles!.slow).toBe("prov/repo-slow");
			expect(s.getProfile("repo-only")?.modelRoles?.slow).toBe("prov/repo-slow");

			// Global file untouched.
			const globalOnDisk = <Record<string, unknown>>YAML.parse(await Bun.file(globalConfigPath()).text());
			expect(globalOnDisk.profiles).toBeUndefined();
		});

		test("partial profile stores only provided roles", async () => {
			const s = await load({});
			await s.setProfile("global", "smol-only", { modelRoles: { smol: "prov/s" } });
			const definition = s.getProfile("smol-only");
			expect(Object.keys(definition?.modelRoles ?? {})).toEqual(["smol"]);
		});
	});

	describe("setProfile — update semantics", () => {
		const INITIAL = {
			modelRoles: { default: "prov/base" },
			profiles: {
				cheap: { description: "v1", modelRoles: { default: "prov/c1", smol: "prov/cs1", slow: "prov/cl1" } },
				other: { modelRoles: { default: "prov/o" } },
			},
		};

		test("updating one role leaves sibling roles, other profiles, and base intact", async () => {
			const s = await load(INITIAL);
			await s.setProfile("global", "cheap", { modelRoles: { smol: "prov/cs2" } });

			const cheap = s.getProfile("cheap")?.modelRoles;
			expect(cheap?.smol).toBe("prov/cs2"); // updated
			expect(cheap?.default).toBe("prov/c1"); // preserved
			expect(cheap?.slow).toBe("prov/cl1"); // preserved
			expect(s.getProfile("other")?.modelRoles?.default).toBe("prov/o"); // sibling intact
			expect(s.getGlobalModelRole("default")).toBe("prov/base"); // base intact

			const onDisk = <ParsedConfig>YAML.parse(await Bun.file(globalConfigPath()).text());
			expect(onDisk.modelRoles!.default).toBe("prov/base");
			expect(onDisk.profiles!.other).toBeDefined();
		});

		test("updating description preserves modelRoles", async () => {
			const s = await load(INITIAL);
			await s.setProfile("global", "cheap", { description: "v2" });
			expect(s.getProfile("cheap")?.description).toBe("v2");
			expect(s.getProfile("cheap")?.modelRoles?.smol).toBe("prov/cs1");
		});

		test("repeated writes do not corrupt or duplicate config", async () => {
			const s = await load(INITIAL);
			for (let i = 0; i < 5; i++) {
				await s.setProfile("global", "cheap", { modelRoles: { smol: `prov/iter${i}` } });
			}
			const onDisk = <ParsedConfig>YAML.parse(await Bun.file(globalConfigPath()).text());
			expect(onDisk.profiles!.cheap.modelRoles!.smol).toBe("prov/iter4");
			expect(onDisk.profiles!.cheap.modelRoles!.default).toBe("prov/c1");
			expect(YAML.stringify(onDisk)).toBeTypeOf("string");
		});

		test("updating an ACTIVE profile changes live effective roles immediately", async () => {
			const s = await load({ ...INITIAL, activeProfile: "cheap" });
			expect(s.getModelRole("smol")).toBe("prov/cs1");
			await s.setProfile("global", "cheap", { modelRoles: { smol: "prov/live-new" } });
			expect(s.getModelRole("smol")).toBe("prov/live-new");
			expect(expandRoleAlias("@smol", s)).toBe("prov/live-new");
		});
	});

	describe("removeProfile", () => {
		test("deletes an inactive profile; others survive", async () => {
			const s = await load({
				profiles: {
					a: { modelRoles: { default: "prov/a" } },
					b: { modelRoles: { default: "prov/b" } },
				},
			});
			await s.removeProfile("global", "a");
			expect(s.getProfile("a")).toBeUndefined();
			expect(s.getProfile("b")).toBeDefined();
		});

		test("deleting the globally-active profile clears the selection and restores base roles", async () => {
			const s = await load({
				modelRoles: { default: "prov/base" },
				activeProfile: "doomed",
				profiles: { doomed: { modelRoles: { default: "prov/x" } } },
			});
			expect(s.getModelRole("default")).toBe("prov/x");
			await s.removeProfile("global", "doomed");
			expect(s.getActiveProfile()).toBe("");
			expect(s.isProfileActive()).toBe(false);
			expect(s.getModelRole("default")).toBe("prov/base");
		});

		test("deleting a project profile does not disturb a global active selection of the same name", async () => {
			await Bun.write(
				globalConfigPath(),
				YAML.stringify({
					activeProfile: "shared",
					profiles: { shared: { modelRoles: { default: "prov/global-def" } } },
				}),
			);
			fs.mkdirSync(path.dirname(projectConfigPath()), { recursive: true });
			await Bun.write(
				projectConfigPath(),
				YAML.stringify({ profiles: { shared: { modelRoles: { smol: "prov/proj-extra" } } } }),
			);
			const s = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			await s.removeProfile("project", "shared");
			// Global selection survives with its own definition.
			expect(s.getActiveProfile()).toBe("shared");
			expect(s.getModelRole("default")).toBe("prov/global-def");
			expect(s.getProfile("shared")?.modelRoles?.smol).toBeUndefined();
		});

		test("deleting a non-existent profile throws cleanly without touching disk", async () => {
			const before = (await Bun.file(globalConfigPath()).exists()) ? await Bun.file(globalConfigPath()).text() : "";
			const s = await load({});
			expect(s.removeProfile("global", "ghost")).rejects.toThrow(/does not exist/);
			if (before) expect(await Bun.file(globalConfigPath()).text()).toBe(before);
		});
	});

	describe("setActiveProfile scopes", () => {
		const CFG = {
			modelRoles: { default: "prov/base" },
			activeProfile: "",
			profiles: { p: { modelRoles: { default: "prov/pd" } } },
		};

		test("persistent global activation writes activeProfile to disk", async () => {
			const s = await load(CFG);
			await s.setActiveProfile("global", "p");
			const onDisk = <ParsedConfig>YAML.parse(await Bun.file(globalConfigPath()).text());
			expect(onDisk.activeProfile).toBe("p");
			expect(s.getModelRole("default")).toBe("prov/pd");
		});

		test("runtime activation does NOT persist but does change live state", async () => {
			const s = await load(CFG);
			await s.setActiveProfile("runtime", "p");
			expect(s.getActiveProfile()).toBe("p");
			expect(s.getModelRole("default")).toBe("prov/pd");
			const onDisk = <ParsedConfig>YAML.parse(await Bun.file(globalConfigPath()).text());
			expect(onDisk.activeProfile).toBe("");
		});

		test("runtime activation of unknown profile throws", async () => {
			const s = await load(CFG);
			expect(s.setActiveProfile("runtime", "nope")).rejects.toThrow(/Unknown profile/);
		});
	});

	describe("validation rejects invalid mutations", () => {
		test.each([
			["empty name", "", { modelRoles: {} }],
			["whitespace name", " padded ", { modelRoles: {} }],
			["reserved off name", "off", { modelRoles: {} }],
			["non-string selector", "ok-name", { modelRoles: { smol: 42 } }],
			["empty selector", "ok-name", { modelRoles: { smol: "" } }],
			["non-string description", "ok-name", { description: 7 }],
		])("%s", async (_label, name, definition) => {
			const s = await load({});
			await expect(s.setProfile("global", name, definition as never)).rejects.toThrow();
		});
	});

	describe("describeProfiles visibility", () => {
		test("reports active state, base vs effective roles, and definition sources", async () => {
			await Bun.write(
				globalConfigPath(),
				YAML.stringify({
					modelRoles: { default: "prov/base-d", smol: "prov/base-s" },
					activeProfile: "mixed",
					profiles: {
						mixed: { modelRoles: { default: "prov/mix-d" } },
						gonly: { modelRoles: { default: "prov/g" } },
					},
				}),
			);
			fs.mkdirSync(path.dirname(projectConfigPath()), { recursive: true });
			await Bun.write(
				projectConfigPath(),
				YAML.stringify({ profiles: { mixed: { modelRoles: { slow: "prov/proj-slow" } } } }),
			);
			const s = await Settings.loadIsolated({ cwd: projectDir, agentDir });

			const snap = s.describeProfiles();
			expect(snap.active).toBe("mixed");
			expect(snap.baseModelRoles.default).toBe("prov/base-d");
			expect(snap.effectiveModelRoles.default).toBe("prov/mix-d"); // profile overlays base
			expect(snap.effectiveModelRoles.smol).toBe("prov/base-s"); // fall-through
			expect(snap.profiles.mixed.definedIn).toContain("global");
			expect(snap.profiles.mixed.definedIn).toContain("project");
			expect(snap.profiles.gonly.definedIn).toEqual(["global"]);
		});
	});

	describe("/profile + CLI see agent-created profiles (same state store)", () => {
		test("picker lists agent-created profile; activateProfile works on it", async () => {
			const s = await load({});
			await s.setProfile("global", "coding", {
				description: "Agent made this",
				modelRoles: { default: "prov/code" },
			});

			const entries = profilePickerEntries(s);
			expect(entries.find(e => e.name === "coding")?.description).toBe("Agent made this");

			const message = activateProfile(s, "coding");
			expect(message).toContain("coding active");
			expect(s.getModelRole("default")).toBe("prov/code");
			activateProfile(s, "off");
			expect(s.getModelRole("default")).toBeUndefined();
		});

		test("CLI --model-profile runtime override activates agent-created profile", async () => {
			const s = await load({ modelRoles: { default: "prov/base" }, profiles: {} });
			await s.setProfile("global", "cli-target", { modelRoles: { default: "prov/cli" } });
			s.override("activeProfile", "cli-target");
			expect(s.getModelRole("default")).toBe("prov/cli");
		});
	});
});
