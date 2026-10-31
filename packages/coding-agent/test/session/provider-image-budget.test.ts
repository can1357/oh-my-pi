import { describe, expect, it } from "bun:test";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	ModelSpec,
	TextContent,
	Tool,
} from "@oh-my-pi/pi-ai";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamFactoryDroid } from "@oh-my-pi/pi-ai/providers/factory-droid";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { factoryDroidRegistry } from "@oh-my-pi/pi-catalog/compat/factory-droid";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { factoryDroidWireBaseUrl } from "@oh-my-pi/pi-catalog/wire/factory-droid";
import { decorateContextImages } from "@oh-my-pi/pi-coding-agent/blob-broker/context-images";
import {
	capArchiveFrameBytes,
	clampProviderContextImageBytes,
	clampProviderContextImages,
} from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import { isRecord } from "@oh-my-pi/pi-utils";

const UMANS_MODEL = buildModel({
	id: "umans-glm-5.2",
	name: "umans-glm-5.2",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const OPENAI_RESPONSES_MODEL = buildModel({
	id: "gpt-5.2",
	name: "gpt-5.2",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});

const ANTHROPIC_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-test",
	name: "claude-test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 4096,
};
const ANTHROPIC_MODEL = buildModel(ANTHROPIC_SPEC);
const ANTHROPIC_PROXY_MODEL = buildModel({ ...ANTHROPIC_SPEC, baseUrl: "https://anthropic-proxy.example.com" });
const CODEX_MODEL = getBundledModel("openai-codex", "gpt-6.1-sol");
const CODEX_PROXY_MODEL = buildModel({
	...toModelSpec(CODEX_MODEL),
	baseUrl: "https://codex-proxy.example/backend-api",
});
const ANTIGRAVITY_CLAUDE_MODEL = getBundledModel("google-antigravity", "claude-sonnet-4-6");
const ANTIGRAVITY_GEMINI_MODEL = getBundledModel("google-antigravity", "gemini-3.7-flash");
const XAI_MODEL = getBundledModel("xai", "grok-4.7");
const XAI_OAUTH_MODEL = getBundledModel("xai-oauth", "grok-4.7");
const CURSOR_CLAUDE_MODEL = getBundledModel("cursor", "claude-opus-5-high");
const CURSOR_GPT_MODEL = getBundledModel("cursor", "gpt-5.5");
const CURSOR_DEFAULT_MODEL = getBundledModel("cursor", "default");
const DEEPSEEK_MODEL = buildModel({
	...toModelSpec(getBundledModel("deepseek", "deepseek-flash")),
});
const DEEPSEEK_PROXY_MODEL = buildModel({
	...toModelSpec(getBundledModel("deepseek", "deepseek-flash")),
	baseUrl: "https://deepseek-proxy.example/v1",
});

function factoryDroidModel(baseUrl: string) {
	return buildModel({
		id: "claude-haiku-4-5-20251001",
		name: "Haiku 4.5",
		api: "factory-droid-agent",
		provider: "factory-droid",
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}
// Factory's hosted HTTP routes refuse request bodies over 4,500,000 bytes (HTTP 413).
const FACTORY_DROID_ROUTE_BODY_LIMIT = 4_500_000;
// A base64 character occupies one byte in Anthropic's JSON request body.
const HALF_ANTHROPIC_IMAGE_BUDGET = "A".repeat(60_000_000);
// Anthropic's Messages API refuses request bodies over 128 MB (HTTP 413).
const ANTHROPIC_BODY_LIMIT = 128_000_000;

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function imageData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") data.push(part.data);
		}
	}
	return data;
}

function textData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (typeof message.content === "string") {
			data.push(message.content);
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") data.push(part.text);
		}
	}
	return data;
}

/**
 * One OpenAI computer-use step: the call and its screenshot result, which carries the screenshot both as content
 * (`shown`, by default the same image) and as `providerMetadata`.
 */
function computerTurn(index: number, screenshot: string, shown: ImageContent[] = [image(screenshot)]): Message[] {
	const id = `call_${index}|cu_${index}`;
	return [
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id,
					name: "computer",
					arguments: {},
					providerMetadata: {
						type: "computer",
						providerItemId: `cu_${index}`,
						actions: [{ type: "screenshot" }],
						pendingSafetyChecks: [],
					},
				},
			],
			api: "openai-responses",
			provider: "openai",
			model: OPENAI_RESPONSES_MODEL.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: index * 2 + 1,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "computer",
			content: [text(`result-${index}`), ...shown],
			isError: false,
			timestamp: index * 2 + 2,
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", image_url: `data:image/png;base64,${screenshot}` },
				acknowledgedSafetyChecks: [],
			},
		},
	];
}

/** A model on Factory Droid's roster, routed on its registry wire. */
function factoryModel(id: string) {
	const entry = factoryDroidRegistry().find(model => model.spec.id === id);
	if (!entry) throw new Error(`Factory registry lost ${id}`);
	return buildModel(buildFactoryDroidModel(entry));
}

/** Factory GPT: its requests take the Responses wire, and the model has no native computer use. */
function factoryGptModel() {
	return factoryModel("gpt-5.6-terra");
}

/** The request body `context` produces on `model`'s Factory route, as sent. */
async function factoryRequestBody(model: Model<"factory-droid-agent">, context: Context): Promise<string> {
	let body = "";
	const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
		body = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array);
		const completed = { type: "response.completed", response: { status: "completed", usage: {} } };
		return new Response(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
			headers: { "Content-Type": "text/event-stream" },
		});
	};
	const [header, claims] = [{ alg: "none" }, { external_org_id: "org-1" }].map(part =>
		Buffer.from(JSON.stringify(part)).toString("base64url"),
	);
	await streamFactoryDroid(model, context, {
		apiKey: `${header}.${claims}.sig`,
		fetch: fetch as typeof globalThis.fetch,
	}).result();
	if (!body) throw new Error("Factory request was not sent");
	return body;
}

/** The Anthropic request body `context` produces on `model`, captured before it is sent. */
async function anthropicRequestBody(model: Model<"anthropic-messages">, context: Context): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const controller = new AbortController();
	controller.abort();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-api-test",
		signal: controller.signal,
		onPayload: payload => resolve(payload),
	});
	return JSON.stringify(await promise);
}

describe("provider context image budgets", () => {
	it("drops oldest images above the active provider cap while preserving text", () => {
		const context: Context = {
			systemPrompt: ["system"],
			tools: [],
			messages: Array.from({ length: 31 }, (_, index) => ({
				role: "user",
				content: [text(`text-${index}`), image(`image-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 21}`));
		expect(textData(clamped)).toEqual(Array.from({ length: 31 }, (_, index) => `text-${index}`));
		expect(clamped).not.toBe(context);
		expect(imageData(context)).toEqual(Array.from({ length: 31 }, (_, index) => `image-${index}`));
	});

	it.each([
		["the official Anthropic API", ANTHROPIC_MODEL, 600],
		["an Anthropic proxy", ANTHROPIC_PROXY_MODEL, 90],
		["the official Codex backend", CODEX_MODEL, 2000],
		["a Codex proxy", CODEX_PROXY_MODEL, 200],
		["Claude on Antigravity", ANTIGRAVITY_CLAUDE_MODEL, 20],
		["Gemini on Antigravity", ANTIGRAVITY_GEMINI_MODEL, 60],
		["xAI", XAI_MODEL, 60],
		["xAI OAuth", XAI_OAUTH_MODEL, 60],
		["Claude on Cursor", CURSOR_CLAUDE_MODEL, 20],
		["GPT on Cursor", CURSOR_GPT_MODEL, 60],
		["Cursor's default route", CURSOR_DEFAULT_MODEL, 20],
		["the official DeepSeek API", DEEPSEEK_MODEL, 600],
		["a DeepSeek proxy", DEEPSEEK_PROXY_MODEL, 5],
	] as const)("keeps the newest images up to the count %s allows", (_label, model, budget) => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: budget + 1 }, (_, index) => ({
				role: "user",
				content: [image(`image-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, model);

		expect(imageData(clamped)).toEqual(Array.from({ length: budget }, (_, index) => `image-${index + 1}`));
	});

	it("drops the oldest images over DeepSeek's 40 MiB inline-image budget", () => {
		const fourteenMegabytes = "A".repeat(14_000_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 3 }, (_, index) => ({
				role: "user",
				content: [text(`image-${index}`), image(fourteenMegabytes)],
				timestamp: index,
			})),
		};
		const clamped = clampProviderContextImageBytes(context, DEEPSEEK_MODEL);
		expect(imageData(clamped)).toEqual([fourteenMegabytes, fourteenMegabytes]);
		expect(textData(clamped)).toEqual(["image-0", "image-1", "image-2"]);
	});

	it.each([
		// Claude's upstream message limit on Antigravity; Gemini there took 64 MB.
		["Claude on Antigravity", ANTIGRAVITY_CLAUDE_MODEL, 30_000_000],
		["Gemini on Antigravity", ANTIGRAVITY_GEMINI_MODEL, 64_000_000],
		// api.x.ai rejects a body over 50 MiB.
		["xAI", XAI_MODEL, 52_428_800],
		["xAI OAuth", XAI_OAUTH_MODEL, 52_428_800],
		// Cursor took a 64 MB body for both upstreams.
		["Claude on Cursor", CURSOR_CLAUDE_MODEL, 64_000_000],
		["GPT on Cursor", CURSOR_GPT_MODEL, 64_000_000],
	] as const)(
		"keeps %s under its measured body limit at omp's 500 KiB image resize target",
		(_label, model, bodyLimit) => {
			// No byte budget applies on these hosts, so the count alone bounds the
			// inline bytes of resized screenshots (`images.autoResize`, on by default).
			const resized = image("A".repeat(Math.ceil((500 * 1024) / 3) * 4));
			const context: Context = {
				systemPrompt: [],
				tools: [],
				messages: Array.from({ length: 1_000 }, (_, index) => ({
					role: "user",
					content: [resized],
					timestamp: index,
				})),
			};

			const kept = imageData(clampProviderContextImages(context, model));

			expect(clampProviderContextImageBytes(context, model)).toBe(context);
			expect(kept.length).toBeGreaterThan(5);
			expect(kept.reduce((bytes, data) => bytes + data.length, 0)).toBeLessThan(bodyLimit);
		},
	);

	it("keeps image-only tool results meaningful when every image block is dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [image(`image-${index}`)],
				isError: false,
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const firstMessage = clamped.messages[0];

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 1}`));
		expect(firstMessage?.role).toBe("toolResult");
		expect(firstMessage?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("invalidates native replay payloads when user or developer images are clamped", () => {
		const userPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "user-native" }] }],
		};
		const developerPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", role: "developer", content: [{ type: "input_image", image_url: "dev-native" }] }],
		};
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [image("user-image")], providerPayload: userPayload, timestamp: 0 },
				{ role: "developer", content: [image("developer-image")], providerPayload: developerPayload, timestamp: 1 },
				...Array.from({ length: 10 }, (_, index) => ({
					role: "user" as const,
					content: [image(`kept-image-${index}`)],
					timestamp: index + 2,
				})),
			],
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const clampedUser = clamped.messages[0];
		const clampedDeveloper = clamped.messages[1];
		const originalUser = context.messages[0];
		const originalDeveloper = context.messages[1];

		expect(clampedUser?.role).toBe("user");
		expect(clampedDeveloper?.role).toBe("developer");
		if (
			clampedUser?.role !== "user" ||
			clampedDeveloper?.role !== "developer" ||
			originalUser?.role !== "user" ||
			originalDeveloper?.role !== "developer"
		) {
			throw new Error("Expected clamped user and developer messages");
		}
		expect(clampedUser.providerPayload).toBeUndefined();
		expect(clampedDeveloper.providerPayload).toBeUndefined();
		expect(originalUser.providerPayload).toBe(userPayload);
		expect(originalDeveloper.providerPayload).toBe(developerPayload);
		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `kept-image-${index}`));
	});

	it("does not charge assistant images against the budget user and tool result images pay", () => {
		// OpenAI budgets 200 input images per request. A Responses turn that ran
		// the image generation tool carries one `ImageContent` per
		// `image_generation_call`, and none of those are re-read as input images
		// on the next turn, so they must not consume the budget.
		const generated = Array.from({ length: 202 }, (_, index) => image(`generated-${index}`));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("draw 202 of them"), image("user-image")], timestamp: 0 },
				{
					role: "assistant",
					content: [text("here they are"), ...generated],
					api: "openai-responses",
					provider: "openai",
					model: OPENAI_RESPONSES_MODEL.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "screenshot",
					content: [image("tool-image")],
					isError: false,
					timestamp: 2,
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_RESPONSES_MODEL);

		// 204 images total, 2 of them inputs. The clamp must leave both inputs in
		// place instead of evicting them to pay for 202 model outputs.
		expect(imageData(clamped)).toEqual(["user-image", ...generated.map(part => part.data), "tool-image"]);
		expect(clamped.messages[0]).toBe(context.messages[0]);
		expect(clamped.messages[2]).toBe(context.messages[2]);
	});

	it("still clamps user and tool result images that genuinely exceed the cap", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("all of these"), ...Array.from({ length: 202 }, (_, index) => image(`input-${index}`))],
					timestamp: 0,
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_RESPONSES_MODEL);

		expect(imageData(clamped)).toEqual(Array.from({ length: 200 }, (_, index) => `input-${index + 2}`));
	});

	it("retains exactly the configured inline byte budget, then drops oldest images without mutating the context", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("old"), image(HALF_ANTHROPIC_IMAGE_BUDGET)],
					providerPayload: {
						type: "openaiResponsesHistory",
						items: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "native" }] }],
					},
					timestamp: 0,
				},
				{ role: "developer", content: [text("middle"), image(HALF_ANTHROPIC_IMAGE_BUDGET)], timestamp: 1 },
			],
		};
		expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).toBe(context);

		const overBudget: Context = {
			...context,
			messages: [...context.messages, { role: "user", content: [text("new"), image("AAAA")], timestamp: 2 }],
		};
		const clamped = clampProviderContextImageBytes(overBudget, ANTHROPIC_MODEL);
		expect(clamped).not.toBe(overBudget);
		expect(clamped.messages[0]).toEqual({ role: "user", content: [text("old")], timestamp: 0 });
		expect(clamped.messages[1]).toBe(overBudget.messages[1]);
		expect(clamped.messages[2]).toBe(overBudget.messages[2]);
		expect(imageData(clamped)).toEqual([HALF_ANTHROPIC_IMAGE_BUDGET, "AAAA"]);
		expect(textData(clamped)).toEqual(["old", "middle", "new"]);
		expect(imageData(overBudget)).toHaveLength(3);
		expect(overBudget.messages[0]).toBe(context.messages[0]);
	});

	it("removes oldest live screenshots before Anthropic's 128 MB request cap", () => {
		const screenshot = "A".repeat(534_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 240 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "screenshot",
				content: [text(`result-${index}`), image(screenshot)],
				isError: false,
				timestamp: index,
			})),
		};
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		const keptImages = imageData(clamped);
		expect(keptImages).toHaveLength(224);
		expect(keptImages.reduce((size, data) => size + data.length, 0)).toBe(119_616_000);
		expect(clamped.messages.slice(0, 16).every(message => message.content.length === 1)).toBe(true);
		expect(clamped.messages.slice(16).every(message => message.content.length === 2)).toBe(true);
		expect(textData(clamped)).toEqual(Array.from({ length: 240 }, (_, index) => `result-${index}`));
		expect(imageData(context)).toHaveLength(240);
	});

	it("keeps the newest Anthropic user message's images past the image budget while they fit the body limit", () => {
		// The first-party API takes images of up to 10 MB of base64 each.
		const pasted = "A".repeat(9_500_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("old"), image("O".repeat(1_000_000))], timestamp: 0 },
				{ role: "user", content: [text("new"), ...Array.from({ length: 13 }, () => image(pasted))], timestamp: 1 },
			],
		};
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		// 123.5 MB of newest images: over the 120 MB image budget, under the body limit; the older image goes instead.
		expect(imageData(clamped)).toEqual(Array.from({ length: 13 }, () => pasted));
		expect(textData(clamped)).toEqual(["old", "new"]);
	});

	it("drops Anthropic images under the image budget when long text leaves them no room under the body limit", async () => {
		const screenshot = "A".repeat(9_500_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				// Whitespace runs are cheap in tokens and full price in bytes.
				{ role: "user", content: [text(`start${" ".repeat(20_000_000)}end`)], timestamp: 0 },
				...Array.from({ length: 12 }, (_, index) => ({
					role: "user" as const,
					content: [text(`shot-${index}`), image(screenshot)],
					timestamp: index + 1,
				})),
				{ role: "user", content: [text("next")], timestamp: 13 },
			],
		};
		// 114 MB of images fit the 120 MB image budget, but not beside 20 MB of text.
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		expect(imageData(clamped)).toHaveLength(11);
		expect(clamped.messages[1]?.content).toHaveLength(1);
		const body = await anthropicRequestBody(ANTHROPIC_MODEL, clamped);
		expect(Buffer.byteLength(body)).toBeLessThan(ANTHROPIC_BODY_LIMIT);
		expect(body.split(screenshot)).toHaveLength(12);
	});

	it("keeps a Factory-hosted request's inline images under the route body limit, but not a custom gateway's", () => {
		const screenshot = "A".repeat(600_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 10 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "screenshot",
				content: [text(`result-${index}`), image(screenshot)],
				isError: false,
				timestamp: index,
			})),
		};
		expect(JSON.stringify(context).length).toBeGreaterThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		for (const hosted of [
			factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global")),
			factoryDroidModel(factoryDroidWireBaseUrl("openai-responses", "eu")),
		]) {
			const clamped = clampProviderContextImageBytes(context, hosted);
			const kept = imageData(clamped);
			expect(kept.length).toBeGreaterThan(0);
			expect(kept.length).toBeLessThan(10);
			// Oldest screenshots go first; the newest results keep theirs.
			expect(clamped.messages.at(-1)?.content).toHaveLength(2);
			expect(clamped.messages[0].content).toHaveLength(1);
			expect(textData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `result-${index}`));
			expect(JSON.stringify(clamped).length).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		}
		const gateway = factoryDroidModel("https://factory-gateway.example.com/api/llm/a");
		expect(clampProviderContextImageBytes(context, gateway)).toBe(context);
	});

	it("trims five 1 MB Factory screenshots, which the count cap allows, to three", () => {
		const screenshot = "A".repeat(1_000_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 5 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "screenshot",
				content: [text(`result-${index}`), image(screenshot)],
				isError: false,
				timestamp: index,
			})),
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		const counted = clampProviderContextImages(context, hosted);
		expect(imageData(counted)).toHaveLength(5);
		const clamped = clampProviderContextImageBytes(counted, hosted);
		expect(imageData(clamped)).toHaveLength(3);
		expect(clamped.messages.slice(2).every(message => message.content.length === 2)).toBe(true);
	});

	it("trims Factory screenshots under the image budget when text leaves them less of the route body limit", () => {
		const screenshot = "A".repeat(1_000_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("x".repeat(2_000_000))], timestamp: 0 },
				...Array.from({ length: 3 }, (_, index) => ({
					role: "user" as const,
					content: [text(`shot-${index}`), image(screenshot)],
					timestamp: index + 1,
				})),
				{ role: "user", content: [text("next")], timestamp: 4 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		// 3 MB of images fit the 3.5 MB budget, but not beside 2 MB of text under 4.5 MB.
		const clamped = clampProviderContextImageBytes(context, hosted);
		expect(imageData(clamped)).toHaveLength(2);
		expect(clamped.messages[1]?.content).toHaveLength(1);
		expect(JSON.stringify(clamped).length).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
	});

	it("does not charge a Factory GPT turn's Responses history once the session moves to a Factory Claude model", () => {
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		const gpt = factoryGptModel();
		// A Factory turn is recorded under its upstream wire's api.
		const gptTurn: AssistantMessage = {
			role: "assistant",
			content: [text("here it is")],
			api: "openai-responses",
			provider: gpt.provider,
			model: gpt.id,
			// The generated image rides in the native history the Claude wire never replays.
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: hosted.provider,
				items: [{ type: "image_generation_call", result: "B".repeat(3_000_000) }],
			},
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const prompt: Message = { role: "user", content: [text("draw a cat")], timestamp: 0 };
		const fresh: Message = {
			role: "user",
			content: [text("now look at this"), image("A".repeat(2_000_000))],
			timestamp: 2,
		};
		const context: Context = { systemPrompt: [], tools: [], messages: [prompt, gptTurn, fresh] };
		expect(clampProviderContextImageBytes(context, hosted)).toBe(context);
		// On the model that produced it, the history is replayed and leaves the fresh image no room.
		expect(imageData(clampProviderContextImageBytes(context, gpt))).toEqual([]);
	});

	it("charges tool arguments as the escaped string Factory's Responses route sends, and as the object on Claude", async () => {
		const gpt = factoryGptModel();
		const fresh = "C".repeat(3_400_000);
		const claudeTurn: AssistantMessage = {
			role: "assistant",
			// A quote costs two bytes in the arguments object and four once sent as a JSON string inside JSON.
			content: [{ type: "toolCall", id: "toolu_1", name: "write", arguments: { content: '"'.repeat(150_000) } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("x".repeat(700_000))], timestamp: 0 },
				claudeTurn,
				{
					role: "toolResult",
					toolCallId: "toolu_1",
					toolName: "write",
					content: [text("ok")],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: [text("look"), image(fresh)], timestamp: 3 },
			],
		};
		const clamped = clampProviderContextImageBytes(context, gpt);
		expect(imageData(clamped)).toEqual([]);
		expect(Buffer.byteLength(await factoryRequestBody(gpt, clamped))).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		// Kept, the image would have pushed the body past the route limit.
		expect(Buffer.byteLength(await factoryRequestBody(gpt, context))).toBeGreaterThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		// Factory Claude sends the arguments as an object (two bytes a quote), which leaves the image room.
		const claude = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, claude))).toEqual([fresh]);
	});

	it("charges tool arguments as the escaped string Factory's Chat Completions route sends", async () => {
		const kimi = factoryModel("kimi-k3");
		const fresh = "C".repeat(3_400_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("x".repeat(700_000))], timestamp: 0 },
				{
					role: "assistant",
					// A quote costs two bytes in the arguments object and four once sent as a JSON string inside JSON.
					content: [
						{ type: "toolCall", id: "call_1", name: "write", arguments: { content: '"'.repeat(150_000) } },
					],
					api: kimi.api,
					provider: kimi.provider,
					model: kimi.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "write",
					content: [text("ok")],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: [text("look"), image(fresh)], timestamp: 3 },
			],
		};
		const clamped = clampProviderContextImageBytes(context, kimi);
		expect(imageData(clamped)).toEqual([]);
		// Kept, the image would have pushed the body past the route limit.
		expect(Buffer.byteLength(await factoryRequestBody(kimi, context))).toBeGreaterThan(
			FACTORY_DROID_ROUTE_BODY_LIMIT,
		);
	});

	it("charges a same-model Factory Responses turn once, as native items or rebuilt content", async () => {
		const gpt = factoryGptModel();
		const answer = "y".repeat(600_000);
		const fresh = "C".repeat(3_400_000);
		const gptTurn: AssistantMessage = {
			role: "assistant",
			content: [text(answer)],
			api: "openai-responses",
			provider: gpt.provider,
			model: gpt.id,
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: gpt.provider,
				items: [
					{
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: answer, annotations: [] }],
					},
				],
			},
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("write it")], timestamp: 0 },
				gptTurn,
				{ role: "user", content: [text("look"), image(fresh)], timestamp: 2 },
			],
		};
		expect(clampProviderContextImageBytes(context, gpt)).toBe(context);
		const body = await factoryRequestBody(gpt, context);
		expect(body.split(answer)).toHaveLength(2);
		expect(Buffer.byteLength(body)).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
	});

	it("charges Factory Gemini tool schemas as the dereferenced definitions the route sends", async () => {
		const gemini = factoryModel("gemini-3.5-flash");
		const fresh = "C".repeat(3_400_000);
		// One 100 KB definition referenced twelve times: compact in the context, inlined at every use on the wire.
		const properties: Record<string, unknown> = {};
		for (let index = 0; index < 12; index++) properties[`field${index}`] = { $ref: "#/$defs/shared" };
		const context: Context = {
			systemPrompt: [],
			tools: [
				{
					name: "configure",
					description: "configure",
					parameters: {
						type: "object",
						properties,
						$defs: { shared: { type: "string", description: "d".repeat(100_000) } },
					} as Tool["parameters"],
				},
			],
			messages: [{ role: "user", content: [text("look"), image(fresh)], timestamp: 0 }],
		};
		const clamped = clampProviderContextImageBytes(context, gemini);
		expect(imageData(clamped)).toEqual([]);
		// Kept, the image would have pushed the body past the route limit.
		expect(Buffer.byteLength(await factoryRequestBody(gemini, context))).toBeGreaterThan(
			FACTORY_DROID_ROUTE_BODY_LIMIT,
		);
	});

	it("does not charge Factory Gemini for another model's thinking, which its replay drops", async () => {
		const gemini = factoryModel("gemini-3.5-flash");
		const fresh = "C".repeat(3_400_000);
		const claudeTurn: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "t".repeat(1_200_000), thinkingSignature: "sig" }, text("done")],
			api: "anthropic-messages",
			provider: "factory-droid",
			model: "claude-haiku-4-5-20251001",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("think")], timestamp: 0 },
				claudeTurn,
				{ role: "user", content: [text("look"), image(fresh)], timestamp: 2 },
			],
		};
		expect(clampProviderContextImageBytes(context, gemini)).toBe(context);
		const body = await factoryRequestBody(gemini, context);
		expect(body).toContain(fresh);
		expect(Buffer.byteLength(body)).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		// Factory Claude replays its own thinking, which leaves the image no room.
		const claude = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, claude))).toEqual([]);
	});

	it("charges inactive tool definitions only on the Anthropic wire that re-declares them", () => {
		const fresh = "C".repeat(3_400_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			inactiveTools: [
				{
					name: "mcp_withdrawn",
					description: "d".repeat(1_200_000),
					parameters: { type: "object", properties: {} } as Tool["parameters"],
				},
			],
			messages: [{ role: "user", content: [text("look"), image(fresh)], timestamp: 0 }],
		};
		expect(clampProviderContextImageBytes(context, factoryGptModel())).toBe(context);
		const claude = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, claude))).toEqual([]);
	});

	it("evicts more computer screenshots when the text the evicted ones send crowds the rest", async () => {
		// Each result's 20 KB of text stays unsent while the route sends its metadata screenshot; evicted, the result
		// goes out as a note with up to 16,000 characters of that text.
		const screenshot = "A".repeat(20_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("x".repeat(1_000_000))], timestamp: 0 },
				...Array.from({ length: 200 }, (_, index) => {
					const [call, result] = computerTurn(index, screenshot, []);
					if (result.role !== "toolResult") throw new Error("computerTurn lost its result");
					return [call, { ...result, content: [text(`result-${index}${"z".repeat(20_000)}`)] }];
				}).flat(),
			],
		};
		const hosted = factoryGptModel();
		const clamped = clampProviderContextImageBytes(context, hosted);
		const body = await factoryRequestBody(hosted, clamped);
		expect(Buffer.byteLength(body)).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		// The newest screenshots stay.
		expect(body).toContain(`"[Previous computer result; call_id=call_199]`);
	});

	it("keeps five 1 MB computer screenshots on Factory's Responses route under the body limit", async () => {
		// An OpenAI computer-use transcript continued on a Factory GPT model, which has no native computer use: the
		// Responses wire sends each result's metadata screenshot (in an assistant note), not its content image.
		const screenshot = "A".repeat(1_000_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: "use the computer", timestamp: 0 },
				...Array.from({ length: 5 }, (_, index) => computerTurn(index, screenshot)).flat(),
			],
		};
		const hosted = factoryGptModel();
		const clamped = clampProviderContextImageBytes(clampProviderContextImages(context, hosted), hosted);
		expect(imageData(clamped)).toHaveLength(3);

		const body = await factoryRequestBody(hosted, clamped);
		expect(Buffer.byteLength(body)).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		expect(body.split(screenshot)).toHaveLength(4);
		// The two evicted results still report their text.
		expect(body).toContain("result-0");
		expect(body).toContain("result-1");
		const request: unknown = JSON.parse(body);
		if (!isRecord(request) || !Array.isArray(request.input)) throw new Error("Responses request without input");
		const input = request.input.filter(isRecord);
		const calls = new Set(input.filter(item => item.type === "function_call").map(item => item.call_id));
		// An evicted screenshot's result is not left as an output with no call to pair with.
		expect(input.filter(item => item.type === "function_call_output" && !calls.has(item.call_id))).toEqual([]);
	});

	it("charges a computer screenshot once when reserving room for a fresh Factory image", async () => {
		const fresh = "C".repeat(3_600_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				...computerTurn(0, "A".repeat(1_000_000)),
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 3 },
			],
		};
		const hosted = factoryGptModel();
		const clamped = clampProviderContextImageBytes(context, hosted);
		expect(imageData(clamped)).toEqual([fresh]);
		const body = await factoryRequestBody(hosted, clamped);
		expect(Buffer.byteLength(body)).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		expect(body).toContain(fresh);
	});

	it("charges a computer result its metadata screenshot when that copy is larger than its content image", async () => {
		const screenshot = "A".repeat(1_000_000);
		const fresh = "C".repeat(3_600_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				...computerTurn(0, screenshot, [image("p".repeat(1_000))]),
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 3 },
			],
		};
		const hosted = factoryGptModel();
		const body = await factoryRequestBody(hosted, clampProviderContextImageBytes(context, hosted));
		expect(Buffer.byteLength(body)).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		expect(body).toContain(fresh);
		expect(body).not.toContain(screenshot);
	});

	it("evicts computer screenshots that only the metadata holds inline", async () => {
		const screenshot = "A".repeat(1_000_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: "use the computer", timestamp: 0 },
				...Array.from({ length: 5 }, (_, index) => computerTurn(index, screenshot, [])).flat(),
			],
		};
		const hosted = factoryGptModel();
		const body = await factoryRequestBody(hosted, clampProviderContextImageBytes(context, hosted));
		expect(Buffer.byteLength(body)).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		expect(body.split(screenshot)).toHaveLength(4);
	});

	it("does not charge computer metadata screenshots on a route that sends only content", () => {
		// Factory Claude takes the Messages wire, which sends a tool result's content and never its metadata.
		const thumbnail = "p".repeat(1_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 4 }, (_, index) =>
				computerTurn(index, "A".repeat(1_000_000), [image(thumbnail)]),
			).flat(),
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toEqual(Array(4).fill(thumbnail));
	});

	it("keeps a computer screenshot that fits Anthropic's inline budget exactly", () => {
		const screenshot = "A".repeat(1_000_000);
		const fresh = "C".repeat(119_000_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				...computerTurn(0, screenshot),
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 3 },
			],
		};
		expect(imageData(clampProviderContextImageBytes(context, ANTHROPIC_MODEL))).toEqual([screenshot, fresh]);
	});

	it("keeps a small computer screenshot on Factory's Responses route beside a large unsent content image", async () => {
		// The Responses wire sends the 1 KB metadata screenshot; the 4 MB content image never travels, so this request
		// carries about 1 MB of images, and the fresh image after it leaves no room to protect a 4 MB charge.
		const screenshot = "A".repeat(1_000);
		const fresh = "C".repeat(1_000_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: "use the computer", timestamp: 0 },
				...computerTurn(0, screenshot, [image("B".repeat(4_000_000))]),
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 3 },
			],
		};
		const hosted = factoryGptModel();
		const body = await factoryRequestBody(hosted, clampProviderContextImageBytes(context, hosted));
		expect(body).toContain(`data:image/png;base64,${screenshot}`);
		expect(body).toContain(fresh);
		expect(Buffer.byteLength(body)).toBeLessThan(1_100_000);
	});

	it("leaves a computer result's unsent text out of the room reserved on Factory's Responses route", async () => {
		// A result whose content became 1 MB of text: the Responses wire sends only its 2 MB metadata screenshot, so the
		// screenshot and a fresh 2 MB image fit the route together.
		const screenshot = "A".repeat(2_000_000);
		const fresh = "C".repeat(2_000_000);
		const messages = computerTurn(0, screenshot, []);
		const result = messages[1];
		if (result.role !== "toolResult") throw new Error("computerTurn lost its result");
		messages[1] = { ...result, content: [text("x".repeat(1_000_000))] };
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [...messages, { role: "user", content: [text("look at this"), image(fresh)], timestamp: 3 }],
		};
		const hosted = factoryGptModel();
		const body = await factoryRequestBody(hosted, clampProviderContextImageBytes(context, hosted));
		expect(body).toContain(screenshot);
		expect(body).toContain(fresh);
		expect(Buffer.byteLength(body)).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
	});

	it("counts a computer result as its one sent screenshot on Factory's Responses route", async () => {
		// Six content thumbnails exceed Factory's five-image count, but the Responses wire sends only the screenshot.
		const screenshot = "A".repeat(1_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: "use the computer", timestamp: 0 },
				...computerTurn(
					0,
					screenshot,
					Array.from({ length: 6 }, () => image("p".repeat(100))),
				),
			],
		};
		const hosted = factoryGptModel();
		const body = await factoryRequestBody(hosted, clampProviderContextImages(context, hosted));
		expect(body).toContain(`data:image/png;base64,${screenshot}`);
		expect(body).not.toContain("p".repeat(100));
	});

	it("keeps a fresh Factory image that alone fits the route, evicting older ones instead", () => {
		const older = "B".repeat(500_000);
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("first"), image(older)], timestamp: 0 },
				{ role: "user", content: [text("second"), image(older)], timestamp: 1 },
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 2 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		const clamped = clampProviderContextImageBytes(context, hosted);
		expect(imageData(clamped)).toEqual([fresh]);
		expect(clamped.messages[2]).toBe(context.messages[2]);
		expect(textData(clamped)).toEqual(["first", "second", "look at this"]);
		expect(JSON.stringify(clamped).length).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		// An image too large for the route on its own is still dropped.
		const oversized: Context = {
			...context,
			messages: [{ role: "user", content: [text("huge"), image("D".repeat(4_600_000))], timestamp: 0 }],
		};
		expect(imageData(clampProviderContextImageBytes(oversized, hosted))).toEqual([]);
	});

	it("keeps the fresh Factory image when it and the newest tool result's image do not fit together", () => {
		const toolImage = "B".repeat(1_000_000);
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "screenshot",
					content: [text("shot"), image(toolImage)],
					isError: false,
					timestamp: 0,
				},
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		const clamped = clampProviderContextImageBytes(context, hosted);
		expect(imageData(clamped)).toEqual([fresh]);
		expect(textData(clamped)).toEqual(["shot", "look at this"]);
	});

	it("does not protect a fresh Factory image that the request's text leaves no room for", () => {
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("x".repeat(800_000))], timestamp: 0 },
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		const clamped = clampProviderContextImageBytes(context, hosted);
		expect(imageData(clamped)).toEqual([]);
		expect(JSON.stringify(clamped).length).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
	});

	it("reserves a Factory request's text in UTF-8 bytes, not characters", () => {
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("界".repeat(300_000))], timestamp: 0 },
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toEqual([]);
	});

	it("does not reserve room for assistant images no request replays", () => {
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [text("generated"), image("G".repeat(2_000_000))],
					api: "anthropic-messages",
					provider: "factory-droid",
					model: "claude-haiku-4-5-20251001",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toContain(fresh);
	});

	it("does not reserve room for UI-only tool-result details", () => {
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "eval",
					content: [text("done")],
					details: { log: "d".repeat(800_000) },
					isError: false,
					timestamp: 0,
				},
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toEqual([fresh]);
	});

	it("does not reserve room for another provider's native assistant payload", () => {
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [text("generated")],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "openai",
						items: [{ type: "image_generation_call", result: "G".repeat(2_000_000) }],
					},
					api: "openai-responses",
					provider: "openai",
					model: OPENAI_RESPONSES_MODEL.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toEqual([fresh]);
	});

	it("does not reserve room for another provider's payload on a compaction summary", () => {
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("summary")],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "openai-codex",
						items: [{ type: "input_image", image_url: "G".repeat(2_000_000) }],
					},
					timestamp: 0,
				},
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toEqual([fresh]);
	});

	it("leaves room for the request envelope added after the clamp", () => {
		// The context alone fits 4.5 MB with ~10 KB to spare, less than the provider prompt and request fields need.
		const fresh = "C".repeat(FACTORY_DROID_ROUTE_BODY_LIMIT - 10_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 0 }],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toEqual([]);
	});

	it("removes an oversized single tool image but keeps its tool result meaningful", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "screenshot",
					content: [image("A".repeat(FACTORY_DROID_ROUTE_BODY_LIMIT + 1))],
					isError: false,
					timestamp: 0,
				},
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		const clamped = clampProviderContextImageBytes(context, hosted);
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
		expect(imageData(context)).toHaveLength(1);
	});

	it("leaves an omission marker when an oversized image-only prompt is dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [{ role: "user", content: [image("A".repeat(FACTORY_DROID_ROUTE_BODY_LIMIT + 1))], timestamp: 0 }],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		const clamped = clampProviderContextImageBytes(context, hosted);
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("does not charge URL or Anthropic file references for inline bytes", () => {
		const referenceData = HALF_ANTHROPIC_IMAGE_BUDGET;
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [
						{ ...image(referenceData), url: "https://example.com/picture.png" },
						{ ...image(referenceData), providerFile: { provider: "anthropic", id: "file_123" } },
						{ ...image(referenceData), providerFile: { provider: "anthropic", id: "file_456" } },
					],
					timestamp: 0,
				},
			],
		};
		expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).toBe(context);
	});

	it("keeps older external references while removing later inline bytes, but still counts references", () => {
		const reference = { ...image(""), url: "https://example.com/old.png" };
		const oversized = image("A".repeat(ANTHROPIC_BODY_LIMIT + 1));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("old"), reference], timestamp: 0 },
				{ role: "user", content: [text("new"), oversized], timestamp: 1 },
			],
		};
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		expect(clamped.messages[0]).toBe(context.messages[0]);
		expect(clamped.messages[1]?.content).toEqual([text("new")]);
		expect(textData(clamped)).toEqual(["old", "new"]);
		expect(imageData(clamped)).toEqual([""]);
		expect(imageData(context)).toEqual(["", oversized.data]);

		const countLimited: Context = {
			...context,
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "user",
				content: [text(`ref-${index}`), { ...reference, url: `https://example.com/${index}.png` }],
				timestamp: index,
			})),
		};
		const countClamped = clampProviderContextImages(countLimited, UMANS_MODEL);
		expect(countClamped.messages[0]?.content).toEqual([text("ref-0")]);
		expect(imageData(countClamped)).toHaveLength(10);
		expect(textData(countClamped)).toEqual(Array.from({ length: 11 }, (_, index) => `ref-${index}`));
	});

	it("does not charge assistant output images against the inline byte budget", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [image(HALF_ANTHROPIC_IMAGE_BUDGET), image(HALF_ANTHROPIC_IMAGE_BUDGET)],
					api: "anthropic-messages",
					provider: "anthropic",
					model: ANTHROPIC_MODEL.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
				{ role: "user", content: [text("look"), image("AAAA")], timestamp: 1 },
			],
		};
		expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).toBe(context);
	});

	it("does not apply Anthropic's byte policy to other providers, proxies, APIs, or text-only models", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [image(HALF_ANTHROPIC_IMAGE_BUDGET), image(HALF_ANTHROPIC_IMAGE_BUDGET), image("AAAA")],
					timestamp: 0,
				},
			],
		};
		expect(clampProviderContextImageBytes(context, UMANS_MODEL)).toBe(context);
		expect(clampProviderContextImageBytes(context, ANTHROPIC_PROXY_MODEL)).toBe(context);
		expect(clampProviderContextImageBytes(context, { ...ANTHROPIC_MODEL, api: "openai-responses" })).toBe(context);
		expect(clampProviderContextImageBytes(context, { ...ANTHROPIC_MODEL, input: ["text"] })).toBe(context);
	});

	it.each([
		["ANTHROPIC_BASE_URL", { ANTHROPIC_BASE_URL: "https://anthropic-proxy.example/v1" }],
		[
			"Foundry's FOUNDRY_BASE_URL",
			{ CLAUDE_CODE_USE_FOUNDRY: "1", FOUNDRY_BASE_URL: "https://foundry-proxy.example" },
		],
	] as const)("does not apply Anthropic's byte policy to an official model rerouted by %s", (_, reroute) => {
		const frame = (fill: string) => image(fill.repeat(1_600_000));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("summary"), frame("A"), frame("B"), frame("C")],
					historyRewriteAt: 1,
					timestamp: 0,
				},
				{
					role: "user",
					content: [image(HALF_ANTHROPIC_IMAGE_BUDGET), image(HALF_ANTHROPIC_IMAGE_BUDGET)],
					timestamp: 1,
				},
			],
		};
		const keys = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY", "FOUNDRY_BASE_URL"] as const;
		const previous = keys.map(key => [key, Bun.env[key]] as const);
		try {
			for (const key of keys) delete Bun.env[key];
			expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).not.toBe(context);
			expect(capArchiveFrameBytes(context, ANTHROPIC_MODEL)).toBe(context);
			Object.assign(Bun.env, reroute);
			expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).toBe(context);
			// The proxy's 3 MB frame budget keeps only the newest frame.
			const capped = capArchiveFrameBytes(context, ANTHROPIC_MODEL);
			expect(imageData(capped)).toEqual([
				"C".repeat(1_600_000),
				HALF_ANTHROPIC_IMAGE_BUDGET,
				HALF_ANTHROPIC_IMAGE_BUDGET,
			]);
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		}
	});

	it("keeps images that URL decoration moved off the inline wire", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 240 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "screenshot",
				content: [image("A".repeat(534_000))],
				isError: false,
				timestamp: index,
			})),
		};
		const decorated = decorateContextImages(context, () => "https://images.example/frame.png");

		expect(imageData(clampProviderContextImageBytes(context, ANTHROPIC_MODEL))).toHaveLength(224);
		expect(clampProviderContextImageBytes(decorated, ANTHROPIC_MODEL)).toBe(decorated);
	});

	it("preserves context identity when the provider cap is not exceeded", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("ok"), ...Array.from({ length: 10 }, (_, index) => image(`image-${index}`))],
					timestamp: 1,
				},
			],
		};

		expect(clampProviderContextImages(context, UMANS_MODEL)).toBe(context);
	});

	it("caps summary archive frames at the request model's frame budget and leaves other images alone", () => {
		const frame = (fill: string) => image(fill.repeat(1_600_000));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("summary"), frame("A"), frame("B"), frame("C"), text("tail")],
					historyRewriteAt: 1,
					timestamp: 1,
				},
				{ role: "user", content: [text("screenshot"), frame("D")], timestamp: 2 },
			],
		};

		const capped = capArchiveFrameBytes(context, ANTHROPIC_PROXY_MODEL);

		expect(imageData(capped).map(data => data[0])).toEqual(["C", "D"]);
		const [summary] = capped.messages;
		if (summary?.role !== "user" || !Array.isArray(summary.content)) throw new Error("Expected the summary message");
		expect(summary.content.map(block => block.type)).toEqual(["text", "text", "image", "text"]);
		expect(textData(capped)).toContainEqual(expect.stringContaining("2 archived image frames could not be included"));
		expect(capArchiveFrameBytes(context, ANTHROPIC_MODEL)).toBe(context);
	});
});
