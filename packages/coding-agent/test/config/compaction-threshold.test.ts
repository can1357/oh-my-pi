import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { getProjectAgentDir } from "@oh-my-pi/pi-utils";
import {
	matchModelCompactionThreshold,
	parseCompactionPointInput,
	validateAgentCompactionThresholdOverrides,
} from "@oh-my-pi/pi-coding-agent/config/compaction-threshold";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCompactionModelThresholds } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import {
	previewModelCompactionPoint,
	resolveModelCompactionSettings,
	setModelCompactionPoint,
} from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
import { compactionThresholdSettings, createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
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
	it("parses typed compaction points into persisted entries", () => {
		expect(parseCompactionPointInput("90000")).toBe(90000);
		expect(parseCompactionPointInput("90k")).toBe(90000);
		expect(parseCompactionPointInput("2M")).toBe(2_000_000);
		expect(parseCompactionPointInput("1b")).toBe(1_000_000_000);
		expect(parseCompactionPointInput(" 12.5% ")).toBe("12.5%");
		expect(parseCompactionPointInput("  ")).toBeNull();
		expect(parseCompactionPointInput("f400k")).toBe("f400000");
		expect(parseCompactionPointInput("F2M")).toBe("f2000000");
		for (const input of ["abc", "0", "1.5m", "90 kb", "101%", "-5", "f0", "ff1", "f80%"]) {
			expect(() => parseCompactionPointInput(input)).toThrow("Invalid compaction point");
		}
	});

	it("prefers the exact model key, then the longest matching prefix", () => {
		const raw = { "openrouter/*": 50000, "openrouter/anthropic/*": "60%", "openrouter/anthropic/opus": 90000 };
		expect(matchModelCompactionThreshold(raw, { provider: "openrouter", id: "anthropic/opus" })?.key).toBe(
			"openrouter/anthropic/opus",
		);
		expect(matchModelCompactionThreshold(raw, { provider: "openrouter", id: "anthropic/sonnet" })?.key).toBe(
			"openrouter/anthropic/*",
		);
		expect(matchModelCompactionThreshold(raw, { provider: "openrouter", id: "google/gemini" })?.key).toBe(
			"openrouter/*",
		);
		expect(matchModelCompactionThreshold(raw, { provider: "anthropic", id: "opus" })).toBeUndefined();
		expect(() => cfgCompactionModelThresholds.set(Settings.isolated(), { opus: 1000 })).toThrow(
			'compaction.modelThresholds key "opus"',
		);
	});

	it("lets a per-agent override outrank model entries without hiding them from that agent's children", () => {
		const deepseek = { provider: "deepseek", id: "v4" };
		const root = Settings.isolated({
			"compaction.thresholdPercent": 80,
			"compaction.modelThresholds": { "deepseek/*": 90000 },
		});
		expect(resolveModelCompactionSettings(root, deepseek)).toMatchObject({ baseWindowTokens: 90000 });

		const agent = createSubagentSettings(
			root,
			compactionThresholdSettings({ thresholdPercent: 50, thresholdTokens: -1 }),
		);
		expect(resolveModelCompactionSettings(agent, deepseek)).toMatchObject({
			thresholdPercent: 50,
			thresholdTokens: -1,
		});

		// An exact entry added while the agent runs (the /models hub) must not take over.
		cfgCompactionModelThresholds.override(root, { "deepseek/*": 90000, "deepseek/v4": 120000 });
		expect(resolveModelCompactionSettings(root, deepseek)).toMatchObject({ baseWindowTokens: 120000 });
		expect(resolveModelCompactionSettings(agent, deepseek)).toMatchObject({
			thresholdPercent: 50,
			thresholdTokens: -1,
		});

		const grandchild = createSubagentSettings(agent);
		expect(resolveModelCompactionSettings(grandchild, deepseek)).toMatchObject({ baseWindowTokens: 120000 });
	});

	it("scales the configured policy from a token entry instead of triggering at it", () => {
		const terra = { provider: "openai", id: "gpt-5.6-terra" };
		const window = 1_050_000;
		const byDefault = Settings.isolated({ "compaction.modelThresholds": { "openai/gpt-5.6-terra": 400_000 } });
		// Reserve policy: the base minus max(15%, 16384).
		expect(resolveThresholdTokens(window, resolveModelCompactionSettings(byDefault, terra))).toBe(340_000);

		const byPercent = Settings.isolated({
			"compaction.thresholdPercent": 80,
			"compaction.modelThresholds": { "openai/gpt-5.6-terra": 400_000 },
		});
		expect(resolveThresholdTokens(window, resolveModelCompactionSettings(byPercent, terra))).toBe(320_000);

		// A global fixed trigger is not a scale; the model's base replaces it.
		const byFixed = Settings.isolated({
			"compaction.thresholdTokens": 40_000,
			"compaction.modelThresholds": { "openai/gpt-5.6-terra": 400_000 },
		});
		expect(resolveThresholdTokens(window, resolveModelCompactionSettings(byFixed, terra))).toBe(340_000);

		// A percentage entry still scales the real window.
		const byModelPercent = Settings.isolated({ "compaction.modelThresholds": { "openai/gpt-5.6-terra": "50%" } });
		expect(resolveThresholdTokens(window, resolveModelCompactionSettings(byModelPercent, terra))).toBe(525_000);

		// An `f`-prefixed entry is the exact trigger, whatever the policy.
		const byModelFixed = Settings.isolated({
			"compaction.thresholdPercent": 80,
			"compaction.modelThresholds": { "openai/gpt-5.6-terra": "f400000" },
		});
		expect(resolveThresholdTokens(window, resolveModelCompactionSettings(byModelFixed, terra))).toBe(400_000);
		// Agent entries are always exact triggers, so the prefix is not part of their syntax.
		expect(() => validateAgentCompactionThresholdOverrides({ task: "f90000" })).toThrow(
			"task.agentCompactionThresholdOverrides.task",
		);
	});

	it("refuses a hub edit that a project entry for the same model would shadow", async () => {
		await withConfigDirs(async ({ agentDir, cwd }) => {
			await Bun.write(
				path.join(getProjectAgentDir(cwd), "settings.json"),
				JSON.stringify({ compaction: { modelThresholds: { "deepseek/v4": 50000 } } }),
			);
			const settings = await Settings.loadReadOnly({ agentDir, cwd });
			const deepseek = { provider: "deepseek", id: "v4" } as Model;
			const other = { provider: "deepseek", id: "r2" } as Model;

			expect(() => setModelCompactionPoint(settings, deepseek, "90k")).toThrow("project config");
			expect(resolveModelCompactionSettings(settings, deepseek)).toMatchObject({ baseWindowTokens: 50000 });
			expect(setModelCompactionPoint(settings, other, "90k")).toMatchObject({ kind: "saved", entry: 90000 });
			expect(resolveModelCompactionSettings(settings, other)).toMatchObject({ baseWindowTokens: 90000 });
		});
	});

	it("writes a point past the standard window only once confirmed, and rejects one past the largest window", () => {
		const settings = Settings.isolated({ extendedContext: false });
		const model = {
			provider: "openai",
			id: "gpt-5.6-terra",
			contextWindow: 272_000,
			cost: { longContext: { inputThreshold: 272_000 } },
		} as Model;
		const tiers = { standard: 272_000, extended: 1_050_000 };

		const pending = setModelCompactionPoint(settings, model, "400k", { tiers });
		expect(pending).toEqual({ kind: "confirm", message: "Opens 1.05M window; >272K costs more" });
		expect(resolveModelCompactionSettings(settings, model).baseWindowTokens).toBeUndefined();
		// The pricing note follows the scaled trigger: a 300k base compacts at 255k, inside the standard tier.
		expect(setModelCompactionPoint(settings, model, "300k", { tiers })).toEqual({
			kind: "confirm",
			message: "Opens 1.05M window",
		});

		// The saved summary says where the model now compacts: 400k minus the 60k reserve, on the extended window.
		expect(setModelCompactionPoint(settings, model, "400k", { tiers, confirmed: true })).toEqual({
			kind: "saved",
			entry: 400_000,
			described: "400,000-token base",
			summary: "compacts at 340K · 85% of 400K base",
		});
		expect(resolveModelCompactionSettings(settings, model).baseWindowTokens).toBe(400_000);
		expect(setModelCompactionPoint(settings, model, "200k", { tiers })).toMatchObject({
			kind: "saved",
			entry: 200_000,
		});

		expect(() => setModelCompactionPoint(settings, model, "1100k", { tiers, confirmed: true })).toThrow(
			"Must not exceed the 1.05M max window",
		);
		expect(() => setModelCompactionPoint(settings, model, "300k")).toThrow("Must not exceed the 272K window");
		expect(resolveModelCompactionSettings(settings, model).baseWindowTokens).toBe(200_000);
	});

	it("needs room above a fixed trigger: the standard window opens the extended one and the max is rejected", () => {
		const settings = Settings.isolated({ extendedContext: false });
		const model = { provider: "openai", id: "gpt-5.6-terra", contextWindow: 272_000, cost: {} } as Model;
		const tiers = { standard: 272_000, extended: 1_050_000 };

		// A base equal to the standard window fits it; a fixed trigger there needs the extended one.
		expect(setModelCompactionPoint(settings, model, "272k", { tiers })).toMatchObject({
			kind: "saved",
			entry: 272_000,
		});
		expect(setModelCompactionPoint(settings, model, "f272k", { tiers })).toEqual({
			kind: "confirm",
			message: "Opens 1.05M window",
		});
		expect(setModelCompactionPoint(settings, model, "f272k", { tiers, confirmed: true })).toEqual({
			kind: "saved",
			entry: "f272000",
			described: "fixed at 272,000 tokens",
			summary: "compacts at exactly 272K",
		});
		expect(resolveModelCompactionSettings(settings, model)).toMatchObject({ thresholdTokens: 272_000 });
		expect(() => setModelCompactionPoint(settings, model, "f1050k", { tiers, confirmed: true })).toThrow(
			"Must be below the 1.05M max window",
		);
	});

	it("skips the warning when extended context is already on", () => {
		const settings = Settings.isolated({ extendedContext: true });
		const model = { provider: "openai", id: "gpt-5.6-terra", contextWindow: 1_050_000 } as Model;
		expect(
			setModelCompactionPoint(settings, model, "400k", { tiers: { standard: 272_000, extended: 1_050_000 } }),
		).toMatchObject({ kind: "saved", entry: 400_000 });
	});

	it("previews where each kind of typed limit compacts, and stays silent on input submit would reject", () => {
		const settings = Settings.isolated({ extendedContext: false });
		const model = { provider: "openai", id: "gpt-5.6-terra", contextWindow: 272_000 } as Model;
		const tiers = { standard: 272_000, extended: 1_050_000 };
		const preview = (input: string) => previewModelCompactionPoint(settings, model, input, tiers);

		expect(preview("400k")).toBe("compacts at 340K · 85% of 400K base");
		// A base inside the standard window keeps the model on it.
		expect(preview("200k")).toBe("compacts at 170K · 85% of 200K base");
		expect(preview("f400k")).toBe("compacts at exactly 400K");
		expect(preview("50%")).toBe("compacts at 136K · 50% of window");
		expect(preview("")).toBe("resets: compacts at 231.2K · 85% of window");
		for (const rejected of ["abc", "1100k", "f1050k"]) expect(preview(rejected)).toBeUndefined();
	});

	it("previews a reset as the prefix entry the model falls back to", () => {
		const settings = Settings.isolated({
			extendedContext: false,
			"compaction.modelThresholds": { "openai/*": "f100000", "openai/gpt-5.6-terra": 400_000 },
		});
		const model = { provider: "openai", id: "gpt-5.6-terra", contextWindow: 1_050_000 } as Model;
		const tiers = { standard: 272_000, extended: 1_050_000 };
		expect(previewModelCompactionPoint(settings, model, "", tiers)).toBe("resets: compacts at exactly 100K");
	});
});
