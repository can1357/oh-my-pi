import { describe, expect, it } from "bun:test";
import { shouldFetchCatalogProvider } from "../scripts/generate-models";

describe("catalog generation provider selection", () => {
	it("fetches only the explicit provider during scoped generation", () => {
		expect(shouldFetchCatalogProvider("openai")).toBe(true);
		expect(shouldFetchCatalogProvider("merge-gateway")).toBe(false);
		expect(shouldFetchCatalogProvider("merge-gateway", "merge-gateway")).toBe(true);
		expect(shouldFetchCatalogProvider("openai", "merge-gateway")).toBe(false);
		expect(shouldFetchCatalogProvider("ollama", "ollama")).toBe(false);
	});
});
