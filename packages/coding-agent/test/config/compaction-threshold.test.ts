import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import {
	findModelCompactionThreshold,
	validateAgentCompactionThresholdOverrides,
	validateModelCompactionThresholds,
} from "@oh-my-pi/pi-coding-agent/config/compaction-threshold";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCompactionModelThresholds } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgTaskAgentCompactionThresholdOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";

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
				validateAgentCompactionThresholdOverrides(cfgTaskAgentCompactionThresholdOverrides.get(settings)),
			).toEqual({ scout: { thresholdPercent: 80, thresholdTokens: -1 } });
		});
	});

	it("rejects invalid set and override calls without changing the effective value", () => {
		const settings = Settings.isolated();
		cfgTaskAgentCompactionThresholdOverrides.override(settings, { scout: 90000 });

		expect(() => cfgTaskAgentCompactionThresholdOverrides.set(settings, { scout: "eighty" })).toThrow(
			"task.agentCompactionThresholdOverrides.scout",
		);
		expect(() => cfgTaskAgentCompactionThresholdOverrides.override(settings, { scout: Number.NaN })).toThrow(
			"task.agentCompactionThresholdOverrides.scout",
		);
		expect(cfgTaskAgentCompactionThresholdOverrides.get(settings)).toEqual({ scout: 90000 });
	});
});

describe("compaction.modelThresholds", () => {
	const opus = { provider: "anthropic", id: "claude-opus-5-5" };
	const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5" };
	const astra = { provider: "openai-codex", id: "gpt-6-astra" };
	const match = (value: unknown, model: { provider: string; id: string }) =>
		findModelCompactionThreshold(validateModelCompactionThresholds(value), model);

	it("normalizes token counts and percentages into both threshold fields", () => {
		expect(match({ "anthropic/claude-opus-5-5": 600000 }, opus)).toEqual({
			thresholdPercent: -1,
			thresholdTokens: 600000,
		});
		expect(match({ "openai-codex/*": " 40% " }, astra)).toEqual({ thresholdPercent: 40, thresholdTokens: -1 });
	});

	it("prefers an exact provider/id selector, then an exact bare id, then the first declared glob", () => {
		const thresholds = {
			"*": "90%",
			"anthropic/*": "50%",
			"claude-opus-5-5": 500000,
			"Anthropic/Claude-Opus-5-5": 600000,
		};
		expect(match(thresholds, opus)?.thresholdTokens).toBe(600000);
		expect(match({ "anthropic/*": "50%", "claude-opus-5-5": 500000 }, opus)?.thresholdTokens).toBe(500000);
		expect(match(thresholds, sonnet)?.thresholdPercent).toBe(90);
		expect(match({ "anthropic/*": "50%", "*": "90%" }, sonnet)?.thresholdPercent).toBe(50);
		expect(match({ "*opus*": 1000 }, opus)?.thresholdTokens).toBe(1000);
	});

	it("returns no entry for unmatched models and cleared entries", () => {
		expect(match({ "anthropic/*": "50%" }, astra)).toBeUndefined();
		expect(match({ "openai-codex/gpt-6-astra": null }, astra)).toBeUndefined();
		expect(match(undefined, astra)).toBeUndefined();
	});

	it("accepts selectors for models that are not currently available", () => {
		expect(validateModelCompactionThresholds({ "future-provider/unreleased-model": 1000 })).toHaveLength(1);
	});

	it("rejects malformed maps, selectors and entries with the offending setting path", () => {
		const malformed: [unknown, string][] = [
			["anthropic/*: 80%", "Invalid compaction.modelThresholds:"],
			[[], "Invalid compaction.modelThresholds:"],
			[{ " ": 1000 }, "Invalid compaction.modelThresholds: model selectors must be non-empty"],
			[{ "anthropic/*": { thresholdPercent: 80 } }, 'compaction.modelThresholds["anthropic/*"]'],
			[{ "anthropic/*": "80" }, 'compaction.modelThresholds["anthropic/*"]'],
			[{ "anthropic/*": "0%" }, 'compaction.modelThresholds["anthropic/*"]'],
			[{ "anthropic/*": 1.5 }, 'compaction.modelThresholds["anthropic/*"]'],
		];
		for (const [value, message] of malformed) {
			expect(() => validateModelCompactionThresholds(value)).toThrow(message);
		}
	});

	it("rejects malformed values while loading settings and on writes", async () => {
		await withConfigDirs(async ({ agentDir, cwd }) => {
			await Bun.write(
				path.join(agentDir, "config.yml"),
				JSON.stringify({ compaction: { modelThresholds: { "anthropic/*": "eighty" } } }),
			);
			await expect(Settings.loadReadOnly({ agentDir, cwd })).rejects.toThrow("compaction.modelThresholds");
		});
		const settings = Settings.isolated();
		expect(() => cfgCompactionModelThresholds.set(settings, { "anthropic/*": -1 })).toThrow(
			'compaction.modelThresholds["anthropic/*"]',
		);
		expect(cfgCompactionModelThresholds.get(settings)).toEqual({});
	});
});
