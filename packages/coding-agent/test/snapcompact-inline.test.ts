import { describe, expect, it, spyOn } from "bun:test";
import type { Context, ImageContent, Message, TextContent, ToolResultMessage } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import {
	estimateInlineSavings,
	planInlineSwaps,
	type SnapcompactInlineOptions,
	SnapcompactInlineTransformer,
} from "@pk-nerdsaver-ai/pi-coding-agent/session/snapcompact-inline";
import * as snapcompact from "@pk-nerdsaver-ai/snapcompact";

/**
 * Token-dense deterministic word salad: each word is `w` + ≤5 digits, ~7
 * normalized chars with the joining space.
 */
function denseText(words: number): string {
	return Array.from({ length: words }, (_, i) => `w${(i * 7919) % 100000}`).join(" ");
}

/** Frame capacity of the high-capacity test shape. */
const TEST_SHAPE = "6x12-dim";
const DEFAULT_CAPACITY = snapcompact.geometry(snapcompact.resolveShape(undefined, TEST_SHAPE)).capacity;

/**
 * Sized to span exactly 2 default-shape frames (~1.7x one frame's capacity):
 * the legibility-tuned cells pack fewer chars/frame, so the swap's ~6,600
 * estimated image tokens must clear the 0.9 savings gate against a larger
 * text-token bill. 1.7x sits comfortably above break-even while staying at 2
 * frames (the budget math below depends on 2 frames per LARGE).
 */
const LARGE = denseText(Math.ceil((DEFAULT_CAPACITY * 1.7) / 7));
const SMALL = "12 lines OK";
function withTestShape(options: Omit<SnapcompactInlineOptions, "shape">): SnapcompactInlineOptions {
	return { ...options, shape: TEST_SHAPE };
}

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: 0 };
}

function makeModel(
	overrides: {
		provider?: string;
		input?: ("text" | "image")[];
		api?: "anthropic-messages" | "google-generative-ai";
		baseUrl?: string;
	} = {},
) {
	return buildModel({
		id: "test-model",
		name: "Test Model",
		api: overrides.api ?? "anthropic-messages",
		provider: overrides.provider ?? "anthropic",
		baseUrl: overrides.baseUrl ?? "https://example.invalid",
		reasoning: false,
		input: overrides.input ?? ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function makeContext(): Context {
	return {
		systemPrompt: ["You are a coding agent.", "Follow the rules."],
		messages: [
			userMessage("first user prompt"),
			toolResult("call_1", LARGE),
			toolResult("call_2", SMALL),
			toolResult("call_3", LARGE),
		],
	};
}

function imageCount(context: Context): number {
	let count = 0;
	for (const message of context.messages) {
		if (typeof message.content === "string") continue;
		for (const block of message.content) if (block.type === "image") count++;
	}
	return count;
}

describe("SnapcompactInlineTransformer", () => {
	it("is a no-op for text-only models", async () => {
		const transformer = new SnapcompactInlineTransformer(
			withTestShape({ renderSystemPrompt: "all", renderToolResults: true }),
		);
		const context = makeContext();
		expect(await transformer.transform(context, makeModel({ input: ["text"] }))).toBe(context);
	});

	it("is a no-op for Copilot business/enterprise endpoints even when the model claims vision (#3387)", async () => {
		const transformer = new SnapcompactInlineTransformer(
			withTestShape({ renderSystemPrompt: "all", renderToolResults: true }),
		);
		const context = makeContext();
		const business = makeModel({
			provider: "github-copilot",
			baseUrl: "https://api.business.githubcopilot.com",
			input: ["text", "image"],
		});
		expect(await transformer.transform(context, business)).toBe(context);
		expect(
			estimateInlineSavings({
				options: withTestShape({ renderSystemPrompt: "all", renderToolResults: true }),
				model: business,
				systemPrompt: context.systemPrompt ?? [],
				messages: context.messages,
			}),
		).toEqual({ visionCapable: false, savedTokens: 0 });

		const enterprise = makeModel({
			provider: "github-copilot",
			baseUrl: "https://copilot-api.ghe.example.com",
			input: ["text", "image"],
		});
		expect(await transformer.transform(context, enterprise)).toBe(context);

		const personal = makeModel({
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			input: ["text", "image"],
		});
		const result = await transformer.transform(context, personal);
		expect(result).not.toBe(context);
		expect(imageCount(result)).toBeGreaterThan(0);
	});

	it("images large historical tool results, keeping small and most-recent ones as text", async () => {
		const transformer = new SnapcompactInlineTransformer(
			withTestShape({ renderSystemPrompt: "none", renderToolResults: true }),
		);
		const context = makeContext();
		const result = await transformer.transform(context, makeModel());

		// Large historical result → leading text note + image frames.
		const imaged = result.messages[1] as ToolResultMessage;
		expect(imaged.content[0].type).toBe("text");
		expect(imaged.content.length).toBeGreaterThan(1);
		expect(imaged.content.slice(1).every(block => block.type === "image")).toBe(true);
		for (const block of imaged.content.slice(1) as ImageContent[]) {
			expect(block.mimeType).toBe("image/png");
			expect(block.data.length).toBeGreaterThan(0);
		}

		// Small result fails the savings gate; the most-recent stays crisp text.
		expect(result.messages[2]).toBe(context.messages[2]);
		expect(result.messages[3]).toBe(context.messages[3]);
		expect((result.messages[3] as ToolResultMessage).content[0]).toEqual({ type: "text", text: LARGE });

		// System prompt untouched when only tool results are enabled.
		expect(result.systemPrompt).toBe(context.systemPrompt);
	});

	it("reports per-tool-result savings to the sink for each imaged result only", async () => {
		const received: Array<{ toolCallId: string; savedTokens: number }>[] = [];
		let model = "";
		const transformer = new SnapcompactInlineTransformer(
			withTestShape({ renderSystemPrompt: "none", renderToolResults: true }),
			(savings, m) => {
				received.push(savings.map(s => ({ ...s })));
				model = m.id;
			},
		);
		await transformer.transform(makeContext(), makeModel());

		// Only the large historical result (call_1) is imaged; call_2 is small,
		// call_3 is the most-recent (kept crisp).
		expect(received).toHaveLength(1);
		expect(received[0]).toHaveLength(1);
		expect(received[0][0].toolCallId).toBe("call_1");
		expect(received[0][0].savedTokens).toBeGreaterThan(0);
		expect(model).toBe("test-model");
	});

	it("never calls the savings sink when nothing is imaged", async () => {
		let calls = 0;
		const transformer = new SnapcompactInlineTransformer(
			withTestShape({ renderSystemPrompt: "none", renderToolResults: true }),
			() => {
				calls++;
			},
		);
		// Text-only model → vision gate short-circuits before any swap.
		await transformer.transform(makeContext(), makeModel({ input: ["text"] }));
		expect(calls).toBe(0);
	});

	it("never mutates the input context (persisted history shares these references)", async () => {
		const transformer = new SnapcompactInlineTransformer(
			withTestShape({ renderSystemPrompt: "all", renderToolResults: true }),
		);
		const context = makeContext();
		const originalMessages = context.messages;
		const originalSystemPrompt = context.systemPrompt;
		const original = context.messages[1] as ToolResultMessage;
		const originalContent = original.content;

		const result = await transformer.transform(context, makeModel());
		expect(result).not.toBe(context);

		expect(context.messages).toBe(originalMessages);
		expect(context.systemPrompt).toBe(originalSystemPrompt);
		expect(context.systemPrompt).toEqual(["You are a coding agent.", "Follow the rules."]);
		expect(original.content).toBe(originalContent);
		expect(originalContent).toEqual([{ type: "text", text: LARGE }]);
		expect((context.messages[0] as { content: string }).content).toBe("first user prompt");
	});

	it("leaves tool results that already carry images untouched", async () => {
		const transformer = new SnapcompactInlineTransformer(
			withTestShape({ renderSystemPrompt: "none", renderToolResults: true }),
		);
		const withImage: ToolResultMessage = {
			...toolResult("call_img", LARGE),
			content: [
				{ type: "text", text: LARGE },
				{ type: "image", data: "aGk=", mimeType: "image/png" },
			],
		};
		const context: Context = {
			messages: [userMessage("hi"), withImage, toolResult("call_tail", LARGE)],
		};
		const result = await transformer.transform(context, makeModel());
		expect(result.messages[1]).toBe(withImage);
	});
	it("leaves error tool results text-only even when they are large", async () => {
		const transformer = new SnapcompactInlineTransformer(
			withTestShape({ renderSystemPrompt: "none", renderToolResults: true }),
		);
		const errorResult: ToolResultMessage = { ...toolResult("call_error", LARGE), isError: true };
		const context: Context = {
			messages: [userMessage("hi"), errorResult, toolResult("call_tail", LARGE)],
		};
		const result = await transformer.transform(context, makeModel());
		expect(result).toBe(context);
		expect(result.messages[1]).toBe(errorResult);
		expect(errorResult.content.every(block => block.type === "text")).toBe(true);
		expect(imageCount(result)).toBe(0);
	});

	it("replaces a large system prompt with a stub and rides frames on the first user message", async () => {
		const transformer = new SnapcompactInlineTransformer(
			withTestShape({ renderSystemPrompt: "all", renderToolResults: false }),
		);
		const longPrompt = denseText(3000);
		const context: Context = {
			systemPrompt: [longPrompt],
			messages: [userMessage("do the thing"), toolResult("call_1", SMALL)],
		};
		const result = await transformer.transform(context, makeModel());

		expect(result.systemPrompt).toHaveLength(1);
		expect(result.systemPrompt![0]).not.toBe(longPrompt);
		expect(result.systemPrompt![0].length).toBeLessThan(500);

		const carrier = result.messages[0] as { content: (TextContent | ImageContent)[] };
		expect(carrier.content[0].type).toBe("text");
		const images = carrier.content.filter(block => block.type === "image");
		expect(images.length).toBeGreaterThan(0);
		// Original user text survives at the tail.
		expect(carrier.content[carrier.content.length - 1]).toEqual({ type: "text", text: "do the thing" });
	});

	it("moves only loaded context-file instructions when AGENTS.md mode is selected", async () => {
		const transformer = new SnapcompactInlineTransformer(
			withTestShape({
				renderSystemPrompt: "agents-md",
				renderToolResults: false,
			}),
		);
		const longContext = denseText(3000);
		const context: Context = {
			systemPrompt: [
				`Core instructions.\n\n<context>\nYou MUST follow the context files below for all tasks:\n<file path="AGENTS.md">\n${longContext}\n</file>\n</context>\n\nToday is 2026-06-12.`,
				"Final system block.",
			],
			messages: [userMessage("do the thing")],
		};
		const result = await transformer.transform(context, makeModel());

		expect(result.systemPrompt).toHaveLength(2);
		expect(result.systemPrompt![0]).toContain("Core instructions.");
		expect(result.systemPrompt![0]).toContain("Today is 2026-06-12.");
		expect(result.systemPrompt![0]).toContain("Loaded context-file instructions were moved");
		expect(result.systemPrompt![0]).not.toContain(longContext);
		expect(result.systemPrompt![1]).toBe("Final system block.");

		const carrier = result.messages[0] as { content: (TextContent | ImageContent)[] };
		expect((carrier.content[0] as TextContent).text).toContain("CONTEXT FILE INSTRUCTIONS");
		expect(carrier.content.some(block => block.type === "image")).toBe(true);
		expect(carrier.content[carrier.content.length - 1]).toEqual({ type: "text", text: "do the thing" });
	});

	it("keeps a small system prompt as text and skips when no user message exists", async () => {
		const transformer = new SnapcompactInlineTransformer(
			withTestShape({ renderSystemPrompt: "all", renderToolResults: false }),
		);
		const small: Context = { systemPrompt: ["Be terse."], messages: [userMessage("hi")] };
		expect(await transformer.transform(small, makeModel())).toBe(small);

		const noUser: Context = { systemPrompt: [denseText(3000)], messages: [toolResult("call_1", SMALL)] };
		expect(await transformer.transform(noUser, makeModel())).toBe(noUser);
	});

	it("never rasterizes tool results under the 3k-token floor, even when frames are cheaper", async () => {
		const transformer = new SnapcompactInlineTransformer({ renderSystemPrompt: "none", renderToolResults: true });
		// ~1.7k soft tokens: the google shape estimates 1 frame ≈ 1120 tokens, so the
		// savings gate alone would rasterize this — the floor must keep it text.
		const midsize = denseText(900);
		const context: Context = {
			messages: [userMessage("go"), toolResult("call_1", midsize), toolResult("call_2", LARGE)],
		};
		const result = await transformer.transform(
			context,
			makeModel({ api: "google-generative-ai", provider: "google" }),
		);
		expect(result).toBe(context);
	});

	it("respects the per-provider image budget for unknown providers", async () => {
		const transformer = new SnapcompactInlineTransformer(
			withTestShape({ renderSystemPrompt: "none", renderToolResults: true }),
		);
		const context: Context = {
			messages: [
				userMessage("go"),
				toolResult("call_1", LARGE),
				toolResult("call_2", LARGE),
				toolResult("call_3", LARGE),
				toolResult("call_4", LARGE),
			],
		};
		// Unknown provider → default budget 5. Each LARGE needs 2 frames:
		// call_1 (2) + call_2 (2) fit, call_3 needs 2 > 1 remaining → text.
		const result = await transformer.transform(context, makeModel({ provider: "groq" }));
		expect(imageCount(result)).toBeLessThanOrEqual(5);
		expect(result.messages[3]).toBe(context.messages[3]);
		expect(result.messages[4]).toBe(context.messages[4]);
	});

	it("caches renders across turns: identical input does not re-rasterize", async () => {
		const spy = spyOn(snapcompact, "renderMany");
		try {
			const transformer = new SnapcompactInlineTransformer(
				withTestShape({ renderSystemPrompt: "all", renderToolResults: true }),
			);
			const context = makeContext();
			const model = makeModel();

			const first = await transformer.transform(context, model);
			const callsAfterFirst = spy.mock.calls.length;
			expect(callsAfterFirst).toBeGreaterThan(0);

			const second = await transformer.transform(context, model);
			expect(spy.mock.calls.length).toBe(callsAfterFirst);

			const firstFrames = (first.messages[1] as ToolResultMessage).content.slice(1);
			const secondFrames = (second.messages[1] as ToolResultMessage).content.slice(1);
			expect(secondFrames.length).toBe(firstFrames.length);
			for (let i = 0; i < firstFrames.length; i++) {
				expect(secondFrames[i]).toBe(firstFrames[i]);
			}
		} finally {
			spy.mockRestore();
		}
	});
});

describe("planInlineSwaps", () => {
	const shape = snapcompact.resolveShape({ api: "anthropic-messages" });
	const toolOnly = { renderSystemPrompt: "none" as const, renderToolResults: true };
	const promptOnly = { renderSystemPrompt: "all" as const, renderToolResults: false };

	it("never swaps the most recent tool result", () => {
		const plan = planInlineSwaps({
			options: toolOnly,
			shape,
			budget: 90,
			toolResults: [
				{ id: "a", textTokens: 10000, frames: 2, hasImage: false },
				{ id: "z", textTokens: 10000, frames: 2, hasImage: false },
			],
			systemPrompt: undefined,
			hasUserMessage: true,
		});
		expect(plan.toolResults.map(swap => swap.id)).toEqual(["a"]);
	});

	it("skips error, image-carrying, below-floor, and below-margin candidates", () => {
		const plan = planInlineSwaps({
			options: toolOnly,
			shape,
			budget: 90,
			toolResults: [
				{ id: "img", textTokens: 0, frames: 0, hasImage: true },
				{ id: "small", textTokens: 2999, frames: 1, hasImage: false },
				// 2 frames ≈ 6600 image tokens > 7000 * 0.9 — margin gate rejects.
				{ id: "margin", textTokens: 7000, frames: 2, hasImage: false },
				{ id: "err", textTokens: 10000, frames: 2, hasImage: false, isError: true },
				{ id: "ok", textTokens: 10000, frames: 2, hasImage: false },
				{ id: "last", textTokens: 10000, frames: 2, hasImage: false },
			],
			systemPrompt: undefined,
			hasUserMessage: true,
		});
		expect(plan.toolResults.map(swap => swap.id)).toEqual(["ok"]);
	});

	it("skips candidates over the remaining budget but keeps trying smaller ones", () => {
		const plan = planInlineSwaps({
			options: toolOnly,
			shape,
			budget: 3,
			toolResults: [
				{ id: "a", textTokens: 10000, frames: 2, hasImage: false },
				{ id: "b", textTokens: 10000, frames: 2, hasImage: false },
				{ id: "c", textTokens: 5000, frames: 1, hasImage: false },
				{ id: "last", textTokens: 10000, frames: 2, hasImage: false },
			],
			systemPrompt: undefined,
			hasUserMessage: true,
		});
		expect(plan.toolResults.map(swap => swap.id)).toEqual(["a", "c"]);
	});

	it("gives the system prompt only the budget tool results left over", () => {
		const input = {
			options: { renderSystemPrompt: "all" as const, renderToolResults: true },
			shape,
			budget: 2,
			toolResults: [
				{ id: "a", textTokens: 10000, frames: 2, hasImage: false },
				{ id: "last", textTokens: 10000, frames: 2, hasImage: false },
			],
			systemPrompt: { textTokens: 10000, frames: 2 },
			hasUserMessage: true,
		};
		const contested = planInlineSwaps(input);
		expect(contested.toolResults.map(swap => swap.id)).toEqual(["a"]);
		expect(contested.systemPrompt).toBeUndefined();

		const uncontested = planInlineSwaps({ ...input, options: promptOnly });
		expect(uncontested.toolResults).toEqual([]);
		expect(uncontested.systemPrompt).toEqual({ textTokens: 10000, frames: 2 });
	});

	it("gates the system prompt on frame cap, savings margin, and a carrier user message", () => {
		const base = {
			options: promptOnly,
			shape,
			budget: 90,
			toolResults: [],
			hasUserMessage: true,
		};
		// 7 frames exceeds the 6-frame system prompt cap.
		expect(
			planInlineSwaps({ ...base, systemPrompt: { textTokens: 100000, frames: 7 } }).systemPrompt,
		).toBeUndefined();
		// 6 frames ≈ 19800 ≤ 30000 * 0.9 — fits.
		expect(planInlineSwaps({ ...base, systemPrompt: { textTokens: 30000, frames: 6 } }).systemPrompt).toBeDefined();
		// 2 frames ≈ 6600 > 7000 * 0.9 — margin gate rejects.
		expect(planInlineSwaps({ ...base, systemPrompt: { textTokens: 7000, frames: 2 } }).systemPrompt).toBeUndefined();
		// No user message to carry the frames.
		expect(
			planInlineSwaps({ ...base, hasUserMessage: false, systemPrompt: { textTokens: 30000, frames: 6 } })
				.systemPrompt,
		).toBeUndefined();
	});
});

describe("estimateInlineSavings", () => {
	it("reports vision-incapable models as inactive with zero savings", () => {
		const estimate = estimateInlineSavings({
			options: { renderSystemPrompt: "all", renderToolResults: true, shape: TEST_SHAPE },
			model: makeModel({ input: ["text"] }),
			systemPrompt: [LARGE],
			messages: [],
		});
		expect(estimate.visionCapable).toBe(false);
		expect(estimate.savedTokens).toBe(0);
		expect(estimate.systemPrompt).toBeUndefined();
		expect(estimate.toolResults).toBeUndefined();
	});

	it("assumes the next request carries a user message even with empty history", () => {
		const estimate = estimateInlineSavings({
			options: { renderSystemPrompt: "all", renderToolResults: false, shape: TEST_SHAPE },
			model: makeModel(),
			systemPrompt: [LARGE],
			messages: [],
		});
		expect(estimate.visionCapable).toBe(true);
		expect(estimate.systemPrompt?.applied).toBe(true);
		expect(estimate.systemPrompt?.frames).toBe(2);
		expect(estimate.systemPrompt?.imageTokens).toBe(
			estimate.systemPrompt!.frames * snapcompact.resolveShape(undefined, TEST_SHAPE).frameTokenEstimate,
		);
		expect(estimate.systemPrompt?.savedTokens).toBe(
			estimate.systemPrompt!.textTokens - estimate.systemPrompt!.imageTokens,
		);
		expect(estimate.savedTokens).toBe(estimate.systemPrompt!.savedTokens);
		expect(estimate.savedTokens).toBeGreaterThan(0);
		expect(estimate.toolResults).toBeUndefined();
	});

	it("explains why a small system prompt stays text", () => {
		const estimate = estimateInlineSavings({
			options: { renderSystemPrompt: "all", renderToolResults: false, shape: TEST_SHAPE },
			model: makeModel(),
			systemPrompt: ["Be terse."],
			messages: [],
		});
		expect(estimate.systemPrompt?.applied).toBe(false);
		expect(estimate.systemPrompt?.reason).toBe("margin");
		expect(estimate.savedTokens).toBe(0);
	});

	it("matches what the transform actually swaps on the same context", async () => {
		const options: SnapcompactInlineOptions = {
			renderSystemPrompt: "all",
			renderToolResults: true,
			shape: TEST_SHAPE,
		};
		const context = makeContext();
		const model = makeModel();

		const estimate = estimateInlineSavings({
			options,
			model,
			systemPrompt: context.systemPrompt!,
			messages: context.messages,
		});
		const result = await new SnapcompactInlineTransformer(withTestShape(options)).transform(context, model);

		let imaged = 0;
		for (const message of result.messages) {
			if (message.role !== "toolResult") continue;
			if (message.content.some(block => block.type === "image")) imaged++;
		}
		expect(estimate.toolResults?.total).toBe(3);
		expect(estimate.toolResults?.swapped).toBe(imaged);
		expect(estimate.toolResults!.savedTokens).toBe(
			estimate.toolResults!.textTokens - estimate.toolResults!.imageTokens,
		);
		// The tiny two-part system prompt stays text in both paths.
		expect(estimate.systemPrompt?.applied).toBe(false);
		expect(result.systemPrompt).toBe(context.systemPrompt);
	});
});
