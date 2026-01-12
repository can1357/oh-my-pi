import { afterEach, describe, expect, test } from "bun:test";
import { clearModelCache, resolveModelPattern } from "../src/core/tools/task/model-resolver";

describe("task/model-resolver: resolveModelPattern", () => {
	afterEach(() => {
		clearModelCache();
	});

	describe("provider-specific matching", () => {
		const models = ["cerebras/zai-glm-4.7", "zai/glm-4.7", "anthropic/claude-sonnet"];

		test("exact full match with provider prefix", async () => {
			const result = await resolveModelPattern("zai/glm-4.7", models);
			expect(result).toBe("zai/glm-4.7");
		});

		test("explicit provider should not cross provider boundaries", async () => {
			const modelsWithoutZai = ["cerebras/zai-glm-4.7", "zai/glm-4.6"];
			const result = await resolveModelPattern("zai/glm-4.7", modelsWithoutZai);
			expect(result).toBeUndefined();
		});

		test("fuzzy match within explicit provider", async () => {
			const modelsWithSuffix = ["cerebras/zai-glm-4.7-preview", "zai/glm-4.7-beta"];
			const result = await resolveModelPattern("zai/glm-4.7", modelsWithSuffix);
			expect(result).toBe("zai/glm-4.7-beta");
		});

		test("exact ID match without provider", async () => {
			const result = await resolveModelPattern("glm-4.7", models);
			expect(result).toBe("zai/glm-4.7");
		});

		test("fuzzy match without provider uses general fallback", async () => {
			const modelsNoExact = ["cerebras/zai-glm-4.7", "anthropic/claude-sonnet"];
			const result = await resolveModelPattern("glm", modelsNoExact);
			expect(result).toBe("cerebras/zai-glm-4.7");
		});
	});

	describe("comma-separated patterns (fallback chain)", () => {
		test("first pattern fails, second succeeds", async () => {
			const models = ["cerebras/zai-glm-4.7", "anthropic/claude-sonnet"];
			const result = await resolveModelPattern("zai/glm-4.6, glm", models);
			expect(result).toBe("cerebras/zai-glm-4.7");
		});

		test("first pattern succeeds, second ignored", async () => {
			const models = ["zai/glm-4.7", "cerebras/zai-glm-4.7"];
			const result = await resolveModelPattern("zai/glm-4.7, cerebras/zai-glm-4.7", models);
			expect(result).toBe("zai/glm-4.7");
		});
	});

	describe("edge cases", () => {
		test("default returns undefined", async () => {
			const result = await resolveModelPattern("default", ["zai/glm-4.7"]);
			expect(result).toBeUndefined();
		});

		test("undefined returns undefined", async () => {
			const result = await resolveModelPattern(undefined, ["zai/glm-4.7"]);
			expect(result).toBeUndefined();
		});

		test("empty models list returns pattern as-is", async () => {
			const result = await resolveModelPattern("zai/glm-4.7", []);
			expect(result).toBe("zai/glm-4.7");
		});
	});
});
