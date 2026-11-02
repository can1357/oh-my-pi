import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, FetchImpl, Model, ThinkingBudgets } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Gemini counts thinking against `maxOutputTokens`, while a caller's
// `maxTokens` is the answer budget. A small budget sent as the total cap is
// exhausted by thinking and the request ends with no answer (thought-only).

interface GenerationConfig {
	maxOutputTokens?: number;
	thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number; thinkingLevel?: string };
}

const ctx: Context = { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] };

function bundled(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`missing bundled model ${provider}/${id}`);
	return model;
}

async function captureGenerationConfig(
	model: Model<Api>,
	maxTokens: number | undefined,
	options: { apiKey?: string; thinkingBudgets?: ThinkingBudgets } = {},
): Promise<GenerationConfig | undefined> {
	let generationConfig: GenerationConfig | undefined;
	const fetch: FetchImpl = async (_url, init) => {
		const body = JSON.parse(init?.body as string) as {
			generationConfig?: GenerationConfig;
			request?: { generationConfig?: GenerationConfig };
		};
		generationConfig = body.request?.generationConfig ?? body.generationConfig;
		return new Response('{"error":{"message":"bad request"}}', { status: 400 });
	};
	await streamSimple(model, ctx, {
		apiKey: options.apiKey ?? "k",
		maxTokens,
		reasoning: Effort.High,
		thinkingBudgets: options.thinkingBudgets,
		fetch,
	}).result();
	return generationConfig;
}

describe("Google thinking headroom in maxOutputTokens", () => {
	it.each([
		["google-generative-ai level", bundled("google", "gemini-3.1-pro-preview"), "k"],
		["google-vertex level", bundled("google-vertex", "gemini-3.1-pro-preview"), "k"],
		[
			// Without a discovered wire profile: a profiled SKU sends its roster's fixed cap instead.
			"google-gemini-cli level (Antigravity argon)",
			{ ...bundled("google-antigravity", "gemini-4-argon"), antigravityWireProfiles: undefined },
			JSON.stringify({ token: "t", projectId: "p" }),
		],
	])("%s adds the effort's thinking estimate on top of the caller budget", async (_name, model, apiKey) => {
		const config = await captureGenerationConfig(model, 512, { apiKey });

		expect(config?.maxOutputTokens).toBe(512 + 16384);
		expect(config?.thinkingConfig?.thinkingLevel).toBe("HIGH");
	});

	it("budget mode adds the sent budget on top of the caller budget", async () => {
		const config = await captureGenerationConfig(bundled("google", "gemini-2.5-flash"), 512);

		expect(config?.maxOutputTokens).toBe(512 + 24576);
		expect(config?.thinkingConfig?.thinkingBudget).toBe(24576);
	});

	it("budget mode lowers the budget to keep answer room when the model cap cannot fit it", async () => {
		const config = await captureGenerationConfig({ ...bundled("google", "gemini-2.5-flash"), maxTokens: 8192 }, 512);

		expect(config?.maxOutputTokens).toBe(8192);
		expect(config?.thinkingConfig?.thinkingBudget).toBe(8192 - 1024);
	});

	it.each([
		["google-generative-ai", bundled("google", "gemini-2.5-flash")],
		[
			"google-vertex",
			{
				...bundled("google", "gemini-2.5-flash"),
				api: "google-vertex",
				provider: "google-vertex",
			} satisfies Model<Api>,
		],
	])("%s keeps headroom for an explicit dynamic budget (-1)", async (_name, model) => {
		const config = await captureGenerationConfig(model, 512, { thinkingBudgets: { high: -1 } });

		// The catalog high budget (24576) stands in for the dynamic budget when sizing the cap.
		expect(config?.maxOutputTokens).toBe(512 + 24576);
		expect(config?.thinkingConfig?.thinkingBudget).toBe(-1);
	});

	it("budget mode turns thinking off when the cap leaves no answer room", async () => {
		const config = await captureGenerationConfig({ ...bundled("google", "gemini-2.5-flash"), maxTokens: 1000 }, 512);

		expect(config).toBeDefined();
		expect(config?.maxOutputTokens).toBe(512);
		expect(config?.thinkingConfig).toEqual({ includeThoughts: false, thinkingBudget: 0 });
	});

	it("sends no cap when neither the caller nor the model has one", async () => {
		const config = await captureGenerationConfig(
			{ ...bundled("google", "gemini-3.1-pro-preview"), maxTokens: null },
			undefined,
		);

		expect(config).toBeDefined();
		expect(config?.maxOutputTokens).toBeUndefined();
	});
});
