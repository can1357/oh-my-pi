import { describe, expect, it } from "bun:test";
import { fetchZedModels } from "../../src/discovery/zed";
import { Effort } from "../../src/effort";
import type { FetchImpl } from "../../src/types";
import { ZED_APP_VERSION, ZED_CLOUD_URL, ZED_HEADERS } from "../../src/wire/zed";

describe("Zed Model Discovery", () => {
	it("executes the full two-tier auth chain with master credentials (userId + accessToken)", async () => {
		interface RecordedCall {
			url: string;
			method: string;
			headers: Record<string, string>;
			body?: unknown;
		}

		const recordedCalls: RecordedCall[] = [];

		const mockFetcher: FetchImpl = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = init?.method ?? "GET";
			const headersObj: Record<string, string> = {};
			if (init?.headers) {
				const h = new Headers(init.headers);
				h.forEach((value, key) => {
					headersObj[key.toLowerCase()] = value;
				});
			}

			let bodyParsed: unknown;
			if (init?.body && typeof init.body === "string") {
				try {
					bodyParsed = JSON.parse(init.body);
				} catch {
					bodyParsed = init.body;
				}
			}

			recordedCalls.push({
				url,
				method,
				headers: headersObj,
				body: bodyParsed,
			});

			if (url === `${ZED_CLOUD_URL}/client/llm_tokens`) {
				return new Response(JSON.stringify({ token: "minted_short_lived_llm_token_999" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			if (url === `${ZED_CLOUD_URL}/models`) {
				const mockResponse = {
					models: [
						{
							provider: "anthropic",
							id: "claude-sonnet-5",
							display_name: "Claude Sonnet 5",
							max_token_count: 1_000_000,
							max_output_tokens: 64_000,
							supports_tools: true,
							supports_images: true,
							supports_thinking: true,
							supported_effort_levels: [
								{ name: "Low", value: "low" },
								{ name: "Medium", value: "medium", is_default: true },
								{ name: "High", value: "high" },
							],
						},
						{
							provider: "open_ai",
							id: "gpt-5.6-sol",
							display_name: "GPT-5.6 Sol",
							max_token_count: 1_000_000,
							max_output_tokens: 16_384,
							supports_tools: true,
							supports_images: true,
							supports_thinking: true,
							supported_effort_levels: [{ name: "High", value: "high", is_default: true }],
						},
						{
							provider: "x_ai",
							id: "grok-4.20",
							display_name: "Grok 4.20",
							max_token_count: 256_000,
							max_output_tokens: 8_192,
							supports_tools: true,
							supports_images: false,
							supports_thinking: false,
						},
					],
					default_model: "claude-sonnet-5",
					default_fast_model: "grok-4.20",
					recommended_models: ["claude-sonnet-5", "gpt-5.6-sol"],
				};

				return new Response(JSON.stringify(mockResponse), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			return new Response("Not Found", { status: 404 });
		};

		const masterCredentials = "48201 secret_access_token_abc123";
		const models = await fetchZedModels({ token: masterCredentials, fetcher: mockFetcher });

		// 1. Assert exactly 2 sequential requests were made
		expect(recordedCalls.length).toBe(2);

		// 2. Request 1: POST /client/llm_tokens with master Authorization and organization_id: null
		const call1 = recordedCalls[0];
		expect(call1.url).toBe(`${ZED_CLOUD_URL}/client/llm_tokens`);
		expect(call1.method).toBe("POST");
		expect(call1.headers.authorization).toBe("48201 secret_access_token_abc123");
		expect(call1.headers[ZED_HEADERS.VERSION]).toBe(ZED_APP_VERSION);
		expect(call1.headers["content-type"]).toBe("application/json");
		expect(call1.body).toEqual({ organization_id: null });

		// 3. Request 2: GET /models with Bearer minted token, x-zed-version, and x-zed-client-supports-x-ai
		const call2 = recordedCalls[1];
		expect(call2.url).toBe(`${ZED_CLOUD_URL}/models`);
		expect(call2.method).toBe("GET");
		expect(call2.headers.authorization).toBe("Bearer minted_short_lived_llm_token_999");
		expect(call2.headers[ZED_HEADERS.VERSION]).toBe(ZED_APP_VERSION);
		expect(call2.headers[ZED_HEADERS.CLIENT_X_AI]).toBe("true");
		expect(call2.headers["content-type"]).toBe("application/json");

		// 4. Assert returned live models
		expect(models).not.toBeNull();
		expect(models?.length).toBe(3);

		const sonnet = models?.find(m => m.id === "claude-sonnet-5");
		expect(sonnet).toBeDefined();
		expect(sonnet?.name).toBe("Claude Sonnet 5");
		expect(sonnet?.provider).toBe("zed-agent");
		expect(sonnet?.baseUrl).toBe(ZED_CLOUD_URL);
		expect(sonnet?.reasoning).toBeTrue();
		expect(sonnet?.thinking?.mode).toBe("anthropic-adaptive");
		expect(sonnet?.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(sonnet?.thinking?.defaultLevel).toBe(Effort.Medium);
		expect(sonnet?.contextWindow).toBe(1_000_000);
		expect(sonnet?.maxTokens).toBe(64_000);
		expect(sonnet?.input).toEqual(["text", "image"]);
		expect(sonnet?.supportsTools).toBe(true);

		const gpt = models?.find(m => m.id === "gpt-5.6-sol");
		expect(gpt).toBeDefined();
		expect(gpt?.name).toBe("GPT-5.6 Sol");
		expect(gpt?.reasoning).toBeTrue();
		expect(gpt?.thinking?.mode).toBe("effort");
		expect(gpt?.thinking?.efforts).toEqual([Effort.High]);
		expect(gpt?.thinking?.defaultLevel).toBe(Effort.High);
		expect(gpt?.contextWindow).toBe(1_000_000);
		expect(gpt?.maxTokens).toBe(16_384);

		const grok = models?.find(m => m.id === "grok-4.20");
		expect(grok).toBeDefined();
		expect(grok?.name).toBe("Grok 4.20");
		expect(grok?.reasoning).toBeFalse();
		expect(grok?.thinking).toBeUndefined();
		expect(grok?.contextWindow).toBe(256_000);
		expect(grok?.maxTokens).toBe(8_192);
		expect(grok?.input).toEqual(["text"]);
	});

	it("supports direct bearer token when no userId is present in credentials", async () => {
		const recordedCalls: Array<{ url: string; headers: Record<string, string> }> = [];

		const mockFetcher: FetchImpl = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const headersObj: Record<string, string> = {};
			if (init?.headers) {
				const h = new Headers(init.headers);
				h.forEach((value, key) => {
					headersObj[key.toLowerCase()] = value;
				});
			}

			recordedCalls.push({ url, headers: headersObj });

			return new Response(
				JSON.stringify({
					models: [
						{
							provider: "anthropic",
							id: "claude-3-7-sonnet",
							display_name: "Claude 3.7 Sonnet",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const directToken = "direct_pre_minted_llm_token";
		const models = await fetchZedModels({ token: directToken, fetcher: mockFetcher });

		expect(recordedCalls.length).toBe(1);
		expect(recordedCalls[0].url).toBe(`${ZED_CLOUD_URL}/models`);
		expect(recordedCalls[0].headers.authorization).toBe("Bearer direct_pre_minted_llm_token");
		expect(recordedCalls[0].headers[ZED_HEADERS.CLIENT_X_AI]).toBe("true");

		expect(models).not.toBeNull();
		expect(models?.length).toBe(1);
		expect(models?.[0].id).toBe("claude-3-7-sonnet");
	});

	it("returns null on token mint HTTP error without returning stale fallback", async () => {
		const mockFetcher: FetchImpl = async input => {
			const url = String(input);
			if (url.includes("/client/llm_tokens")) {
				return new Response(JSON.stringify({ error: "Unauthorized master token" }), { status: 401 });
			}
			return new Response("Not Found", { status: 404 });
		};

		const models = await fetchZedModels({
			token: "12345 invalid_master_token",
			fetcher: mockFetcher,
		});

		expect(models).toBeNull();
	});

	it("returns null on token mint network error without returning stale fallback", async () => {
		const mockFetcher: FetchImpl = async input => {
			const url = String(input);
			if (url.includes("/client/llm_tokens")) {
				throw new Error("Network connection refused");
			}
			return new Response("Not Found", { status: 404 });
		};

		const models = await fetchZedModels({
			token: "12345 master_token",
			fetcher: mockFetcher,
		});

		expect(models).toBeNull();
	});

	it("returns null on invalid token mint JSON response without returning stale fallback", async () => {
		const mockFetcher: FetchImpl = async input => {
			const url = String(input);
			if (url.includes("/client/llm_tokens")) {
				return new Response(JSON.stringify({ unexpected_shape: true }), { status: 200 });
			}
			return new Response("Not Found", { status: 404 });
		};

		const models = await fetchZedModels({
			token: "12345 master_token",
			fetcher: mockFetcher,
		});

		expect(models).toBeNull();
	});

	it("returns null on models endpoint HTTP error without returning stale fallback", async () => {
		const mockFetcher: FetchImpl = async input => {
			const url = String(input);
			if (url.includes("/client/llm_tokens")) {
				return new Response(JSON.stringify({ token: "test_token" }), { status: 200 });
			}
			if (url.includes("/models")) {
				return new Response("Payment Required", { status: 402 });
			}
			return new Response("Not Found", { status: 404 });
		};

		const models = await fetchZedModels({
			token: "12345 master_token",
			fetcher: mockFetcher,
		});

		expect(models).toBeNull();
	});

	it("returns null on models endpoint network error without returning stale fallback", async () => {
		const mockFetcher: FetchImpl = async input => {
			const url = String(input);
			if (url.includes("/client/llm_tokens")) {
				return new Response(JSON.stringify({ token: "test_token" }), { status: 200 });
			}
			if (url.includes("/models")) {
				throw new Error("Socket hung up");
			}
			return new Response("Not Found", { status: 404 });
		};

		const models = await fetchZedModels({
			token: "12345 master_token",
			fetcher: mockFetcher,
		});

		expect(models).toBeNull();
	});

	it("returns null on models endpoint schema mismatch without returning stale fallback", async () => {
		const mockFetcher: FetchImpl = async input => {
			const url = String(input);
			if (url.includes("/client/llm_tokens")) {
				return new Response(JSON.stringify({ token: "test_token" }), { status: 200 });
			}
			if (url.includes("/models")) {
				return new Response(JSON.stringify({ unexpected_data: "no models key" }), { status: 200 });
			}
			return new Response("Not Found", { status: 404 });
		};

		const models = await fetchZedModels({
			token: "12345 master_token",
			fetcher: mockFetcher,
		});

		expect(models).toBeNull();
	});

	it("returns empty array for valid empty live model catalog", async () => {
		const mockFetcher: FetchImpl = async input => {
			const url = String(input);
			if (url.includes("/client/llm_tokens")) {
				return new Response(JSON.stringify({ token: "test_token" }), { status: 200 });
			}
			if (url.includes("/models")) {
				return new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("Not Found", { status: 404 });
		};

		const models = await fetchZedModels({
			token: "12345 master_token",
			fetcher: mockFetcher,
		});

		expect(models).not.toBeNull();
		expect(models).toEqual([]);
	});

	it("filters out disabled models", async () => {
		const mockFetcher: FetchImpl = async input => {
			const url = String(input);
			if (url.includes("/client/llm_tokens")) {
				return new Response(JSON.stringify({ token: "test_token" }), { status: 200 });
			}
			if (url.includes("/models")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								provider: "anthropic",
								id: "claude-active",
								display_name: "Active Claude",
								is_disabled: false,
							},
							{
								provider: "openai",
								id: "gpt-disabled",
								display_name: "Disabled GPT",
								is_disabled: true,
								disabled_reason: "Quota exceeded",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("Not Found", { status: 404 });
		};

		const models = await fetchZedModels({
			token: "12345 master_token",
			fetcher: mockFetcher,
		});

		expect(models).not.toBeNull();
		expect(models?.length).toBe(1);
		expect(models?.[0].id).toBe("claude-active");
	});
});
