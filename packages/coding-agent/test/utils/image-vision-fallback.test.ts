import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Api, type AssistantMessage, type Context, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import type { ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { cfgOffline } from "@oh-my-pi/pi-coding-agent/config/auxiliary-model-policy";
import { cfgDisabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ImageDescriptions,
	type DescribeAttachedImagesDeps,
	describeAttachedImagesForTextModel,
} from "@oh-my-pi/pi-coding-agent/utils/image-vision-fallback";
import { CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import {
	anthropicChunks,
	type CapturedRequest,
	captureFetch,
	factoryModel,
	WORKOS_TOKEN,
} from "../../../ai/test/helpers/factory-droid";

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
// 1x1 red PNG: a second, distinct image.
const RED_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD3sAAAAASUVORK5CYII=";

const visionModel: Model<"openai-responses"> = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const textModel: Model<"openai-responses"> = { ...visionModel, id: "gpt-4.1-mini", input: ["text"] };
const cheaperVisionModel: Model<"openai-responses"> = {
	...visionModel,
	id: "gpt-4o-mini",
	cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
};

function makeCompleteStub(text: string): { calls: unknown[][]; fn: typeof completeSimple } {
	const calls: unknown[][] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args);
		return {
			role: "assistant",
			api: visionModel.api,
			provider: visionModel.provider,
			model: visionModel.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			content: [{ type: "text", text }],
		} satisfies AssistantMessage;
	}) as typeof completeSimple;
	return { calls, fn };
}

function makeDeps(
	artifactsDir: string,
	available: Model<Api>[],
	completeImpl: typeof completeSimple,
	apiKey: string | undefined = "test-key",
): DescribeAttachedImagesDeps {
	const deps: DescribeAttachedImagesDeps = {
		activeModel: textModel,
		modelRegistry: {
			getAvailable: () => {
				if (cfgOffline.get(deps.settings)) throw new Error("Offline mode read every provider's catalog");
				return available;
			},
			getAvailableForProviders: (providers: ReadonlySet<string>) =>
				available.filter(model => providers.has(model.provider)),
			getApiKey: async () => apiKey,
			resolver: () => async () => apiKey,
		} as unknown as DescribeAttachedImagesDeps["modelRegistry"],
		settings: Settings.isolated(),
		localProtocolOptions: { getArtifactsDir: () => artifactsDir, getSessionId: () => "test-session" },
		activeModelString: `${textModel.provider}/${textModel.id}`,
		completeImpl,
	};
	return deps;
}

describe("describeAttachedImagesForTextModel", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-fallback-"));
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("saves the image under local:// and injects a vision description block", async () => {
		const stub = makeCompleteStub("A man holding a red balloon.");
		const blocks = await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			makeDeps(testDir, [textModel, visionModel], stub.fn),
		);

		expect(blocks).toHaveLength(1);
		const text = blocks[0]!.text;
		// Block wraps the local:// path and the description.
		const match = text.match(/^<image path="(local:\/\/[^"]+\.png)">\n([\s\S]*)\n<\/image>$/);
		expect(match).not.toBeNull();
		expect(match![2]).toBe("A man holding a red balloon.");

		// The vision model was actually consulted.
		expect(stub.calls).toHaveLength(1);

		// The image was persisted under <artifactsDir>/local and round-trips.
		const fileName = match![1].slice("local://".length);
		const saved = await fs.readFile(path.join(testDir, "local", fileName));
		expect(saved.toString("base64")).toBe(TINY_PNG_BASE64);
	});

	it("counts each description against the session's cost cap and describes nothing at it", async () => {
		const stub = makeCompleteStub("A man holding a red balloon.");
		const billed = (async (...args: Parameters<typeof completeSimple>) => {
			const message = await stub.fn(...args);
			message.usage.cost.total = 1.2;
			return message;
		}) as typeof completeSimple;
		const costGate = new CostGate(Settings.isolated({ "session.maxCost": 1 }), 0, () => {});
		const deps = { ...makeDeps(testDir, [textModel, visionModel], billed), costGate };
		await describeAttachedImagesForTextModel([{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }], deps);
		expect(costGate.spent).toBe(1.2);
		// A different image: the first one's saved description would be reused without a request.
		const capped = await describeAttachedImagesForTextModel(
			[{ type: "image", data: RED_PNG_BASE64, mimeType: "image/png" }],
			deps,
		);

		expect(stub.calls).toHaveLength(1);
		expect(capped[0]!.text).not.toContain("red balloon");
	});

	it("journals each description once as usage-only `image-describe`", async () => {
		const stub = makeCompleteStub("A man holding a red balloon.");
		const usageLedger = SessionManager.inMemory();
		const deps = { ...makeDeps(testDir, [textModel, visionModel], stub.fn), usageLedger };

		await describeAttachedImagesForTextModel([{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }], deps);

		const journaled = usageLedger.getEntries().filter(entry => entry.type === "model_usage");
		expect(journaled).toHaveLength(1);
		expect(journaled[0]).toMatchObject({
			purpose: "image-describe",
			model: visionModel.id,
			usage: { input: 1, output: 1, totalTokens: 2 },
		});
		// The description is already in the transcript, and the request text is a fixed instruction.
		expect(journaled[0]).not.toHaveProperty("completion");
	});

	it("chooses the cheaper available vision model instead of catalog order", async () => {
		const unpriced = {
			...visionModel,
			id: "unpriced-vision",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const stub = makeCompleteStub("description");
		await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			makeDeps(testDir, [textModel, unpriced, visionModel, cheaperVisionModel], stub.fn),
		);

		expect(stub.calls[0]?.[0]).toMatchObject({ id: "gpt-4o-mini" });
	});

	it("prefers a declared free vision model over a paid one listed after it", async () => {
		const free = {
			...visionModel,
			id: "free-vision",
			pricingStatus: "free" as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const stub = makeCompleteStub("description");
		await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			makeDeps(testDir, [textModel, free, cheaperVisionModel], stub.fn),
		);

		expect(stub.calls[0]?.[0]).toMatchObject({ id: "free-vision" });
	});

	it("keeps a configured vision role ahead of the cheaper fallback", async () => {
		const stub = makeCompleteStub("description");
		const deps = makeDeps(testDir, [textModel, visionModel, cheaperVisionModel], stub.fn);
		deps.settings = Settings.isolated({ modelRoles: { vision: "openai/gpt-4o" } });
		await describeAttachedImagesForTextModel([{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }], deps);

		expect(stub.calls[0]?.[0]).toMatchObject({ id: "gpt-4o" });
	});

	it("offline mode keeps the description on the active model's provider, over the vision role", async () => {
		const elsewhere = { ...cheaperVisionModel, provider: "elsewhere", id: "elsewhere-vision" };
		const stub = makeCompleteStub("description");
		const deps = makeDeps(testDir, [textModel, elsewhere, visionModel], stub.fn);
		deps.settings = Settings.isolated({
			"models.offline": true,
			modelRoles: { vision: "elsewhere/elsewhere-vision" },
		});
		await describeAttachedImagesForTextModel([{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }], deps);

		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.[0]).toMatchObject({ provider: "openai", id: "gpt-4o" });
	});

	it("offline mode describes nothing when only another provider has a vision model", async () => {
		const elsewhere = { ...visionModel, provider: "elsewhere" };
		const stub = makeCompleteStub("should not be used");
		const deps = makeDeps(testDir, [textModel, elsewhere], stub.fn);
		deps.settings = Settings.isolated({ "models.offline": true });
		const blocks = await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			deps,
		);

		expect(stub.calls).toHaveLength(0);
		// The note names the provider offline mode is holding the session to.
		expect(blocks[0]!.text).toContain("openai");
		expect(blocks[0]!.text).toMatch(/path="local:\/\/image-/);
	});

	it("saves the image but emits a no-vision note when no vision model is available", async () => {
		const stub = makeCompleteStub("should not be used");
		const blocks = await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			makeDeps(testDir, [textModel], stub.fn),
		);

		expect(blocks).toHaveLength(1);
		// No vision-capable model -> no model call, but a note + saved artifact.
		expect(stub.calls).toHaveLength(0);
		expect(blocks[0]!.text).toContain("No vision-capable model");

		const match = blocks[0]!.text.match(/path="local:\/\/([^"]+)"/);
		expect(match).not.toBeNull();
		const saved = await fs.readFile(path.join(testDir, "local", match![1]));
		expect(saved.toString("base64")).toBe(TINY_PNG_BASE64);
	});

	it("falls back to a note when the vision model returns no text", async () => {
		const stub = makeCompleteStub("   ");
		const blocks = await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			makeDeps(testDir, [textModel, visionModel], stub.fn),
		);

		expect(stub.calls).toHaveLength(1);
		expect(blocks[0]!.text).toContain("Image description unavailable");
	});

	it("is content-addressed: identical images reuse one saved file path", async () => {
		const image = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" } as const;
		const stub = makeCompleteStub("desc");
		const blocks = await describeAttachedImagesForTextModel(
			[image, image],
			makeDeps(testDir, [textModel, visionModel], stub.fn),
		);

		const paths = blocks.map(b => b.text.match(/path="(local:\/\/[^"]+)"/)![1]);
		expect(paths[0]).toBe(paths[1]);
	});
	it("treats a wire-stripped completions model as text-only when resolving the vision model", async () => {
		const stripped = buildModel({
			id: "deepseek-v4-flash",
			name: "deepseek-v4-flash",
			api: "openai-completions",
			provider: "myproxy",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
			compat: { stripImageInput: true },
		} as ModelSpec);
		const stub = makeCompleteStub("should not be used");
		const blocks = await describeAttachedImagesForTextModel(
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			makeDeps(testDir, [stripped], stub.fn),
		);
		expect(stub.calls).toHaveLength(0);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.text).toContain("No vision-capable model");
	});
});

describe("ImageDescriptions", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-transform-wire-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(testDir);
	});

	function makeProxyModel(compat: ModelSpec["compat"]): Model<Api> {
		return buildModel({
			id: "deepseek-v4-flash",
			name: "deepseek-v4-flash",
			api: "openai-completions",
			provider: "myproxy",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
			compat,
		} as ModelSpec);
	}

	it("falls back for a wire-stripped model that declares image input, not for an opted-out one", async () => {
		const stub = makeCompleteStub("should not be used");
		const { transform } = new ImageDescriptions(() => makeDeps(testDir, [], stub.fn));
		const context: Context = {
			systemPrompt: [],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this?" },
						{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
		};

		const stripped = await transform(context, makeProxyModel({ stripImageInput: true }));
		expect(stripped.messages[0]?.content).toEqual([
			{ type: "text", text: "what is this?" },
			{ type: "text", text: expect.stringContaining("No vision-capable model") },
		]);

		const optedOut = await transform(context, makeProxyModel({ stripImageInput: false }));
		expect(optedOut).toBe(context);
		expect(stub.calls).toHaveLength(0);
	});

	function imageContext(): Context {
		return {
			systemPrompt: [],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this?" },
						{ type: "image", data: RED_PNG_BASE64, mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
		};
	}

	it("offers neither a denied vision model nor a denied Factory fallback for the description", async () => {
		const factory = factoryModel("claude-fable-5", ["anthropic"]);
		const requests: CapturedRequest[] = [];
		const fetch = captureFetch(requests, anthropicChunks("A red pixel."));
		const deps = makeDeps(
			testDir,
			[textModel, cheaperVisionModel, factory],
			(model, context, options) => completeSimple(model, context, { ...options, fetch }),
			WORKOS_TOKEN,
		);
		deps.settings = Settings.isolated({
			modelRoles: { vision: "openai/gpt-4o-mini" },
			disabledModels: ["openai/gpt-4o-mini", "factory-droid/claude-opus-5"],
		});

		const described = await new ImageDescriptions(() => deps).transform(imageContext(), textModel);

		expect(JSON.stringify(described.messages)).toContain("A red pixel.");
		expect(requests.map(request => request.body.model)).toEqual([factory.id]);
		expect(requests[0]!.body.fallbacks).toBeUndefined();
	});

	it("keeps an image local when its description model becomes disabled before dispatch", async () => {
		const stub = makeCompleteStub("A red pixel.");
		const deps = makeDeps(testDir, [textModel, visionModel], stub.fn);
		vi.spyOn(deps.modelRegistry, "getApiKey").mockImplementationOnce(async () => {
			cfgDisabledModels.set(deps.settings, ["openai/gpt-4o"]);
			return "test-key";
		});
		const { transform } = new ImageDescriptions(() => deps);

		const withheld = await transform(imageContext(), textModel);
		expect(stub.calls).toHaveLength(0);
		expect(withheld.messages[0]?.content).toContainEqual({
			type: "text",
			text: expect.stringContaining('path="local://image-'),
		});

		cfgDisabledModels.set(deps.settings, []);
		const described = await transform(imageContext(), textModel);
		expect(JSON.stringify(described.messages)).toContain("A red pixel.");
		expect(stub.calls).toHaveLength(1);
	});

	it("describes an image once, for later requests and for a resumed session", async () => {
		const stub = makeCompleteStub("A red pixel.");
		const deps = () => makeDeps(testDir, [textModel, visionModel], stub.fn);

		const first = await new ImageDescriptions(deps).transform(imageContext(), textModel);
		const { transform } = new ImageDescriptions(deps);
		await transform(imageContext(), textModel);
		const resumed = await transform(imageContext(), textModel);

		expect(JSON.stringify(first.messages)).toContain("A red pixel.");
		expect(JSON.stringify(resumed.messages)).toContain("A red pixel.");
		expect(JSON.stringify(resumed.messages)).not.toContain('"type":"image"');
		expect(stub.calls).toHaveLength(1);
	});

	it("leaves summary archive frames and tool-result images to the provider", async () => {
		const stub = makeCompleteStub("should not be used");
		const { transform } = new ImageDescriptions(() => makeDeps(testDir, [textModel, visionModel], stub.fn));
		const image = { type: "image" as const, data: RED_PNG_BASE64, mimeType: "image/png" };
		const context: Context = {
			systemPrompt: [],
			messages: [
				{ role: "user", content: [image], historyRewriteAt: 1, timestamp: 1 },
				{
					role: "toolResult",
					toolCallId: "call",
					toolName: "read",
					content: [image],
					isError: false,
					timestamp: 2,
				},
			],
		};

		expect(await transform(context, textModel)).toBe(context);
		expect(stub.calls).toHaveLength(0);
	});

	it("asks again after a failed description, once the retry delay has passed", async () => {
		let fail = true;
		const stub = makeCompleteStub("A red pixel.");
		const flaky = (async (...args: Parameters<typeof completeSimple>) => {
			const message = await stub.fn(...args);
			return fail ? { ...message, stopReason: "error" as const } : message;
		}) as typeof completeSimple;
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const { transform } = new ImageDescriptions(() => makeDeps(testDir, [textModel, visionModel], flaky));

		const failed = await transform(imageContext(), textModel);
		fail = false;
		const meanwhile = await transform(imageContext(), textModel);
		now += 61_000;
		const retried = await transform(imageContext(), textModel);

		expect(JSON.stringify(failed.messages)).toContain("Image description unavailable");
		expect(JSON.stringify(meanwhile.messages)).toContain("Image description unavailable");
		expect(JSON.stringify(retried.messages)).toContain("A red pixel.");
		expect(stub.calls).toHaveLength(2);
	});

	it("describes an image once a vision model becomes available, not before", async () => {
		const stub = makeCompleteStub("A red pixel.");
		let available: Model<Api>[] = [textModel];
		const { transform } = new ImageDescriptions(() => makeDeps(testDir, available, stub.fn));

		const unavailable = await transform(imageContext(), textModel);
		await transform(imageContext(), textModel);
		available = [textModel, visionModel];
		const described = await transform(imageContext(), textModel);

		expect(JSON.stringify(unavailable.messages)).toContain("No vision-capable model");
		expect(JSON.stringify(described.messages)).toContain("A red pixel.");
		expect(stub.calls).toHaveLength(1);
	});

	it("keeps at most four vision requests in flight", async () => {
		const stub = makeCompleteStub("A pixel.");
		let inFlight = 0;
		let peak = 0;
		// Requests hold until four are in flight, so an uncapped run would start a fifth meanwhile.
		const full = Promise.withResolvers<void>();
		const counted = (async (...args: Parameters<typeof completeSimple>) => {
			peak = Math.max(peak, ++inFlight);
			if (inFlight === 4) full.resolve();
			await full.promise;
			inFlight--;
			return stub.fn(...args);
		}) as typeof completeSimple;
		const { transform } = new ImageDescriptions(() => makeDeps(testDir, [textModel, visionModel], counted));
		const images = Array.from({ length: 9 }, (_, index) => ({
			type: "image" as const,
			data: Buffer.from(`image ${index}`).toString("base64"),
			mimeType: "image/png",
		}));

		const described = await transform(
			{ systemPrompt: [], messages: [{ role: "user", content: images, timestamp: 1 }] },
			textModel,
		);

		expect(JSON.stringify(described.messages)).not.toContain('"type":"image"');
		expect(stub.calls).toHaveLength(9);
		expect(peak).toBe(4);
	});

	it("describes the newest images first, so a history backlog cannot delay the current prompt's", async () => {
		const asked: string[] = [];
		const stub = makeCompleteStub("A pixel.");
		const recording = (async (model, context, options) => {
			const image = context.messages[0]?.content;
			if (Array.isArray(image) && image[0]?.type === "image") asked.push(image[0].data);
			return stub.fn(model, context, options);
		}) as typeof completeSimple;
		const { transform } = new ImageDescriptions(() => makeDeps(testDir, [textModel, visionModel], recording));
		const image = (label: string) => ({
			type: "image" as const,
			data: Buffer.from(label).toString("base64"),
			mimeType: "image/png",
		});
		const history = Array.from({ length: 8 }, (_, index) => image(`history ${index}`));
		const current = image("current prompt");

		await transform(
			{
				systemPrompt: [],
				messages: [
					{ role: "user", content: history, timestamp: 1 },
					{ role: "user", content: [{ type: "text", text: "what is this?" }, current], timestamp: 2 },
				],
			},
			textModel,
		);

		expect(asked).toHaveLength(9);
		expect(asked.slice(0, 4)).toContain(current.data);
	});

	it("stops asking a vision model that is timing out, leaving the rest for later", async () => {
		let requests = 0;
		const hang = (async (_model, _context, options) => {
			requests++;
			const { promise, reject } = Promise.withResolvers<never>();
			options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			return promise;
		}) as typeof completeSimple;
		// A real, short timeout: the request timeout is an AbortSignal.timeout, which fake timers do not drive.
		const { transform } = new ImageDescriptions(() => ({
			...makeDeps(testDir, [textModel, visionModel], hang),
			timeoutMs: 30,
		}));
		const images = Array.from({ length: 9 }, (_, index) => ({
			type: "image" as const,
			data: Buffer.from(`image ${index}`).toString("base64"),
			mimeType: "image/png",
		}));

		const result = await transform(
			{ systemPrompt: [], messages: [{ role: "user", content: images, timestamp: 1 }] },
			textModel,
		);

		expect(requests).toBe(4);
		const content = JSON.stringify(result.messages);
		expect(content.match(/Image description unavailable/g)).toHaveLength(4);
		expect(content.match(/"type":"image"/g)).toHaveLength(5);
	});

	it("finishes a description an aborted request started, for the next request", async () => {
		const stub = makeCompleteStub("A red pixel.");
		const release = Promise.withResolvers<void>();
		const held = (async (...args: Parameters<typeof completeSimple>) => {
			await release.promise;
			return stub.fn(...args);
		}) as typeof completeSimple;
		const { transform } = new ImageDescriptions(() => makeDeps(testDir, [textModel, visionModel], held));
		const controller = new AbortController();

		const aborted = transform(imageContext(), textModel, controller.signal);
		controller.abort();
		await expect(aborted).rejects.toThrow();
		release.resolve();
		const next = await transform(imageContext(), textModel);

		expect(JSON.stringify(next.messages)).toContain("A red pixel.");
		expect(stub.calls).toHaveLength(1);
	});
});
