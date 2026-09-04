import { describe, expect, it } from "bun:test";
import type { Api } from "@oh-my-pi/pi-ai/types";
import {
	coerceServiceTierByFamily,
	getPriorityPremiumRequests,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
	shouldSendServiceTier,
} from "@oh-my-pi/pi-ai/types";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";

const m = (provider: string, api: Api, id: string) => ({
	provider,
	api,
	id,
	identity: classifyModel(provider, id),
});

const openai = m("openai", "openai-responses", "gpt-5");
const codex = m("openai-codex", "openai-codex-responses", "gpt-5.5");
const anthropic = m("anthropic", "anthropic-messages", "claude-opus-4-6");
const vertexClaude = m("google-vertex", "anthropic-messages", "claude-opus-4-6");
const gemini = m("google", "google-generative-ai", "gemini-3-flash");
const vertexGemini = m("google-vertex", "google-vertex", "gemini-3-flash");
const fireworks = m("fireworks", "openai-completions", "qwen3");
const fireworksOpenAI = m("fireworks", "openai-completions", "gpt-oss-120b");
const orOpenAI = m("openrouter", "openai-responses", "openai/gpt-5.5");
const orGoogle = m("openrouter", "openai-completions", "google/gemini-3-flash");
const orAnthropic = m("openrouter", "openai-completions", "anthropic/claude-opus-4-6");
const customOpenAI = m("custom-relay", "openai-completions", "gpt-5.5");
const customCodex = m("custom-relay", "openai-codex-responses", "gpt-5.5");
const customOpenAIAliases = [
	m("custom-relay", "openai-responses", "gpt-4o"),
	m("custom-relay", "openai-responses", "o3"),
	m("custom-relay", "openai-responses", "o4-mini"),
	m("custom-relay", "openai-responses", "codex-mini-latest"),
];

describe("serviceTierFamily", () => {
	it("classifies first-party providers by provider/api", () => {
		expect(serviceTierFamily(openai)).toBe("openai");
		expect(serviceTierFamily(codex)).toBe("openai");
		expect(serviceTierFamily(anthropic)).toBe("anthropic");
		expect(serviceTierFamily(vertexClaude)).toBe("anthropic"); // Claude on Vertex is the anthropic family
		expect(serviceTierFamily(gemini)).toBe("google");
		expect(serviceTierFamily(vertexGemini)).toBe("google");
		expect(serviceTierFamily(fireworks)).toBeUndefined();
		expect(serviceTierFamily(fireworksOpenAI)).toBeUndefined();
	});

	it("classifies OpenAI-compatible custom providers by api", () => {
		expect(serviceTierFamily(customOpenAI)).toBe("openai");
		expect(serviceTierFamily(customCodex)).toBe("openai");
		for (const model of customOpenAIAliases) {
			expect(serviceTierFamily(model)).toBe("openai");
		}
	});

	it("classifies OpenRouter models by id namespace", () => {
		expect(serviceTierFamily(orOpenAI)).toBe("openai");
		expect(serviceTierFamily(orGoogle)).toBe("google");
		expect(serviceTierFamily(orAnthropic)).toBe("anthropic");
		expect(serviceTierFamily(m("openrouter", "openai-completions", "z-ai/glm-4.7"))).toBeUndefined();
	});
});

describe("resolveModelServiceTier", () => {
	it("reduces a per-family map to the model's family entry", () => {
		const tiers = { openai: "priority", anthropic: "priority", google: "flex" } as const;
		expect(resolveModelServiceTier(tiers, openai)).toBe("priority");
		expect(resolveModelServiceTier(tiers, gemini)).toBe("flex");
		expect(resolveModelServiceTier(tiers, orAnthropic)).toBe("priority");
		expect(resolveModelServiceTier(tiers, customCodex)).toBe("priority");
		expect(resolveModelServiceTier(tiers, fireworks)).toBeUndefined(); // no family
		expect(resolveModelServiceTier(tiers, fireworksOpenAI)).toBeUndefined(); // dedicated provider tier
		expect(resolveModelServiceTier(undefined, openai)).toBeUndefined();
		expect(resolveModelServiceTier({ google: "priority" }, openai)).toBeUndefined();
	});
});

describe("shouldSendServiceTier", () => {
	it("sends every explicit tier on the OpenAI family, omits auto, supported tiers elsewhere", () => {
		for (const p of ["openai", "openai-codex"] as const) {
			expect(shouldSendServiceTier("flex", p)).toBe(true);
			expect(shouldSendServiceTier("scale", p)).toBe(true);
			expect(shouldSendServiceTier("priority", p)).toBe(true);
			expect(shouldSendServiceTier("default", p)).toBe(true);
			// `auto` is OpenAI's implicit default and the Codex endpoint rejects it — never sent.
			expect(shouldSendServiceTier("auto", p)).toBe(false);
		}
		expect(shouldSendServiceTier("auto", codex)).toBe(false);
		expect(shouldSendServiceTier("auto", customOpenAI)).toBe(false);
		expect(shouldSendServiceTier("flex", "openrouter")).toBe(true);
		expect(shouldSendServiceTier("default", "openrouter")).toBe(false);
		expect(shouldSendServiceTier("priority", customCodex)).toBe(true);
		expect(shouldSendServiceTier("scale", customOpenAI)).toBe(true);
		expect(shouldSendServiceTier("default", customOpenAI)).toBe(true);
		for (const model of customOpenAIAliases) {
			expect(shouldSendServiceTier("priority", model)).toBe(true);
		}
	});

	it("sends flex/priority on direct Google, priority-only on Vertex (no scale)", () => {
		expect(shouldSendServiceTier("flex", "google")).toBe(true);
		expect(shouldSendServiceTier("priority", "google")).toBe(true);
		expect(shouldSendServiceTier("scale", "google")).toBe(false);
		expect(shouldSendServiceTier("priority", "google-vertex")).toBe(true);
		expect(shouldSendServiceTier("flex", "google-vertex")).toBe(false); // Vertex flex has no wire control
	});

	it("sends only priority on Fireworks, nothing on Anthropic", () => {
		expect(shouldSendServiceTier("priority", "fireworks")).toBe(true);
		expect(shouldSendServiceTier("flex", "fireworks")).toBe(false);
		expect(shouldSendServiceTier("priority", "anthropic")).toBe(false);
	});

	it("returns false for unset tiers", () => {
		expect(shouldSendServiceTier(undefined, "openai")).toBe(false);
		expect(shouldSendServiceTier(null, "openai")).toBe(false);
	});
});

describe("realizesPriorityServiceTier", () => {
	it("realizes priority where the wire actually applies it", () => {
		expect(realizesPriorityServiceTier("priority", openai)).toBe(true);
		expect(realizesPriorityServiceTier("priority", anthropic)).toBe(true); // direct fast mode
		expect(realizesPriorityServiceTier("priority", gemini)).toBe(true);
		expect(realizesPriorityServiceTier("priority", vertexGemini)).toBe(true);
		expect(realizesPriorityServiceTier("priority", fireworks)).toBe(true);
		expect(realizesPriorityServiceTier("priority", orOpenAI)).toBe(true);
		expect(realizesPriorityServiceTier("priority", orGoogle)).toBe(true);
		expect(realizesPriorityServiceTier("priority", customCodex)).toBe(true);
		for (const model of customOpenAIAliases) {
			expect(realizesPriorityServiceTier("priority", model)).toBe(true);
		}
	});

	it("does not realize priority where the wire drops it", () => {
		expect(realizesPriorityServiceTier("priority", vertexClaude)).toBe(false); // no fast mode on Vertex
		expect(realizesPriorityServiceTier("priority", orAnthropic)).toBe(false); // OpenRouter Anthropic
		expect(realizesPriorityServiceTier("flex", openai)).toBe(false);
		expect(realizesPriorityServiceTier(undefined, openai)).toBe(false);
	});
});

describe("getPriorityPremiumRequests", () => {
	it("counts one premium request per realized priority on billing providers", () => {
		expect(getPriorityPremiumRequests("priority", openai)).toBe(1);
		expect(getPriorityPremiumRequests("priority", codex)).toBe(1);
		expect(getPriorityPremiumRequests("priority", anthropic)).toBe(1);
		expect(getPriorityPremiumRequests("priority", gemini)).toBe(1);
		expect(getPriorityPremiumRequests("priority", vertexGemini)).toBe(1);
	});

	it("does not bill OpenRouter, unrealized, or non-priority traffic", () => {
		expect(getPriorityPremiumRequests("priority", orOpenAI)).toBe(0); // OpenRouter bills its own way
		expect(getPriorityPremiumRequests("priority", vertexClaude)).toBe(0); // not realized
		expect(getPriorityPremiumRequests("priority", fireworks)).toBe(0); // realized but not Copilot-premium
		expect(getPriorityPremiumRequests("priority", fireworksOpenAI)).toBe(0); // dedicated provider tier
		expect(getPriorityPremiumRequests("flex", openai)).toBe(0);
		expect(getPriorityPremiumRequests(undefined, openai)).toBe(0);
	});
});

describe("coerceServiceTierByFamily", () => {
	it("migrates legacy scalar values to a per-family map", () => {
		expect(coerceServiceTierByFamily("priority")).toEqual({
			openai: "priority",
			anthropic: "priority",
			google: "priority",
		});
		expect(coerceServiceTierByFamily("openai-only")).toEqual({ openai: "priority" });
		expect(coerceServiceTierByFamily("claude-only")).toEqual({ anthropic: "priority" });
		expect(coerceServiceTierByFamily("flex")).toEqual({ openai: "flex" });
		expect(coerceServiceTierByFamily("none")).toBeUndefined();
		expect(coerceServiceTierByFamily(null)).toBeUndefined();
	});

	it("passes a per-family map through, dropping invalid entries", () => {
		expect(coerceServiceTierByFamily({ openai: "priority", google: "flex" })).toEqual({
			openai: "priority",
			google: "flex",
		});
		expect(coerceServiceTierByFamily({ openai: "bogus" })).toBeUndefined();
	});
});
