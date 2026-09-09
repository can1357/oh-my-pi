import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models";

describe("catalog provider descriptors", () => {
	test("descriptors cover standard model providers, excluding special-managed ones", () => {
		const zenmux = PROVIDER_DESCRIPTORS.find(descriptor => descriptor.providerId === "zenmux");
		expect(zenmux).toBeDefined();
		expect(zenmux?.defaultModel).toBe("anthropic/claude-opus-4.8");
		// The descriptor factory carries the provider identity through.
		expect(zenmux?.createModelManagerOptions({ apiKey: "k" }).providerId).toBe("zenmux");

		// openai-codex is special-managed (bespoke runtime factory) → excluded from descriptors,
		// but still a known model provider with a default.
		expect(PROVIDER_DESCRIPTORS.some(descriptor => descriptor.providerId === "openai-codex")).toBe(false);
		expect(DEFAULT_MODEL_PER_PROVIDER["openai-codex"]).toBe("gpt-5.5");
		expect(DEFAULT_MODEL_PER_PROVIDER.minimax).toBe("MiniMax-M3");
		expect(DEFAULT_MODEL_PER_PROVIDER["minimax-code"]).toBe("MiniMax-M3");
		expect(DEFAULT_MODEL_PER_PROVIDER["minimax-code-cn"]).toBe("MiniMax-M3");
		expect(DEFAULT_MODEL_PER_PROVIDER.xiaomi).toBe("mimo-v2.5");
		// Login-only tools have no default model.
		expect(DEFAULT_MODEL_PER_PROVIDER).not.toHaveProperty("kagi");
	});

	test("anthropic descriptor opts into first-party catalog discovery", () => {
		const anthropic = PROVIDER_DESCRIPTORS.find(descriptor => descriptor.providerId === "anthropic");
		expect(anthropic).toBeDefined();
		expect(anthropic?.catalogDiscovery).toEqual({
			label: "Anthropic",
			envVars: ["ANTHROPIC_API_KEY"],
		});

		const options = anthropic?.createModelManagerOptions({ apiKey: "k" });
		expect(options?.providerId).toBe("anthropic");
		expect(typeof options?.fetchDynamicModels).toBe("function");
	});

	test("every descriptor has a default model and a factory that preserves provider identity", () => {
		for (const descriptor of PROVIDER_DESCRIPTORS) {
			expect(descriptor.defaultModel).toBeTruthy();
			expect(typeof descriptor.createModelManagerOptions).toBe("function");
			expect(descriptor.createModelManagerOptions({ apiKey: "k" }).providerId).toBe(descriptor.providerId);
		}
	});
});
