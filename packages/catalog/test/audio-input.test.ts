import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { openrouterModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function spec(id: string, api: Api, provider: string): ModelSpec<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	};
}

describe("audio input modality", () => {
	it("Gemini hears audio on Google's GenerateContent transports", () => {
		expect(buildModel(spec("gemini-2.5-flash", "google-generative-ai", "google")).input).toEqual([
			"text",
			"image",
			"audio",
		]);
		expect(buildModel(spec("gemini-3.1-pro", "google-gemini-cli", "google-antigravity")).input).toContain("audio");
		expect(buildModel(spec("gemini-3.5-flash", "google-vertex", "google-vertex")).input).toContain("audio");
	});

	it("bundled Gemini rows on Google transports carry the rule's audio input", () => {
		for (const [provider, id] of [
			["google", "gemini-2.5-flash"],
			["google-antigravity", "gemini-3.1-pro"],
			["google-gemini-cli", "gemini-2.5-pro"],
			["google-vertex", "gemini-3.5-flash"],
		] as const) {
			const bundled = getBundledModel(provider, id);
			expect(bundled.input).toEqual(buildModel(bundled).input);
			expect(bundled.input).toContain("audio");
		}
	});

	it("leaves Gemini image-generation rows and other transports without audio", () => {
		expect(buildModel(spec("gemini-3-pro-image", "google-generative-ai", "google")).input).toEqual(["text", "image"]);
		expect(buildModel(spec("gemini-2.5-pro", "openai-completions", "github-copilot")).input).toEqual([
			"text",
			"image",
		]);
		expect(buildModel(spec("claude-sonnet-4-5", "google-gemini-cli", "google-antigravity")).input).toEqual([
			"text",
			"image",
		]);
	});

	it("keeps the audio input OpenRouter reports, over a bundled row without it and across a cached reload", async () => {
		const options = openrouterModelManagerOptions({
			fetch: async input => {
				if (String(input) === "https://openrouter.ai/api/v1/models") {
					return Response.json({
						data: [
							{
								id: "xiaomi/mimo-v2.6-flash",
								name: "MiMo V2.6 Flash",
								supported_parameters: ["tools"],
								architecture: { input_modalities: ["text", "image", "video", "audio"] },
							},
							{
								id: "openai/gpt-audio-mini",
								name: "GPT Audio Mini",
								supported_parameters: ["tools"],
								architecture: { input_modalities: ["text", "audio"] },
							},
							{
								id: "anthropic/claude-haiku-4.5",
								name: "Claude Haiku 4.5",
								supported_parameters: ["tools"],
								architecture: { input_modalities: ["text", "image"] },
							},
						],
					});
				}
				return Response.json({ data: [] });
			},
		});

		const bundled = {
			...spec("xiaomi/mimo-v2.6-flash", "openrouter", "openrouter"),
			baseUrl: "https://openrouter.ai/api/v1",
		};
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "audio-input-cache-"));
		try {
			const resolveOptions = { ...options, staticModels: [bundled], cacheDbPath: path.join(dir, "models.db") };
			for (const strategy of ["online", "offline"] as const) {
				const { models } = await resolveProviderModels(resolveOptions, strategy);
				const inputOf = (id: string) => models.find(model => model.id === id)?.input;
				expect(inputOf("xiaomi/mimo-v2.6-flash")).toEqual(["text", "image", "audio"]);
				expect(inputOf("openai/gpt-audio-mini")).toEqual(["text", "audio"]);
				expect(inputOf("anthropic/claude-haiku-4.5")).toEqual(["text", "image"]);
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
