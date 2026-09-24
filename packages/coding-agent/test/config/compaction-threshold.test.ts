import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { validateAgentCompactionThresholdOverrides } from "@oh-my-pi/pi-coding-agent/config/compaction-threshold";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

async function withConfigDirs(run: (dirs: { root: string; agentDir: string; cwd: string }) => Promise<void>) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-compaction-threshold-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	try {
		await run({ root, agentDir, cwd });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function overridesYaml(value: unknown): string {
	return JSON.stringify({ task: { agentCompactionThresholdOverrides: value } });
}

describe("task.agentCompactionThresholdOverrides", () => {
	it("normalizes token counts and percentages into both threshold fields", () => {
		expect(validateAgentCompactionThresholdOverrides(undefined)).toEqual({});
		expect(validateAgentCompactionThresholdOverrides(null)).toEqual({});
		expect(
			validateAgentCompactionThresholdOverrides({ scout: "80%", task: 90000, eval: " 12.5% ", cleared: null }),
		).toEqual({
			scout: { thresholdPercent: 80, thresholdTokens: -1 },
			task: { thresholdPercent: -1, thresholdTokens: 90000 },
			eval: { thresholdPercent: 12.5, thresholdTokens: -1 },
		});
	});

	it("rejects malformed maps and entries with the offending setting path", () => {
		const malformed: [unknown, string][] = [
			["scout: 80%", "Invalid task.agentCompactionThresholdOverrides:"],
			[[], "Invalid task.agentCompactionThresholdOverrides:"],
			[{ scout: { thresholdPercent: 80 } }, "task.agentCompactionThresholdOverrides.scout"],
			[{ scout: [] }, "task.agentCompactionThresholdOverrides.scout"],
			[{ scout: "80" }, "task.agentCompactionThresholdOverrides.scout"],
			[{ scout: "0%" }, "task.agentCompactionThresholdOverrides.scout"],
			[{ scout: "101%" }, "task.agentCompactionThresholdOverrides.scout"],
			[{ scout: 0 }, "task.agentCompactionThresholdOverrides.scout"],
			[{ scout: -1 }, "task.agentCompactionThresholdOverrides.scout"],
			[{ scout: 1.5 }, "task.agentCompactionThresholdOverrides.scout"],
			[{ scout: Number.POSITIVE_INFINITY }, "task.agentCompactionThresholdOverrides.scout"],
		];
		for (const [value, message] of malformed) {
			expect(() => validateAgentCompactionThresholdOverrides(value)).toThrow(message);
		}
	});

	it("rejects malformed values while loading settings", async () => {
		await withConfigDirs(async ({ agentDir, cwd }) => {
			const configPath = path.join(agentDir, "config.yml");
			for (const value of [[], { scout: { thresholdPercent: 80 } }, { scout: "80" }]) {
				await Bun.write(configPath, overridesYaml(value));
				await expect(Settings.loadReadOnly({ agentDir, cwd })).rejects.toThrow(
					"task.agentCompactionThresholdOverrides",
				);
			}
		});
	});

	it("lets a higher-priority layer replace or clear a lower-priority entry", async () => {
		await withConfigDirs(async ({ root, agentDir, cwd }) => {
			await Bun.write(path.join(agentDir, "config.yml"), overridesYaml({ scout: 90000, task: 50000 }));
			const overlay = path.join(root, "overlay.yml");
			await Bun.write(overlay, overridesYaml({ scout: "80%", task: null }));

			const settings = await Settings.loadReadOnly({ agentDir, cwd, configFiles: [overlay] });
			expect(
				validateAgentCompactionThresholdOverrides(settings.get("task.agentCompactionThresholdOverrides")),
			).toEqual({ scout: { thresholdPercent: 80, thresholdTokens: -1 } });
		});
	});

	it("rejects invalid set and override calls without changing the effective value", () => {
		const settings = Settings.isolated();
		settings.override("task.agentCompactionThresholdOverrides", { scout: 90000 });

		expect(() => settings.set("task.agentCompactionThresholdOverrides", { scout: "eighty" })).toThrow(
			"task.agentCompactionThresholdOverrides.scout",
		);
		expect(() => settings.override("task.agentCompactionThresholdOverrides", { scout: Number.NaN })).toThrow(
			"task.agentCompactionThresholdOverrides.scout",
		);
		expect(settings.get("task.agentCompactionThresholdOverrides")).toEqual({ scout: 90000 });
	});
});
