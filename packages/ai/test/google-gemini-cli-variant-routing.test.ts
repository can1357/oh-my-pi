import { describe, expect, it } from "bun:test";
import { Effort, type FetchImpl } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

interface CapturedRequestBody {
	model?: string;
	request?: {
		generationConfig?: {
			maxOutputTokens?: number;
			thinkingConfig?: {
				includeThoughts?: boolean;
				thinkingLevel?: string;
				thinkingBudget?: number;
			};
		};
	};
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function collapsedFlashModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-3.5-flash",
		requestModelId: "gemini-3.5-flash-extra-low",
		name: "Gemini 3.5 Flash",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortBudgets: {
				[Effort.Minimal]: 1000,
				[Effort.Low]: 1000,
				[Effort.Medium]: 4000,
				[Effort.High]: 10000,
			},
			effortRouting: {
				off: "gemini-3.5-flash-extra-low",
				[Effort.Minimal]: "gemini-3.5-flash-extra-low",
				[Effort.Low]: "gemini-3.5-flash-extra-low",
				[Effort.Medium]: "gemini-3.5-flash-low",
				[Effort.High]: "gemini-3-flash-agent",
			},
			suppressWhenOff: true,
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	} satisfies ModelSpec<"google-gemini-cli">);
}

function collapsedClaudeModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "claude-sonnet-4-6",
		requestModelId: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortRouting: {
				off: "claude-sonnet-4-6",
				[Effort.Minimal]: "claude-sonnet-4-6-thinking",
				[Effort.Low]: "claude-sonnet-4-6-thinking",
				[Effort.Medium]: "claude-sonnet-4-6-thinking",
				[Effort.High]: "claude-sonnet-4-6-thinking",
			},
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	} satisfies ModelSpec<"google-gemini-cli">);
}

function unroutedModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	} satisfies ModelSpec<"google-gemini-cli">);
}

async function captureRequest(
	model: Model<"google-gemini-cli">,
	reasoning: Effort | undefined,
	options: { forceReasoningOff?: boolean } = {},
): Promise<{ body: CapturedRequestBody; attributedModel: string }> {
	let requestBody: string | undefined;
	const fetchMock: FetchImpl = (_input, init) => {
		requestBody = typeof init?.body === "string" ? init.body : undefined;
		return Promise.resolve(new Response('{"error":{"message":"bad request"}}', { status: 400 }));
	};
	const stream = streamSimple(model, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		reasoning,
		forceReasoningOff: options.forceReasoningOff,
		fetch: fetchMock,
	});
	const result = await stream.result();
	if (!requestBody) throw new Error("request body was not captured");
	return { body: JSON.parse(requestBody) as CapturedRequestBody, attributedModel: result.model };
}

describe("google-gemini-cli effort-tier variant routing", () => {
	it("routes each effort to its backing wire id with the per-tier budget and attributes usage to the logical id", async () => {
		const high = await captureRequest(collapsedFlashModel(), Effort.High);
		expect(high.body.model).toBe("gemini-3-flash-agent");
		expect(high.body.request?.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 10000,
		});
		expect(high.body.request?.generationConfig?.maxOutputTokens).toBe(65536);
		expect(high.attributedModel).toBe("gemini-3.5-flash");

		const medium = await captureRequest(collapsedFlashModel(), Effort.Medium);
		expect(medium.body.model).toBe("gemini-3.5-flash-low");
		expect(medium.body.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBe(4000);

		const low = await captureRequest(collapsedFlashModel(), Effort.Low);
		expect(low.body.model).toBe("gemini-3.5-flash-extra-low");
		expect(low.body.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBe(1000);
	});

	it("suppresses thinking with a zero budget on the wire when off and suppressWhenOff is set", async () => {
		const off = await captureRequest(collapsedFlashModel(), undefined);
		expect(off.body.model).toBe("gemini-3.5-flash-extra-low");
		expect(off.body.request?.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: false,
			thinkingBudget: 0,
		});
	});

	it("routes to the explicit off wire shape when an external scratchpad replaces reasoning", async () => {
		const off = await captureRequest(collapsedFlashModel(), Effort.High, { forceReasoningOff: true });
		expect(off.body.model).toBe("gemini-3.5-flash-extra-low");
		expect(off.body.request?.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: false,
			thinkingBudget: 0,
		});
	});

	it("routes claude pairs to the bare id when off without wire suppression", async () => {
		const off = await captureRequest(collapsedClaudeModel(), undefined);
		expect(off.body.model).toBe("claude-sonnet-4-6");
		// Omitting thinkingConfig is correct on the non-thinking backing id.
		expect(off.body.request?.generationConfig?.thinkingConfig).toBeUndefined();
	});

	it("routes claude pairs to the -thinking id with a budget when reasoning", async () => {
		const high = await captureRequest(collapsedClaudeModel(), Effort.High);
		expect(high.body.model).toBe("claude-sonnet-4-6-thinking");
		expect(high.body.request?.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);
		expect(high.body.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBeGreaterThan(0);
	});

	it("keeps the status quo for un-routed models", async () => {
		const off = await captureRequest(unroutedModel(), undefined);
		expect(off.body.model).toBe("gemini-2.5-flash");
		expect(off.body.request?.generationConfig?.thinkingConfig).toBeUndefined();

		const high = await captureRequest(unroutedModel(), Effort.High);
		expect(high.body.model).toBe("gemini-2.5-flash");
		expect(high.body.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBeGreaterThan(0);
	});
});
