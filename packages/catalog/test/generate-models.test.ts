import { describe, expect, it } from "bun:test";
import { shouldFetchModelsDevSource, shouldFetchProviderSource } from "../scripts/generate-models";

describe("catalog generation provider selection", () => {
	it("fetches only the explicit provider during scoped generation", () => {
		expect(shouldFetchProviderSource("openai")).toBe(true);
		expect(shouldFetchProviderSource("merge-gateway")).toBe(false);
		expect(shouldFetchProviderSource("merge-gateway", "merge-gateway")).toBe(true);
		expect(shouldFetchProviderSource("openai", "merge-gateway")).toBe(false);
		expect(shouldFetchProviderSource("ollama", "ollama")).toBe(false);
		expect(shouldFetchModelsDevSource()).toBe(true);
		expect(shouldFetchModelsDevSource("openai")).toBe(true);
		expect(shouldFetchModelsDevSource("merge-gateway")).toBe(false);
	});
});
