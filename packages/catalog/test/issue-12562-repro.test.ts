import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * #12562: a Pi extension that registers a provider with a custom (non-builtin)
 * `api` id and reuses the built-in OpenAI-completions streamer received models
 * whose `compat` was `undefined`, crashing the streamer at the first
 * `model.compat.*` dereference. `resolveModelPolicy` now resolves the
 * OpenAI-completions dialect for custom api ids so the record is populated and
 * declared `compat` overrides apply.
 */
function customSpec(overrides: Partial<ModelSpec<Api>> = {}): ModelSpec<Api> {
	return {
		id: "hy4-preview",
		name: "HY4 Preview",
		provider: "my-provider",
		baseUrl: "https://example.com/v2",
		api: "my-completions",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 8_192,
		...overrides,
	} as ModelSpec<Api>;
}

describe("custom-api compat resolution (#12562)", () => {
	it("resolves a complete OpenAI-completions compat record for a custom api id", () => {
		const compat = resolveModelPolicy(customSpec()).compat;
		expect(compat).toBeDefined();
		// Fields the OpenAI-completions streamer dereferences unguarded — these
		// were the crash sites when the record was undefined.
		expect(typeof compat?.disableReasoningOnForcedToolChoice).toBe("boolean");
		expect(typeof compat?.supportsForcedToolChoice).toBe("boolean");
		expect(compat?.wireModelIdMode).toBe("raw");
	});

	it("applies declared spec `compat` overrides for a custom api id", () => {
		const spec = customSpec({ compat: { supportsDeveloperRole: false } } as Partial<ModelSpec<Api>>);
		const model = buildModel(spec);
		expect(model.compat?.supportsDeveloperRole).toBe(false);
		// The verbatim sparse config is still preserved for introspection.
		expect(model.compatConfig).toEqual({ supportsDeveloperRole: false });
	});

	it.each(["ollama-chat", "cursor-agent", "gitlab-duo-agent"] as const)(
		"leaves built-in no-wire-compat transport %s undefined",
		api => {
			expect(resolveModelPolicy(customSpec({ api })).compat).toBeUndefined();
		},
	);
});
