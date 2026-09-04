import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getSettingDef } from "@oh-my-pi/pi-coding-agent/modes/components/settings-defs";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	CONDITION_SPECS,
	getUi,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const paths = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

describe("CONDITION_SPECS coverage", () => {
	it("has a declarative spec for every ui.condition name used in the schema", () => {
		const used = new Set<string>();
		for (const key of paths) {
			const condition = getUi(key)?.condition;
			if (condition) used.add(condition);
		}
		// Guards against the coverage check below passing vacuously if nobody
		// declares a `ui.condition` any more.
		expect(used.size).toBeGreaterThan(0);
		for (const name of used) {
			expect(CONDITION_SPECS).toHaveProperty(name);
		}
	});

	it("has no spec that names a condition nothing in the schema declares", () => {
		const used = new Set<string>();
		for (const key of paths) {
			const condition = getUi(key)?.condition;
			if (condition) used.add(condition);
		}
		for (const name of Object.keys(CONDITION_SPECS)) {
			expect(used).toContain(name);
		}
	});

	it("covers all three declarative condition kinds", () => {
		const kinds = new Set(Object.values(CONDITION_SPECS).map(spec => spec.kind));
		expect(kinds).toEqual(new Set(["setting", "platform", "terminal"]));
	});

	it("resolves platform and terminal conditions to descriptors, never an evaluated boolean", () => {
		expect(CONDITION_SPECS.macOS).toEqual({ kind: "platform", platform: "darwin" });
		expect(CONDITION_SPECS.hasImageProtocol).toEqual({ kind: "terminal", capability: "imageProtocol" });
	});

	it("resolves a truthy-checked condition (planModeEnabled) as an explicit equals:true", () => {
		expect(CONDITION_SPECS.planModeEnabled).toEqual({ kind: "setting", dependsOn: "plan.enabled", equals: true });
	});

	it("resolves setting-dependent conditions with the dependsOn path and expected value", () => {
		expect(CONDITION_SPECS.advisorEnabled).toEqual({ kind: "setting", dependsOn: "advisor.enabled", equals: true });
		expect(CONDITION_SPECS.hindsightActive).toEqual({
			kind: "setting",
			dependsOn: "memory.backend",
			equals: "hindsight",
		});
	});
});

describe("settings-defs derives runtime predicates from CONDITION_SPECS", () => {
	let agentDir: TempDir | undefined;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		resetSettingsForTest();
		agentDir = TempDir.createSync("@omp-condition-specs-");
		setAgentDir(agentDir.path());
	});

	afterEach(async () => {
		AgentStorage.close();
		resetSettingsForTest();
		if (originalAgentDir) setAgentDir(originalAgentDir);
		else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (agentDir) {
			try {
				await agentDir.remove();
			} catch {}
			agentDir = undefined;
		}
	});

	it("a setting-kind condition (advisorEnabled) tracks its dependsOn setting live", async () => {
		await Settings.init();
		const def = getSettingDef("advisor.syncBacklog");
		expect(def?.condition).toBeDefined();

		Settings.instance.set("advisor.enabled", true);
		expect(def?.condition?.()).toBe(true);

		Settings.instance.set("advisor.enabled", false);
		expect(def?.condition?.()).toBe(false);
	});
});
