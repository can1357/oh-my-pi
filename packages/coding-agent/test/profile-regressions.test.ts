/**
 * Review-finding regression tests: effective-state reload signals (E),
 * prototype-key profile-name safety (F), central name validation with
 * reserved sentinels (I), and status-line sanitization of profile names (J).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { onActiveProfileChanged, onModelRolesChanged, resetSettingsForTest, Settings } from "../src/config/settings";
import { sanitizeStatusText } from "../src/modes/shared";
import { initTheme } from "../src/modes/theme/theme";
import { TRUNCATE_LENGTHS, truncateToWidth } from "../src/tools/render-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const YAML = Bun.YAML;

describe("review-finding regressions", () => {
	test("E: external edit to the ACTIVE profile's roles fires signals on reloadFromDisk", async () => {
		const temp = TempDir.createSync("@pi-regression-e-");
		const agentDir = temp.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				activeProfile: "a",
				profiles: { a: { modelRoles: { default: "provider/one" } } },
			}),
		);
		resetSettingsForTest();
		const s = await Settings.loadIsolated({ cwd: agentDir, agentDir });
		expect(s.getModelRole("default")).toBe("provider/one");

		let roleSignals = 0;
		let profileSignals = 0;
		const unsubs = [onModelRolesChanged(() => roleSignals++), onActiveProfileChanged(() => profileSignals++)];
		try {
			// Same active profile NAME, different roles: the signal must fire.
			fs.writeFileSync(
				path.join(agentDir, "config.yml"),
				YAML.stringify({
					activeProfile: "a",
					profiles: { a: { modelRoles: { default: "provider/two" } } },
				}),
			);
			await s.reloadFromDisk();
			expect(s.getModelRole("default")).toBe("provider/two");
			expect(roleSignals).toBeGreaterThan(0);
			expect(profileSignals).toBeGreaterThan(0);
		} finally {
			for (const unsub of unsubs) unsub();
		}

		// Inactive-profile external edits stay silent on the live signals.
		let silent = 0;
		const unsub = onActiveProfileChanged(() => silent++);
		try {
			fs.writeFileSync(
				path.join(agentDir, "config.yml"),
				YAML.stringify({
					activeProfile: "a",
					profiles: {
						a: { modelRoles: { default: "provider/two" } },
						b: { modelRoles: { default: "provider/other" } },
					},
				}),
			);
			await s.reloadFromDisk();
			expect(silent).toBe(0);
			expect(s.getModelRole("default")).toBe("provider/two"); // live model untouched
		} finally {
			unsub();
		}
		await temp.remove();
	});

	test("F: prototype keys never masquerade as profiles", async () => {
		const temp = TempDir.createSync("@pi-regression-f-");
		const agentDir = temp.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "config.yml"), "activeProfile: toString\n");
		resetSettingsForTest();
		const s = await Settings.loadIsolated({ cwd: agentDir, agentDir });
		// No real `toString` profile exists: inherited Object.prototype.toString
		// must not be returned, and the active profile must not resolve to it.
		expect(s.getProfile("toString")).toBeUndefined();
		expect(s.getProfiles()).toEqual({});
		// isProfileActive must be false — the "active" name has no overlay.
		expect(s.isProfileActive()).toBe(false);
		await temp.remove();
	});

	test("F: __proto__ in profiles config is ignored, not inherited", async () => {
		const temp = TempDir.createSync("@pi-regression-f2-");
		const agentDir = temp.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		// Raw YAML with a __proto__ key (YAML.parse produces an own property).
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			"profiles:\n  __proto__:\n    modelRoles:\n      default: provider/evil\n  real:\n    modelRoles:\n      default: provider/ok\n",
		);
		resetSettingsForTest();
		const s = await Settings.loadIsolated({ cwd: agentDir, agentDir });
		expect(Object.keys(s.getProfiles()).sort()).toEqual(["real"]);
		expect(s.getProfile("__proto__")).toBeUndefined();
		await temp.remove();
	});

	test("I: reserved sentinel and prototype-collision names are rejected", async () => {
		const temp = TempDir.createSync("@pi-regression-i-");
		const agentDir = temp.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "config.yml"), "modelRoles:\n  default: provider/base\n");
		resetSettingsForTest();
		const s = await Settings.loadIsolated({ cwd: agentDir, agentDir });
		for (const name of ["off", "+create", "__proto__", "constructor", "hasOwnProperty", "bad name", "", "  x  "]) {
			await expect(s.setProfile("global", name, { modelRoles: { default: "m" } })).rejects.toThrow();
		}
		// Valid names with the advertised charset still work.
		await s.setProfile("global", "work.machine-1", { modelRoles: { default: "m" } });
		expect(s.getProfile("work.machine-1")).toBeDefined();
		await temp.remove();
	});

	test("J: status-line profile name is sanitized and width-bounded", async () => {
		await initTheme();
		// Malformed config values that could corrupt TUI layout.
		const evil = "\x1b[31mred\u0007\tnew\nline";
		const safe = truncateToWidth(sanitizeStatusText(evil), TRUNCATE_LENGTHS.SHORT);
		expect(safe).not.toContain("\x1b");
		expect(safe).not.toContain("\n");
		expect(safe).not.toContain("\t");
		expect(safe.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.SHORT);
		// A long-but-valid name is truncated, not passed through.
		const long = truncateToWidth(sanitizeStatusText("x".repeat(200)), TRUNCATE_LENGTHS.SHORT);
		expect(long.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.SHORT);
	});
});

describe("round-2 review regressions", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	const YAML_ = Bun.YAML;

	function writeProject(config: Record<string, unknown>): void {
		fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".omp", "config.yml"), YAML_.stringify(config));
	}

	function readProjectDisk(): Record<string, unknown> | null {
		const p = path.join(projectDir, ".omp", "config.yml");
		return fs.existsSync(p) ? (YAML_.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>) : null;
	}

	function readGlobalDisk(): Record<string, unknown> {
		return YAML_.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf-8")) as Record<string, unknown>;
	}

	async function load(): Promise<Settings> {
		const s = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		return s;
	}

	async function freshCase(): Promise<Settings> {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-round2-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML_.stringify({ modelRoles: { default: "provider/base" } }),
		);
		writeProject({
			activeProfile: "a",
			profiles: {
				a: { modelRoles: { default: "provider/a1", smol: "provider/a-smol" } },
				b: { modelRoles: { default: "provider/b1" } },
			},
		});
		resetSettingsForTest();
		return load();
	}

	async function teardown(): Promise<void> {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		resetSettingsForTest();
		await tempDir?.remove();
	}

	test("1: active project profile default mutation notifies live consumers", async () => {
		const s = await freshCase();
		let profileSignals = 0;
		let roleSignals = 0;
		const unsubs = [onActiveProfileChanged(() => profileSignals++), onModelRolesChanged(() => roleSignals++)];
		try {
			await s.setProfile("project", "a", { modelRoles: { default: "provider/a2" } });
			expect(s.getModelRole("default")).toBe("provider/a2");
			expect(profileSignals).toBeGreaterThan(0);
			expect(roleSignals).toBeGreaterThan(0);
		} finally {
			for (const unsub of unsubs) unsub();
		}
		await teardown();
	});

	test("2: inactive project profile mutation does not reset live default", async () => {
		const s = await freshCase();
		let profileSignals = 0;
		const unsub = onActiveProfileChanged(() => profileSignals++);
		try {
			await s.setProfile("project", "b", { modelRoles: { default: "provider/b2" } });
			expect(s.getModelRole("default")).toBe("provider/a1"); // untouched
			expect(profileSignals).toBe(0);
		} finally {
			unsub();
		}
		await teardown();
	});

	test("2b: description-only project edit does not reset the live model", async () => {
		const s = await freshCase();
		let profileSignals = 0;
		const unsub = onActiveProfileChanged(() => profileSignals++);
		try {
			await s.setProfile("project", "a", { description: "just a label" });
			expect(profileSignals).toBe(0);
			expect(s.getModelRole("default")).toBe("provider/a1");
		} finally {
			unsub();
		}
		await teardown();
	});

	test("2c: smol-only edit notifies role consumers without changing default", async () => {
		const s = await freshCase();
		let roleSignals = 0;
		let profileSignals = 0;
		const unsubs = [onModelRolesChanged(() => roleSignals++), onActiveProfileChanged(() => profileSignals++)];
		try {
			await s.setProfile("project", "a", { modelRoles: { smol: "provider/a-smol2" } });
			expect(roleSignals).toBeGreaterThan(0);
			expect(s.getModelRole("smol")).toBe("provider/a-smol2");
			// Default unchanged → the default-model reset signal stays silent.
			expect(profileSignals).toBe(0);
			expect(s.getModelRole("default")).toBe("provider/a1");
		} finally {
			for (const unsub of unsubs) unsub();
		}
		await teardown();
	});

	test("3/4/5: setActiveProfile writes exactly the requested layer", async () => {
		const s = await freshCase();
		const globalBefore = fs.readFileSync(path.join(agentDir, "config.yml"), "utf-8");

		await s.setActiveProfile("runtime", "b");
		expect(s.getActiveProfile()).toBe("b");
		expect(fs.readFileSync(path.join(agentDir, "config.yml"), "utf-8")).toBe(globalBefore);
		expect(readProjectDisk()?.activeProfile).toBe("a");

		await s.setActiveProfile("global", "b");
		expect(readGlobalDisk().activeProfile).toBe("b");
		expect(readProjectDisk()?.activeProfile).toBe("a"); // project untouched

		await s.setActiveProfile("project", "a");
		expect(readProjectDisk()?.activeProfile).toBe("a");
		expect(readGlobalDisk().activeProfile).toBe("b"); // global untouched

		// Clear/off at each scope: runtime off shadows the persisted selection
		// for THIS session only; a fresh instance restores project "a".
		await s.setActiveProfile("runtime", "off");
		expect(s.getActiveProfile()).toBe(""); // session-local off
		const fresh = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		expect(fresh.getActiveProfile()).toBe("a"); // persisted selection returns
		await s.setActiveProfile("project", "off");
		expect(readProjectDisk()?.activeProfile).toBe("off");
		expect(readGlobalDisk().activeProfile).toBe("b");
		await teardown();
	});

	test("6: switching A→B→A keeps inactive-edit comparisons correct", async () => {
		const s = await freshCase();
		let resets = 0;
		const unsub = onActiveProfileChanged(() => resets++);
		try {
			await s.setActiveProfile("runtime", "b");
			await s.setProfile("project", "a", { description: "inactive now" });
			await s.setActiveProfile("runtime", "a");
			await s.setProfile("project", "b", { description: "inactive again" });
			// Only the two deliberate switches fire; the inactive edits stay silent.
			expect(resets).toBe(2);
			expect(s.getModelRole("default")).toBe("provider/a1");
		} finally {
			unsub();
		}
		await teardown();
	});

	test("7: reloadForCwd same name different default notifies and updates", async () => {
		const s = await freshCase();
		const project2 = tempDir.join("project2");
		fs.mkdirSync(path.join(project2, ".omp"), { recursive: true });
		fs.writeFileSync(
			path.join(project2, ".omp", "config.yml"),
			YAML_.stringify({
				activeProfile: "a",
				profiles: { a: { modelRoles: { default: "provider/a-other" } } },
			}),
		);
		let roleSignals = 0;
		const unsub = onModelRolesChanged(() => roleSignals++);
		try {
			await s.reloadForCwd(project2);
			expect(s.getActiveProfile()).toBe("a"); // same name…
			expect(s.getModelRole("default")).toBe("provider/a-other"); // …new roles
			expect(roleSignals).toBeGreaterThan(0); // …and consumers were told
		} finally {
			unsub();
		}
		await teardown();
	});

	test("8: reloadForCwd same name same roles does not fire", async () => {
		const s = await freshCase();
		const project2 = tempDir.join("project2");
		fs.mkdirSync(path.join(project2, ".omp"), { recursive: true });
		fs.writeFileSync(
			path.join(project2, ".omp", "config.yml"),
			YAML_.stringify({
				activeProfile: "a",
				profiles: { a: { modelRoles: { default: "provider/a1", smol: "provider/a-smol" } } },
			}),
		);
		let resets = 0;
		const unsub = onActiveProfileChanged(() => resets++);
		try {
			await s.reloadForCwd(project2);
			expect(resets).toBe(0);
			expect(s.getModelRole("default")).toBe("provider/a1");
		} finally {
			unsub();
		}
		await teardown();
	});

	test("9: runtime override survives cwd reload and picks each project's roles", async () => {
		const s = await freshCase();
		const project2 = tempDir.join("project2");
		fs.mkdirSync(path.join(project2, ".omp"), { recursive: true });
		fs.writeFileSync(
			path.join(project2, ".omp", "config.yml"),
			YAML_.stringify({
				activeProfile: "a",
				profiles: { a: { modelRoles: { default: "provider/a-proj2" } } },
			}),
		);
		await s.setActiveProfile("runtime", "a"); // --model-profile equivalent
		expect(s.getModelRole("default")).toBe("provider/a1");
		await s.reloadForCwd(project2);
		expect(s.getActiveProfile()).toBe("a");
		expect(s.getModelRole("default")).toBe("provider/a-proj2");
		await teardown();
	});
});
