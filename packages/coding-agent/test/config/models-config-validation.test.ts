import { describe, expect, test } from "bun:test";
import { OmpErrors } from "@oh-my-pi/omptype";
import { getModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema-bundle";
import { validateProviderConfiguration } from "@oh-my-pi/pi-coding-agent/config/models-config";

const models = [{ id: "grok-4", api: "openai-completions" as const }];
const baseUrl = "https://api.example.invalid/v1";

describe("validateProviderConfiguration (models-config auth)", () => {
	test("auth: oauth allows custom models without apiKey", () => {
		expect(() =>
			validateProviderConfiguration("xai-oauth", { baseUrl, auth: "oauth", models }, "models-config"),
		).not.toThrow();
	});

	test("auth: none allows custom models without apiKey", () => {
		expect(() =>
			validateProviderConfiguration("local", { baseUrl, auth: "none", models }, "models-config"),
		).not.toThrow();
	});

	test("default auth (apiKey) still requires apiKey for custom models", () => {
		expect(() => validateProviderConfiguration("custom", { baseUrl, models }, "models-config")).toThrow(
			'Provider custom: "apiKey" is required when defining custom models unless auth is "none" or "oauth".',
		);
	});

	test("explicit auth: apiKey with apiKey set passes", () => {
		expect(() =>
			validateProviderConfiguration(
				"custom",
				{ baseUrl, auth: "apiKey", apiKey: "sk-test", models },
				"models-config",
			),
		).not.toThrow();
	});
});

describe("models.yml compat.stripImageInput (#11697)", () => {
	const schema = getModelsConfigSchema();
	const configWithModelCompat = (compat: unknown) => ({
		providers: {
			p: {
				baseUrl: "http://x/v1",
				apiKey: "K",
				api: "openai-completions" as const,
				models: [{ id: "m", input: ["text", "image"] as ("text" | "image")[], compat }],
			},
		},
	});

	test("accepts a boolean opt-out and preserves it", () => {
		const parsed = schema(configWithModelCompat({ stripImageInput: false }));
		expect(parsed instanceof OmpErrors).toBe(false);
		if (!(parsed instanceof OmpErrors)) {
			expect(parsed.providers?.p?.models?.[0]?.compat).toMatchObject({ stripImageInput: false });
		}
	});

	test("rejects a wrong-typed opt-out instead of silently ignoring it", () => {
		const parsed = schema(configWithModelCompat({ stripImageInput: "no" }));
		expect(parsed instanceof OmpErrors).toBe(true);
		if (parsed instanceof OmpErrors) {
			expect(parsed.summary).toContain("stripImageInput");
		}
	});
});
