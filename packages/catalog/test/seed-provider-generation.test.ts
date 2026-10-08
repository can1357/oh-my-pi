import { describe, expect, it } from "bun:test";
import { regenerateSeedProvider } from "../scripts/generate-models";
import { modelKind } from "../src/types";

describe("seed provider generation", () => {
	it("builds selectable search models from KDL while preserving other provider snapshots", () => {
		const initial = regenerateSeedProvider("web", {});
		const previous = { ...initial, unrelated: initial.web! };
		const generated = regenerateSeedProvider("web", previous);
		const anysearch = generated.web?.anysearch;
		if (!anysearch) throw new Error("AnySearch seed was not generated");
		expect(modelKind(anysearch)).toBe("search");
		expect(anysearch.api).toBe("web-search");
		expect(anysearch.provider).toBe("web");
		expect(generated.unrelated).toEqual(previous.unrelated);
		// Repeating a scoped generation must not remove previous providers.
		expect(regenerateSeedProvider("web", generated)).toEqual(generated);
	});

	it("rejects a provider without an authored seed instead of replacing its snapshot", () => {
		expect(() => regenerateSeedProvider("not-a-provider", {})).toThrow("always-bundled seed");
	});
});
