import { describe, expect, it } from "bun:test";
import type { Api, Context, Model } from "@pk-nerdsaver-ai/pi-ai";
import * as snapcompact from "@pk-nerdsaver-ai/snapcompact";
import {
	type BackgroundPackModelProfile,
	type BackgroundPackModelQualification,
	BackgroundPackRenderer,
	backgroundPackModelFingerprint,
	backgroundPackShapeFingerprint,
	countContextImages,
	injectBackgroundPackMessages,
	type ResolvedBackgroundPack,
} from "../src/context/background-packs";

function makeModel(extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "qualified-model",
		name: "Qualified Model",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.test/v1",
		requestModelId: "qualified-model-2026-07-01",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 4096,
		...extra,
	} as Model<Api>;
}

function profileFor(model: Model<Api>): BackgroundPackModelProfile {
	return {
		provider: model.provider,
		api: model.api,
		id: model.id,
		requestModelId: model.requestModelId ?? model.id,
		baseUrl: model.baseUrl,
		input: model.input,
	};
}

function qualificationFor(model: Model<Api>, artifact = "passing-artifact"): BackgroundPackModelQualification {
	return {
		modelFingerprint: backgroundPackModelFingerprint(profileFor(model)),
		shapeFingerprint: backgroundPackShapeFingerprint(snapcompact.resolveShape(model)),
		artifact,
	};
}

function pack(text: string, contentHash = "pack-hash", name = "Reference"): ResolvedBackgroundPack {
	return { name, text, contentHash, sourceCount: 1 };
}

// A pack only clears the profitability gate when its text is token-dense.
// Image encoding costs a flat ~2882 tokens per frame and a frame holds ~13.9k
// characters, so the break-even point is around 4.3 characters per token.
// Repetitive English sits near 7.1 (cl100k collapses the repeats), which makes
// it permanently unprofitable — the gate is right to reject it. High-entropy
// identifier/hash-style content lands near 1.8, which is what a real reference
// pack of symbol tables, checksums, or tabular data looks like.
const profitableText = (() => {
	let seed = 987_654_321;
	const next = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff);
	const word = () => next().toString(16).padStart(8, "0");
	return Array.from({ length: 4_000 }, () => `${word()}${word()}`).join("\n");
})();

describe("background-pack renderer", () => {
	it("skips non-vision and unqualified exact models without a text fallback", async () => {
		const renderer = new BackgroundPackRenderer();
		const nonVision = await renderer.prepare([pack(profitableText)], makeModel({ input: ["text"] }));
		expect(nonVision.messages).toEqual([]);
		expect(nonVision.warnings.map(warning => warning.code)).toEqual(["model-not-vision"]);

		const unqualified = await renderer.prepare([pack(profitableText)], makeModel());
		expect(unqualified.messages).toEqual([]);
		expect(unqualified.warnings.map(warning => warning.code)).toEqual(["model-not-qualified"]);
		expect(JSON.stringify(unqualified)).not.toContain(profitableText.slice(0, 80));
	});

	it("sends only resolved pack text to the renderer and emits a non-authoritative image message", async () => {
		const model = makeModel();
		const qualification = qualificationFor(model);
		const renderedSources: string[] = [];
		const renderMany: typeof snapcompact.renderMany = async source => {
			renderedSources.push(source);
			return [{ type: "image", data: "cGFjay1pbWFnZQ==", mimeType: "image/png" }];
		};
		const renderer = new BackgroundPackRenderer({
			qualifications: { [qualification.modelFingerprint]: qualification },
			renderMany,
		});

		const prepared = await renderer.prepare([pack(profitableText)], model);

		expect(renderedSources).toEqual([profitableText]);
		expect(prepared.warnings).toEqual([]);
		expect(prepared.messages).toHaveLength(1);
		const content = prepared.messages[0]?.content;
		expect(Array.isArray(content)).toBe(true);
		expect(JSON.stringify(content)).toContain("non-authoritative general background");
		expect(JSON.stringify(content)).toContain("cGFjay1pbWFnZQ==");
		expect(JSON.stringify(content)).not.toContain(profitableText.slice(0, 80));
	});

	it("skips packs that do not save enough uncached input tokens", async () => {
		const model = makeModel();
		const qualification = qualificationFor(model);
		let renderCalls = 0;
		const renderMany: typeof snapcompact.renderMany = async () => {
			renderCalls++;
			return [{ type: "image", data: "c2hvcnQ=", mimeType: "image/png" }];
		};
		const renderer = new BackgroundPackRenderer({
			qualifications: { [qualification.modelFingerprint]: qualification },
			renderMany,
		});

		const prepared = await renderer.prepare([pack("short background")], model);

		expect(prepared.messages).toEqual([]);
		expect(prepared.warnings.map(warning => warning.code)).toEqual(["pack-unprofitable"]);
		expect(renderCalls).toBe(0);
	});

	it("caches by content hash and exact model profile while preserving pack order", async () => {
		const firstModel = makeModel();
		const secondModel = makeModel({ requestModelId: "qualified-model-2026-07-02" });
		const firstQualification = qualificationFor(firstModel, "artifact-a");
		const secondQualification = qualificationFor(secondModel, "artifact-b");
		const renderedSources: string[] = [];
		const renderMany: typeof snapcompact.renderMany = async source => {
			renderedSources.push(source);
			return [{ type: "image", data: btoa(source.slice(0, 12)), mimeType: "image/png" }];
		};
		const renderer = new BackgroundPackRenderer({
			qualifications: {
				[firstQualification.modelFingerprint]: firstQualification,
				[secondQualification.modelFingerprint]: secondQualification,
			},
			renderMany,
		});
		const first = pack(`FIRST ${profitableText}`, "hash-a", "First");
		const second = pack(`SECOND ${profitableText}`, "hash-b", "Second");

		const ordered = await renderer.prepare([first, second], firstModel);
		await renderer.prepare([first], firstModel);
		await renderer.prepare([pack(first.text, "hash-c")], firstModel);
		await renderer.prepare([first], secondModel);

		expect(ordered.messages).toHaveLength(2);
		expect(renderedSources).toEqual([first.text, second.text, first.text, first.text]);
	});
	it("subtracts existing request images before admitting a background pack", async () => {
		const model = makeModel();
		const qualification = qualificationFor(model);
		const imageBudget = snapcompact.providerImageBudget(model.provider);
		const existingImages = Array.from({ length: imageBudget }, (_, index) => ({
			type: "image" as const,
			data: btoa(`existing-${index}`),
			mimeType: "image/png",
		}));
		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: existingImages, timestamp: 1 }],
			tools: [],
		};
		let renderCalls = 0;
		const renderer = new BackgroundPackRenderer({
			qualifications: { [qualification.modelFingerprint]: qualification },
			renderMany: async () => {
				renderCalls++;
				return [{ type: "image", data: "cGFjaw==", mimeType: "image/png" }];
			},
		});

		const existingImageCount = countContextImages(context);
		const prepared = await renderer.prepare([pack(profitableText)], model, {
			reservedImageCount: existingImageCount,
		});

		expect(existingImageCount).toBe(imageBudget);
		expect(prepared.messages).toEqual([]);
		expect(prepared.warnings.map(warning => warning.code)).toEqual(["provider-image-budget"]);
		expect(renderCalls).toBe(0);
	});

	it("contains renderer exceptions, skips the failed pack, and does not leak error details", async () => {
		const model = makeModel();
		const qualification = qualificationFor(model);
		const failedText = `FAIL ${profitableText}`;
		const successfulText = `SUCCEED ${profitableText}`;
		const renderer = new BackgroundPackRenderer({
			qualifications: { [qualification.modelFingerprint]: qualification },
			renderMany: async source => {
				if (source === failedText)
					throw new Error("C:\\private\\background-source.txt contains SECRET_SOURCE_TEXT");
				return [{ type: "image", data: "c3VjY2Vzcw==", mimeType: "image/png" }];
			},
		});

		const prepared = await renderer.prepare(
			[pack(failedText, "failed-hash"), pack(successfulText, "successful-hash")],
			model,
		);

		expect(prepared.messages).toHaveLength(1);
		expect(prepared.warnings.map(warning => warning.code)).toEqual(["pack-render-failed"]);
		expect(JSON.stringify(prepared.warnings)).not.toContain("private");
		expect(JSON.stringify(prepared.warnings)).not.toContain("SECRET_SOURCE_TEXT");
	});

	it("fails closed for empty or malformed rendered image results", async () => {
		const model = makeModel();
		const qualification = qualificationFor(model);
		const emptyText = `EMPTY ${profitableText}`;
		const malformedText = `MALFORMED ${profitableText}`;
		const renderer = new BackgroundPackRenderer({
			qualifications: { [qualification.modelFingerprint]: qualification },
			renderMany: async source => (source === emptyText ? [] : [{ type: "image", data: "", mimeType: "image/png" }]),
		});

		const prepared = await renderer.prepare(
			[pack(emptyText, "empty-hash"), pack(malformedText, "malformed-hash")],
			model,
		);

		expect(prepared.messages).toEqual([]);
		expect(prepared.warnings.map(warning => warning.code)).toEqual(["pack-render-failed", "pack-render-failed"]);
	});

	it("rejects a render whose actual image count exceeds the remaining request budget", async () => {
		const model = makeModel();
		const qualification = qualificationFor(model);
		const shape = snapcompact.resolveShape(model);
		const frameCount = snapcompact.frames(profitableText, { shape });
		const imageBudget = snapcompact.providerImageBudget(model.provider);
		const renderedImages = Array.from({ length: frameCount + 1 }, (_, index) => ({
			type: "image" as const,
			data: btoa(`overflow-${index}`),
			mimeType: "image/png",
		}));
		const renderer = new BackgroundPackRenderer({
			qualifications: { [qualification.modelFingerprint]: qualification },
			renderMany: async () => renderedImages,
		});

		const prepared = await renderer.prepare([pack(profitableText)], model, {
			reservedImageCount: imageBudget - frameCount,
		});

		expect(frameCount).toBeGreaterThan(0);
		expect(frameCount).toBeLessThanOrEqual(imageBudget);
		expect(prepared.messages).toEqual([]);
		expect(prepared.warnings.map(warning => warning.code)).toEqual(["provider-image-budget"]);
	});

	it("evicts the least-recently-used rendered pack when the cache bound is exceeded", async () => {
		const model = makeModel();
		const qualification = qualificationFor(model);
		const renderedSources: string[] = [];
		const renderer = new BackgroundPackRenderer({
			qualifications: { [qualification.modelFingerprint]: qualification },
			cacheMaxEntries: 2,
			renderMany: async source => {
				renderedSources.push(source);
				return [{ type: "image", data: btoa(source.slice(0, 12)), mimeType: "image/png" }];
			},
		});
		const first = pack(`FIRST ${profitableText}`, "lru-a");
		const second = pack(`SECOND ${profitableText}`, "lru-b");
		const third = pack(`THIRD ${profitableText}`, "lru-c");

		await renderer.prepare([first], model);
		await renderer.prepare([second], model);
		await renderer.prepare([first], model);
		await renderer.prepare([third], model);
		await renderer.prepare([second], model);

		expect(renderedSources).toEqual([first.text, second.text, third.text, second.text]);
	});
});

describe("background-pack provider message injection", () => {
	it("keeps instructions, history, tool results, and the current user turn native and ordered", () => {
		const context: Context = {
			systemPrompt: ["SYSTEM INSTRUCTION MUST STAY TEXT"],
			messages: [
				{ role: "user", content: [{ type: "text", text: "earlier question" }], timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "earlier answer" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test-model",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "read",
					content: [{ type: "text", text: "TOOL RESULT MUST STAY TEXT" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: [{ type: "text", text: "CURRENT USER INSTRUCTION" }], timestamp: 4 },
			],
			tools: [],
		};
		const background = {
			role: "user" as const,
			synthetic: true,
			content: [
				{ type: "text" as const, text: "non-authoritative general background" },
				{ type: "image" as const, data: "cGFjaw==", mimeType: "image/png" },
			],
			timestamp: 10,
		};

		const injected = injectBackgroundPackMessages(context, [background]);

		expect(injected.systemPrompt).toBe(context.systemPrompt);
		expect(injected.messages.map(message => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
			"user",
		]);
		expect(injected.messages[2]).toBe(context.messages[2]);
		expect(injected.messages[3]).toBe(background);
		expect(injected.messages[4]).toBe(context.messages[3]);
		expect(JSON.stringify(injected.messages[2])).toContain("TOOL RESULT MUST STAY TEXT");
		expect(JSON.stringify(injected.messages[4])).toContain("CURRENT USER INSTRUCTION");
	});
});
