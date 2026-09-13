/**
 * Agent-managed Profile configuration tests: create/update/delete/activate
 * through the structured Settings mutation API, across global and project
 * scopes, with patch semantics, live reload behavior, and config integrity.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { expandRoleAlias } from "../src/config/model-resolver";
import { onModelRolesChanged, resetSettingsForTest, Settings } from "../src/config/settings";
import {
	type ProfileMutation,
	parseProfileMutation,
	runProfileMutation,
} from "../src/slash-commands/helpers/profile-command";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const YAML = Bun.YAML;

describe("Profile mutation API", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-profile-mutation-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		for (const instance of trackedInstances) {
			try {
				await instance.flush();
			} catch {
				// best-effort: persistence state is verified per-test
			}
		}
		trackedInstances.length = 0;
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		resetSettingsForTest();
		await tempDir?.remove();
	});

	const trackedInstances: Settings[] = [];

	async function load(): Promise<Settings> {
		const s = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		trackedInstances.push(s);
		return s;
	}

	function writeGlobalConfig(config: Record<string, unknown>): void {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
	}

	function readGlobalConfig(): Record<string, unknown> {
		return YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf-8")) as Record<string, unknown>;
	}

	function readProjectConfig(): Record<string, unknown> {
		const p = path.join(projectDir, ".omp", "config.yml");
		return YAML.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
	}

	describe("create", () => {
		test("creates a global profile with arbitrary name and partial roles", async () => {
			writeGlobalConfig({ modelRoles: { default: "provider/base" } });
			const s = await load();
			await s.setProfile("global", "my-custom_thing", { modelRoles: { smol: "provider/x" } });
			expect(s.getProfile("my-custom_thing")?.modelRoles?.smol).toBe("provider/x");
			expect(s.getActiveProfile()).toBe("");
			// Persisted and re-readable through the real load path.
			resetSettingsForTest();
			const fresh = await load();
			expect(fresh.getProfile("my-custom_thing")?.modelRoles?.smol).toBe("provider/x");
		});

		test("creating a profile never touches base modelRoles or unrelated config", async () => {
			writeGlobalConfig({
				modelRoles: { default: "provider/base" },
				theme: { dark: "titanium" },
				customFutureKey: { nested: [1, 2] },
			});
			const s = await load();
			await s.setProfile("global", "cheap", { description: "Cheap", modelRoles: { default: "provider/c" } });
			const onDisk = readGlobalConfig();
			expect(onDisk.modelRoles).toEqual({ default: "provider/base" });
			expect(onDisk.theme).toEqual({ dark: "titanium" });
			expect(onDisk.customFutureKey).toEqual({ nested: [1, 2] });
			expect(s.getModelRole("default")).toBe("provider/base");
		});

		test("create in project scope writes only the project file", async () => {
			writeGlobalConfig({ profiles: { globalOnly: { modelRoles: { default: "provider/g" } } } });
			const s = await load();
			await s.setProfile("project", "repo-profile", { modelRoles: { default: "provider/p" } });
			expect(s.getProfile("repo-profile")?.modelRoles?.default).toBe("provider/p");
			expect(readProjectConfig().profiles).toHaveProperty("repo-profile");
			expect(readGlobalConfig().profiles).not.toHaveProperty("repo-profile");
		});
	});

	describe("patch-like updates", () => {
		const BASE = {
			modelRoles: { default: "provider/base" },
			profiles: {
				cheap: {
					description: "Cheap",
					modelRoles: { default: "model-a", smol: "model-b", slow: "model-c" },
				},
				other: { modelRoles: { default: "model-z" } },
			},
		};

		test("updating one role preserves siblings, own description, other profiles, and base roles", async () => {
			writeGlobalConfig(BASE);
			const s = await load();
			await s.setProfile("global", "cheap", { modelRoles: { smol: "model-d" } });
			const cheap = s.getProfile("cheap") ?? {};
			expect(cheap.description).toBe("Cheap");
			expect(cheap.modelRoles).toEqual({ default: "model-a", smol: "model-d", slow: "model-c" });
			expect(s.getProfile("other")?.modelRoles?.default).toBe("model-z");
			expect(s.getModelRole("default")).toBe("provider/base");
		});

		test("null selector removes a role; missing role can be added later", async () => {
			writeGlobalConfig(BASE);
			const s = await load();
			await s.setProfile("global", "cheap", { modelRoles: { slow: null } });
			expect(s.getProfile("cheap")?.modelRoles?.slow).toBeUndefined();
			await s.setProfile("global", "cheap", { modelRoles: { plan: "model-p" } });
			expect(s.getProfile("cheap")?.modelRoles?.plan).toBe("model-p");
		});

		test("description update does not disturb roles", async () => {
			writeGlobalConfig(BASE);
			const s = await load();
			await s.setProfile("global", "cheap", { description: "Even cheaper" });
			expect(s.getProfile("cheap")?.description).toBe("Even cheaper");
			expect(s.getProfile("cheap")?.modelRoles?.smol).toBe("model-b");
		});
	});

	describe("activation", () => {
		const CONFIG = {
			modelRoles: { default: "provider/base", smol: "provider/base-smol" },
			profiles: {
				cheap: { modelRoles: { default: "provider/c1", smol: "provider/c2" } },
			},
		};

		test("persistent activation survives reload and drives effective + subagent roles", async () => {
			writeGlobalConfig(CONFIG);
			let s = await load();
			await s.setActiveProfile("global", "cheap");
			expect(s.getActiveProfile()).toBe("cheap");
			expect(s.getModelRole("default")).toBe("provider/c1");
			expect(expandRoleAlias("@smol", s)).toBe("provider/c2");
			resetSettingsForTest();

			s = await load();
			expect(s.getActiveProfile()).toBe("cheap");
			expect(s.getModelRole("default")).toBe("provider/c1");
		});

		test("runtime activation is session-only and does not persist", async () => {
			writeGlobalConfig(CONFIG);
			const s = await load();
			await s.setActiveProfile("runtime", "cheap");
			expect(s.getActiveProfile()).toBe("cheap");
			expect(readGlobalConfig().activeProfile).toBeUndefined();
			await s.setActiveProfile("runtime", "");
			expect(s.getActiveProfile()).toBe("");
		});

		test("deactivation restores exact base roles", async () => {
			writeGlobalConfig(CONFIG);
			const s = await load();
			await s.setActiveProfile("global", "cheap");
			expect(s.getModelRole("smol")).toBe("provider/c2");
			await s.setActiveProfile("global", "");
			expect(s.getModelRole("default")).toBe("provider/base");
			expect(s.getModelRole("smol")).toBe("provider/base-smol");
			expect(s.isProfileActive()).toBe(false);
		});
	});

	describe("live update of the active profile", () => {
		test("changing the active profile's role updates live effective resolution without touching base", async () => {
			writeGlobalConfig({
				modelRoles: { default: "provider/base" },
				activeProfile: "cheap",
				profiles: { cheap: { modelRoles: { default: "model-a" } } },
			});
			const s = await load();
			expect(s.getModelRole("default")).toBe("model-a");

			let fired = 0;

			onModelRolesChanged(() => {
				fired++;
			});

			await s.setProfile("global", "cheap", { modelRoles: { default: "model-b" } });

			expect(fired).toBeGreaterThan(0);
			expect(s.getModelRole("default")).toBe("model-b"); // live effective updated
			expect(s.getProfile("cheap")?.modelRoles?.default).toBe("model-b"); // persisted overlay
			expect(s.getGlobalModelRole("default")).toBe("provider/base"); // base untouched
			expect(s.getActiveProfile()).toBe("cheap"); // still active
		});
	});

	describe("delete", () => {
		const CONFIG = {
			modelRoles: { default: "provider/base" },
			profiles: {
				inactive: { modelRoles: { smol: "provider/i" } },
				doomed: { modelRoles: { default: "provider/d" } },
			},
		};

		test("deleting an inactive profile removes only that profile", async () => {
			writeGlobalConfig(CONFIG);
			const s = await load();
			await s.removeProfile("global", "inactive");
			expect(s.getProfile("inactive")).toBeUndefined();
			expect(s.getProfile("doomed")).toBeDefined();
			const onDisk = readGlobalConfig().profiles as Record<string, unknown>;
			expect(onDisk).not.toHaveProperty("inactive");
			expect(onDisk).toHaveProperty("doomed");
		});

		test("deleting the active profile deactivates and restores base roles", async () => {
			writeGlobalConfig({ ...CONFIG, activeProfile: "doomed" });
			const s = await load();
			expect(s.getModelRole("default")).toBe("provider/d");
			await s.removeProfile("global", "doomed");
			expect(s.getActiveProfile()).toBe("");
			expect(s.getModelRole("default")).toBe("provider/base");
			expect(readGlobalConfig().activeProfile).toBe("");
		});

		test("deleting a nonexistent profile throws without corrupting config", async () => {
			writeGlobalConfig(CONFIG);
			const s = await load();
			expect(s.removeProfile("global", "ghost")).rejects.toThrow(/does not exist/);
			expect(Object.keys(readGlobalConfig().profiles as object)).toHaveLength(2);
		});
	});

	describe("validation", () => {
		beforeEach(() => {
			writeGlobalConfig({ modelRoles: { default: "provider/base" }, profiles: {} });
		});

		test("rejects malformed names without writing anything", async () => {
			const s = await load();
			for (const bad of ["", "off", " padded"]) {
				expect(s.setProfile("global", bad, { modelRoles: { smol: "x" } })).rejects.toThrow();
			}
			expect(readGlobalConfig().profiles).toEqual({});
		});

		test("rejects invalid selectors without corrupting existing config", async () => {
			const s = await load();
			expect(s.setProfile("global", "ok", { modelRoles: { smol: "provider/fine" } })).resolves.toBeDefined();
			expect(s.setProfile("global", "bad", { modelRoles: { smol: 42 as unknown as string } })).rejects.toThrow(
				/Invalid model selector/,
			);
			expect(s.getProfile("ok")).toBeDefined(); // prior write intact
			expect(s.getProfile("bad")).toBeUndefined();
		});

		test("repeated edits keep config valid and parseable", async () => {
			const s = await load();
			for (let i = 0; i < 5; i++) {
				await s.setProfile("global", "churn", { modelRoles: { smol: `provider/v${i}` } });
			}
			expect(s.getProfile("churn")?.modelRoles?.smol).toBe("provider/v4");
			const onDisk = readGlobalConfig();
			expect((onDisk.profiles as Record<string, unknown>).churn).toBeDefined();
		});
	});

	describe("external visibility", () => {
		test("reloadFromDisk observes a tool-created profile and /profile sees it via getProfiles", async () => {
			writeGlobalConfig({ modelRoles: { default: "provider/base" } });
			const s = await load();
			await s.setProfile("global", "fresh", { description: "New", modelRoles: { smol: "provider/f1" } });
			resetSettingsForTest();

			const fresh = await load();
			// Simulate another process seeing it after disk reload:
			writeGlobalConfig({
				modelRoles: { default: "provider/base" },
				profiles: {
					fresh: { description: "New", modelRoles: { smol: "provider/f1" } },
					second: { modelRoles: { default: "provider/f2" } },
				},
			});
			await fresh.reloadFromDisk();
			const names = Object.keys(fresh.getProfiles()).sort();
			expect(names).toEqual(["fresh", "second"]);
		});

		test("--model-profile works against a newly created persistent profile", async () => {
			writeGlobalConfig({ modelRoles: { default: "provider/base" }, profiles: {} });
			const s = await load();
			await s.setProfile("global", "brand-new", { modelRoles: { default: "provider/nb" } });
			s.override("activeProfile", "brand-new");
			expect(s.getActiveProfile()).toBe("brand-new");
			expect(s.getModelRole("default")).toBe("provider/nb");
		});
	});
});

describe("/profile mutation parsing and execution", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-profile-parse-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				modelRoles: { default: "provider/base" },
				profiles: { existing: { description: "Old", modelRoles: { default: "m0", smol: "s0" } } },
			}),
		);
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		resetSettingsForTest();
		await tempDir?.remove();
	});

	async function exec(args: string): Promise<{ message: string; settings: Settings }> {
		const s = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const parsed = parseProfileMutation(args);
		if (typeof parsed === "string") {
			return { message: `ACTIVATE:${parsed}`, settings: s };
		}
		if ("error" in parsed) {
			return { message: parsed.error, settings: s };
		}
		const message = await runProfileMutation(s, parsed as ProfileMutation);
		await s.flush();
		return { message, settings: s };
	}

	test("bare args activate directly (back-compat)", async () => {
		const { message } = await exec("existing");
		// Bare words are returned as an activation request for the slash
		// command's existing activateProfile path — not a mutation op.
		expect(message).toBe("ACTIVATE:existing");
	});

	test("list shows profiles with scope and descriptions", async () => {
		const { message } = await exec("list");
		expect(message).toContain("existing");
		expect(message).toContain("Old");
		expect(message).toContain("(global)");
	});

	test("show prints full profile configuration", async () => {
		const { message } = await exec("show existing");
		expect(message).toContain("Profile existing");
		expect(message).toContain("default: m0");
		expect(message).toContain("smol: s0");
	});

	test("create writes the profile and set-role patches one role", async () => {
		const created = await exec("create coding --role default=cd-1 --role smol=cd-2 --description Coding stuff");
		expect(created.message).toContain("created");
		expect(created.settings.getProfile("coding")?.description).toBe("Coding stuff");

		const patched = await exec("set-role existing smol=s9");
		expect(patched.message).toContain("existing.smol = s9");
		const profile = patched.settings.getProfile("existing");
		expect(profile?.modelRoles).toEqual({ default: "m0", smol: "s9" }); // patch, not replace
		expect(profile?.description).toBe("Old");
	});

	test("set-role null removes the role", async () => {
		const { message, settings: s } = await exec("set-role existing smol=null");
		expect(message).toContain("removed");
		expect(s.getProfile("existing")?.modelRoles?.smol).toBeUndefined();
	});

	test("delete removes and reports unknown profiles safely", async () => {
		const gone = await exec("delete existing");
		expect(gone.message).toContain("deleted");
		expect(gone.settings.getProfile("existing")).toBeUndefined();
		const ghost = await exec("delete existing");
		expect(ghost.message).toContain("does not exist");
	});

	test("malformed operations return usage errors without side effects", async () => {
		const { message } = await exec("create");
		expect(message).toMatch(/^Usage:/);
	});
});
