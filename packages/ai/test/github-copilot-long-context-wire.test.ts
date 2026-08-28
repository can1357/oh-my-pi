/**
 * Copilot long-context catalog variants (e.g. `claude-opus-4.7-1m`) are local
 * entries for a tier of the same upstream model: the wire request MUST carry
 * `requestModelId`, never the local variant id, on every Copilot API path.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Api, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { COPILOT_API_HEADERS } from "@oh-my-pi/pi-catalog/wire/github-copilot";

afterEach(() => {
	vi.restoreAllMocks();
});

// Fixed timestamp keeps the wire-body assertions deterministic; the value is
// never read on the wire, but pinning it avoids any incidental nondeterminism.
const FIXED_TIMESTAMP = 1_700_000_000_000;

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: FIXED_TIMESTAMP }],
};

function makeLongContextVariant<TApi extends Api>(spec: Partial<ModelSpec<TApi>> & { api: TApi }): Model<TApi> {
	return buildModel({
		id: "claude-opus-4.7-1m",
		requestModelId: "claude-opus-4.7",
		name: "Claude Opus 4.7 (1M)",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		headers: { ...COPILOT_API_HEADERS },
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		...spec,
	} as ModelSpec<TApi>);
}

async function getRequestBody(input: string | URL | Request, init?: RequestInit): Promise<Record<string, unknown>> {
	if (input instanceof Request) {
		return (await input.clone().json()) as Record<string, unknown>;
	}
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function createUnauthorizedResponse(): Response {
	return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
		status: 401,
		headers: { "Content-Type": "application/json" },
	});
}

describe("GitHub Copilot long-context variant wire model id", () => {
	it("anthropic-messages sends requestModelId", async () => {
		const wireModelIds: unknown[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			wireModelIds.push((await getRequestBody(input, init)).model);
			return createUnauthorizedResponse();
		});

		const model = makeLongContextVariant({ api: "anthropic-messages" });
		const result = await streamAnthropic(model, testContext, {
			apiKey: "ghu_test_copilot_token",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(wireModelIds[0]).toBe("claude-opus-4.7");
	});

	it("openai-responses sends requestModelId", async () => {
		const wireModelIds: unknown[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			wireModelIds.push((await getRequestBody(input, init)).model);
			return createUnauthorizedResponse();
		});

		const model = makeLongContextVariant({
			api: "openai-responses",
			id: "gpt-5.5-1m",
			requestModelId: "gpt-5.5",
			name: "GPT-5.5 (1M)",
		});
		const result = await streamOpenAIResponses(model, testContext, {
			apiKey: "ghu_test_copilot_token",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(wireModelIds[0]).toBe("gpt-5.5");
	});

	it("openai-completions sends requestModelId", async () => {
		const wireModelIds: unknown[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			wireModelIds.push((await getRequestBody(input, init)).model);
			return createUnauthorizedResponse();
		});

		const model = makeLongContextVariant({
			api: "openai-completions",
			id: "gemini-3.1-pro-preview-1m",
			requestModelId: "gemini-3.1-pro-preview",
			name: "Gemini 3.1 Pro (1M)",
		});
		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "ghu_test_copilot_token",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(wireModelIds[0]).toBe("gemini-3.1-pro-preview");
	});
});

/**
 * GitHub Copilot's Responses endpoint rejects the `detail: "original"` image
 * hint (an oh-my-pi extension that preserves native-resolution snapcompact
 * frames) with an HTTP 400. The catalog resolves `supportsImageDetailOriginal`
 * to `false` for Copilot, and the Responses request builder degrades the hint
 * to `"auto"` so the wire stays valid. Every other host preserves `"original"`.
 */
describe("GitHub Copilot Responses image detail clamp (#2822)", () => {
	const imageContext: Context = {
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "describe this frame" },
					{ type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "original" },
				],
				timestamp: FIXED_TIMESTAMP,
			},
		],
	};

	// Walk a serialized Responses request body and return the first `input_image`
	// detail hint it emits (the wire nests it under `input[].content[]`).
	function firstImageDetail(body: Record<string, unknown>): string | undefined {
		let found: string | undefined;
		const walk = (node: unknown): void => {
			if (found !== undefined || node === null || typeof node !== "object") return;
			if (Array.isArray(node)) {
				for (const child of node) walk(child);
				return;
			}
			const obj = node as Record<string, unknown>;
			if (obj.type === "input_image" && typeof obj.detail === "string") {
				found = obj.detail;
				return;
			}
			for (const value of Object.values(obj)) walk(value);
		};
		walk(body);
		return found;
	}

	async function detailOnWire(model: Model<"openai-responses">): Promise<string | undefined> {
		let body: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			body = await getRequestBody(input, init);
			return createUnauthorizedResponse();
		});
		try {
			// The mocked fetch returns 401; this test only cares about what was
			// serialized onto the wire, which `fetchMock` captures into `body`
			// before `.result()` settles. Tolerate the result rejecting.
			await streamOpenAIResponses(model, imageContext, {
				apiKey: "ghu_test_copilot_token",
				fetch: fetchMock as unknown as typeof fetch,
			}).result();
		} catch {
			// Ignore: the 401 may surface as a rejection on some result paths.
		}
		return body === undefined ? undefined : firstImageDetail(body);
	}

	it("degrades `original` to `auto` for GitHub Copilot, which rejects it with a 400", async () => {
		const model = makeLongContextVariant({
			api: "openai-responses",
			id: "gpt-5.5-1m",
			requestModelId: "gpt-5.5",
			name: "GPT-5.5 (1M)",
		});
		expect(model.compat.supportsImageDetailOriginal).toBe(false);
		expect(await detailOnWire(model)).toBe("auto");
	});

	it("preserves `original` for non-Copilot Responses hosts (snapcompact native frames)", async () => {
		const model = makeLongContextVariant({
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			headers: {},
			id: "gpt-5.5",
			requestModelId: "gpt-5.5",
			name: "GPT-5.5",
		});
		expect(model.compat.supportsImageDetailOriginal).toBe(true);
		expect(await detailOnWire(model)).toBe("original");
	});

	it("clamps `original` when only the base URL identifies Copilot (provider id differs)", async () => {
		// A model pointed at the Copilot Responses host but labeled with a generic
		// provider id must still degrade `original`. Detecting Copilot solely by the
		// provider field would resolve `supportsImageDetailOriginal: true` here and
		// reintroduce the HTTP 400 this clamp prevents; host-aware detection keeps it
		// `false`.
		const model = makeLongContextVariant({
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.githubcopilot.com",
			id: "gpt-5.5-1m",
			requestModelId: "gpt-5.5",
			name: "GPT-5.5 (1M)",
		});
		expect(model.compat.supportsImageDetailOriginal).toBe(false);
		expect(await detailOnWire(model)).toBe("auto");
	});
});
