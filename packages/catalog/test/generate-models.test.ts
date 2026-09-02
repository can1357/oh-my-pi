import { describe, expect, it } from "bun:test";
import { shouldFetchCatalogProvider } from "../scripts/generate-models";

describe("catalog generation provider selection", () => {
	it("fetches credential-scoped catalogs only for explicit provider generation", () => {
		expect(shouldFetchCatalogProvider("merge-gateway")).toBe(false);
		expect(shouldFetchCatalogProvider("merge-gateway", "merge-gateway")).toBe(true);
		expect(shouldFetchCatalogProvider("ollama", "ollama")).toBe(false);
	});
});
