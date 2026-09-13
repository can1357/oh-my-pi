/**
 * Round-3 review regressions: layered project edits preserve inheritance,
 * focused-input Escape cancellation, global mutations merge under the write
 * lock (stale-instance scenarios), latest-wins async switch ordering,
 * describeProfiles role union, and strict direct-activation parsing.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { onActiveProfileChanged, resetSettingsForTest, Settings } from "../src/config/settings";
import { LatestWinsExecutor } from "../src/modes/latest-wins-executor";
import { parseProfileMutation } from "../src/slash-commands/helpers/profile-command";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const YAML = Bun.YAML;

describe("round-3 review regressions", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	async function setup(configs: {
		global?: Record<string, unknown>;
		project?: Record<string, unknown>;
	}): Promise<Settings> {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-round3-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify(configs.global ?? { modelRoles: { default: "provider/base" } }),
		);
		if (configs.project) {
			fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(projectDir, ".omp", "config.yml"), YAML.stringify(configs.project));
		}
		resetSettingsForTest();
		return await Settings.loadIsolated({ cwd: projectDir, agentDir });
	}

	async function teardown(): Promise<void> {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		resetSettingsForTest();
		await tempDir?.remove();
	}

	function projectDisk(): Record<string, unknown> {
		return YAML.parse(fs.readFileSync(path.join(projectDir, ".omp", "config.yml"), "utf-8")) as Record<
			string,
			unknown
		>;
	}

	function globalDisk(): Record<string, unknown> {
		return YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf-8")) as Record<string, unknown>;
	}

	test("1: layered project edit persists only the scope-local override", async () => {
		const s = await setup({
			global: { profiles: { coding: { modelRoles: { default: "global-default", slow: "global-slow" } } } },
			project: { activeProfile: "coding", profiles: { coding: { modelRoles: { default: "project-default" } } } },
		});
		// Effective view merges layers…
		expect(s.getProfile("coding")?.modelRoles?.slow).toBe("global-slow");
		// …but the scope-local view does not materialize them.
		expect(s.getScopeLocalProfile("project", "coding")?.modelRoles?.slow).toBeUndefined();
		// Editing project default writes ONLY that role to project config.
		await s.setProfile("project", "coding", { modelRoles: { default: "project-c" } });
		const local = (projectDisk().profiles as Record<string, { modelRoles?: Record<string, string> }>).coding;
		expect(local.modelRoles?.default).toBe("project-c");
		expect(local.modelRoles?.slow).toBeUndefined(); // inherited role NOT copied
		// Changing global slow now flows through to the effective profile.
		await s.setProfile("global", "coding", { modelRoles: { slow: "global-slow2" } });
		expect(s.getProfile("coding")?.modelRoles?.slow).toBe("global-slow2");
		await teardown();
	});

	test("2: adding a project-only role materializes just that role", async () => {
		const s = await setup({
			global: { profiles: { coding: { modelRoles: { default: "g" } } } },
			project: { activeProfile: "coding", profiles: { coding: { modelRoles: { default: "p" } } } },
		});
		await s.setProfile("project", "coding", { modelRoles: { smol: "project-smol" } });
		const local = (projectDisk().profiles as Record<string, { modelRoles?: Record<string, string> }>).coding;
		expect(local.modelRoles?.smol).toBe("project-smol");
		expect(Object.keys(local.modelRoles ?? {})).toEqual(["default", "smol"]); // no inherited roles
		await teardown();
	});

	test("3: removing a project override falls through to global", async () => {
		const s = await setup({
			global: { profiles: { coding: { modelRoles: { default: "g-default" } } } },
			project: { activeProfile: "coding", profiles: { coding: { modelRoles: { default: "p-default" } } } },
		});
		await s.setProfile("project", "coding", { modelRoles: { default: null } }); // tombstone
		const local = (projectDisk().profiles as Record<string, { modelRoles?: Record<string, string> }>).coding;
		expect(local.modelRoles?.default).toBeUndefined(); // local override gone
		expect(s.getProfile("coding")?.modelRoles?.default).toBe("g-default"); // inherits again
		await teardown();
	});

	test("4: describeProfiles effective map includes profile-only roles", async () => {
		const s = await setup({
			global: {
				activeProfile: "p",
				modelRoles: { default: "base-default" },
				profiles: { p: { modelRoles: { slow: "prof-slow", plan: "prof-plan" } } },
			},
		});
		const snapshot = s.describeProfiles();
		expect(snapshot.effectiveModelRoles.default).toBe("base-default");
		expect(snapshot.effectiveModelRoles.slow).toBe("prof-slow"); // profile-only role visible
		expect(snapshot.effectiveModelRoles.plan).toBe("prof-plan");
		// Override wins in the union view too.
		await s.setProfile("global", "p", { modelRoles: { default: "prof-default" } });
		expect(s.describeProfiles().effectiveModelRoles.default).toBe("prof-default");
		await teardown();
	});

	test("5: alias default registers a change when its target role changes", async () => {
		const s = await setup({
			global: {
				activeProfile: "a",
				profiles: { a: { modelRoles: { default: "@smol", smol: "provider/s1" } } },
			},
		});
		let profileSignals = 0;
		const unsub = onActiveProfileChanged(() => profileSignals++);
		try {
			// getModelRole stays raw ("@smol"); the session resolves aliases.
			expect(s.getModelRole("default")).toBe("@smol");
			// Raw default selector is unchanged but the RESOLVED model moves —
			// the snapshot must notice and notify the reconciler.
			await s.setProfile("global", "a", { modelRoles: { smol: "provider/s2" } });
			expect(s.getModelRole("smol")).toBe("provider/s2");
			expect(profileSignals).toBeGreaterThan(0); // reconciler must be told
		} finally {
			unsub();
		}
		await teardown();
	});

	test("6: direct activation rejects trailing args but accepts one token", async () => {
		expect(parseProfileMutation("cheap")).toBe("cheap");
		expect(parseProfileMutation("cheap extra")).toEqual({ error: "Usage: /profile <name>" });
		expect(parseProfileMutation("cheap --project")).toEqual({ error: "Usage: /profile <name>" });
		expect(parseProfileMutation("cheap typo words")).toEqual({ error: "Usage: /profile <name>" });
		// Structured subcommands unaffected.
		expect(parseProfileMutation("list")).toEqual({ op: "list" });
		expect(parseProfileMutation("off")).toBe("off");
		await teardown();
	});

	test("7: stale global create preserves externally added sibling", async () => {
		const s = await setup({ global: { profiles: { a: { modelRoles: { default: "a" } } } } });
		// External process adds B after this instance loaded.
		const disk = globalDisk();
		(disk.profiles as Record<string, unknown>).b = { modelRoles: { default: "b" } };
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(disk));
		// Stale instance creates C.
		await s.setProfile("global", "c", { modelRoles: { default: "c" } });
		const final = globalDisk().profiles as Record<string, unknown>;
		expect(Object.keys(final).sort()).toEqual(["a", "b", "c"]);
		await teardown();
	});

	test("8: stale global update preserves external changes to siblings", async () => {
		const s = await setup({
			global: {
				profiles: {
					a: { modelRoles: { default: "a" } },
					b: { modelRoles: { default: "old" } },
				},
			},
		});
		const disk = globalDisk();
		(disk.profiles as Record<string, { modelRoles: Record<string, string> }>).b.modelRoles.default = "changed";
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(disk));
		await s.setProfile("global", "a", { modelRoles: { smol: "a-smol" } });
		const final = globalDisk().profiles as Record<string, { modelRoles: Record<string, string> }>;
		expect(final.b.modelRoles.default).toBe("changed"); // external change survives
		expect(final.a.modelRoles.smol).toBe("a-smol");
		await teardown();
	});

	test("9: stale global delete preserves externally added sibling", async () => {
		const s = await setup({ global: { profiles: { a: { modelRoles: { default: "a" } } } } });
		const disk = globalDisk();
		(disk.profiles as Record<string, unknown>).b = { modelRoles: { default: "b" } };
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(disk));
		await s.removeProfile("global", "a");
		const final = globalDisk().profiles as Record<string, unknown>;
		expect(final.a).toBeUndefined();
		expect(final.b).toBeDefined(); // external sibling survives
		await teardown();
	});

	test("10: stale global delete clears only same-scope stale selection", async () => {
		const s = await setup({ global: { activeProfile: "a", profiles: { a: { modelRoles: { default: "a" } } } } });
		await s.removeProfile("global", "a");
		expect(globalDisk().activeProfile).toBe("");
		await teardown();
	});

	test("11: latest-wins executor runs newest request last and skips superseded", async () => {
		const executor = new LatestWinsExecutor();
		const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
		const order: string[] = [];
		const first = executor.run(async () => {
			order.push("a-start");
			await gate;
			order.push("a-end");
		});
		// Let A actually start (chain microtasks) before queueing B and C.
		await Bun.sleep(1);
		// B queued while A in flight; C supersedes B before it starts.
		const second = executor.run(async () => {
			order.push("b");
		});
		const third = executor.run(async () => {
			order.push("c");
		});
		openGate();
		await Promise.all([first, second, third]);
		expect(order).toEqual(["a-start", "a-end", "c"]); // b superseded, never ran
		await teardown();
	});

	test("12: async mkdir project writes work without a pre-existing .omp dir", async () => {
		const s = await setup({ global: { profiles: { g: { modelRoles: { default: "g" } } } } });
		fs.rmSync(path.join(projectDir, ".omp"), { recursive: true, force: true });
		await s.setProfile("project", "fresh", { modelRoles: { default: "f" } }); // mkdir path
		expect(s.getProfile("fresh")?.modelRoles?.default).toBe("f");
		await s.setActiveProfile("project", "fresh"); // mkdir path again
		expect(projectDisk().activeProfile).toBe("fresh");
		await teardown();
	});
});
