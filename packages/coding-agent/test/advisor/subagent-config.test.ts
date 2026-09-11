import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	advisorRunsForAgentKind,
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	saveWatchdogConfigFile,
	serializeWatchdogConfig,
	type WatchdogConfigDoc,
} from "../../src/advisor/config";

describe("advisor subagent eligibility", () => {
	for (const agentKind of ["main", "sub"] as const) {
		for (const subagents of [undefined, true, false]) {
			it(`${agentKind} session with subagents=${String(subagents)}`, () => {
				expect(advisorRunsForAgentKind({ name: "reviewer", subagents }, agentKind)).toBe(
					agentKind === "main" || subagents !== false,
				);
			});
		}
	}
});

describe("WATCHDOG.yml subagent eligibility", () => {
	let tempDir: TempDir;
	let projectDir: string;
	let agentDir: string;
	let configPath: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("omp-advisor-subagent-config-");
		projectDir = path.join(tempDir.path(), "project");
		agentDir = path.join(tempDir.path(), "agent");
		configPath = path.join(projectDir, "WATCHDOG.yml");
		await fs.mkdir(path.join(projectDir, ".git"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("round-trips all three states alongside note budgets and an empty tool grant", async () => {
		const doc: WatchdogConfigDoc = {
			instructions: "Shared review guidance",
			maxNotesPerUpdate: 3,
			advisors: [
				{ name: "inherit" },
				{ name: "included", subagents: true, maxNotesPerUpdate: 2, tools: [] },
				{ name: "main-only", subagents: false, enabled: false, instructions: "Main session only" },
			],
		};
		await saveWatchdogConfigFile(configPath, doc);
		expect(await loadWatchdogConfigFile(configPath)).toEqual(doc);
		const discovered = await discoverAdvisorConfigs(projectDir, agentDir);
		expect(discovered.advisors.map(advisor => advisor.subagents)).toEqual([undefined, true, false]);
		expect(discovered.advisors[1].tools).toEqual([]);
		expect(discovered.advisors[1].maxNotesPerUpdate).toBe(2);
		expect(discovered.sharedMaxNotesPerUpdate).toBe(3);
		expect(discovered.sharedInstructions).toBe("Shared review guidance");
		expect(serializeWatchdogConfig({ advisors: [{ name: "inherit" }] })).not.toContain("subagents:");
	});

	it.each([true, false])("preserves a lone default advisor with subagents=%s", async subagents => {
		const doc: WatchdogConfigDoc = { advisors: [{ name: "default", subagents }] };
		await saveWatchdogConfigFile(configPath, doc);
		expect(await Bun.file(configPath).exists()).toBe(true);
		expect(await loadWatchdogConfigFile(configPath)).toEqual(doc);
	});

	it.each([undefined, true, false])("replaces the user override with the project value %s", async subagents => {
		await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), {
			advisors: [{ name: "reviewer", subagents: true, maxNotesPerUpdate: 2 }],
		});
		await saveWatchdogConfigFile(configPath, {
			advisors: [{ name: "reviewer", subagents, maxNotesPerUpdate: 5 }],
		});
		const discovered = await discoverAdvisorConfigs(projectDir, agentDir);
		expect(discovered.advisors).toHaveLength(1);
		expect(discovered.advisors[0].subagents).toBe(subagents);
		expect(discovered.advisors[0].maxNotesPerUpdate).toBe(5);
	});

	it.each(['"true"', '"false"', "1", "null"])("rejects non-boolean subagents: %s", async value => {
		await Bun.write(configPath, `advisors:\n  - name: reviewer\n    subagents: ${value}\n`);
		expect(await loadWatchdogConfigFile(configPath)).toEqual({ advisors: [] });
		expect((await discoverAdvisorConfigs(projectDir, agentDir)).advisors).toEqual([]);
	});
});
