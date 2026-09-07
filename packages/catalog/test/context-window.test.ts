import { expect, test } from "bun:test";
import { resolveMaxContextWindow } from "@oh-my-pi/pi-catalog/compat/context-window";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

function bundledAstra() {
	const astra = getBundledModels("openai-codex").find(model => model.id === "gpt-6-astra");
	if (!astra) throw new Error("Expected bundled Astra model");
	return astra;
}

function bundledLegacy() {
	const legacy = getBundledModels("openai-codex").find(model => model.id === "gpt-5.5");
	if (!legacy) throw new Error("Expected bundled legacy Codex model");
	return legacy;
}

test("corrects a stale live maximum up to the curated window", () => {
	const astra = bundledAstra();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 872_000 })).toBe(1_050_000);
});

test("keeps a higher live maximum above the curated window", () => {
	const astra = bundledAstra();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 1_200_000 })).toBe(1_200_000);
});

test("falls back to the curated window when the live maximum is missing or invalid", () => {
	const astra = bundledAstra();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: undefined })).toBe(1_050_000);
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 0 })).toBe(1_050_000);
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: Number.NaN })).toBe(1_050_000);
});

test("leaves models without a curated maximum to the live value or undefined", () => {
	const legacy = bundledLegacy();
	// No `max-context-window` rule owns this SKU, so extended-context widening
	// sees exactly what discovery reported — nothing curated is injected.
	expect(resolveMaxContextWindow({ ...legacy, maxContextWindow: 640_000 })).toBe(640_000);
	expect(resolveMaxContextWindow({ ...legacy, maxContextWindow: undefined })).toBeUndefined();
	expect(resolveMaxContextWindow({ ...legacy, maxContextWindow: 0 })).toBeUndefined();
	expect(resolveMaxContextWindow({ ...legacy, maxContextWindow: Number.NaN })).toBeUndefined();
});
