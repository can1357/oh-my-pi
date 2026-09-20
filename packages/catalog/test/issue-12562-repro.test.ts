// Contract (#12562): a custom (non-builtin) api id must still resolve a
// complete openai-completions wire-compat record. Custom streamSimple
// registration reserves builtin api ids, so extensions that wrap
// streamOpenAICompletions used to get `compat: undefined` and crash on
// `disableReasoningOnForcedToolChoice`. Sparse spec.compat overlays must
// apply; known APIs with no dialect (ollama-chat, cursor-agent,
// gitlab-duo-agent) stay undefined.
import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function customApiSpec(overrides: Partial<ModelSpec> = {}): ModelSpec {
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
		maxTokens: 8192,
		...overrides,
	};
}

describe("custom-api compat (#12562)", () => {
	it("resolves openai-completions dialect compat for a custom api id", () => {
		const custom = resolveModelPolicy(customApiSpec());
		const builtin = resolveModelPolicy(customApiSpec({ api: "openai-completions" }));

		expect(custom.compat).toBeDefined();
		expect(custom.compat).toEqual(builtin.compat);
		expect(custom.compat).toMatchObject({
			disableReasoningOnForcedToolChoice: expect.any(Boolean),
			supportsForcedToolChoice: expect.any(Boolean),
			supportsDeveloperRole: expect.any(Boolean),
		});
	});

	it("applies declared spec.compat overlays on the custom-api dialect record", () => {
		const policy = resolveModelPolicy(
			customApiSpec({
				compat: { supportsDeveloperRole: true },
			}),
		);
		const baseline = resolveModelPolicy(customApiSpec());

		expect(baseline.compat).toMatchObject({ supportsDeveloperRole: false });
		expect(policy.compat).toMatchObject({ supportsDeveloperRole: true });
	});

	it("buildModel materializes wire compat and keeps the sparse overlay on compatConfig", () => {
		const overlay = { supportsDeveloperRole: true } as const;
		const model = buildModel(customApiSpec({ compat: overlay }));

		expect(model.api).toBe("my-completions");
		expect(model.compat).toBeDefined();
		expect(model.compat).toMatchObject({
			supportsDeveloperRole: true,
			disableReasoningOnForcedToolChoice: expect.any(Boolean),
		});
		expect(model.compatConfig).toEqual(overlay);
	});

	it("leaves known APIs without a wire-compat dialect undefined", () => {
		for (const api of ["ollama-chat", "cursor-agent", "gitlab-duo-agent"] as const satisfies readonly Api[]) {
			expect(resolveModelPolicy(customApiSpec({ api })).compat).toBeUndefined();
		}
	});
});
