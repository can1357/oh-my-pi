import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "../src/build";
import { Effort } from "../src/effort";
import { resolveProviderModels } from "../src/model-manager";
import type { Model, ModelSpec } from "../src/types";

const tempDirs: string[] = [];
afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

/**
 * Isolated cache DB for resolution tests: the shared agent cache may hold
 * runtime discovery rows written by a real CLI session, and those must not
 * leak into the bundled-catalog assertions.
 */
function isolatedCachePath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friendli-seed-"));
	tempDirs.push(dir);
	return path.join(dir, "models.db");
}

/**
 * Friendli's bundled catalog maps its models.dev provider slice at generation
 * time (six tool-capable serverless models) with a curated static seed as the
 * offline fallback for the default model. The provider must resolve end-to-end
 * from the bundle alone: the picker lists the models and chat requests carry
 * the correct reasoning-effort dialect.
 * Regression guards: a stale/empty `"friendli": {}` slice once left the
 * descriptor's `defaultModel` unresolvable at boot (#9410), and a hand-written
 * `thinking` block on the seed would fight the identity-derived ladder.
 */
function spec(): ModelSpec<"openai-completions"> {
	return {
		id: "zai-org/GLM-5.3",
		name: "GLM-5.3",
		api: "openai-completions",
		provider: "friendli",
		baseUrl: "https://api.friendli.ai/serverless/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 1_048_576,
	};
}

describe("Friendli provider bundle", () => {
	it("resolves the bundled provider catalog with the default model present", async () => {
		const result = await resolveProviderModels(
			{ providerId: "friendli", cacheDbPath: isolatedCachePath() },
			"offline",
		);
		expect(result.source).toBe("bundled");
		expect(result.models.map(model => model.id)).toContain("zai-org/GLM-5.3");
	});

	it("derives the wire reasoning surface from identity, not a seed thinking block", () => {
		const model = buildModel(spec()) as Model<"openai-completions">;
		// GLM-5.3+ exposes a uniform low/high/max ladder with thinking always on;
		// the effort tiers must reach the wire as distinct `reasoning_effort` values.
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.thinking?.defaultLevel).toBe(Effort.Max);
		expect(model.compat.supportsReasoningEffort).toBe(true);
		expect(model.compat.thinkingFormat).toBe("openai");
	});
});
