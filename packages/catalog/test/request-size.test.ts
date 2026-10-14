import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveImageCountBudget, resolveInlineImageByteBudget } from "@oh-my-pi/pi-catalog/compat/request-size";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { CODEX_BASE_URL } from "@oh-my-pi/pi-catalog/wire/codex";

/** The configured endpoint's classification; request-time env reroutes are pi-ai's to apply. */
function configuredOfficial(model: Model): boolean {
	return !!model.compat && "officialEndpoint" in model.compat && model.compat.officialEndpoint === true;
}

function imageCountBudget(model: Model): number | undefined {
	return resolveImageCountBudget(model, configuredOfficial(model));
}

function inlineImageByteBudget(model: Model): number | undefined {
	return resolveInlineImageByteBudget(model, configuredOfficial(model));
}

/**
 * An image model built from a spec, so each budget comes from the KDL rules rather than bundled rows. The window is
 * the same for every fixture: the 100-image rule is keyed on Claude revision, not on the window.
 */
function imageModel(provider: string, api: Api, baseUrl: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	});
}

const ANTHROPIC_API = "https://api.anthropic.com";
const ANTIGRAVITY_URL = "https://daily-cloudcode-pa.googleapis.com";
const XAI_URL = "https://api.x.ai/v1";
const CURSOR_URL = "https://api2.cursor.sh";

function codex(baseUrl = CODEX_BASE_URL): Model {
	return imageModel("openai-codex", "openai-codex-responses", baseUrl, "gpt-6.1-sol");
}

describe("image-count-budget", () => {
	test.each([
		["claude-opus-4-5", 100],
		["claude-sonnet-4-5", 100],
		["claude-haiku-4-5", 100],
		["claude-opus-45", 100],
		["claude-opus-4-6", 600],
		["claude-opus-46", 600],
		["claude-opus-5-5", 600],
	] as const)(
		"the Anthropic API allows %s %d images: 100 before Claude 4.6, collapsed revisions included",
		(id, budget) => {
			expect(imageCountBudget(imageModel("anthropic", "anthropic-messages", ANTHROPIC_API, id))).toBe(budget);
		},
	);

	test.each([
		["anthropic", "claude-opus-5-5", 600, 90, "anthropic-messages", ANTHROPIC_API],
		["anthropic", "claude-opus-4-5", 100, 90, "anthropic-messages", ANTHROPIC_API],
		["openai-codex", "gpt-6.1-sol", 2000, 200, "openai-codex-responses", CODEX_BASE_URL],
	] as const)(
		"%s %s allows %d images on its official endpoint and %d through a custom baseUrl",
		(provider, id, official, custom, api, officialUrl) => {
			for (const [baseUrl, budget] of [
				[officialUrl, official],
				["", official],
				[`${officialUrl}/`, official],
				["https://llm-proxy.example/v1", custom],
			] as const) {
				expect({ baseUrl, budget: imageCountBudget(imageModel(provider, api, baseUrl, id)) }).toEqual({
					baseUrl,
					budget,
				});
			}
		},
	);

	test.each([
		["openai", "openai-responses", "https://api.openai.com/v1", "gpt-5.5", 200],
		[
			"amazon-bedrock",
			"bedrock-converse-stream",
			"https://bedrock-runtime.us-east-1.amazonaws.com",
			"us.anthropic.claude-opus-5-5",
			90,
		],
		["openrouter", "openrouter", "https://openrouter.ai/api/v1", "anthropic/claude-opus-5.5", 90],
		["google-antigravity", "google-gemini-cli", ANTIGRAVITY_URL, "gemini-3.7-flash", 60],
		["xai-oauth", "openai-responses", XAI_URL, "grok-4.7", 60],
		["xai", "openai-responses", XAI_URL, "grok-4.6", 60],
		["cursor", "cursor-agent", CURSOR_URL, "gpt-5.5", 60],
	] as const)("%s carries its budget", (provider, api, baseUrl, id, budget) => {
		expect(imageCountBudget(imageModel(provider, api, baseUrl, id))).toBe(budget);
	});

	test("Claude on Antigravity and Cursor, and Cursor's default route, carry Claude's 20-image many-image limit", () => {
		for (const [provider, api, baseUrl, id] of [
			["google-antigravity", "google-gemini-cli", ANTIGRAVITY_URL, "claude-sonnet-4-6"],
			["google-antigravity", "google-gemini-cli", ANTIGRAVITY_URL, "claude-opus-5-5"],
			["cursor", "cursor-agent", CURSOR_URL, "claude-opus-5-high"],
			["cursor", "cursor-agent", CURSOR_URL, "claude-4.5-sonnet"],
			["cursor", "cursor-agent", CURSOR_URL, "default"],
		] as const) {
			expect({ provider, id, budget: imageCountBudget(imageModel(provider, api, baseUrl, id)) }).toEqual({
				provider,
				id,
				budget: 20,
			});
		}
	});

	test("an unlisted host has no budget", () => {
		expect(
			imageCountBudget(imageModel("ramp", "anthropic-messages", ANTHROPIC_API, "claude-opus-5-5")),
		).toBeUndefined();
	});
});

describe("inline-image-byte-budget", () => {
	test("the Codex backend carries 24 MB; a rerouted Codex baseUrl carries none", () => {
		const sol = codex();
		expect(configuredOfficial(sol)).toBe(true);
		expect(inlineImageByteBudget(sol)).toBe(24_000_000);
		expect(inlineImageByteBudget(codex("https://chatgpt.com/backend-api/"))).toBe(24_000_000);
		const proxied = codex("https://codex-proxy.example/backend-api");
		expect(configuredOfficial(proxied)).toBe(false);
		expect(inlineImageByteBudget(proxied)).toBeUndefined();
	});

	test("a Codex baseUrl naming the backend's /codex or /codex/responses path keeps the official budgets", () => {
		for (const baseUrl of [`${CODEX_BASE_URL}/codex`, `${CODEX_BASE_URL}/codex/responses/`]) {
			const model = codex(baseUrl);
			expect({ baseUrl, images: imageCountBudget(model), bytes: inlineImageByteBudget(model) }).toEqual({
				baseUrl,
				images: 2000,
				bytes: 24_000_000,
			});
		}
		expect(configuredOfficial(codex("https://chatgpt.com/backend-api-proxy"))).toBe(false);
	});
});
