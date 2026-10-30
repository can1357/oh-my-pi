import { describe, expect, it } from "bun:test";
import { encodeModelCatalog, getCatalogProvider, openModelCatalog } from "../src/model-catalog-format";
import { getBundledModel } from "../src/models";
import type { Api, Model } from "../src/types";

describe("compact model catalog", () => {
	it("preserves absent and false flags across mask words and compat deltas", () => {
		const original = getBundledModel("openrouter", "~anthropic/claude-fable-latest");
		const first = structuredClone(original);
		const second = structuredClone(original);
		second.id = "alternate";
		const flags: Record<string, boolean> = {};
		for (let i = 0; i < 70; i++) flags[`flag${i.toString().padStart(2, "0")}`] = i % 3 === 0;
		Reflect.set(first, "codecProbe", {
			flags,
			nested: [{ enabled: false }, { enabled: true }, { enabled: undefined }],
		});
		Reflect.set(second, "codecProbe", { flags: { ...flags, flag32: true, flag69: false } });
		if (!first.compat || !second.compat) throw new Error("Expected compat on fixture");
		Reflect.set(first.compat, "codecProbe", false);
		Reflect.deleteProperty(second.compat, "codecProbe");
		const input: Record<string, Record<string, Model<Api>>> = {
			openrouter: { [first.id]: first, [second.id]: second },
		};
		const catalog = openModelCatalog(JSON.parse(encodeModelCatalog(input)));
		expect(getCatalogProvider(catalog, "openrouter")).toEqual(JSON.parse(JSON.stringify(input.openrouter)));
		expect(getCatalogProvider(catalog, "missing")).toBeUndefined();
	});
});
