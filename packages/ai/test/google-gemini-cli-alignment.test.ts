import { describe, expect, it } from "bun:test";
import * as geminiCliProvider from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import {
	buildRequest,
	parseGeminiCliCredentials,
	shouldRefreshGeminiCliCredentials,
	streamGoogleGeminiCli,
} from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/registry/oauth";
import type { AssistantMessageEvent, Context, FetchImpl, Model, TJsonSchema } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function createModel(provider: "google-gemini-cli" | "google-antigravity"): Model<"google-gemini-cli"> {
	return buildModel({
		id: provider === "google-antigravity" ? "gemini-3-flash" : "gemini-2.5-flash",
		name: provider,
		api: "google-gemini-cli",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "implement token refresh", timestamp: Date.now() }],
	};
}

const VALIDATION_URL = "https://accounts.google.com/signin/continue?sarp=1&scc=1&plt=AKgnsbtTOKEN";

const validationRequiredBody = JSON.stringify({
	error: {
		code: 403,
		status: "PERMISSION_DENIED",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.ErrorInfo",
				reason: "VALIDATION_REQUIRED",
				metadata: { validation_url: VALIDATION_URL, validation_url_link_text: "Verify your account" },
			},
		],
	},
});

describe("Google Gemini CLI alignment", () => {
	it("encodes enriched OAuth JSON while preserving token + projectId", async () => {
		const expiresAt = Date.now() + 60 * 60 * 1000;
		const result = await getOAuthApiKey("google-gemini-cli", {
			"google-gemini-cli": {
				access: "access-token",
				refresh: "refresh-token",
				expires: expiresAt,
				projectId: "proj-123",
				email: "dev@example.com",
				accountId: "acct-1",
			},
		});

		expect(result).not.toBeNull();
		const payload = JSON.parse(result!.apiKey) as {
			token?: string;
			projectId?: string;
			refreshToken?: string;
			expiresAt?: number;
			email?: string;
			accountId?: string;
		};
		expect(payload.token).toBe("access-token");
		expect(payload.projectId).toBe("proj-123");
		expect(payload.refreshToken).toBe("refresh-token");
		expect(payload.expiresAt).toBe(expiresAt);
		expect(payload.email).toBe("dev@example.com");
		expect(payload.accountId).toBe("acct-1");
	});

	it("accepts legacy, alias, and enriched OAuth JSON payloads", () => {
		const legacy = parseGeminiCliCredentials(JSON.stringify({ token: "legacy-token", projectId: "proj-legacy" }));
		expect(legacy).toEqual({
			accessToken: "legacy-token",
			projectId: "proj-legacy",
			refreshToken: undefined,
			expiresAt: undefined,
			email: undefined,
		});

		const aliasPayload = parseGeminiCliCredentials(
			JSON.stringify({
				token: "alias-token",
				project_id: "proj-alias",
				refresh: "refresh-alias",
				expires: 1_737_000_000,
			}),
		);
		expect(aliasPayload).toEqual({
			accessToken: "alias-token",
			projectId: "proj-alias",
			refreshToken: "refresh-alias",
			expiresAt: 1_737_000_000_000,
			email: undefined,
		});

		const enriched = parseGeminiCliCredentials(
			JSON.stringify({
				token: "enriched-token",
				projectId: "proj-enriched",
				refreshToken: "refresh-token",
				expiresAt: 1_737_000_000_000,
				email: "dev@example.com",
			}),
		);
		expect(enriched).toEqual({
			accessToken: "enriched-token",
			projectId: "proj-enriched",
			refreshToken: "refresh-token",
			expiresAt: 1_737_000_000_000,
			email: "dev@example.com",
		});
	});

	it("keeps projectId alias precedence and tolerates a mistyped projectId", () => {
		// projectId wins over project_id even when it is an empty string.
		const emptyPrimary = parseGeminiCliCredentials(
			JSON.stringify({ token: "t", projectId: "", project_id: "fallback" }),
		);
		expect(emptyPrimary.projectId).toBe("");

		// A non-string projectId is dropped, so project_id is used instead.
		const mistyped = parseGeminiCliCredentials(JSON.stringify({ token: "t", projectId: 42, project_id: "fallback" }));
		expect(mistyped.projectId).toBe("fallback");
	});

	it("avoids excessive antigravity refresh churn with pre-buffered OAuth expiry", () => {
		const issuedAt = 1_700_000_000_000;
		const preBufferedExpiry = issuedAt + 55 * 60 * 1000;

		expect(shouldRefreshGeminiCliCredentials(preBufferedExpiry, true, issuedAt + 10 * 60 * 1000)).toBe(false);
		expect(shouldRefreshGeminiCliCredentials(preBufferedExpiry, true, issuedAt + 54 * 60 * 1000)).toBe(true);
		expect(shouldRefreshGeminiCliCredentials(preBufferedExpiry, false, issuedAt + 54 * 60 * 1000)).toBe(true);
	});

	it("does not export provider-direct refresh helper", () => {
		expect(shouldRefreshGeminiCliCredentials).toBe(geminiCliProvider.shouldRefreshGeminiCliCredentials);
		expect(Object.hasOwn(geminiCliProvider, "refreshGeminiCliCredentialsIfNeeded")).toBe(false);
	});

	it("omits antigravity-only metadata in non-antigravity request payloads", () => {
		const model = createModel("google-gemini-cli");
		const payload = buildRequest(model, createContext(), "proj-123", {}, false) as {
			request: { sessionId?: string };
			requestType?: string;
			userAgent?: string;
			requestId?: string;
		};

		expect(payload.request.sessionId).toBeUndefined();
		expect(payload.requestType).toBeUndefined();
		expect(payload.userAgent).toBeUndefined();
		expect(payload.requestId).toBeUndefined();
	});
	it("keeps every system prompt block in systemInstruction instead of conversation contents", () => {
		const model = createModel("google-gemini-cli");
		const context: Context = {
			systemPrompt: ["primary instruction", "", "supplemental \uD800instruction"],
			messages: [{ role: "user", content: "implement token refresh", timestamp: Date.now() }],
		};
		const payload = buildRequest(model, context, "proj-123", {}, false) as {
			request: {
				contents: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
				systemInstruction?: { role?: string; parts: Array<{ text: string }> };
			};
		};

		expect(payload.request.systemInstruction).toEqual({
			parts: [{ text: "primary instruction" }, { text: "supplemental �instruction" }],
		});
		expect(payload.request.systemInstruction?.role).toBeUndefined();
		expect(payload.request.contents).toEqual([{ role: "user", parts: [{ text: "implement token refresh" }] }]);
	});

	it("drops only unsigned thinking when replaying Antigravity Claude history", () => {
		const signedThinking = "signed reasoning";
		const unsignedThinking = "unsigned reasoning";
		const signature = "c2lnbmVk";
		const createThinkingContext = (model: Model<"google-gemini-cli">): Context => ({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: signedThinking, thinkingSignature: signature },
						{ type: "thinking", thinking: unsignedThinking },
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
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
				{ role: "user", content: "continue", timestamp: 2 },
			],
		});
		const claudeModel = buildModel({
			...createModel("google-antigravity"),
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			reasoning: true,
		} as ModelSpec<"google-gemini-cli">);
		const claudePayload = buildRequest(claudeModel, createThinkingContext(claudeModel), "proj-123", {}, true) as {
			request: {
				contents: Array<{
					role: string;
					parts: Array<{ text?: string; thought?: boolean; thoughtSignature?: string }>;
				}>;
			};
		};
		const claudeParts = claudePayload.request.contents.find(content => content.role === "model")?.parts;
		expect(claudeParts).toEqual([{ thought: true, text: signedThinking, thoughtSignature: signature }]);

		const geminiModel = createModel("google-antigravity");
		const geminiPayload = buildRequest(geminiModel, createThinkingContext(geminiModel), "proj-123", {}, true) as {
			request: {
				contents: Array<{
					role: string;
					parts: Array<{ text?: string; thought?: boolean; thoughtSignature?: string }>;
				}>;
			};
		};
		const geminiParts = geminiPayload.request.contents.find(content => content.role === "model")?.parts ?? [];
		expect(geminiParts).toContainEqual({ thought: true, text: signedThinking, thoughtSignature: signature });
		expect(geminiParts.some(part => part.text?.includes(unsignedThinking))).toBe(true);
	});

	it("keeps antigravity metadata in antigravity request payloads", () => {
		const model = createModel("google-antigravity");
		const context: Context = { ...createContext(), systemPrompt: ["be terse"] };
		const payload = buildRequest(model, context, "proj-123", {}, true) as {
			request: {
				sessionId?: string;
				labels?: Record<string, string>;
				systemInstruction?: { role?: string };
			};
			requestType?: string;
			userAgent?: string;
			requestId?: string;
		};

		expect(payload.request.sessionId).toMatch(/^-[0-9]+$/);
		expect(payload.requestType).toBe("agent");
		expect(payload.userAgent).toBe("antigravity");
		// Structured requestId: agent/<agentId>/<ts>/<trajectoryId>/<step>.
		expect(payload.requestId).toMatch(/^agent\/[0-9a-f-]+\/\d+\/[0-9a-f-]+\/\d+$/);
		// Antigravity tags its system instruction with role "user".
		expect(payload.request.systemInstruction?.role).toBe("user");
		const labels = payload.request.labels;
		expect(labels?.trajectory_id).toMatch(/^[0-9a-f-]+$/);
		expect(labels?.last_step_index).toBe("1");
		expect(labels?.used_claude).toBe("false");
		expect(labels?.used_claude_conservative).toBe("false");
	});

	it("stamps the antigravity wire profile (maxOutputTokens + model_enum) by routed wire id", () => {
		const model = createModel("google-antigravity");
		const payload = buildRequest(
			model,
			createContext(),
			"proj-123",
			{ requestModelId: "gemini-3.5-flash-low" },
			true,
		) as {
			model?: string;
			request: { generationConfig?: { maxOutputTokens?: number }; labels?: Record<string, string> };
		};

		expect(payload.model).toBe("gemini-3.5-flash-low");
		expect(payload.request.generationConfig?.maxOutputTokens).toBe(65536);
		expect(payload.request.labels?.model_enum).toBe("MODEL_PLACEHOLDER_M20");
	});

	it("caps Claude maxOutputTokens at 64000 and omits the unset model_enum label", () => {
		// Regression for #3067: discovery may advertise 65536, but
		// `daily-cloudcode-pa` 400s when Claude requests exceed 64000.
		// The Claude profiles also lack a captured model_enum token, so
		// the request must not emit a stale or placeholder label.
		const cases = [{ requestModelId: "claude-sonnet-4-6" }, { requestModelId: "claude-opus-4-6-thinking" }];
		for (const opts of cases) {
			const payload = buildRequest(createModel("google-antigravity"), createContext(), "proj-123", opts, true) as {
				model?: string;
				request: { generationConfig?: { maxOutputTokens?: number }; labels?: Record<string, string> };
			};

			expect(payload.model).toBe(opts.requestModelId);
			expect(payload.request.generationConfig?.maxOutputTokens).toBe(64000);
			expect(payload.request.labels?.model_enum).toBeUndefined();
		}
	});

	it("defaults antigravity tools to VALIDATED but omits AUTO toolConfig for plain gemini-cli", () => {
		const context: Context = {
			messages: [{ role: "user", content: "inspect repo", timestamp: Date.now() }],
			tools: [
				{
					name: "read_file",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					} as TJsonSchema,
				},
			],
		};

		const cli = buildRequest(
			createModel("google-gemini-cli"),
			context,
			"proj-123",
			{ toolChoice: "auto" },
			false,
		) as {
			request: { tools?: unknown; toolConfig?: unknown };
		};
		expect(cli.request.tools).toBeDefined();
		expect(cli.request.toolConfig).toBeUndefined();

		const antigravity = buildRequest(
			createModel("google-antigravity"),
			context,
			"proj-123",
			{ toolChoice: "auto" },
			true,
		) as {
			request: { tools?: unknown; toolConfig?: { functionCallingConfig: { mode: string } } };
		};
		expect(antigravity.request.tools).toBeDefined();
		expect(antigravity.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
	});

	it("strips patternProperties when antigravity rewrites tools to legacy parameters", () => {
		const model = createModel("google-antigravity");
		const toolContext: Context = {
			messages: [{ role: "user", content: "rewrite files", timestamp: Date.now() }],
			tools: [
				{
					name: "rewrite_rules",
					description: "Map rewrite regex to replacement",
					parameters: {
						type: "object",
						properties: {
							rules: {
								type: "object",
								patternProperties: {
									"^(.*)$": { type: "string" },
								},
							},
						},
						required: ["rules"],
					} as TJsonSchema,
				},
			],
		};
		const payload = buildRequest(model, toolContext, "proj-123", {}, true) as {
			request: { tools?: Array<{ functionDeclarations: Array<{ parameters?: unknown }> }> };
		};

		const parameters = payload.request.tools?.[0]?.functionDeclarations[0]?.parameters;
		expect(parameters).toBeDefined();
		expect(JSON.stringify(parameters)).not.toContain('"patternProperties"');
	});
	it("adds anthropic-beta for Antigravity Claude reasoning models without relying on id suffix", async () => {
		let requestHeaders: Headers | undefined;
		const fetchMock: FetchImpl = async (_url, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response('{"error":{"message":"bad request"}}', { status: 400 });
		};

		const model: Model<"google-gemini-cli"> = buildModel({
			...createModel("google-antigravity"),
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			reasoning: true,
		} as ModelSpec<"google-gemini-cli">);

		const result = await streamGoogleGeminiCli(model, createContext(), {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestHeaders!.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
		expect(requestHeaders!.get("X-Goog-Api-Client")).toBeNull();
		expect(requestHeaders!.get("Client-Metadata")).toBeNull();
	});

	it("sends the antigravity/hub User-Agent header on the Antigravity transport", async () => {
		let requestHeaders: Headers | undefined;
		const fetchMock: FetchImpl = async (_url, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response('{"error":{"message":"bad request"}}', { status: 400 });
		};

		const model = createModel("google-antigravity");
		await streamGoogleGeminiCli(model, createContext(), {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		}).result();

		expect(requestHeaders!.get("User-Agent")).toMatch(/^antigravity\/hub\/[0-9.]+ /);
	});

	it("filters out empty text parts at stream end but preserves terminal thought signatures", async () => {
		const sseChunks = [
			'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]}}]}}\n\n',
			'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"","thoughtSignature":"terminal-sig"}]},"finishReason":"STOP"}]}}\n\n',
		];

		const fetchMock: FetchImpl = async () => {
			const stream = new ReadableStream({
				async start(controller) {
					const encoder = new TextEncoder();
					for (const chunk of sseChunks) {
						controller.enqueue(encoder.encode(chunk));
						await Promise.resolve();
					}
					controller.close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		};

		const model: Model<"google-gemini-cli"> = buildModel({
			...createModel("google-antigravity"),
			id: "gemini-3.5-flash",
			name: "Gemini 3.5 Flash",
			reasoning: true,
		} as ModelSpec<"google-gemini-cli">);

		const events: AssistantMessageEvent[] = [];
		const stream = streamGoogleGeminiCli(model, createContext(), {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Hello",
			textSignature: "terminal-sig",
		});

		const textStartEvents = events.filter(e => e.type === "text_start");
		expect(textStartEvents).toHaveLength(1);
		expect(textStartEvents[0].contentIndex).toBe(0);

		const textDeltaEvents = events.filter(e => e.type === "text_delta");
		expect(textDeltaEvents).toHaveLength(1);
		expect(textDeltaEvents[0].delta).toBe("Hello");

		const textEndEvents = events.filter(e => e.type === "text_end");
		expect(textEndEvents).toHaveLength(1);
		expect(textEndEvents[0].content).toBe("Hello");
	});

	it("keeps a text block's own thoughtSignature when a following function call carries its own", async () => {
		// A functionCall part with `text: undefined` must NOT pollute the preceding text/thinking
		// block via the terminal-signature branch; its signature belongs on the tool call alone.
		const sseChunks = [
			'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello","thoughtSignature":"text-sig"}]}}]}}\n\n',
			'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"SF"}},"thoughtSignature":"toolcall-sig"}]},"finishReason":"STOP"}]}}\n\n',
		];

		const fetchMock: FetchImpl = async () => {
			const stream = new ReadableStream({
				async start(controller) {
					const encoder = new TextEncoder();
					for (const chunk of sseChunks) {
						controller.enqueue(encoder.encode(chunk));
						await Promise.resolve();
					}
					controller.close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		};

		const model: Model<"google-gemini-cli"> = buildModel({
			...createModel("google-antigravity"),
			id: "gemini-3.5-flash",
			name: "Gemini 3.5 Flash",
			reasoning: true,
		} as ModelSpec<"google-gemini-cli">);

		const events: AssistantMessageEvent[] = [];
		const stream = streamGoogleGeminiCli(model, createContext(), {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(2);

		// The text block keeps its OWN signature — the function call's signature must NOT migrate onto it.
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Hello",
			textSignature: "text-sig",
		});

		// The function call's signature is captured on the tool call itself, by the functionCall branch.
		const toolCall = result.content[1];
		expect(toolCall.type).toBe("toolCall");
		if (toolCall.type === "toolCall") {
			expect(toolCall.name).toBe("get_weather");
			expect(toolCall.thoughtSignature).toBe("toolcall-sig");
		}

		expect(events.filter(e => e.type === "toolcall_start")).toHaveLength(1);
	});

	it("surfaces account verification failures from model requests", async () => {
		const fetchMock: FetchImpl = async () => new Response(validationRequiredBody, { status: 403 });
		const model = createModel("google-antigravity");

		const stream = streamGoogleGeminiCli(model, createContext(), {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123", email: "dev@example.com" }),
			fetch: fetchMock,
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(403);
		expect(result.errorMessage).toBe(
			`Cloud Code Assist API error (403): Account verification required for dev@example.com. Visit ${VALIDATION_URL} to continue, then retry your request.`,
		);
	});

	describe("retry guardrails", () => {
		it("does not treat explicit HTTP failures as network retry errors", async () => {
			let fetchCalls = 0;
			const fetchMock: FetchImpl = async () => {
				fetchCalls += 1;
				return new Response('{"error":{"message":"busy"}}', {
					status: 503,
					headers: { "retry-after": "120" },
				});
			};

			const model = createModel("google-gemini-cli");
			const stream = streamGoogleGeminiCli(model, createContext(), {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				maxRetryDelayMs: 1000,
				fetch: fetchMock,
			});

			const result = await stream.result();
			expect(fetchCalls).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Cloud Code Assist API error (503)");
		});
	});

	describe("planning leak interception", () => {
		it("intercepts a fragmented planning leak and retries after discarding it", async () => {
			const sseChunks = [
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"{\\n"}]}}]}}\n\n',
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"  \\"thought\\": \\"let us do something\\",\\n"}]}}]}}\n\n',
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"  \\"call\\": \\"read\\",\\n  \\"paths\\": [\\"src/main.ts\\"]\\n}"}]},"finishReason":"STOP"}]}}\n\n',
			];

			let fetchCalls = 0;
			const fetchMock: FetchImpl = async () => {
				fetchCalls += 1;
				const chunks =
					fetchCalls === 1
						? sseChunks
						: [
								'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Recovered."}]},"finishReason":"STOP"}]}}\n\n',
							];
				const stream = new ReadableStream({
					async start(controller) {
						const encoder = new TextEncoder();
						for (const chunk of chunks) {
							controller.enqueue(encoder.encode(chunk));
							await Promise.resolve();
						}
						controller.close();
					},
				});
				const response = new Response(stream, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
				Object.defineProperty(response, "url", {
					value: "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent",
				});
				return response;
			};

			const model = createModel("google-gemini-cli");
			const events: AssistantMessageEvent[] = [];
			const stream = streamGoogleGeminiCli(model, createContext(), {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				fetch: fetchMock,
			});
			for await (const event of stream) {
				events.push(event);
			}
			const result = await stream.result();

			expect(fetchCalls).toBe(2);
			expect(result.content).toEqual([{ type: "text", text: "Recovered." }]);
			expect(result.stopReason).toBe("stop");

			const textDeltaEvents = events.filter(e => e.type === "text_delta");
			expect(textDeltaEvents).toHaveLength(1);
			expect(textDeltaEvents[0].delta).toBe("Recovered.");
		});

		it("does not intercept normal JSON starting with { and releases it", async () => {
			const sseChunks = [
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"{\\n"}]}}]}}\n\n',
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"  \\"some\\": \\"normal json\\"\\n}"}]},"finishReason":"STOP"}]}}\n\n',
			];

			const fetchMock: FetchImpl = async () => {
				const stream = new ReadableStream({
					async start(controller) {
						const encoder = new TextEncoder();
						for (const chunk of sseChunks) {
							controller.enqueue(encoder.encode(chunk));
							await Promise.resolve();
						}
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			};

			const model = createModel("google-gemini-cli");
			const events: AssistantMessageEvent[] = [];
			const stream = streamGoogleGeminiCli(model, createContext(), {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				fetch: fetchMock,
			});
			for await (const event of stream) {
				events.push(event);
			}
			const result = await stream.result();

			expect(result.content).toHaveLength(1);
			expect(result.content[0]).toEqual({
				type: "text",
				text: '{\n  "some": "normal json"\n}',
			});

			const textDeltaEvents = events.filter(e => e.type === "text_delta");
			expect(textDeltaEvents.length).toBeGreaterThan(0);
		});

		it("releases buffer immediately if prefix does not match thought within 100 chars", async () => {
			const longNonThoughtKey = `{${"a".repeat(105)}}`;
			const sseChunks = [
				`data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"${longNonThoughtKey}"}]},"finishReason":"STOP"}]}}\n\n`,
			];

			const fetchMock: FetchImpl = async () => {
				const stream = new ReadableStream({
					async start(controller) {
						const encoder = new TextEncoder();
						for (const chunk of sseChunks) {
							controller.enqueue(encoder.encode(chunk));
							await Promise.resolve();
						}
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			};

			const model = createModel("google-gemini-cli");
			const events: AssistantMessageEvent[] = [];
			const stream = streamGoogleGeminiCli(model, createContext(), {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				fetch: fetchMock,
			});
			for await (const event of stream) {
				events.push(event);
			}
			const result = await stream.result();

			expect(result.content).toHaveLength(1);
			const block = result.content[0];
			if (block.type !== "text") throw new Error("expected text content");
			expect(block.text).toBe(longNonThoughtKey);

			const textDeltaEvents = events.filter(e => e.type === "text_delta");
			expect(textDeltaEvents).toHaveLength(1);
			expect(textDeltaEvents[0].delta).toBe(longNonThoughtKey);
		});

		it("preserves visible suffix after a leaked planning object", async () => {
			const sseChunks = [
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"{\\n  \\"thought\\": \\"The user asked for a rewrite\\"\\n}好的，我来复述这段文本。"}]},"finishReason":"STOP"}]}}\n\n',
			];
			const fetchMock: FetchImpl = async () => {
				const stream = new ReadableStream({
					async start(controller) {
						const encoder = new TextEncoder();
						for (const chunk of sseChunks) {
							controller.enqueue(encoder.encode(chunk));
						}
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			};
			const model = createModel("google-gemini-cli");
			const events: AssistantMessageEvent[] = [];
			const stream = streamGoogleGeminiCli(model, createContext(), {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				fetch: fetchMock,
			});
			for await (const event of stream) {
				events.push(event);
			}
			const result = await stream.result();
			expect(result.content).toHaveLength(1);
			expect(result.content[0]).toEqual({
				type: "text",
				text: "好的，我来复述这段文本。",
			});
		});

		it("does not swallow a visible suffix that itself contains }", async () => {
			const sseChunks = [
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"{\\n  \\"thought\\": \\"plan\\",\\n  \\"call\\": \\"read\\"\\n}示例里保留这个右花括号 } 以及后面的正文"}]},"finishReason":"STOP"}]}}\n\n',
			];
			const fetchMock: FetchImpl = async () => {
				const stream = new ReadableStream({
					async start(controller) {
						const encoder = new TextEncoder();
						for (const chunk of sseChunks) {
							controller.enqueue(encoder.encode(chunk));
						}
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			};
			const model = createModel("google-gemini-cli");
			const events: AssistantMessageEvent[] = [];
			const stream = streamGoogleGeminiCli(model, createContext(), {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				fetch: fetchMock,
			});
			for await (const event of stream) {
				events.push(event);
			}
			const result = await stream.result();
			expect(result.content).toHaveLength(1);
			expect(result.content[0]).toEqual({
				type: "text",
				text: "示例里保留这个右花括号 } 以及后面的正文",
			});
		});

		it("does not erase already-emitted text when a later chunk starts with a leaked planning object", async () => {
			const sseChunks = [
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"先说明一下："}]}}]}}\n\n',
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"{\\n  \\"thought\\": \\"plan\\"\\n}真正答案"}]},"finishReason":"STOP"}]}}\n\n',
			];
			const fetchMock: FetchImpl = async () => {
				const stream = new ReadableStream({
					async start(controller) {
						const encoder = new TextEncoder();
						for (const chunk of sseChunks) {
							controller.enqueue(encoder.encode(chunk));
						}
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			};
			const model = createModel("google-gemini-cli");
			const events: AssistantMessageEvent[] = [];
			const stream = streamGoogleGeminiCli(model, createContext(), {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				fetch: fetchMock,
			});
			for await (const event of stream) {
				events.push(event);
			}
			const result = await stream.result();
			expect(result.content).toHaveLength(1);
			expect(result.content[0]).toEqual({
				type: "text",
				text: "先说明一下：真正答案",
			});
		});

		it("handles functionCall immediately after a planning leak", async () => {
			const sseChunks = [
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"{\\n  \\"thought\\": \\"doing reading\\",\\n  \\"call\\": \\"read\\",\\n  \\"paths\\": [\\"src/main.ts\\"]\\n}"}]}}]}}\n\n',
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read","args":{"path":"src/main.ts"}}}]},"finishReason":"STOP"}]}}\n\n',
			];

			const fetchMock: FetchImpl = async () => {
				const stream = new ReadableStream({
					async start(controller) {
						const encoder = new TextEncoder();
						for (const chunk of sseChunks) {
							controller.enqueue(encoder.encode(chunk));
							await Promise.resolve();
						}
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			};

			const model = createModel("google-gemini-cli");
			const events: AssistantMessageEvent[] = [];
			const stream = streamGoogleGeminiCli(model, createContext(), {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				fetch: fetchMock,
			});
			for await (const event of stream) {
				events.push(event);
			}
			const result = await stream.result();

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("toolCall");
			if (result.content[0].type === "toolCall") {
				expect(result.content[0].name).toBe("read");
				expect(result.content[0].arguments).toEqual({ path: "src/main.ts" });
			}

			expect(events.filter(e => e.type === "toolcall_start")).toHaveLength(1);
		});

		it("handles unescaped quotes in leak with trailing response", async () => {
			const sseChunks = [
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"{\\n  \\"thought\\": \\"He said \\"hello\\" to me\\"\\n}好的，我来复述这段文本。"}]},"finishReason":"STOP"}]}}\n\n',
			];
			const fetchMock: FetchImpl = async () => {
				const stream = new ReadableStream({
					async start(controller) {
						const encoder = new TextEncoder();
						for (const chunk of sseChunks) {
							controller.enqueue(encoder.encode(chunk));
						}
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			};
			const model = createModel("google-gemini-cli");
			const events: AssistantMessageEvent[] = [];
			const stream = streamGoogleGeminiCli(model, createContext(), {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				fetch: fetchMock,
			});
			for await (const event of stream) {
				events.push(event);
			}
			const result = await stream.result();
			expect(result.content).toHaveLength(1);
			expect(result.content[0]).toEqual({
				type: "text",
				text: "好的，我来复述这段文本。",
			});
		});

		it("discards incomplete planning leak with unescaped quotes at EOF", async () => {
			const sseChunks = [
				'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"{\\n  \\"thought\\": \\"incomplete thought with \\"unescaped quotes\\" inside"}]},"finishReason":"STOP"}]}}\n\n',
			];
			const fetchMock: FetchImpl = async () => {
				const stream = new ReadableStream({
					async start(controller) {
						const encoder = new TextEncoder();
						for (const chunk of sseChunks) {
							controller.enqueue(encoder.encode(chunk));
						}
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			};
			const model = createModel("google-gemini-cli");
			const events: AssistantMessageEvent[] = [];
			const stream = streamGoogleGeminiCli(model, createContext(), {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				fetch: fetchMock,
			});
			for await (const event of stream) {
				events.push(event);
			}
			const result = await stream.result();
			expect(result.content).toHaveLength(0);
		});
	});
});
