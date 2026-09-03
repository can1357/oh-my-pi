import { describe, expect, it } from "bun:test";
import { Effort, type FetchImpl } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface CapturedPayload {
	config?: {
		thinkingConfig?: {
			includeThoughts?: boolean;
			thinkingBudget?: number;
		};
	};
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const model: Model<"google-generative-ai"> = buildModel({
	id: "gemini-2.5-flash",
	name: "Gemini 2.5 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com",
	reasoning: true,
	thinking: {
		mode: "budget",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	},
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

async function capturePayload(flag: "disableReasoning" | "forceReasoningOff"): Promise<CapturedPayload> {
	let captured: CapturedPayload | undefined;
	const fetchMock: FetchImpl = async () =>
		new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });

	await streamSimple(model, context, {
		apiKey: "test-key",
		reasoning: Effort.High,
		[flag]: true,
		fetch: fetchMock,
		onPayload: payload => {
			captured = payload as CapturedPayload;
		},
	}).result();

	if (!captured) throw new Error("Google request payload was not captured");
	return captured;
}

describe("Google reasoning disablement", () => {
	for (const flag of ["disableReasoning", "forceReasoningOff"] as const) {
		it(`sends an explicit zero thinking budget for ${flag}`, async () => {
			const payload = await capturePayload(flag);

			expect(payload.config?.thinkingConfig).toEqual({
				includeThoughts: false,
				thinkingBudget: 0,
			});
		});
	}
});
