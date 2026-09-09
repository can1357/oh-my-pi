import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

afterEach(() => {
	vi.restoreAllMocks();
});

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function getRequestUrl(input: string | URL | Request): string {
	if (input instanceof Request) {
		return input.url;
	}
	return typeof input === "string" ? input : input.toString();
}

function getRequestHeader(
	input: string | URL | Request,
	init: RequestInit | undefined,
	headerName: string,
): string | null {
	if (input instanceof Request) {
		return input.headers.get(headerName);
	}
	return new Headers(init?.headers).get(headerName);
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

const INTEGRATOR_ENTITLEMENT_BODY = {
	error: {
		message:
			'The requested model is not available for integrator "opencode". Available models: [gpt-4.1 claude-opus-4.7 gpt-5.5]',
		code: "model_not_available_for_integrator",
		param: "model",
		type: "invalid_request_error",
	},
};

const testToken = "ghu_test_copilot_token";
const enterpriseApiKey = JSON.stringify({ token: testToken, enterpriseUrl: "ghe.example.com" });
const businessApiKey = JSON.stringify({
	token: testToken,
	apiEndpoint: "https://api.business.githubcopilot.com",
});

describe("GitHub Copilot OpenAI transport base URL", () => {
	it("uses model baseUrl for chat completions", async () => {
		const requestedUrls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			requestedUrls.push(getRequestUrl(input));
			return createUnauthorizedResponse();
		});

		const model = getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">;
		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: testToken,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestedUrls[0]).toBe("https://api.githubcopilot.com/chat/completions");
	});

	it("uses model baseUrl for responses API", async () => {
		const requestedUrls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			requestedUrls.push(getRequestUrl(input));
			return createUnauthorizedResponse();
		});

		const model = getBundledModel("github-copilot", "gpt-5-mini") as Model<"openai-responses">;
		const result = await streamOpenAIResponses(model, testContext, {
			apiKey: testToken,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestedUrls[0]).toBe("https://api.githubcopilot.com/responses");
	});

	it("surfaces responses API integrator entitlement details without retrying", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify(INTEGRATOR_ENTITLEMENT_BODY), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const model = getBundledModel("github-copilot", "gpt-5.6-sol") as Model<"openai-responses">;
		const result = await streamOpenAIResponses(model, testContext, {
			apiKey: testToken,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('not available for integrator "opencode"');
		expect(result.errorMessage).toContain("Available models: [gpt-4.1 claude-opus-4.7 gpt-5.5]");
	});

	it("surfaces chat completions model_not_supported after a single request", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "The requested model is not supported.",
							code: "model_not_supported",
							param: "model",
							type: "invalid_request_error",
						},
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				),
		);

		const model = getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">;
		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: testToken,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("The requested model is not supported.");
	});

	it("omits OpenAI priority service tier while native OpenAI keeps it", async () => {
		const requestedBodies: Record<string, unknown>[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requestedBodies.push(await getRequestBody(input, init));
			return createUnauthorizedResponse();
		});
		const requestOptions = {
			apiKey: testToken,
			fetch: fetchMock as unknown as typeof fetch,
			serviceTier: "priority" as const,
		};

		const copilotModel = getBundledModel("github-copilot", "gpt-5.4") as Model<"openai-responses">;
		await streamOpenAIResponses(copilotModel, testContext, requestOptions).result();

		const openAIModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
		await streamOpenAIResponses(openAIModel, testContext, requestOptions).result();

		expect(requestedBodies).toHaveLength(2);
		expect(requestedBodies[0]?.service_tier).toBeUndefined();
		expect(requestedBodies[1]?.service_tier).toBe("priority");
	});

	it("routes structured enterprise credentials to the enterprise chat completions host", async () => {
		const requestedUrls: string[] = [];
		const requestedAuthHeaders: Array<string | null> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requestedUrls.push(getRequestUrl(input));
			requestedAuthHeaders.push(getRequestHeader(input, init, "Authorization"));
			return createUnauthorizedResponse();
		});

		const model = getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">;
		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: enterpriseApiKey,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestedUrls[0]).toBe("https://copilot-api.ghe.example.com/chat/completions");
		expect(requestedAuthHeaders[0]).toBe(`Bearer ${testToken}`);
	});

	it("routes structured business credentials to the business chat completions host", async () => {
		const requestedUrls: string[] = [];
		const requestedAuthHeaders: Array<string | null> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requestedUrls.push(getRequestUrl(input));
			requestedAuthHeaders.push(getRequestHeader(input, init, "Authorization"));
			return createUnauthorizedResponse();
		});

		const model = getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">;
		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: businessApiKey,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestedUrls[0]).toBe("https://api.business.githubcopilot.com/chat/completions");
		expect(requestedAuthHeaders[0]).toBe(`Bearer ${testToken}`);
	});

	it("routes structured enterprise credentials to the enterprise responses host", async () => {
		const requestedUrls: string[] = [];
		const requestedAuthHeaders: Array<string | null> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requestedUrls.push(getRequestUrl(input));
			requestedAuthHeaders.push(getRequestHeader(input, init, "Authorization"));
			return createUnauthorizedResponse();
		});

		const model = getBundledModel("github-copilot", "gpt-5-mini") as Model<"openai-responses">;
		const result = await streamOpenAIResponses(model, testContext, {
			apiKey: enterpriseApiKey,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestedUrls[0]).toBe("https://copilot-api.ghe.example.com/responses");
		expect(requestedAuthHeaders[0]).toBe(`Bearer ${testToken}`);
	});

	it("routes structured business credentials to the business responses host", async () => {
		const requestedUrls: string[] = [];
		const requestedAuthHeaders: Array<string | null> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requestedUrls.push(getRequestUrl(input));
			requestedAuthHeaders.push(getRequestHeader(input, init, "Authorization"));
			return createUnauthorizedResponse();
		});

		const model = getBundledModel("github-copilot", "gpt-5-mini") as Model<"openai-responses">;
		const result = await streamOpenAIResponses(model, testContext, {
			apiKey: businessApiKey,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestedUrls[0]).toBe("https://api.business.githubcopilot.com/responses");
		expect(requestedAuthHeaders[0]).toBe(`Bearer ${testToken}`);
	});

	it("forwards initiatorOverride to chat completions requests", async () => {
		const requestedInitiators: Array<string | null> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requestedInitiators.push(getRequestHeader(input, init, "X-Initiator"));
			return createUnauthorizedResponse();
		});

		const model = getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">;
		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: testToken,
			fetch: fetchMock as unknown as typeof fetch,
			initiatorOverride: "agent",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestedInitiators[0]).toBe("agent");
	});

	it("forwards initiatorOverride to responses requests", async () => {
		const requestedInitiators: Array<string | null> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requestedInitiators.push(getRequestHeader(input, init, "X-Initiator"));
			return createUnauthorizedResponse();
		});

		const model = getBundledModel("github-copilot", "gpt-5-mini") as Model<"openai-responses">;
		const result = await streamOpenAIResponses(model, testContext, {
			apiKey: testToken,
			fetch: fetchMock as unknown as typeof fetch,
			initiatorOverride: "agent",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestedInitiators[0]).toBe("agent");
	});
});
