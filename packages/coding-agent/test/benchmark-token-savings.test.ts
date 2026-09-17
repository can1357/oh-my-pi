import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import {
	generate100LineModule,
	generate400LineModule,
	parseArgsAndRun,
	runOfflineBenchmark,
} from "../scripts/benchmark-token-savings";

describe("benchmark token savings", () => {
	it("generates fixtures satisfying >350 line read and 100 line generation", () => {
		const readModule = generate400LineModule();
		const readLines = readModule.split("\n").filter(Boolean).length;
		expect(readLines).toBe(400);
		expect(readLines).toBeGreaterThan(350);

		const genModule = generate100LineModule();
		const genLines = genModule.split("\n").filter(Boolean).length;
		expect(genLines).toBe(100);
	});

	it("executes offline benchmark with independent workspaces, parity, and source separation", async () => {
		const result = await runOfflineBenchmark();

		expect(result.mode).toBe("offline");
		expect(result.live).toBeNull();

		// Parity checks
		expect(result.parity.readTargetIdentical).toBe(true);
		expect(result.parity.generationLinesParity).toBe(true);
		expect(result.parity.sourceSeparation).toBe(true);
		expect(result.parity.receiptValid).toBe(true);

		// Workspaces & Lines
		expect(result.workspaces.direct.readTarget.lines).toBe(400);
		expect(result.workspaces.direct.generationTarget.lines).toBe(100);
		expect(result.workspaces.delegated.readTarget.lines).toBe(400);
		expect(result.workspaces.delegated.generationTarget.lines).toBe(100);

		// Receipt assertions
		expect(result.workspaces.delegated.generationTarget.receipt).toBeDefined();
		expect(result.workspaces.delegated.generationTarget.receipt?.changesApplied).toBe(true);
		expect(result.workspaces.delegated.generationTarget.receipt?.lines).toBe(100);
		expect(result.workspaces.delegated.generationTarget.receipt?.target).toBe("generated.ts");

		// Contract: Offline unmeasured token/cost savings null
		expect(result.metrics.tokenSavings).toBeNull();
		expect(result.metrics.costSavings).toBeNull();

		// Metric assertions: Significant context reduction (>80%)
		expect(result.metrics.frontierContextReductionBytes).toBeGreaterThan(0);
		expect(result.metrics.frontierContextReductionRatio).toBeGreaterThan(0.8);
		expect(result.metrics.delegatedFrontierContextBytes).toBeLessThan(result.metrics.directFrontierContextBytes);
	});

	it("parses CLI args and writes benchmark JSON to output path", async () => {
		const tempDir = TempDir.createSync("@bench-cli-test-");
		try {
			const outputPath = path.join(tempDir.path(), "benchmark-result.json");
			const result = await parseArgsAndRun(["--offline", "--output", outputPath]);

			expect(result.mode).toBe("offline");
			const file = Bun.file(outputPath);
			expect(await file.exists()).toBe(true);

			const parsed = JSON.parse(await file.text()) as typeof result;
			expect(parsed.mode).toBe("offline");
			expect(parsed.parity.sourceSeparation).toBe(true);
			expect(parsed.metrics.frontierContextReductionRatio).toBeGreaterThan(0.8);
		} finally {
			await tempDir.remove();
		}
	});

	it("rejects live benchmark without explicit credentials and authorization", async () => {
		await expect(parseArgsAndRun(["--live"])).rejects.toThrow(
			"Live benchmark requires explicit paid-run authorization",
		);
	});
});
