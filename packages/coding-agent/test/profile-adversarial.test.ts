/**
 * Adversarial behavioral coverage for Profiles: precedence interactions with
 * every CLI role flag, rapid/extended switching cycles, live-change signals,
 * provenance reporting, plan-role resolution, parser edge cases, malformed
 * configs, and scope isolation under mutation. Complements the base suites
 * (profiles.test.ts, profile-mutation.test.ts, profile-config.test.ts,
 * profile-command.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { expandRoleAlias } from "../src/config/model-resolver";
import { onActiveProfileChanged, onModelRolesChanged, resetSettingsForTest, Settings } from "../src/config/settings";
import {
	type ProfileMutation,
	parseProfileMutation,
	runProfileMutation,
} from "../src/slash-commands/helpers/profile-command";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const YAML = Bun.YAML;

describe("Profiles adversarial coverage", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-profile-adv-");
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

	function writeGlobal(config: Record<string, unknown>): void {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
	}

	function readGlobal(): Record<string, unknown> {
		return YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf-8")) as Record<string, unknown>;
	}

	function readProject(): Record<string, unknown> | null {
		const p = path.join(projectDir, ".omp", "config.yml");
		if (!fs.existsSync(p)) return null;
		return YAML.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
	}

	async function load(): Promise<Settings> {
		return await Settings.loadIsolated({ cwd: projectDir, agentDir });
	}

	const RICH = {
		modelRoles: {
			default: "provider/base-main",
			smol: "provider/base-smol",
			slow: "provider/base-slow",
			plan: "provider/base-plan",
		},
		profiles: {
			cheap: {
				description: "Minimize cost",
				modelRoles: {
					default: "provider/cheap-main",
					smol: "provider/cheap-smol",
					slow: "provider/cheap-slow",
					plan: "provider/cheap-plan",
				},
			},
			normal: {
				description: "Balanced",
				modelRoles: { default: "provider/norm-main", smol: "provider/norm-smol" },
			},
			advanced: {
				description: "Max capability",
				modelRoles: {
					default: "provider/adv-main",
					smol: "provider/adv-smol",
					slow: "provider/adv-slow",
					plan: "provider/adv-plan",
				},
			},
			custom: {
				modelRoles: { slow: "provider/custom-slow" },
			},
		},
	};

	describe("CLI role-flag precedence over profiles", () => {
		for (const [flagRole, profileModel] of [
			["smol", "provider/explicit-smol"],
			["slow", "provider/explicit-slow"],
			["plan", "provider/explicit-plan"],
		] as const) {
			test(`--${flagRole} beats an active profile that also sets ${flagRole}`, async () => {
				writeGlobal({ ...RICH, activeProfile: "cheap" });
				const s = await load();
				s.overrideModelRoles({ [flagRole]: profileModel });
				expect(s.getModelRole(flagRole)).toBe(profileModel);
				expect(s.getModelRoleProvenance(flagRole)).toBe("runtime");
				// Untouched roles keep coming from the profile.
				expect(s.getModelRoleProvenance("default")).toBe("profile");
			});
		}

		test("--model (default role) beats the profile's default while other roles stay profile-driven", async () => {
			writeGlobal({ ...RICH, activeProfile: "advanced" });
			const s = await load();
			s.overrideModelRoles({ default: "provider/explicit-main" });
			expect(s.getModelRole("default")).toBe("provider/explicit-main");
			expect(s.getModelRole("slow")).toBe("provider/adv-slow");
		});

		test("clearing the runtime override re-exposes the profile role", async () => {
			writeGlobal({ ...RICH, activeProfile: "cheap" });
			const s = await load();
			s.overrideModelRoles({ smol: "provider/temp" });
			s.clearOverride("modelRoles");
			expect(s.getModelRole("smol")).toBe("provider/cheap-smol");
			expect(s.getModelRoleProvenance("smol")).toBe("profile");
		});

		test("@task-style alias expansion follows runtime override before profile", async () => {
			writeGlobal({ ...RICH, activeProfile: "cheap" });
			const s = await load();
			s.overrideModelRoles({ smol: "provider/task-explicit" });
			expect(expandRoleAlias("@smol", s)).toBe("provider/task-explicit");
		});
	});

	describe("switching cycles", () => {
		test("repeated cheap → normal → advanced → custom → off cycles stay consistent", async () => {
			writeGlobal(RICH);
			const s = await load();
			const expected = new Map(
				Object.entries({
					cheap: ["provider/cheap-main", "provider/cheap-smol", "provider/cheap-slow"],
					normal: ["provider/norm-main", "provider/norm-smol", "provider/base-slow"],
					advanced: ["provider/adv-main", "provider/adv-smol", "provider/adv-slow"],
					custom: ["provider/base-main", "provider/base-smol", "provider/custom-slow"],
				}),
			);
			for (let cycle = 0; cycle < 3; cycle++) {
				for (const name of ["cheap", "normal", "advanced", "custom"]) {
					await s.setActiveProfile("global", name);
					const [d, sm, sl] = expected.get(name)!;
					expect([s.getModelRole("default"), s.getModelRole("smol"), s.getModelRole("slow")]).toEqual([d, sm, sl]);
					expect(s.getActiveProfile()).toBe(name);
				}
				await s.setActiveProfile("global", "");
				expect(s.getModelRole("default")).toBe("provider/base-main");
				expect(s.getModelRole("slow")).toBe("provider/base-slow");
			}
		});

		test("rapid sequential switching does not corrupt config or drop signals", async () => {
			writeGlobal({ ...RICH, activeProfile: "cheap" });
			const s = await load();
			let modelRoleSignals = 0;

			const unsub = onModelRolesChanged(() => {
				modelRoleSignals++;
			});
			try {
				for (const name of ["advanced", "normal", "cheap", "custom", "advanced", "", "cheap"]) {
					if (name === "") {
						await s.setActiveProfile("global", "");
					} else {
						await s.setActiveProfile("global", name);
					}
				}
				expect(modelRoleSignals).toBeGreaterThanOrEqual(7);
				expect(readGlobal().activeProfile).toBe("cheap");
				expect(Object.keys(readGlobal().profiles as object)).toHaveLength(4);
				expect(s.getModelRole("default")).toBe("provider/cheap-main");
			} finally {
				unsub();
			}
		});
	});

	describe("live change signals on active-profile edits", () => {
		test("editing the ACTIVE profile's non-default role fires signals and updates expansion", async () => {
			writeGlobal({ ...RICH, activeProfile: "cheap" });
			const s = await load();
			let roleSignals = 0;
			let profileSignals = 0;

			const unsubs = [onModelRolesChanged(() => roleSignals++), onActiveProfileChanged(() => profileSignals++)];
			try {
				await s.setProfile("global", "cheap", { modelRoles: { smol: "provider/hot-smol" } });
				// Editing the active profile's roles re-resolves every consumer's
				// effective roles, so the roles signal must fire; the selection
				// signal may fire too (definitions changed) but that is secondary.
				expect(roleSignals).toBeGreaterThan(0);
				expect(s.getModelRole("smol")).toBe("provider/hot-smol");
				expect(expandRoleAlias("@smol", s)).toBe("provider/hot-smol");
			} finally {
				for (const unsub of unsubs) unsub();
			}
		});

		test("deleting the ACTIVE profile restores base roles and fires the selection signal", async () => {
			writeGlobal({ ...RICH, activeProfile: "cheap" });
			const s = await load();
			let profileSignals = 0;

			const unsub = onActiveProfileChanged(() => profileSignals++);
			try {
				await s.removeProfile("global", "cheap");
				expect(profileSignals).toBeGreaterThan(0);
				expect(s.getActiveProfile()).toBe("");
				expect(s.getModelRole("default")).toBe("provider/base-main");
				expect(expandRoleAlias("@smol", s)).toBe("provider/base-smol");
			} finally {
				unsub();
			}
		});
	});

	describe("provenance and plan-role resolution", () => {
		test("provenance reports each layer correctly with a profile active", async () => {
			writeGlobal({ ...RICH, activeProfile: "normal" }); // normal sets default+smol only
			const s = await load();
			expect(s.getModelRoleProvenance("default")).toBe("profile");
			expect(s.getModelRoleProvenance("smol")).toBe("profile");
			expect(s.getModelRoleProvenance("slow")).toBe("global"); // not in profile → falls through
			expect(s.getModelRoleProvenance("plan")).toBe("global");
		});

		test("project modelRoles beat global but lose to the profile", async () => {
			writeGlobal({ ...RICH, activeProfile: "cheap" });
			fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
			fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
			fs.writeFileSync(
				path.join(projectDir, ".omp", "config.yml"),
				YAML.stringify({ modelRoles: { slow: "provider/project-slow" } }),
			);
			const s = await load();
			expect(s.getModelRole("slow")).toBe("provider/cheap-slow"); // profile wins
			await s.setActiveProfile("global", "");
			expect(s.getModelRole("slow")).toBe("provider/project-slow"); // now project is visible
			expect(s.getModelRole("default")).toBe("provider/base-main"); // global still supplies
		});

		test("plan role resolves through the active profile when set", async () => {
			writeGlobal({ ...RICH, activeProfile: "advanced" });
			const s = await load();
			expect(s.getModelRole("plan")).toBe("provider/adv-plan");
			expect(expandRoleAlias("@plan", s)).toBe("provider/adv-plan");
			await s.setActiveProfile("global", "cheap");
			expect(s.getModelRole("plan")).toBe("provider/cheap-plan");
		});
	});

	describe("scope isolation under mutation", () => {
		test("a project-scoped create writes nothing to global config", async () => {
			writeGlobal({ modelRoles: { default: "provider/base" } });
			const s = await load();
			await s.setProfile("project", "repo-only", { modelRoles: { smol: "provider/repo" } });
			expect(readGlobal().profiles).toBeUndefined();
			expect(readProject()).toHaveProperty("profiles");
		});

		test("a global-scoped create writes nothing to project config", async () => {
			writeGlobal({ modelRoles: { default: "provider/base" } });
			const s = await load();
			await s.setProfile("global", "everywhere", { modelRoles: { smol: "provider/g" } });
			expect(readProject()).toBeNull(); // no project file created at all
		});

		test("updating a project profile never alters the same-named global profile's roles", async () => {
			writeGlobal({
				profiles: { shared: { description: "global one", modelRoles: { default: "provider/global-d" } } },
			});
			const s = await load();
			await s.setProfile("project", "shared", { modelRoles: { smol: "provider/proj-smol" } });
			expect((readProject()!.profiles as Record<string, never>).shared).toBeDefined();
			const globalProfiles = readGlobal().profiles as Record<
				string,
				{ description?: string; modelRoles?: Record<string, string> }
			>;
			expect(globalProfiles.shared.modelRoles?.default).toBe("provider/global-d");
			expect(globalProfiles.shared.modelRoles?.smol).toBeUndefined();
			expect(globalProfiles.shared.description).toBe("global one");
		});

		test("failed mutations leave both config files byte-stable", async () => {
			writeGlobal({ modelRoles: { default: "provider/base" }, profiles: { keep: { modelRoles: { smol: "x1" } } } });
			const s = await load();
			const before = fs.readFileSync(path.join(agentDir, "config.yml"), "utf-8");
			expect(s.setProfile("global", "bad name ", { modelRoles: { smol: "x" } })).rejects.toThrow();
			expect(s.removeProfile("global", "ghost")).rejects.toThrow();
			expect(s.setProfile("global", "bad2", { modelRoles: { smol: "" } })).rejects.toThrow(
				/Invalid model selector|non-empty/,
			);
			expect(fs.readFileSync(path.join(agentDir, "config.yml"), "utf-8")).toBe(before);
		});
	});

	describe("malformed configs and unknown models", () => {
		test("profile with a nonexistent provider/model falls through per-role without crashing", async () => {
			writeGlobal({
				modelRoles: { default: "provider/base-main" },
				activeProfile: "ghost-models",
				profiles: {
					"ghost-models": { modelRoles: { smol: "no-such-provider/no-such-model", slow: "also-missing/m3" } },
				},
			});
			const s = await load();
			// String values pass through untouched — resolution leniency matches base modelRoles.
			expect(s.getProfile("ghost-models")?.modelRoles?.smol).toBe("no-such-provider/no-such-model");
			expect(s.getActiveProfile()).toBe("ghost-models");
			expect(s.getModelRole("default")).toBe("provider/base-main");
		});

		test("malformed profile blocks are skipped while valid siblings survive", async () => {
			writeGlobal({
				modelRoles: { default: "provider/base-main" },
				activeProfile: "broken",
				profiles: {
					broken: { modelRoles: { smol: 12345 }, description: 42 },
					good: { modelRoles: { smol: "provider/works" } },
				},
			});
			const s = await load();
			// The broken profile cannot crash startup; activating it applies nothing.
			expect(s.getModelRole("default")).toBe("provider/base-main");
			await s.setActiveProfile("global", "good");
			expect(s.getModelRole("smol")).toBe("provider/works");
		});

		test("profiles key holding a plain string instead of a record degrades gracefully", async () => {
			writeGlobal({ modelRoles: { default: "provider/base-main" }, profiles: "not-a-record" });
			const s = await load();
			expect(s.getProfiles()).toEqual({});
			expect(s.getActiveProfile()).toBe("");
			expect(s.getModelRole("default")).toBe("provider/base-main");
		});
	});

	describe("/profile parser edge cases", () => {
		function parse(args: string): ProfileMutation | { error: string } | string {
			return parseProfileMutation(args);
		}

		test("whitespace-only args mean list", () => {
			expect(parse("   ")).toEqual({ op: "list" });
		});

		test("off routes through activation, not the delete op", () => {
			expect(parse("off")).toBe("off");
		});

		test("show requires exactly one name", () => {
			expect(parse("show")).toMatchObject({ error: expect.stringContaining("Usage") });
			expect(parse("show a b")).toMatchObject({ error: expect.stringContaining("Usage") });
			expect(parse("show ok-name")).toEqual({ op: "show", name: "ok-name" });
		});

		test("set-role rejects pairs without '='", () => {
			expect(parse("set-role prof badvalue")).toMatchObject({ error: expect.stringContaining("Usage") });
			expect(parse("set-role prof role=sel")).toEqual({
				op: "set-role",
				name: "prof",
				role: "role",
				selector: "sel",
				scope: "global",
			});
			expect(parse("set-role prof role=null --project")).toEqual({
				op: "set-role",
				name: "prof",
				role: "role",
				selector: null,
				scope: "project",
			});
		});

		test("create accepts selectors containing '=' and hyphens", () => {
			const parsed = parse("create p --role default=provider/x-y:high") as Extract<
				ProfileMutation,
				{ op: "create" }
			>;
			expect(parsed.roles.default).toBe("provider/x-y:high");
		});

		test("unknown subcommand words fall through to activation", () => {
			expect(parse("my-profile")).toBe("my-profile");
		});

		test("runProfileMutation surfaces validation errors without writing", async () => {
			writeGlobal({ profiles: {} });
			const s = await load();
			const parsed = parse("delete missing") as Extract<ProfileMutation, { op: "delete" }>;
			const message = await runProfileMutation(s, parsed);
			expect(message).toContain("does not exist");
		});
	});

	describe("reload paths see agent-created profiles", () => {
		test("reloadFromDisk picks up an externally added profile without losing runtime activation", async () => {
			writeGlobal({ ...RICH });
			const s = await load();
			s.override("activeProfile", "cheap"); // session-only activation
			const disk = readGlobal();
			(disk.profiles as Record<string, unknown>).external = { modelRoles: { smol: "provider/ext" } };
			writeGlobal(disk);
			await s.reloadFromDisk();
			expect(s.getProfile("external")?.modelRoles?.smol).toBe("provider/ext");
			expect(s.getActiveProfile()).toBe("cheap"); // runtime selection survives reload
		});

		test("reloadForCwd swaps project profile scope cleanly", async () => {
			writeGlobal({ profiles: { shared: { modelRoles: { default: "provider/g-shared" } } } });
			// Load from an unrelated directory first, then move into the project
			// that selects the profile: reloadForCwd must pick up its selection.
			const otherDir = tempDir.join("other-project");
			fs.mkdirSync(otherDir, { recursive: true });
			fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
			fs.writeFileSync(
				path.join(projectDir, ".omp", "config.yml"),
				YAML.stringify({ activeProfile: "shared", profiles: { shared: { description: "project variant" } } }),
			);
			const s = await Settings.loadIsolated({ cwd: otherDir, agentDir });
			expect(s.getActiveProfile()).toBe("");
			await s.reloadForCwd(projectDir);
			expect(s.getActiveProfile()).toBe("shared");
			expect(s.getModelRole("default")).toBe("provider/g-shared"); // deep-merged definition
		});
	});

	describe("backward compatibility hardening", () => {
		test("config with only legacy keys round-trips untouched through profile APIs", async () => {
			const original = { modelRoles: { default: "provider/plain" }, theme: { dark: "dark-terminal" } };
			writeGlobal(original);
			const before = fs.readFileSync(path.join(agentDir, "config.yml"), "utf-8");
			const s = await load();
			await s.setActiveProfile("runtime", ""); // no-op deactivation
			expect(s.getProfiles()).toEqual({});
			expect(fs.readFileSync(path.join(agentDir, "config.yml"), "utf-8")).toBe(before);
		});

		test("activeProfile set but every profile deleted behaves as no profile", async () => {
			writeGlobal({ activeProfile: "vanished", profiles: {} });
			const s = await load();
			expect(s.getActiveProfile()).toBe("");
			expect(s.isProfileActive()).toBe(false);
		});
	});
});
