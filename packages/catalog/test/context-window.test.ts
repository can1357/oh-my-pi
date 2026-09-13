import { expect, test } from "bun:test";
import {
	clampCodexContextWindow,
	clampsContextOverride,
	codexOverrideCeiling,
	resolveMaxContextWindow,
} from "@oh-my-pi/pi-catalog/compat/context-window";
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
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 872_000 })).toBe(922_000);
});

test("keeps a higher live maximum above the curated window", () => {
	const astra = bundledAstra();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 1_200_000 })).toBe(1_200_000);
});

test("falls back to the curated window when the live maximum is missing or invalid", () => {
	const astra = bundledAstra();
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: undefined })).toBe(922_000);
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: 0 })).toBe(922_000);
	expect(resolveMaxContextWindow({ ...astra, maxContextWindow: Number.NaN })).toBe(922_000);
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

test("clamps Codex overrides to the stale-aware ceiling", () => {
	const astra = bundledAstra();
	// Stale 872K server maximum: the curated 922K input cap is the ceiling.
	expect(codexOverrideCeiling({ ...astra, maxContextWindow: 872_000 })).toBe(922_000);
	expect(clampCodexContextWindow({ ...astra, maxContextWindow: 872_000 }, 2_000_000)).toBe(922_000);
	// Fitting requests pass through untouched.
	expect(clampCodexContextWindow({ ...astra, maxContextWindow: 872_000 }, 400_000)).toBe(400_000);
	// A higher live maximum still wins as the ceiling.
	expect(clampCodexContextWindow({ ...astra, maxContextWindow: 1_200_000 }, 2_000_000)).toBe(1_200_000);
});

test("never clamps below the working window on a stale-low maximum", () => {
	const legacy = bundledLegacy();
	// 128K base with a 64K advertised maximum: the ceiling is discredited,
	// so an explicit override falls back to the working window.
	const stale = { ...legacy, contextWindow: 128_000, maxContextWindow: 64_000 };
	expect(codexOverrideCeiling(stale)).toBe(64_000);
	expect(clampCodexContextWindow(stale, 200_000)).toBe(128_000);
	expect(clampCodexContextWindow(stale, 100_000)).toBe(100_000);
});

test("leaves models without a ceiling unclamped", () => {
	const legacy = bundledLegacy();
	expect(codexOverrideCeiling({ ...legacy, maxContextWindow: undefined })).toBeUndefined();
	expect(clampCodexContextWindow({ ...legacy, maxContextWindow: undefined }, 2_000_000)).toBe(2_000_000);
});

test("reads the override-clamp contract from KDL policy, not provider ids", () => {
	const astra = bundledAstra();
	const legacy = bundledLegacy();
	// Provider-wide Codex semantics: every Codex SKU clamps, on any route.
	expect(clampsContextOverride(astra)).toBe(true);
	expect(clampsContextOverride({ ...legacy, maxContextWindow: 640_000 })).toBe(true);
	expect(clampsContextOverride({ ...legacy, id: "gpt-5.5-wm" })).toBe(true);
	// Other providers never clamp, even with a live maximum present.
	expect(clampsContextOverride({ ...legacy, provider: "openai" })).toBe(false);
	expect(clampsContextOverride({ ...legacy, provider: "openrouter", maxContextWindow: 640_000 })).toBe(false);
});
