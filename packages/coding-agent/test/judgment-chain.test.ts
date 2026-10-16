import { afterEach, describe, expect, it, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as path from "node:path";
import type { ChatUsageEvent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, ChoiceQuestion, ImageContent, Model, NoulQuestion } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChainJudge, hasNativeJudge, JudgmentCache, journalJudgmentUsage } from "@oh-my-pi/pi-coding-agent/judgment";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

const JEV_PREVIEW = {
	id: "jev-preview",
	name: "JEV Preview",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;

const OPENROUTER_DECISIONS_URL = "https://decisions.example.test/decisions";
const OPENROUTER_JEV = {
	...JEV_PREVIEW,
	id: "~typesafe/jev-latest",
	api: "openrouter-decisions",
	provider: "openrouter",
	baseUrl: "https://decisions.example.test",
	input: ["text", "image"],
} as Model<Api>;
const OPENROUTER_TEXT_ONLY = {
	...OPENROUTER_JEV,
	id: "text-only-openrouter",
	name: "Text-only native",
	input: ["text"],
} as Model<Api>;

const LOCAL = getBundledModel("local", "qwen2.5-1.5b");
const ONLINE = getBundledModel("anthropic", "claude-sonnet-4-6");
if (!LOCAL || !ONLINE) throw new Error("Expected bundled local and online judge models");

const ONLINE_BACKUP = { ...ONLINE, id: "claude-sonnet-judge-backup", name: "Judge Backup" } as Model<Api>;

const TEXT_ONLY = { ...ONLINE, id: "text-only-judge", name: "Text-only judge", input: ["text"] } as Model<Api>;

const VISION_CHAT = {
	...ONLINE,
	id: "vision-chat-judge",
	name: "Vision chat judge",
	input: ["text", "image"],
} as Model<Api>;
const OPENAI_DECISIONS = {
	...JEV_PREVIEW,
	id: "gpt-6-luna-decisions",
	requestModelId: "gpt-6-luna",
	name: "GPT-6 Luna Decisions",
	api: "openai-decisions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	input: ["text", "image"],
} as Model<Api>;

const OPENAI_DECISIONS_BACKUP = {
	...OPENAI_DECISIONS,
	id: "gpt-6-luna-decisions-backup",
	requestModelId: "gpt-6-luna-decisions-backup",
	name: "GPT-6 Luna Decisions Backup",
} as Model<Api>;

const IMAGE_ONE: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/png",
};
const IMAGE_TWO: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};
/** 320x320 grayscale PNG: inside Jev's 280–1568 px per-side bounds, unlike the 1x1 fixtures above. */
const JEV_IMAGE: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAAAAADo+/p2AAAAeklEQVR42u3BgQAAAADDoPlTH+ECVQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMA3kU8AAamZiz8AAAAASUVORK5CYII=",
	mimeType: "image/png",
};

const BUCKET_QUESTION: ChoiceQuestion<"trivial" | "moderate" | "hard"> = {
	type: "choice",
	instructions: "Choose a coarse task bucket.",
	criteria: { trivial: "mechanical", moderate: "localized", hard: "deep" },
};

const TIER_QUESTION: ChoiceQuestion<"low" | "high"> = {
	type: "choice",
	instructions: "Choose the reasoning tier.",
	criteria: { low: "simple", high: "complex" },
};

function makeRegistry(models: Model<Api>[], keys: Record<string, string> = {}): ModelRegistry {
	const authStorage = createInMemoryAuthStorage();
	for (const provider in keys) authStorage.keys.setRuntime(provider, keys[provider]!);
	const registry = new ModelRegistry(authStorage, "/nonexistent/judgment-chain-models.yml");
	// Return the supplied fixtures directly; getAvailable's normal auth filtering is intentionally bypassed.
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return registry;
}

function reply(model: Model<Api>, text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 3,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ChainJudge", () => {
	it("falls from a coarse local question to a tiered online question", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${LOCAL.provider}/${LOCAL.id}` },
			"retry.fallbackChains": { judge: [`${ONLINE.provider}/${ONLINE.id}`] },
		});
		const registry = makeRegistry([LOCAL, ONLINE], { [ONLINE.provider]: "online-key" });
		const kinds: string[] = [];
		let localPrompt = "";
		let onlinePrompt = "";
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_model, promptText) => {
			localPrompt = promptText;
			return "not a bucket";
		});
		vi.spyOn(ai, "completeSimple").mockImplementation(async (model, context, options) => {
			onlinePrompt = context.systemPrompt?.join("\n") ?? "";
			const response = reply(model, "level: high");
			options?.onAttempt?.(response);
			return response;
		});
		const onUsage = vi.fn();
		const judge = new ChainJudge({ settings, registry, purpose: "test", onUsage });

		const answer = await judge.withCandidate(async (candidate, kind) => {
			kinds.push(kind);
			if (kind === "local") {
				const result = await candidate.judge({
					state: "refactor the scheduler",
					questions: { bucket: BUCKET_QUESTION },
				});
				return result.answers.bucket.choice;
			}
			const result = await candidate.judge({
				state: "refactor the scheduler",
				questions: { level: TIER_QUESTION },
			});
			return result.answers.level.choice;
		});

		expect(answer).toBe("high");
		expect(kinds).toEqual(["local", "online"]);
		expect(localPrompt).toContain("trivial");
		expect(localPrompt).toContain("moderate");
		expect(localPrompt).toContain("hard");
		expect(onlinePrompt).toContain("low");
		expect(onlinePrompt).toContain("high");
		expect(onUsage).toHaveBeenCalledWith(
			expect.objectContaining({ role: "judge", provider: ONLINE.provider, model: ONLINE.id }),
		);
	});

	it("sends the selected TypeSafe model and base URL and attributes its usage", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: "typesafe/jev-preview" } });
		const registry = makeRegistry([JEV_PREVIEW], { typesafe: "ts-key" });
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (url, init) => {
				expect(String(url)).toBe("https://judge.example.test/v1/systemone");
				const body = JSON.parse(String(init?.body)) as { model: string };
				expect(body.model).toBe("jev-preview");
				return Response.json({
					model: "jev-1.13.0",
					answers: {
						level: { type: "choice", choice: "high", probabilities: { low: 0.1, high: 0.9 }, confidence: 0.8 },
					},
					usage: { input_tokens: 8, output_tokens: 2 },
				});
			}),
		);
		const onUsage = vi.fn();

		const result = await new ChainJudge({ settings, registry, purpose: "test", onUsage }).judge({
			state: "redesign the scheduler",
			questions: { level: TIER_QUESTION },
		});

		expect(result.answers.level.choice).toBe("high");
		expect(result.model).toBe("jev-1.13.0");
		expect(onUsage).toHaveBeenCalledWith(
			expect.objectContaining({ role: "typesafe", provider: "typesafe", model: "jev-preview" }),
		);
	});

	it("journals judgment usage on the active branch and stops once the session changes", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: "typesafe/jev-preview" } });
		const registry = makeRegistry([JEV_PREVIEW], { typesafe: "ts-key" });
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async () =>
				Response.json({
					model: "jev-1.13.0",
					answers: {
						level: { type: "choice", choice: "high", probabilities: { low: 0.1, high: 0.9 }, confidence: 0.8 },
					},
					usage: { input_tokens: 8, output_tokens: 2 },
				}),
			),
		);
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "locate the scheduler", timestamp: 1 });
		const leafBefore = manager.getLeafId();
		const judge = new ChainJudge({ settings, registry, purpose: "find", onUsage: journalJudgmentUsage(manager) });
		const request = { state: "redesign the scheduler", questions: { level: TIER_QUESTION } };

		await judge.judge(request);
		const usage = manager.getBranch().filter(entry => entry.type === "model_usage");
		expect(usage).toHaveLength(1);
		expect(usage[0]).toMatchObject({
			parentId: leafBefore,
			purpose: "find",
			role: "typesafe",
			model: "jev-preview",
			usage: { input: 8, output: 2 },
		});
		expect(manager.getLeafId()).toBe(usage[0]!.id);

		await manager.newSession();
		await judge.judge(request);
		expect(manager.getBranch().filter(entry => entry.type === "model_usage")).toHaveLength(0);
	});

	it("falls back from a failed native judge only to another native judge", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: "typesafe/jev-preview" },
			"retry.fallbackChains": {
				judge: [`${LOCAL.provider}/${LOCAL.id}`, `${OPENROUTER_JEV.provider}/${OPENROUTER_JEV.id}`],
			},
		});
		const registry = makeRegistry([JEV_PREVIEW, LOCAL, OPENROUTER_JEV, ONLINE], {
			typesafe: "ts-key",
			openrouter: "or-key",
			[ONLINE.provider]: "online-key",
		});
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async url => {
				urls.push(String(url));
				if (String(url).endsWith("/v1/systemone")) return new Response("rejected", { status: 400 });
				return Response.json({
					model: "jev-1.13.0",
					answers: { level: { type: "choice", choice: "high" } },
					usage: { input_tokens: 8, output_tokens: 2 },
				});
			}),
		);
		const local = vi.spyOn(tinyModelClient, "complete");
		const online = vi.spyOn(ai, "completeSimple");

		const result = await new ChainJudge({ settings, registry, purpose: "test", sessionModel: ONLINE_BACKUP }).judge({
			state: "redesign the scheduler",
			questions: { level: TIER_QUESTION },
		});

		expect(result.answers.level.choice).toBe("high");
		expect(urls).toEqual(["https://judge.example.test/v1/systemone", OPENROUTER_DECISIONS_URL]);
		expect(local).not.toHaveBeenCalled();
		expect(online).not.toHaveBeenCalled();
	});

	it("fails instead of degrading to a prompted model, and skips a rejected account on later calls", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: "typesafe/jev-preview" },
			"retry.fallbackChains": { judge: [`${ONLINE.provider}/${ONLINE.id}`] },
		});
		const registry = makeRegistry([JEV_PREVIEW, ONLINE], { typesafe: "ts-key", [ONLINE.provider]: "online-key" });
		const typesafeCalls = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(
				asGlobalFetch(async () => Response.json({ detail: { error_type: "billing_error" } }, { status: 402 })),
			);
		const online = vi.spyOn(ai, "completeSimple");
		const onUsage = vi.fn();
		const request = { state: "rename a local", questions: { level: TIER_QUESTION } };

		await expect(
			new ChainJudge({ settings, registry, purpose: "test", sessionModel: ONLINE, onUsage }).judge(request),
		).rejects.toThrow("402");
		await expect(new ChainJudge({ settings, registry, purpose: "test", onUsage }).judge(request)).rejects.toThrow(
			"rejected the account recently",
		);

		expect(typesafeCalls).toHaveBeenCalledTimes(1);
		expect(online).not.toHaveBeenCalled();
		expect(onUsage).toHaveBeenCalledTimes(1);
		expect(onUsage).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "typesafe", model: "jev-preview", stopReason: "error" }),
		);
	});

	it("skips text-only chat and local candidates for image judgments", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${TEXT_ONLY.provider}/${TEXT_ONLY.id}` },
			"retry.fallbackChains": {
				judge: [`${LOCAL.provider}/${LOCAL.id}`, `${OPENAI_DECISIONS.provider}/${OPENAI_DECISIONS.id}`],
			},
		});
		const registry = makeRegistry([TEXT_ONLY, LOCAL, OPENAI_DECISIONS], {
			[TEXT_ONLY.provider]: "text-key",
			[OPENAI_DECISIONS.provider]: "openai-key",
		});
		const chat = vi.spyOn(ai, "completeSimple");
		const local = vi.spyOn(tinyModelClient, "complete");
		let body: { input?: unknown } | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_url, init) => {
				body = JSON.parse(String(init?.body));
				return Response.json({
					model: "gpt-6-luna",
					answers: [{ type: "predicate", name: "visible", probability: 0.75 }],
					usage: { input_tokens: 8, output_tokens: 0 },
				});
			}),
		);
		const nativeImage: ImageContent = { ...IMAGE_ONE, detail: "original" };

		const result = await new ChainJudge({ settings, registry, purpose: "test" }).judge({
			state: "look at this",
			questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
			images: [nativeImage],
		});

		expect(result.answers.visible.noul).toBe(0.75);
		expect(chat).not.toHaveBeenCalled();
		expect(local).not.toHaveBeenCalled();
		const serializedInput = JSON.stringify(body?.input);
		expect(serializedInput).toContain('"type":"input_text"');
		expect(serializedInput).toContain('"type":"input_image"');
		expect(serializedInput).toContain(`data:image/png;base64,${nativeImage.data}`);
		expect(serializedInput).toContain('"detail":"original"');
	});

	it("selects OpenRouter Jev after filtering the text-only native candidate", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${OPENROUTER_TEXT_ONLY.provider}/${OPENROUTER_TEXT_ONLY.id}` },
			"retry.fallbackChains": {
				judge: [`${OPENROUTER_JEV.provider}/${OPENROUTER_JEV.id}`, `${VISION_CHAT.provider}/${VISION_CHAT.id}`],
			},
		});
		const registry = makeRegistry([OPENROUTER_TEXT_ONLY, OPENROUTER_JEV, VISION_CHAT], {
			openrouter: "or-key",
			[VISION_CHAT.provider]: "vision-key",
		});
		let nativeUrl: string | undefined;
		const native = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async url => {
				nativeUrl = String(url);
				return Response.json({
					model: OPENROUTER_JEV.id,
					answers: { visible: { type: "noul", noul: 0.75 } },
					usage: { input_tokens: 8, output_tokens: 0 },
				});
			}),
		);
		const chat = vi.spyOn(ai, "completeSimple");

		const result = await new ChainJudge({ settings, registry, purpose: "test" }).judge({
			state: "look at this",
			questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
			images: [JEV_IMAGE],
		});

		expect(result.answers.visible.noul).toBe(0.75);
		expect(native).toHaveBeenCalledTimes(1);
		expect(nativeUrl).toBe(OPENROUTER_DECISIONS_URL);
		expect(chat).not.toHaveBeenCalled();
	});

	it("uses vision chat when the image falls outside the native judge's size bounds", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${OPENROUTER_JEV.provider}/${OPENROUTER_JEV.id}` },
			"retry.fallbackChains": { judge: [`${VISION_CHAT.provider}/${VISION_CHAT.id}`] },
		});
		const registry = makeRegistry([OPENROUTER_JEV, VISION_CHAT], {
			openrouter: "or-key",
			[VISION_CHAT.provider]: "vision-key",
		});
		const native = vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(async () => Response.json({})));
		const chat = vi.spyOn(ai, "completeSimple").mockImplementation(async (model, _context, options) => {
			const response = reply(model, "visible: yes");
			options?.onAttempt?.(response);
			return response;
		});

		// IMAGE_ONE is 1x1, below Jev's 280 px minimum side, which Jev rejects rather than resizes.
		const result = await new ChainJudge({ settings, registry, purpose: "test" }).judge({
			state: "look at this",
			questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
			images: [IMAGE_ONE],
		});

		expect(result.answers.visible.noul).toBe(1);
		expect(native).not.toHaveBeenCalled();
		expect(chat).toHaveBeenCalledTimes(1);
	});

	it("reports an explicit error when no candidate supports image judgments", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: `${LOCAL.provider}/${LOCAL.id}` } });
		const registry = makeRegistry([LOCAL]);
		const local = vi.spyOn(tinyModelClient, "complete");

		await expect(
			new ChainJudge({ settings, registry, purpose: "test" }).judge({
				state: "look at this",
				questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
				images: [IMAGE_ONE],
			}),
		).rejects.toThrow("judgment: no compatible judge candidate supports images");

		expect(local).not.toHaveBeenCalled();
	});

	it("uses vision chat after filtering the text-only native candidate", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${OPENROUTER_TEXT_ONLY.provider}/${OPENROUTER_TEXT_ONLY.id}` },
			"retry.fallbackChains": {
				judge: [`${VISION_CHAT.provider}/${VISION_CHAT.id}`],
			},
		});
		const registry = makeRegistry([OPENROUTER_TEXT_ONLY, VISION_CHAT], {
			openrouter: "or-key",
			[VISION_CHAT.provider]: "vision-key",
		});
		const native = vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(async () => Response.json({})));
		let userContent: unknown;
		const chat = vi.spyOn(ai, "completeSimple").mockImplementation(async (model, context, options) => {
			userContent = context.messages.find(message => message.role === "user")?.content;
			const response = reply(model, "visible: yes");
			options?.onAttempt?.(response);
			return response;
		});

		const result = await new ChainJudge({ settings, registry, purpose: "test" }).judge({
			state: "look at this",
			questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
			images: [IMAGE_ONE],
		});

		expect(result.answers.visible.noul).toBe(1);
		expect(native).not.toHaveBeenCalled();
		expect(chat).toHaveBeenCalledTimes(1);
		const imageBlocks = Array.isArray(userContent)
			? userContent.filter((block): block is ImageContent => block.type === "image")
			: [];
		expect(imageBlocks).toHaveLength(1);
		const imageMetadata = await new Bun.Image(Buffer.from(imageBlocks[0]!.data, "base64")).metadata();
		expect(Math.min(imageMetadata.width, imageMetadata.height)).toBeGreaterThanOrEqual(200);
		expect(imageBlocks[0]?.data).not.toBe(IMAGE_ONE.data);
	});

	it("normalizes prompted image inputs for each selected model without mutating originals", async () => {
		const stbModel = {
			...VISION_CHAT,
			id: "stb-vision-chat-judge",
			name: "STB vision chat judge",
			imageInputDecoder: "stb",
		} as Model<Api>;
		const settings = Settings.isolated({
			modelRoles: { judge: `${stbModel.provider}/${stbModel.id}` },
			"retry.fallbackChains": { judge: [`${VISION_CHAT.provider}/${VISION_CHAT.id}`] },
		});
		const registry = makeRegistry([stbModel, VISION_CHAT], { [VISION_CHAT.provider]: "vision-key" });
		const tinyImage: ImageContent = { ...IMAGE_ONE, detail: "original" };
		const webpBytes = await new Bun.Image(Buffer.from(IMAGE_ONE.data, "base64"))
			.resize(200, 200, { filter: "nearest" })
			.webp({ quality: 90 })
			.bytes();
		const webpImage: ImageContent = {
			type: "image",
			data: Buffer.from(webpBytes).toString("base64"),
			mimeType: "image/webp",
			detail: "high",
		};
		const attempts: Array<{ model: Model<Api>; images: ImageContent[] }> = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (model, context, options) => {
			const user = context.messages.find(message => message.role === "user");
			const images = Array.isArray(user?.content)
				? user.content.filter((block): block is ImageContent => block.type === "image")
				: [];
			attempts.push({ model, images });
			if (attempts.length === 1) throw new Error("first prompted candidate failed");
			const response = reply(model, "visible: yes");
			options?.onAttempt?.(response);
			return response;
		});

		const result = await new ChainJudge({ settings, registry, purpose: "test" }).judge({
			state: "look at this",
			questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
			images: [tinyImage, webpImage],
		});

		expect(result.answers.visible.noul).toBe(1);
		expect(attempts.map(({ model }) => model.id)).toEqual([stbModel.id, VISION_CHAT.id]);
		const [stbImages, fallbackImages] = attempts.map(attempt => attempt.images);
		expect(stbImages).toHaveLength(2);
		expect(stbImages[0]?.detail).toBe("original");
		expect(stbImages[0]?.data).not.toBe(tinyImage.data);
		const tinyMetadata = await new Bun.Image(Buffer.from(stbImages[0]!.data, "base64")).metadata();
		expect(Math.min(tinyMetadata.width, tinyMetadata.height)).toBeGreaterThanOrEqual(200);
		expect(stbImages[1]?.mimeType).not.toBe("image/webp");
		expect(stbImages[1]?.data).not.toBe(webpImage.data);
		expect(stbImages[1]?.detail).toBe("high");
		const convertedWebpMetadata = await new Bun.Image(Buffer.from(stbImages[1]!.data, "base64")).metadata();
		expect(Math.min(convertedWebpMetadata.width, convertedWebpMetadata.height)).toBeGreaterThanOrEqual(200);
		expect(fallbackImages?.[1]).toEqual(webpImage);
		expect(fallbackImages?.[0]?.detail).toBe("original");
		expect(fallbackImages?.[0]?.data).not.toBe(tinyImage.data);
		expect(tinyImage).toEqual({ ...IMAGE_ONE, detail: "original" });
		expect(webpImage.mimeType).toBe("image/webp");
	});

	it("does not prompt after a compatible native image judgment fails", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${OPENAI_DECISIONS.provider}/${OPENAI_DECISIONS.id}` },
			"retry.fallbackChains": { judge: [`${VISION_CHAT.provider}/${VISION_CHAT.id}`] },
		});
		const registry = makeRegistry([OPENAI_DECISIONS, VISION_CHAT], {
			[OPENAI_DECISIONS.provider]: "openai-key",
			[VISION_CHAT.provider]: "vision-key",
		});
		const native = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(asGlobalFetch(async () => new Response("native failed", { status: 400 })));
		const chat = vi.spyOn(ai, "completeSimple");

		await expect(
			new ChainJudge({ settings, registry, purpose: "test" }).judge({
				state: "look at this",
				questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
				images: [IMAGE_ONE],
			}),
		).rejects.toThrow("400");

		expect(native).toHaveBeenCalledTimes(1);
		expect(chat).not.toHaveBeenCalled();
	});

	it("falls from one image native to another without prompting", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${OPENAI_DECISIONS.provider}/${OPENAI_DECISIONS.id}` },
			"retry.fallbackChains": {
				judge: [
					`${OPENAI_DECISIONS_BACKUP.provider}/${OPENAI_DECISIONS_BACKUP.id}`,
					`${VISION_CHAT.provider}/${VISION_CHAT.id}`,
				],
			},
		});
		const registry = makeRegistry([OPENAI_DECISIONS, OPENAI_DECISIONS_BACKUP, VISION_CHAT], {
			[OPENAI_DECISIONS.provider]: "openai-key",
			[VISION_CHAT.provider]: "vision-key",
		});
		const requestedModels: (string | undefined)[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_url, init) => {
				const body = JSON.parse(String(init?.body)) as { model?: string };
				requestedModels.push(body.model);
				if (requestedModels.length === 1) return new Response("native failed", { status: 400 });
				return Response.json({
					model: "gpt-6-luna-decisions-backup",
					answers: [{ type: "predicate", name: "visible", probability: 0.75 }],
					usage: { input_tokens: 8, output_tokens: 0 },
				});
			}),
		);
		const chat = vi.spyOn(ai, "completeSimple");

		const result = await new ChainJudge({ settings, registry, purpose: "test" }).judge({
			state: "look at this",
			questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
			images: [IMAGE_ONE],
		});

		expect(result.answers.visible.noul).toBe(0.75);
		expect(requestedModels).toEqual(["gpt-6-luna", "gpt-6-luna-decisions-backup"]);
		expect(chat).not.toHaveBeenCalled();
	});

	it("rejects a malformed image as caller error without trying any candidate", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${OPENAI_DECISIONS.provider}/${OPENAI_DECISIONS.id}` },
			"retry.fallbackChains": {
				judge: [
					`${OPENAI_DECISIONS_BACKUP.provider}/${OPENAI_DECISIONS_BACKUP.id}`,
					`${VISION_CHAT.provider}/${VISION_CHAT.id}`,
				],
			},
		});
		const registry = makeRegistry([OPENAI_DECISIONS, OPENAI_DECISIONS_BACKUP, VISION_CHAT], {
			[OPENAI_DECISIONS.provider]: "openai-key",
			[VISION_CHAT.provider]: "vision-key",
		});
		const native = vi.spyOn(globalThis, "fetch");
		const chat = vi.spyOn(ai, "completeSimple");

		await expect(
			new ChainJudge({ settings, registry, purpose: "test" }).judge({
				state: "look at this",
				questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
				images: [{ ...IMAGE_ONE, data: "not base64!" }],
			}),
		).rejects.toThrow("judgment: images[0] must contain non-empty base64 data");

		expect(native).not.toHaveBeenCalled();
		expect(chat).not.toHaveBeenCalled();
	});

	it("uses a capable session model when image filtering removes every native candidate", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: "typesafe/jev-preview" },
			"retry.fallbackChains": {
				judge: [`${OPENROUTER_TEXT_ONLY.provider}/${OPENROUTER_TEXT_ONLY.id}`],
			},
		});
		const registry = makeRegistry([JEV_PREVIEW, OPENROUTER_TEXT_ONLY], {
			[VISION_CHAT.provider]: "vision-key",
		});
		const native = vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(async () => Response.json({})));
		const chat = vi.spyOn(ai, "completeSimple").mockImplementation(async (model, _context, options) => {
			const response = reply(model, "visible: yes");
			options?.onAttempt?.(response);
			return response;
		});

		const result = await new ChainJudge({
			settings,
			registry,
			purpose: "test",
			sessionModel: VISION_CHAT,
		}).judge({
			state: "look at this",
			questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
			images: [IMAGE_ONE],
		});

		expect(result.answers.visible.noul).toBe(1);
		expect(native).not.toHaveBeenCalled();
		expect(chat).toHaveBeenCalledTimes(1);
	});

	it("rejects an image-incapable session model after filtering text-only natives", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: "typesafe/jev-preview" },
			"retry.fallbackChains": {
				judge: [`${OPENROUTER_TEXT_ONLY.provider}/${OPENROUTER_TEXT_ONLY.id}`],
			},
		});
		const registry = makeRegistry([JEV_PREVIEW, OPENROUTER_TEXT_ONLY], {
			[TEXT_ONLY.provider]: "text-key",
		});
		const native = vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(async () => Response.json({})));
		const chat = vi.spyOn(ai, "completeSimple");

		await expect(
			new ChainJudge({ settings, registry, purpose: "test", sessionModel: TEXT_ONLY }).judge({
				state: "look at this",
				questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
				images: [IMAGE_ONE],
			}),
		).rejects.toThrow("judgment: no compatible judge candidate supports images");

		expect(native).not.toHaveBeenCalled();
		expect(chat).not.toHaveBeenCalled();
	});

	it("propagates caller abort without attempting a fallback", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` },
			"retry.fallbackChains": { judge: [`${LOCAL.provider}/${LOCAL.id}`] },
		});
		const registry = makeRegistry([ONLINE, LOCAL], { [ONLINE.provider]: "online-key" });
		const controller = new AbortController();
		vi.spyOn(registry, "getApiKey").mockImplementation(async () => {
			controller.abort(new Error("caller stopped"));
			throw new Error("credential refresh interrupted");
		});
		const local = vi.spyOn(tinyModelClient, "complete");

		await expect(
			new ChainJudge({ settings, registry, purpose: "test" }).judge(
				{ state: "x", questions: { level: TIER_QUESTION } },
				{ signal: controller.signal },
			),
		).rejects.toThrow("caller stopped");
		expect(local).not.toHaveBeenCalled();
	});

	it("does not append a session model already present in the configured chain", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` },
			"retry.fallbackChains": { judge: [`${ONLINE_BACKUP.provider}/${ONLINE_BACKUP.id}`] },
		});
		const registry = makeRegistry([ONLINE, ONLINE_BACKUP], { [ONLINE.provider]: "online-key" });
		const attempted: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async model => {
			attempted.push(model.id);
			if (model.id === ONLINE.id) return reply(model, "unparseable");
			return reply(model, "level: low");
		});

		const result = await new ChainJudge({ settings, registry, purpose: "test", sessionModel: ONLINE }).judge({
			state: "rename a local",
			questions: { level: TIER_QUESTION },
		});

		expect(result.answers.level.choice).toBe("low");
		// The primary's three entries are its initial completion plus two format
		// corrections. A duplicated session fallback would add another three.
		expect(attempted).toEqual([ONLINE.id, ONLINE.id, ONLINE.id, ONLINE_BACKUP.id]);
	});

	it("follows a judge role change inside the chain reuse window, agreeing with the native gate", () => {
		const settings = Settings.isolated({ modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` } });
		const registry = makeRegistry([JEV_PREVIEW, ONLINE], { typesafe: "ts-key", [ONLINE.provider]: "online-key" });
		expect(new ChainJudge({ settings, registry, purpose: "test" }).primaryModel()?.id).toBe(ONLINE.id);

		cfgModelRoles.override(settings, { judge: "typesafe/jev-preview" });

		// A gated feature (find, tab.goal) passes on a native judge, so its judge must route there too.
		expect(hasNativeJudge(settings, registry)).toBe(true);
		expect(new ChainJudge({ settings, registry, purpose: "test" }).primaryModel()?.id).toBe(JEV_PREVIEW.id);
	});

	it("resolves and forwards configured headers to native judgment models", async () => {
		const recordedHeaders: Record<string, string>[] = [];
		const nativeModel = {
			...JEV_PREVIEW,
			id: "jev-custom-headers",
			api: "openrouter-decisions" as const,
			provider: "custom-judge",
			baseUrl: "https://custom.example/v1",
			resolveHeaders: async () => ({
				"x-custom-routing": "router-1",
				"x-custom-tenant": "tenant-abc",
			}),
		} as Model<Api>;

		const settings = Settings.isolated({
			modelRoles: { judge: "custom-judge/jev-custom-headers" },
		});
		const registry = makeRegistry([nativeModel], { "custom-judge": "test-key" });

		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch((_url, init) => {
				const h = new Headers(init?.headers);
				recordedHeaders.push({
					auth: h.get("authorization") ?? "",
					customRouting: h.get("x-custom-routing") ?? "",
					customTenant: h.get("x-custom-tenant") ?? "",
				});
				return Response.json({
					model: "typesafe/jev-1.13",
					answers: { level: { type: "choice", choice: "low" } },
					usage: { input_tokens: 10, output_tokens: 2 },
				});
			}),
		);

		const result = await new ChainJudge({ settings, registry, purpose: "test" }).judge({
			state: "mechanical task",
			questions: { level: TIER_QUESTION },
		});

		expect(result.answers.level.choice).toBe("low");
		expect(recordedHeaders).toEqual([
			{
				auth: "Bearer test-key",
				customRouting: "router-1",
				customTenant: "tenant-abc",
			},
		]);
	});

	it("answers repeated questions from the cache and sends only the unanswered ones", async () => {
		using tempDir = TempDir.createSync("@omp-judgment-cache-");
		const dbPath = path.join(tempDir.path(), "judgment-cache.db");
		const cache = JudgmentCache.open(dbPath);
		// $1000/M input tokens: 10 tokens per question bill $0.01 each.
		const priced = { ...JEV_PREVIEW, cost: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
		const settings = Settings.isolated({ modelRoles: { judge: "typesafe/jev-preview" } });
		const registry = makeRegistry([priced], { typesafe: "ts-key" });
		const sent: string[][] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_url, init) => {
				const body = JSON.parse(String(init?.body)) as { questions: Record<string, NoulQuestion> };
				const ids = Object.keys(body.questions);
				sent.push(ids);
				const answers: Record<string, { type: "noul"; noul: number }> = {};
				for (const id of ids) answers[id] = { type: "noul", noul: id === "a" ? 0.9 : 0.2 };
				return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 10 * ids.length } });
			}),
		);
		const onUsage = vi.fn();
		const judge = new ChainJudge({ settings, registry, purpose: "test", onUsage, cache });
		const question = (instructions: string): NoulQuestion => ({ type: "noul", instructions });

		await judge.judge({ state: { file: "a.ts", body: "x" }, questions: { a: question("A?"), b: question("B?") } });
		// Same state with reordered keys: only the new question reaches the provider.
		const second = await judge.judge({
			state: { body: "x", file: "a.ts" },
			questions: { b: question("B?"), c: question("C?") },
		});
		const third = await judge.judge({ state: { file: "a.ts", body: "x" }, questions: { a: question("A?") } });
		// A changed instruction is a different question.
		await judge.judge({ state: { file: "a.ts", body: "x" }, questions: { a: question("A, really?") } });

		expect(sent).toEqual([["a", "b"], ["c"], ["a"]]);
		expect(second.answers.b.noul).toBe(0.2);
		expect(second.usage.input).toBe(10);
		expect(third.answers.a.noul).toBe(0.9);
		expect(third.usage.cost.total).toBe(0);
		// The fully cached request never reaches the ledger.
		expect(onUsage.mock.calls.map(([usage]) => usage.usage.cost.total)).toEqual([0.02, 0.01, 0.01]);

		cache.close();
		using db = new Database(dbPath, { readonly: true });
		const rows = db
			.query<{ names: string; price: number }, []>(
				"SELECT (SELECT group_concat(o.name) FROM oracle o, json_each(u.results) r WHERE o.id = r.value) AS names, u.price FROM usage u ORDER BY u.id",
			)
			.all();
		expect(rows).toEqual([
			{ names: "a,b", price: 0.02 },
			{ names: "c", price: 0.01 },
			{ names: "a", price: 0.01 },
		]);
		expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM states").get()?.n).toBe(1);
	});

	it("keys native answer caching by ordered image digests and detail without persisting payloads", async () => {
		using tempDir = TempDir.createSync("@omp-judgment-image-cache-");
		const dbPath = path.join(tempDir.path(), "judgment-cache.db");
		const cache = JudgmentCache.open(dbPath);
		const questions = { visible: { type: "noul" as const, instructions: "Is an object visible?" } };
		const identity = (images: ImageContent[]) => cache.lookup("identity", { state: "same", questions, images });
		const ordered = identity([IMAGE_ONE, IMAGE_TWO]);
		const reversed = identity([IMAGE_TWO, IMAGE_ONE]);
		const changedMime = identity([{ ...IMAGE_ONE, mimeType: "image/jpeg" }, IMAGE_TWO]);
		expect(new Set([ordered.stateId, reversed.stateId, changedMime.stateId]).size).toBe(3);

		const settings = Settings.isolated({
			modelRoles: { judge: `${OPENAI_DECISIONS.provider}/${OPENAI_DECISIONS.id}` },
		});
		const registry = makeRegistry([OPENAI_DECISIONS], { [OPENAI_DECISIONS.provider]: "openai-key" });
		let calls = 0;
		let probability = 0.75;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async () => {
				calls++;
				return Response.json({
					model: "gpt-6-luna",
					answers: [{ type: "predicate", name: "visible", probability }],
					usage: { input_tokens: 8, output_tokens: 0 },
				});
			}),
		);
		const judge = new ChainJudge({ settings, registry, purpose: "test", cache });
		const request = { state: "same", questions, images: [IMAGE_ONE] };
		await judge.judge(request);
		await judge.judge({ ...request, images: [IMAGE_TWO] });
		await judge.judge(request);
		const lowDetail: ImageContent["detail"] = "low";
		const highDetail: ImageContent["detail"] = "high";
		const autoDetail: ImageContent["detail"] = "auto";
		const lowRequest = { ...request, images: [{ ...IMAGE_ONE, detail: lowDetail }] };
		const highRequest = { ...request, images: [{ ...IMAGE_ONE, detail: highDetail }] };
		const autoRequest = { ...request, images: [{ ...IMAGE_ONE, detail: autoDetail }] };
		probability = 0.2;
		const low = await judge.judge(lowRequest);
		expect(low.answers.visible).toEqual({ type: "noul", noul: 0.2 });
		probability = 0.9;
		const high = await judge.judge(highRequest);
		expect(high.answers.visible).toEqual({ type: "noul", noul: 0.9 });
		const repeatedLow = await judge.judge(lowRequest);
		expect(repeatedLow.answers.visible).toEqual({ type: "noul", noul: 0.2 });
		const explicitAuto = await judge.judge(autoRequest);
		expect(explicitAuto.answers.visible).toEqual({ type: "noul", noul: 0.75 });

		expect(calls).toBe(4);

		using db = new Database(dbPath, { readonly: true });
		const states = db.query<{ state: string }, []>("SELECT state FROM states").all();
		expect(states).toHaveLength(4);
		for (const { state } of states) {
			expect(state).toStartWith("multimodal-judgment-cache-v1:");
			expect(state).toContain('"digest"');
			expect(state).not.toContain(IMAGE_ONE.data);
			expect(state).not.toContain(IMAGE_TWO.data);
		}
	});

	it("rejects malformed image aliases before serving native cached answers", async () => {
		using tempDir = TempDir.createSync("@omp-judgment-image-cache-validation-");
		const cache = JudgmentCache.open(path.join(tempDir.path(), "judgment-cache.db"));
		try {
			const settings = Settings.isolated({
				modelRoles: { judge: `${OPENAI_DECISIONS.provider}/${OPENAI_DECISIONS.id}` },
			});
			const registry = makeRegistry([OPENAI_DECISIONS], { [OPENAI_DECISIONS.provider]: "openai-key" });
			const questions = { visible: { type: "noul" as const, instructions: "Is an object visible?" } };
			const request = { state: "same", questions, images: [IMAGE_TWO] };
			let calls = 0;
			vi.spyOn(globalThis, "fetch").mockImplementation(
				asGlobalFetch(async () => {
					calls++;
					return Response.json({
						model: "gpt-6-luna",
						answers: [{ type: "predicate", name: "visible", probability: 0.75 }],
						usage: { input_tokens: 8, output_tokens: 0 },
					});
				}),
			);
			const judge = new ChainJudge({ settings, registry, purpose: "test", cache });

			const cached = await judge.judge(request);
			expect(cached.answers.visible).toEqual({ type: "noul", noul: 0.75 });
			expect(calls).toBe(1);

			await expect(
				judge.judge({ ...request, images: [{ ...IMAGE_TWO, data: `${IMAGE_TWO.data}=` }] }),
			).rejects.toThrow("judgment: images[0] must contain non-empty base64 data");
			expect(calls).toBe(1);

			const unpadded = await judge.judge({
				...request,
				images: [{ ...IMAGE_TWO, data: IMAGE_TWO.data.replace(/=+$/, "") }],
			});
			expect(unpadded.answers.visible).toEqual(cached.answers.visible);
			expect(calls).toBe(1);

			// The wire lowercases MIME types, so a case variant is the same image.
			const uppercase = await judge.judge({ ...request, images: [{ ...IMAGE_TWO, mimeType: "IMAGE/PNG" }] });
			expect(uppercase.answers.visible).toEqual(cached.answers.visible);
			expect(calls).toBe(1);
		} finally {
			cache.close();
		}
	});

	it("bills a chat-backed judgment once per completion attempt on the ledger and in telemetry", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` } });
		const registry = makeRegistry([ONLINE], { [ONLINE.provider]: "online-key" });
		const replies = ["no idea", "level: high"];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (model, _context, options) => {
			const response = reply(model, replies.shift() ?? "");
			response.usage.cost = { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 };
			options?.onAttempt?.(response);
			return response;
		});
		const onUsage = vi.fn();
		const events: ChatUsageEvent[] = [];
		const judge = new ChainJudge({
			settings,
			registry,
			purpose: "test",
			onUsage,
			telemetry: { onChatUsage: event => void events.push(event) },
		});

		// Telemetry hooks fire synchronously inside the attempt report.
		const result = await judge.judge({ state: "redesign the scheduler", questions: { level: TIER_QUESTION } });

		expect(result.answers.level.choice).toBe("high");
		// Two attempts (initial + format correction): each billed once, never re-billed from the aggregate result.
		expect(onUsage.mock.calls.map(([usage]) => usage.usage.cost.total)).toEqual([0.01, 0.01]);
		expect(events.map(event => [event.operation, event.cost])).toEqual([
			["judgment", { usd: 0.01, inputUsd: 0.01, outputUsd: 0 }],
			["judgment", { usd: 0.01, inputUsd: 0.01, outputUsd: 0 }],
		]);
	});
});
