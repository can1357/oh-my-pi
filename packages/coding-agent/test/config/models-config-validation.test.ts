import { describe, expect, test } from "bun:test";
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
