import { afterEach, describe, expect, it } from "bun:test";
import { buildFalRequestBody } from "@oh-my-pi/pi-coding-agent/tools/image-fal";
import {
	DEFAULT_IMAGE_MODEL_BY_PROVIDER,
	IMAGE_MODEL_CATALOG,
	type ImageModelEntry,
} from "@oh-my-pi/pi-coding-agent/tools/image-models";
import { buildOpenRouterRequestBody } from "@oh-my-pi/pi-coding-agent/tools/image-openrouter";
import type { ImageProvider } from "@oh-my-pi/pi-coding-agent/tools/image-providers";
import {
	assertBindingSupports,
	computeImageSize,
	ImageCapabilityError,
	loadFalEndpointBinding,
	loadOpenRouterImageBinding,
	resetImageDiscoveryCachesForTests,
	resolveImageTargets,
} from "@oh-my-pi/pi-coding-agent/tools/image-targets";

afterEach(() => {
	resetImageDiscoveryCachesForTests();
});

const FLUX_PIXELS = {
	minWidth: 256,
	maxWidth: 2560,
	minHeight: 256,
	maxHeight: 2560,
	maxArea: 4_194_304,
	multipleOf: 16,
};

function fluxEntry(): ImageModelEntry {
	const entry = IMAGE_MODEL_CATALOG.find(e => e.id === "flux-2-pro");
	if (!entry) throw new Error("flux-2-pro missing from catalog");
	return entry;
}

describe("computeImageSize", () => {
	it("preserves 16:9 at 2K as 2560x1440 (not axis-clamped 2560x1536)", () => {
		expect(computeImageSize("16:9", "2K", FLUX_PIXELS)).toEqual({ width: 2560, height: 1440 });
	});
	it("keeps rounded output inside the binding area cap", () => {
		const size = computeImageSize("4:3", "2K", FLUX_PIXELS);
		expect(size.width * size.height).toBeLessThanOrEqual(FLUX_PIXELS.maxArea);
	});

	it("honors an endpoint area floor without distorting ordinary ratios", () => {
		const entry = IMAGE_MODEL_CATALOG.find(model => model.id === "seedream-5-pro");
		const pixels = entry?.bindings.find(binding => binding.provider === "fal")?.pixels;
		expect(pixels).toMatchObject({ minArea: 1_048_576 });
		expect(computeImageSize("16:9", "1K", pixels!)).toEqual({ width: 1368, height: 768 });
		expect(computeImageSize("16:9", "2K", pixels!)).toEqual({ width: 2728, height: 1536 });
	});
	it("grows rounded dimensions to satisfy an area floor", () => {
		const entry = IMAGE_MODEL_CATALOG.find(model => model.id === "seedream-5-pro");
		const pixels = entry?.bindings.find(binding => binding.provider === "fal")?.pixels;

		expect(computeImageSize("4:5", "1K", pixels!)).toEqual({ width: 920, height: 1144 });
	});

	it("preserves 21:9 at 2K as 2560x1104", () => {
		expect(computeImageSize("21:9", "2K", FLUX_PIXELS)).toEqual({ width: 2560, height: 1104 });
	});

	it("computes 1:1 at 2K as 2048x2048", () => {
		expect(computeImageSize("1:1", "2K", FLUX_PIXELS)).toEqual({ width: 2048, height: 2048 });
	});

	it("fails closed when the resolution tier exceeds the binding max area", () => {
		expect(() => computeImageSize("16:9", "4K", FLUX_PIXELS)).toThrow(ImageCapabilityError);
	});

	it("defaults to 1K area when only an aspect ratio is requested", () => {
		expect(computeImageSize("16:9", undefined, FLUX_PIXELS)).toEqual({ width: 1360, height: 768 });
	});
});

describe("assertBindingSupports", () => {
	const binding = fluxEntry().bindings.find(b => b.provider === "fal")!;

	it("accepts a valid size request", () => {
		assertBindingSupports(binding, { prompt: "x", seed: 1 }, 0);
	});

	it("rejects a resolution tier the binding cannot serve", () => {
		expect(() => assertBindingSupports(binding, { prompt: "x", resolution: "4K" }, 0)).toThrow(ImageCapabilityError);
	});
	it("rejects an image_size aspect ratio that cannot fit before provider I/O", () => {
		const entry = IMAGE_MODEL_CATALOG.find(e => e.id === "qwen-image-3");
		const falBinding = entry?.bindings.find(binding => binding.provider === "fal");
		expect(falBinding).toBeDefined();
		expect(() =>
			assertBindingSupports(falBinding!, { prompt: "x", aspectRatio: "1:2", resolution: "512" }, 0),
		).toThrow(/cannot serve 1:2/i);
	});

	it("rejects an image count above maxImages", () => {
		expect(() => assertBindingSupports(binding, { prompt: "x", n: 2 }, 0)).toThrow(ImageCapabilityError);
	});

	it("rejects output formats the binding does not declare", () => {
		expect(() => assertBindingSupports(binding, { prompt: "x", outputFormat: "webp" }, 0)).toThrow(
			ImageCapabilityError,
		);
	});

	it("names sibling bindings so a fail-closed background rejection is actionable", () => {
		const gpt = IMAGE_MODEL_CATALOG.find(e => e.id === "gpt-image-2")!;
		const falBinding = gpt.bindings.find(b => b.provider === "fal")!;
		// Without an entryId the message still names the concrete binding.
		const bare = ((): string => {
			try {
				assertBindingSupports(falBinding, { prompt: "x", background: "opaque" }, 0);
				return "";
			} catch (err) {
				return (err as Error).message;
			}
		})();
		expect(bare).toMatch(/not supported by fal/);

		// With the entry id, the message points at the OpenRouter binding that
		// actually supports background — the exact fix the retry loop needs.
		const withHint = ((): string => {
			try {
				assertBindingSupports(falBinding, { prompt: "x", background: "opaque" }, 0, "gpt-image-2");
				return "";
			} catch (err) {
				return (err as Error).message;
			}
		})();
		expect(withHint).toContain("openrouter");
		expect(withHint).toContain("openai/gpt-image-2");
		expect(withHint).toMatch(/set provider: openai or openrouter/);
		expect(withHint).toMatch(/only if that provider's credential is configured|adjust\/omit this knob/);
	});
	it("reports every unsupported knob in one capability error", () => {
		const entry = IMAGE_MODEL_CATALOG.find(model => model.id === "nano-banana-pro");
		expect(entry).toBeDefined();
		const falBinding = entry?.bindings.find(binding => binding.provider === "fal");
		expect(falBinding).toBeDefined();

		let thrown: unknown;
		try {
			assertBindingSupports(
				falBinding!,
				{ prompt: "x", quality: "high", background: "opaque" },
				0,
				"nano-banana-pro",
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ImageCapabilityError);
		const message = (thrown as Error).message;
		expect(message).toContain("Quality is not supported");
		expect(message).toContain("Background handling is not supported");
	});
});

describe("resolveImageTargets", () => {
	const allProviders: readonly ImageProvider[] = [
		"openai",
		"openai-codex",
		"antigravity",
		"xai",
		"openrouter",
		"gemini",
		"fal",
	];

	it("resolves an alias to its ordered bindings and pins to the requested provider", async () => {
		const targets = await resolveImageTargets({
			requestedModel: "nano-banana-pro",
			requestedProvider: "fal",
			providerOrder: allProviders,
			hasInputImages: false,
		});
		expect(targets).toHaveLength(1);
		expect(targets[0]?.binding.provider).toBe("fal");
		expect(targets[0]?.endpoint).toBe("fal-ai/nano-banana-pro");
	});

	it("pins the per-provider default walk to the requested provider", async () => {
		const noModel = { providerOrder: allProviders, hasInputImages: false };
		const all = await resolveImageTargets(noModel);
		// Every provider in the walk contributes exactly one target.
		for (const provider of allProviders) {
			expect(all.some(t => t.binding.provider === provider)).toBe(true);
		}

		const pinned = await resolveImageTargets({ ...noModel, requestedProvider: "fal" });
		expect(pinned).toHaveLength(1);
		expect(pinned[0]?.binding.provider).toBe("fal");
		expect(pinned[0]?.entryId).toBe(DEFAULT_IMAGE_MODEL_BY_PROVIDER.fal);
	});

	it("rejects an unknown alias with a fail-closed capability error", async () => {
		await expect(
			resolveImageTargets({
				requestedModel: "definitely-not-a-model",
				providerOrder: allProviders,
				hasInputImages: false,
			}),
		).rejects.toThrow(ImageCapabilityError);
	});
});

describe("raw FAL discovery", () => {
	it("maps a raw endpoint and caches the schema fetch in memory", async () => {
		let fetches = 0;
		const fetchMock = (async (url: string | URL | Request) => {
			fetches += 1;
			expect(String(url).startsWith("https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=")).toBe(true);
			return new Response(
				JSON.stringify({
					components: {
						schemas: {
							QwenImage3EditInput: {
								properties: {
									prompt: { type: "string" },
									image_size: { type: "object" },
									num_images: { type: "integer" },
									image_urls: { type: "array" },
									seed: { type: "integer" },
									output_format: { type: "string", enum: ["jpeg", "png", "webp"] },
								},
							},
						},
					},
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		const binding = await loadFalEndpointBinding("alibaba/qwen-image-3/edit", fetchMock);
		expect(binding.sizeMode).toBe("image_size");
		expect(binding.maxImages).toBe(1);

		expect(binding.edit).toBe("alibaba/qwen-image-3/edit");
		expect(binding.supportsSeed).toBe(true);
		expect(binding.pixels).toMatchObject({
			minWidth: 256,
			maxWidth: 2048,
			minHeight: 256,
			maxHeight: 2048,
			maxArea: 4_194_304,
			multipleOf: 8,
		});
		expect(fetches).toBe(1);

		const second = await loadFalEndpointBinding("alibaba/qwen-image-3/edit", fetchMock);

		expect(second).toBe(binding);
		expect(fetches).toBe(1);
	});
	it("discovers and serializes a singular FAL edit image field", async () => {
		const fetchMock = (async () =>
			new Response(
				JSON.stringify({
					components: {
						schemas: {
							FluxEditInput: {
								properties: {
									prompt: { type: "string" },
									image_url: { type: "string" },
								},
							},
						},
					},
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;

		const binding = await loadFalEndpointBinding("fal-ai/flux-pro/edit", fetchMock);
		expect(binding.edit).toBe("fal-ai/flux-pro/edit");
		expect(binding.inputImageField).toBe("image_url");
		expect(binding.maxReferences).toBe(1);
		expect(buildFalRequestBody(binding, { prompt: "x" }, ["https://fal.invalid/input.png"])).toEqual({
			prompt: "x",
			image_url: "https://fal.invalid/input.png",
		});
	});

	it("preserves discovered resolution wire values", async () => {
		const fetchMock = (async () =>
			new Response(
				JSON.stringify({
					components: {
						schemas: {
							RawImageInput: {
								properties: {
									prompt: { type: "string" },
									aspect_ratio: { type: "string", enum: ["1:1"] },
									resolution: { type: "string", enum: ["0.5K", "1k", "2k"] },
								},
							},
						},
					},
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;

		const binding = await loadFalEndpointBinding("fal-ai/raw-ratio", fetchMock);
		expect(binding.resolutions).toEqual(["512", "1K", "2K"]);
		expect(binding.resolutionWireValues).toEqual({ "512": "0.5K", "1K": "1k", "2K": "2k" });
		expect(buildFalRequestBody(binding, { prompt: "x", resolution: "512" }, [])).toMatchObject({
			resolution: "0.5K",
		});
	});

	it("rejects an endpoint without a prompt as not prompt-driven", async () => {
		const fetchMock = (async () =>
			new Response(
				JSON.stringify({
					components: { schemas: { FooInput: { properties: { image_size: { type: "object" } } } } },
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;
		await expect(loadFalEndpointBinding("fal-ai/foo", fetchMock)).rejects.toThrow(ImageCapabilityError);
	});
});

describe("raw OpenRouter discovery", () => {
	it("indexes the model list once and maps supported_parameters", async () => {
		let fetches = 0;
		const fetchMock = (async () => {
			fetches += 1;
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "google/gemini-3.1-flash-image",
							supported_parameters: {
								resolution: { type: "enum", values: ["512", "1K", "2K", "4K"] },
								aspect_ratio: {
									type: "enum",
									values: ["1:1", "16:9", "21:9", "9:19.5", "19.5:9", "9:20", "20:9"],
								},
								quality: { type: "enum", values: ["low", "medium", "high"] },
								background: { type: "enum", values: ["transparent", "opaque"] },
								n: { type: "range", min: 1, max: 1 },
								input_references: { type: "range", min: 0, max: 14 },
							},
						},
					],
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const binding = await loadOpenRouterImageBinding("google/gemini-3.1-flash-image", fetchMock);
		expect(binding.sizeMode).toBe("aspect_ratio");
		expect(binding.resolutions).toContain("1K");
		expect(binding.aspectRatios).toEqual(["1:1", "16:9", "21:9", "9:19.5", "19.5:9", "9:20", "20:9"]);
		expect(binding.qualityValues).toEqual(["low", "medium", "high"]);
		expect(binding.backgroundValues).toEqual(["transparent", "opaque"]);
		expect(binding.maxImages).toBe(1);
		expect(binding.maxReferences).toBe(14);
		expect(binding.edit).toBe("google/gemini-3.1-flash-image");
		expect(fetches).toBe(1);

		await loadOpenRouterImageBinding("google/gemini-3.1-flash-image", fetchMock);
		expect(fetches).toBe(1);
	});
	it("preserves enum capabilities, rejects undeclared values, and filters them from requests", async () => {
		const fetchMock = (async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "raw/enum-capabilities",
							supported_parameters: {
								quality: { type: "enum", values: ["low", "medium", "high"] },
								background: { type: "enum", values: ["transparent", "opaque"] },
							},
						},
					],
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;
		const binding = await loadOpenRouterImageBinding("raw/enum-capabilities", fetchMock);

		let thrown: unknown;
		try {
			assertBindingSupports(binding, { prompt: "x", quality: "auto", background: "auto" }, 0);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ImageCapabilityError);
		const message = (thrown as Error).message;
		expect(message).toMatch(/quality.*auto.*supported.*low.*medium.*high/i);
		expect(message).toMatch(/background.*auto.*supported.*transparent.*opaque/i);

		const declared = buildOpenRouterRequestBody(
			"raw/enum-capabilities",
			binding,
			{ prompt: "x", quality: "high", background: "opaque" },
			[],
		);
		expect(declared.quality).toBe("high");
		expect(declared.background).toBe("opaque");

		const undeclared = buildOpenRouterRequestBody(
			"raw/enum-capabilities",
			binding,
			{ prompt: "x", quality: "auto", background: "auto" },
			[],
		);
		expect(undeclared.quality).toBeUndefined();
		expect(undeclared.background).toBeUndefined();
	});
	it("keeps static boolean-only OpenRouter knobs in the request", () => {
		const binding = IMAGE_MODEL_CATALOG.find(entry => entry.id === "gpt-image-2")?.bindings.find(
			entry => entry.provider === "openrouter",
		);
		expect(binding).toBeDefined();

		const body = buildOpenRouterRequestBody(
			"openai/gpt-image-2",
			binding!,
			{ prompt: "x", quality: "high", background: "opaque" },
			[],
		);
		expect(body.quality).toBe("high");
		expect(body.background).toBe("opaque");
	});
	it("fails closed when a raw model omits aspect-ratio support", async () => {
		const fetchMock = (async () =>
			new Response(
				JSON.stringify({
					data: [{ id: "raw/no-aspect", supported_parameters: { resolution: { values: ["1K"] } } }],
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;
		const binding = await loadOpenRouterImageBinding("raw/no-aspect", fetchMock);
		expect(binding.aspectRatios).toEqual([]);
		expect(() => assertBindingSupports(binding, { prompt: "x", aspectRatio: "16:9" }, 0)).toThrow(
			ImageCapabilityError,
		);
	});

	it("fails closed for an unknown model id", async () => {
		const fetchMock = (async () =>
			new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
		await expect(loadOpenRouterImageBinding("nope/nope", fetchMock)).rejects.toThrow(ImageCapabilityError);
	});
});

describe("confirmed image capability boundaries", () => {
	it("normalizes FAL enums nested under anyOf and uses num_images maximum", async () => {
		const fetchMock = (async () =>
			new Response(
				JSON.stringify({
					components: {
						schemas: {
							NestedInput: {
								properties: {
									prompt: { type: "string" },
									aspect_ratio: {
										anyOf: [{ type: "string", enum: ["auto", "1:1", "4:1"] }, { type: "null" }],
									},
									resolution: { anyOf: [{ enum: ["0.5K", "1k", "2K"] }, { type: "null" }] },
									num_images: { type: "integer", minimum: 1, maximum: 7 },
									output_format: { anyOf: [{ enum: ["png", "jpeg"] }, { type: "null" }] },
									quality: { anyOf: [{ enum: ["auto", "low", "medium", "high"] }, { type: "null" }] },
									background: { anyOf: [{ enum: ["auto", "transparent", "opaque"] }, { type: "null" }] },
									image_urls: { type: "array", maxItems: 10 },
								},
							},
						},
					},
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;

		const binding = await loadFalEndpointBinding("fal-ai/nested", fetchMock);
		expect(binding.aspectRatios).toEqual(["auto", "1:1"]);
		expect(binding.outputFormats).toEqual(["png", "jpeg"]);
		expect(binding.qualityValues).toEqual(["auto", "low", "medium", "high"]);
		expect(binding.backgroundValues).toEqual(["auto", "transparent", "opaque"]);
		expect(binding.maxImages).toBe(7);
		expect(binding.maxReferences).toBe(10);
		expect(binding.supportsQuality).toBe(true);
		expect(binding.supportsBackground).toBe(true);
		expect(buildFalRequestBody(binding, { prompt: "x", quality: "high", background: "opaque" }, [])).toMatchObject({
			quality: "high",
			background: "opaque",
		});
	});

	it("rejects automatic aspect ratios for image_size bindings instead of making a square", () => {
		const binding = IMAGE_MODEL_CATALOG.find(entry => entry.id === "flux-2-pro")?.bindings.find(
			entry => entry.provider === "fal",
		);
		expect(binding).toBeDefined();
		expect(() => assertBindingSupports(binding!, { prompt: "x", aspectRatio: "auto" }, 0)).toThrow(
			/Automatic aspect ratio cannot be represented by image_size bindings/i,
		);
		expect(() => buildFalRequestBody(binding!, { prompt: "x", aspectRatio: "auto" }, [])).toThrow(
			/Automatic aspect ratio cannot be represented by image_size bindings/i,
		);
	});

	it("keeps static image bindings aligned with documented provider capabilities", () => {
		const pro = IMAGE_MODEL_CATALOG.find(entry => entry.id === "nano-banana-pro");
		const gemini = pro?.bindings.find(binding => binding.provider === "gemini");
		const antigravity = pro?.bindings.find(binding => binding.provider === "antigravity");
		expect(gemini?.resolutions).toEqual(["1K", "2K", "4K"]);
		expect(gemini?.maxReferences).toBe(14);
		expect(antigravity?.resolutions).toEqual(["1K", "2K", "4K"]);
		expect(antigravity?.maxReferences).toBe(14);
		const nanoFal = pro?.bindings.find(binding => binding.provider === "fal");
		expect(nanoFal?.aspectRatios).toEqual([
			"auto",
			"1:1",
			"2:3",
			"3:2",
			"3:4",
			"4:3",
			"4:5",
			"5:4",
			"9:16",
			"16:9",
			"21:9",
		]);
		expect(buildFalRequestBody(nanoFal!, { prompt: "x", aspectRatio: "auto" }, []).aspect_ratio).toBe("auto");

		const seedream = IMAGE_MODEL_CATALOG.find(entry => entry.id === "seedream-5-pro")?.bindings.find(
			binding => binding.provider === "fal",
		);
		expect(seedream?.maxImages).toBe(6);
		expect(seedream?.maxReferences).toBe(10);

		const nanoTwoFal = IMAGE_MODEL_CATALOG.find(entry => entry.id === "nano-banana-2")?.bindings.find(
			binding => binding.provider === "fal",
		);
		expect(nanoTwoFal?.resolutions).toEqual(["512", "1K", "2K", "4K"]);
		expect(nanoTwoFal?.resolutionWireValues).toEqual({ "512": "0.5K" });

		expect(buildFalRequestBody(nanoTwoFal!, { prompt: "x", resolution: "512" }, []).resolution).toBe("0.5K");

		const gptOpenRouter = IMAGE_MODEL_CATALOG.find(entry => entry.id === "gpt-image-2")?.bindings.find(
			binding => binding.provider === "openrouter",
		);
		expect(
			buildOpenRouterRequestBody(
				"openai/gpt-image-2",
				gptOpenRouter!,
				{ prompt: "x", background: "transparent" },
				[],
			).background,
		).toBeUndefined();
		const gptOpenAI = IMAGE_MODEL_CATALOG.find(entry => entry.id === "gpt-image-2")?.bindings.find(
			binding => binding.provider === "openai",
		);
		const gptCodex = IMAGE_MODEL_CATALOG.find(entry => entry.id === "gpt-image-2")?.bindings.find(
			binding => binding.provider === "openai-codex",
		);
		expect(gptOpenAI?.outputFormats).toEqual(["webp"]);
		expect(gptCodex?.outputFormats).toEqual(["webp"]);
		expect(gptOpenAI?.qualityValues).toEqual(["auto", "low", "medium", "high"]);
		expect(gptOpenAI?.backgroundValues).toEqual(["auto", "opaque"]);

		const gptFal = IMAGE_MODEL_CATALOG.find(entry => entry.id === "gpt-image-2")?.bindings.find(
			binding => binding.provider === "fal",
		);
		expect(gptFal?.pixels).toMatchObject({
			minWidth: 16,
			maxWidth: 3840,
			minHeight: 16,
			maxHeight: 3840,
			minArea: 655_360,
			maxArea: 8_294_400,
			multipleOf: 16,
		});
		expect(gptFal?.resolutions).toEqual(["1K", "2K"]);
		expect(gptFal?.maxImages).toBe(4);
		expect(gptFal?.maxReferences).toBe(16);
		const gptReferences = Array.from({ length: 16 }, (_, index) => `https://example.test/input-${index}.png`);
		let gptValidationError: unknown;
		try {
			assertBindingSupports(gptFal!, { prompt: "x", aspectRatio: "16:9", resolution: "2K" }, gptReferences.length);
		} catch (error) {
			gptValidationError = error;
		}
		expect(gptValidationError).toBeUndefined();
		const gptBody = buildFalRequestBody(
			gptFal!,
			{ prompt: "x", aspectRatio: "16:9", resolution: "2K" },
			gptReferences,
		);
		expect(gptBody.image_size).toEqual({ width: 2736, height: 1536 });
		expect(() => assertBindingSupports(gptFal!, { prompt: "x", resolution: "4K" }, 0)).toThrow(/Supported: 1K, 2K/);
		expect(gptBody.image_urls).toEqual(gptReferences);
		expect(() => assertBindingSupports(gptFal!, { prompt: "x", resolution: "512" }, 0)).toThrow(/Supported: 1K, 2K/);
		expect(gptFal?.qualityValues).toEqual(["auto", "low", "medium", "high"]);
		expect(gptBody.quality).toBeUndefined();
		expect(buildFalRequestBody(gptFal!, { prompt: "x", quality: "high" }, []).quality).toBe("high");
		expect(gptOpenRouter?.backgroundValues).toEqual(["auto", "opaque"]);

		const grokOpenRouter = IMAGE_MODEL_CATALOG.find(entry => entry.id === "grok-imagine")?.bindings.find(
			binding => binding.provider === "openrouter",
		);
		expect(grokOpenRouter?.aspectRatios).toEqual([
			"auto",
			"1:1",
			"3:4",
			"4:3",
			"9:16",
			"16:9",
			"2:3",
			"3:2",
			"9:19.5",
			"19.5:9",
			"9:20",
			"20:9",
			"1:2",
			"2:1",
		]);
		expect(grokOpenRouter?.qualityValues).toEqual(["low", "medium"]);
		expect(() => assertBindingSupports(grokOpenRouter!, { prompt: "x", quality: "high" }, 0)).toThrow(
			/Supported: low, medium/,
		);
		expect(
			buildOpenRouterRequestBody(
				"x-ai/grok-imagine-image-2.0",
				grokOpenRouter!,
				{ prompt: "x", aspectRatio: "9:20" },
				[],
			),
		).toMatchObject({ aspect_ratio: "9:20" });

		const grokFal = IMAGE_MODEL_CATALOG.find(entry => entry.id === "grok-imagine")?.bindings.find(
			binding => binding.provider === "fal",
		);
		expect(grokFal?.aspectRatios).toEqual([
			"2:1",
			"20:9",
			"19.5:9",
			"16:9",
			"4:3",
			"3:2",
			"1:1",
			"2:3",
			"3:4",
			"9:16",
			"9:19.5",
			"9:20",
			"1:2",
		]);
		expect(() => assertBindingSupports(grokFal!, { prompt: "x", aspectRatio: "auto" }, 0)).toThrow(
			/Unsupported aspect ratio auto/,
		);
		expect(buildFalRequestBody(grokFal!, { prompt: "x", aspectRatio: "20:9" }, [])).toMatchObject({
			aspect_ratio: "20:9",
		});
	});
});
