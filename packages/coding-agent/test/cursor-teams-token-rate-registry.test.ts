import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai/types";
import { calculateCost, calculateUsageCost } from "@oh-my-pi/pi-catalog/models";
import type { ModelCost } from "@oh-my-pi/pi-catalog/types";
import { renderProviderModels } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const sampleUsage = (input: number): Usage => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("Cursor Teams token rate (models.yml → registry)", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `pi-test-cursor-token-rate-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("stamps teamsTokenRatePerMillion from providers.cursor and clears it on reload", () => {
		fs.writeFileSync(
			modelsPath,
			`providers:
  cursor:
    teamsTokenRatePerMillion: 0.25
`,
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("cursor", "gemini-3.8-flash");
		expect(model).toBeDefined();
		expect(model!.teamsTokenRatePerMillion).toBe(0.25);
		const usage = sampleUsage(1_000_000);
		calculateCost(model!, usage);
		expect(usage.cost.input).toBeCloseTo(1.0, 8);

		fs.writeFileSync(modelsPath, "providers: {}\n");
		const reloaded = new ModelRegistry(authStorage, modelsPath);
		const cleared = reloaded.find("cursor", "gemini-3.8-flash");
		expect(cleared).toBeDefined();
		expect(cleared!.teamsTokenRatePerMillion).toBeUndefined();
		const clearedUsage = sampleUsage(1_000_000);
		calculateCost(cleared!, clearedUsage);
		expect(clearedUsage.cost.input).toBeCloseTo(0.75, 8);
	});

	test("lets `omp models --json` reprice usage exactly as billing charges it", () => {
		// A long-context prompt with one-hour cache writes: the tier and the 2x write
		// multiplier must apply to the list card, with the token rate added flat.
		fs.writeFileSync(modelsPath, "providers:\n  cursor:\n    teamsTokenRatePerMillion: 0.25\n");
		const model = new ModelRegistry(authStorage, modelsPath).find("cursor", "gpt-5.6-luna")!;
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += String(chunk);
			return true;
		});
		try {
			renderProviderModels({ getAvailable: () => [model], getError: () => undefined }, "ls", undefined, true);
		} finally {
			vi.restoreAllMocks();
		}
		const published: { cost: ModelCost; teamsTokenRatePerMillion?: number } = JSON.parse(stdout).models[0];
		const threshold = published.cost.longContext?.inputThreshold;
		if (threshold === undefined) throw new Error("gpt-5.6-luna lost its long-context tier");
		const usage = (): Usage => ({
			...sampleUsage(threshold + 28_000),
			cacheWrite: 10_000,
			cttl: { ephemeral5m: 0, ephemeral1h: 10_000 },
		});
		const billed = calculateCost(model, usage());
		const repriced = calculateUsageCost(published.cost, usage(), undefined, published.teamsTokenRatePerMillion);
		expect(published.teamsTokenRatePerMillion).toBe(0.25);
		expect(repriced.total).toBeCloseTo(billed.total, 10);
		expect(repriced.cacheWrite).toBeCloseTo(billed.cacheWrite, 10);
	});
});
