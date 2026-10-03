import { describe, expect, it } from "bun:test";
import { Effort, type FetchImpl } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface GeminiCliThinkingConfig {
	thinkingLevel?: string;
	thinkingBudget?: number;
	includeThoughts?: boolean;
}

interface CapturedRequestBody {
	model?: string;
	request?: {
		generationConfig?: {
			thinkingConfig?: GeminiCliThinkingConfig;
		};
	};
}

function createModel(id: string): Model<"google-gemini-cli"> {
	return buildModel({
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function extractThinking(bodyText: string | undefined): GeminiCliThinkingConfig | undefined {
	if (!bodyText) return undefined;
	const parsed = JSON.parse(bodyText) as CapturedRequestBody;
	return parsed.request?.generationConfig?.thinkingConfig;
}

describe("google-gemini-cli Gemini 3.x thinking mapping", () => {
	const createFetchMock =
		(capture: (body: string | undefined) => void): FetchImpl =>
		(_input, init) => {
			capture(typeof init?.body === "string" ? init.body : undefined);
			return Promise.resolve(new Response('{"error":{"message":"bad request"}}', { status: 400 }));
		};
	it("uses thinkingLevel for gemini-3.1-pro-preview when the effort is supported", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createModel("gemini-3.1-pro-preview"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.High,
			fetch: fetchMock,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.thinkingLevel).toBe("HIGH");
		expect(thinking?.thinkingBudget).toBeUndefined();
	});

	it("keeps Cloud Code Assist reasoning enabled when only summaries are hidden", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createModel("gemini-3.1-pro-preview"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.High,
			hideThinkingSummary: true,
			fetch: fetchMock,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.includeThoughts).toBe(false);
		expect(thinking?.thinkingLevel).toBe("HIGH");
	});

	it("rejects unsupported gemini-3.1-pro-preview efforts instead of promoting them", () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		expect(() =>
			streamSimple(createModel("gemini-3.1-pro-preview"), context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				reasoning: Effort.Medium,
				fetch: fetchMock,
			}),
		).toThrow(/Supported efforts: low, high/);
		expect(requestBody).toBeUndefined();
	});

	it("uses thinkingLevel for gemini-3.1-flash-preview", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createModel("gemini-3.1-flash-preview"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.Medium,
			fetch: fetchMock,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.thinkingLevel).toBe("MEDIUM");
		expect(thinking?.thinkingBudget).toBeUndefined();
	});

	it("keeps thinkingBudget for gemini-2.5-pro", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createModel("gemini-2.5-pro"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.Medium,
			fetch: fetchMock,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.thinkingLevel).toBeUndefined();
		expect(thinking?.thinkingBudget).toBeDefined();
	});

	it("sends LOW not MINIMAL when gemini-3.7-flash minimal aliases the -low SKU", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const model = buildModel({
			id: "gemini-3.7-flash",
			name: "Gemini 3.7 Flash",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.googleapis.com",
			reasoning: true,
			thinking: {
				mode: "google-level",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				requiresEffort: true,
				effortRouting: {
					[Effort.Minimal]: "gemini-3.7-flash-low",
					[Effort.Low]: "gemini-3.7-flash-low",
					[Effort.Medium]: "gemini-3.7-flash-medium",
					[Effort.High]: "gemini-3.7-flash-high",
				},
			},
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
		});

		const stream = streamSimple(model, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.Minimal,
			fetch: fetchMock,
		});
		await stream.result();

		const parsed = JSON.parse(requestBody ?? "{}") as CapturedRequestBody;
		expect(parsed.model).toBe("gemini-3.7-flash-low");
		expect(parsed.request?.generationConfig?.thinkingConfig?.thinkingLevel).toBe("LOW");
	});
});
