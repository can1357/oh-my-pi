import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	buildZedProviderRequest,
	clearZedLlmTokenCache,
	fetchZedLlmToken,
	normalizeZedProvider,
	streamZedHosted,
	unwrapZedLine,
	ZED_CLOUD_BASE_URL,
	ZED_COMPLETIONS_PATH,
	ZED_LLM_TOKEN_PATH,
	ZED_USERS_ME_PATH,
} from "../src/providers/zed-hosted";
import {
	createZedNativeAuthData,
	decryptZedAccessToken,
	loginZedHostedHook,
	parseZedCallbackPayload,
	ZedHostedOAuthProvider,
} from "../src/registry/oauth/zed-hosted";
import type { AssistantMessage, Context, FetchImpl, Model, UserMessage } from "../src/types";

describe("zed-hosted provider and auth", () => {
	it("returns structured JSON for OAuth getApiKey", () => {
		const provider = new ZedHostedOAuthProvider();
		const creds = {
			access: "secret-token",
			refresh: "",
			expires: 12345,
			accountId: "user-123",
			email: "user@example.com",
			orgId: "org-456",
			authorizedAt: 0,
		};
		const apiKey = provider.getApiKey(creds);
		const parsed = JSON.parse(apiKey);
		expect(parsed).toEqual({
			token: "secret-token",
			accountId: "user-123",
			email: "user@example.com",
			orgId: "org-456",
		});
	});

	it("generates native auth data with 2048-bit RSA keypair", () => {
		const authData = createZedNativeAuthData({ nativeAppPort: 58443, systemId: "test-sys" });
		expect(authData.authUrl).toContain("https://zed.dev/native_app_signin");
		expect(authData.authUrl).toContain("native_app_port=58443");
		expect(authData.authUrl).toContain("system_id=test-sys");
		expect(authData.authUrl).toContain("native_app_public_key=");
		expect(authData.publicKey.length).toBeGreaterThan(100);
		expect(authData.privateKeyPem).toContain("BEGIN RSA PRIVATE KEY");
	});

	it("encrypts with RSA public key and decrypts with private key", () => {
		const authData = createZedNativeAuthData();
		const rawToken = "zed_secret_access_token_123456789";

		const derBuffer = Buffer.from(authData.publicKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
		const encryptedBuffer = crypto.publicEncrypt(
			{
				key: derBuffer,
				format: "der",
				type: "pkcs1",
				padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: "sha256",
			},
			Buffer.from(rawToken, "utf8"),
		);
		const encryptedBase64Url = encryptedBuffer.toString("base64url");

		const decrypted = decryptZedAccessToken(encryptedBase64Url, authData.privateKeyPem);
		expect(decrypted).toBe(rawToken);

		const decryptedViaVerifier = decryptZedAccessToken(encryptedBase64Url, authData.privateKeyVerifier);
		expect(decryptedViaVerifier).toBe(rawToken);
	});

	it("parses callback payload from various formats", () => {
		const payload1 = parseZedCallbackPayload("http://127.0.0.1:58443/?user_id=usr_42&access_token=enc_tok_abc");
		expect(payload1.userId).toBe("usr_42");
		expect(payload1.encryptedAccessToken).toBe("enc_tok_abc");

		const payload2 = parseZedCallbackPayload("user_id=usr_99&access_token=enc_tok_xyz");
		expect(payload2.userId).toBe("usr_99");
		expect(payload2.encryptedAccessToken).toBe("enc_tok_xyz");

		const payload3 = parseZedCallbackPayload(JSON.stringify({ userId: "usr_json", accessToken: "enc_json" }));
		expect(payload3.userId).toBe("usr_json");
		expect(payload3.encryptedAccessToken).toBe("enc_json");
	});

	it("unwraps zed NDJSON lines properly including stream_ended", () => {
		expect(unwrapZedLine("data: [DONE]")).toEqual({ done: true });
		expect(unwrapZedLine('data: {"status": "waiting"}')).toEqual({ status: { type: "waiting" } });
		expect(unwrapZedLine('data: {"status": "stream_ended"}')).toEqual({ done: true });
		expect(unwrapZedLine('data: {"status": {"stream_ended": true}}')).toEqual({ done: true });
		expect(unwrapZedLine('data: {"status": {"failed": {"message": "out of quota"}}}')).toEqual({
			status: { type: "failed", message: "out of quota" },
		});

		const eventLine = JSON.stringify({ event: { type: "text_delta", text: "hello" } });
		expect(unwrapZedLine(`data: ${eventLine}`)).toEqual({
			event: { type: "text_delta", text: "hello" },
		});
	});

	it("normalizes provider names from model ids to open_ai wire value", () => {
		expect(normalizeZedProvider(null, "claude-opus-4-6")).toBe("anthropic");
		expect(normalizeZedProvider(null, "gemini-3-1-pro")).toBe("google");
		expect(normalizeZedProvider(null, "gpt-5-2")).toBe("open_ai");
		expect(normalizeZedProvider("open_ai", "custom-model")).toBe("open_ai");
		expect(normalizeZedProvider("openai", "gpt-6-luna")).toBe("open_ai");
	});

	it("builds provider requests correctly for anthropic, google, and open_ai Responses dialect", () => {
		const context: Context = {
			systemPrompt: ["You are a helpful coding assistant."],
			messages: [
				{ role: "user", content: "Hello Zed", timestamp: Date.now() } satisfies UserMessage,
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi there!" }],
					api: "zed-hosted",
					provider: "zed-hosted",
					model: "claude-opus-4-6",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				} satisfies AssistantMessage,
				{
					role: "toolResult",
					toolName: "test_tool",
					toolCallId: "call_123",
					content: [{ type: "text", text: "tool-output" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
			tools: [
				{
					name: "test_tool",
					description: "A tool for testing",
					parameters: { type: "object", properties: { query: { type: "string" } } },
				},
			],
		};

		const anthropicReq = buildZedProviderRequest("anthropic", "claude-opus-4-6", context);
		expect(anthropicReq.model).toBe("claude-opus-4-6");
		expect(anthropicReq.system).toBe("You are a helpful coding assistant.");
		expect(Array.isArray(anthropicReq.messages)).toBe(true);

		const googleReq = buildZedProviderRequest("google", "gemini-3-1-pro", context);
		expect(Array.isArray(googleReq.contents)).toBe(true);
		// Gemini toolResult should be role: "user"
		const contents = googleReq.contents as Array<{ role: string }>;
		const toolTurn = contents.find(c => c.role === "user");
		expect(toolTurn).toBeDefined();

		const openaiReq = buildZedProviderRequest("open_ai", "gpt-5-2", context);
		expect(Array.isArray(openaiReq.input)).toBe(true);
		expect(openaiReq.stream).toBe(true);

		// Verify toolChoice: "none" disables tools across all builders
		const anthropicReqNone = buildZedProviderRequest("anthropic", "claude-opus-4-6", context, { toolChoice: "none" });
		expect(anthropicReqNone.tools).toBeUndefined();
		expect(anthropicReqNone.tool_choice).toEqual({ type: "none" });

		const googleReqNone = buildZedProviderRequest("google", "gemini-3-1-pro", context, { toolChoice: "none" });
		expect(googleReqNone.tools).toBeUndefined();
		expect(googleReqNone.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });

		const openaiReqNone = buildZedProviderRequest("open_ai", "gpt-5-2", context, { toolChoice: "none" });
		expect(openaiReqNone.tools).toBeUndefined();
		expect(openaiReqNone.tool_choice).toBe("none");

		// Verify image input format in Responses request
		const imgContext: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "image", mimeType: "image/png", data: "AA==" }],
					timestamp: Date.now(),
				} satisfies UserMessage,
			],
		};
		const openaiImgReq = buildZedProviderRequest("open_ai", "gpt-5-2", imgContext);
		const inputItems = openaiImgReq.input as Array<{ content: Array<{ type: string; image_url: string }> }>;
		expect(inputItems[0].content[0].type).toBe("input_image");
		expect(typeof inputItems[0].content[0].image_url).toBe("string");
		expect(inputItems[0].content[0].image_url).toContain("data:image/png;base64,AA==");
	});

	it("exchanges LLM tokens with caching", async () => {
		clearZedLlmTokenCache();
		let postCount = 0;
		const mockFetch: FetchImpl = async input => {
			const url = String(input);
			if (url.includes(ZED_USERS_ME_PATH)) {
				return new Response(
					JSON.stringify({
						id: "user_123",
						email: "dev@zed.dev",
						default_organization_id: "org_abc",
					}),
					{ status: 200 },
				);
			}
			if (url.includes(ZED_LLM_TOKEN_PATH)) {
				postCount++;
				return new Response(JSON.stringify({ token: "llm_tok_12345" }), { status: 200 });
			}
			return new Response("Not found", { status: 404 });
		};

		const creds = { userId: "user_123", accessToken: "access_sec_456" };
		const token1 = await fetchZedLlmToken(creds, { fetch: mockFetch });
		expect(token1).toBe("llm_tok_12345");
		expect(postCount).toBe(1);

		const token2 = await fetchZedLlmToken(creds, { fetch: mockFetch });
		expect(token2).toBe("llm_tok_12345");
		expect(postCount).toBe(1);

		const token3 = await fetchZedLlmToken(creds, { forceRefresh: true, fetch: mockFetch });
		expect(token3).toBe("llm_tok_12345");
		expect(postCount).toBe(2);
	});

	it("streams zed completion events end-to-end for Anthropic and terminates on stream_ended", async () => {
		clearZedLlmTokenCache();
		const mockFetch: FetchImpl = async input => {
			const url = String(input);
			if (url.includes(ZED_LLM_TOKEN_PATH)) {
				return new Response(JSON.stringify({ token: "llm_mock_tok" }), { status: 200 });
			}
			if (url.includes(ZED_COMPLETIONS_PATH)) {
				const stream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();
						const lines = [
							JSON.stringify({ event: { type: "message_start", message: { usage: { input_tokens: 10 } } } }),
							JSON.stringify({
								event: { type: "content_block_start", content_block: { type: "text", text: "" } },
							}),
							JSON.stringify({
								event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello from " } },
							}),
							JSON.stringify({
								event: { type: "content_block_delta", delta: { type: "text_delta", text: "Zed!" } },
							}),
							JSON.stringify({ event: { type: "content_block_stop" } }),
							JSON.stringify({
								event: {
									type: "message_delta",
									delta: { stop_reason: "end_turn" },
									usage: { output_tokens: 5 },
								},
							}),
							JSON.stringify({ status: "stream_ended" }),
						];
						for (const l of lines) {
							controller.enqueue(encoder.encode(`data: ${l}\n\n`));
						}
					},
				});
				return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			}
			return new Response("Not found", { status: 404 });
		};

		const model = buildModel({
			id: "claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "zed-hosted",
			provider: "zed-hosted",
			baseUrl: ZED_CLOUD_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 64000,
		}) as Model<"zed-hosted">;

		const context: Context = {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() } satisfies UserMessage],
		};

		const stream = streamZedHosted(model, context, {
			apiKey: JSON.stringify({ token: "acc_456", accountId: "usr_123" }),
			organizationId: "org_1",
			fetch: mockFetch,
		});

		const events = [];
		for await (const event of stream) {
			events.push(event);
		}

		const result = await stream.result();
		expect(result.role).toBe("assistant");
		expect(result.stopReason).toBe("stop");
		expect(result.content.length).toBe(1);
		expect(result.content[0].type).toBe("text");
		if (result.content[0].type === "text") {
			expect(result.content[0].text).toBe("Hello from Zed!");
		}
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(5);
	});

	it("streams zed completion events for OpenAI Responses dialect", async () => {
		clearZedLlmTokenCache();
		const mockFetch: FetchImpl = async input => {
			const url = String(input);
			if (url.includes(ZED_LLM_TOKEN_PATH)) {
				return new Response(JSON.stringify({ token: "llm_mock_tok" }), { status: 200 });
			}
			if (url.includes(ZED_COMPLETIONS_PATH)) {
				const stream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();
						const lines = [
							JSON.stringify({ event: { type: "response.output_text.delta", delta: "Hello from " } }),
							JSON.stringify({ event: { type: "response.output_text.delta", delta: "GPT Responses!" } }),
							JSON.stringify({
								event: {
									type: "response.completed",
									response: { usage: { input_tokens: 15, output_tokens: 7 } },
								},
							}),
							JSON.stringify({ status: "stream_ended" }),
						];
						for (const l of lines) {
							controller.enqueue(encoder.encode(`data: ${l}\n\n`));
						}
					},
				});
				return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			}
			return new Response("Not found", { status: 404 });
		};

		const model = buildModel({
			id: "gpt-5-2",
			name: "GPT-5.2",
			api: "zed-hosted",
			provider: "zed-hosted",
			baseUrl: ZED_CLOUD_BASE_URL,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 64000,
		}) as Model<"zed-hosted">;

		const context: Context = {
			messages: [{ role: "user", content: "Hi GPT", timestamp: Date.now() } satisfies UserMessage],
		};

		const stream = streamZedHosted(model, context, {
			apiKey: JSON.stringify({ token: "acc_456", accountId: "usr_123" }),
			organizationId: "org_1",
			fetch: mockFetch,
		});

		const events = [];
		for await (const event of stream) {
			events.push(event);
		}

		const result = await stream.result();
		expect(result.role).toBe("assistant");
		expect(result.stopReason).toBe("stop");
		expect(result.content.length).toBe(1);
		expect(result.content[0].type).toBe("text");
		if (result.content[0].type === "text") {
			expect(result.content[0].text).toBe("Hello from GPT Responses!");
		}
		expect(result.usage.input).toBe(15);
		expect(result.usage.output).toBe(7);
	});

	it("surfaces response.failed event as stream error", async () => {
		clearZedLlmTokenCache();
		const mockFetch: FetchImpl = async input => {
			const url = String(input);
			if (url.includes(ZED_LLM_TOKEN_PATH)) {
				return new Response(JSON.stringify({ token: "mock_llm_tok" }), { status: 200 });
			}
			if (url.includes(ZED_COMPLETIONS_PATH)) {
				const stream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "Quota exceeded" } } })}\n\n`,
							),
						);
						controller.close();
					},
				});
				return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			}
			return new Response("Not found", { status: 404 });
		};

		const model = buildModel({
			id: "gpt-5-2",
			name: "GPT-5.2",
			api: "zed-hosted",
			provider: "zed-hosted",
			baseUrl: ZED_CLOUD_BASE_URL,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 64000,
		}) as Model<"zed-hosted">;

		const context: Context = {
			messages: [{ role: "user", content: "Hi GPT", timestamp: Date.now() } satisfies UserMessage],
		};

		const stream = streamZedHosted(model, context, {
			apiKey: JSON.stringify({ token: "acc_456", accountId: "usr_123" }),
			organizationId: "org_1",
			fetch: mockFetch,
		});

		for await (const _ of stream) {
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Quota exceeded");
	});

	it("completes loginZedHostedHook with simulated browser redirect and validates token before stop", async () => {
		const mockFetch: FetchImpl = async input => {
			const url = String(input);
			if (url.includes(ZED_USERS_ME_PATH)) {
				return new Response(
					JSON.stringify({
						id: "user_zed_1",
						email: "user@zed.dev",
						default_organization_id: "org_default_1",
					}),
					{ status: 200 },
				);
			}
			return new Response("Not found", { status: 404 });
		};

		const creds = await loginZedHostedHook({
			fetch: mockFetch,
			onAuth(info) {
				const url = new URL(info.url);
				const port = url.searchParams.get("native_app_port");
				const rawPublicKey = url.searchParams.get("native_app_public_key")!;
				const derBuffer = Buffer.from(rawPublicKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
				const encrypted = crypto.publicEncrypt(
					{
						key: derBuffer,
						format: "der",
						type: "pkcs1",
						padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
						oaepHash: "sha256",
					},
					Buffer.from("secret_access_token_123", "utf8"),
				);

				// Send an invalid forged request first; server must reject with 400 and continue listening
				void fetch(`http://127.0.0.1:${port}/?user_id=forged&access_token=invalid_garbage`).then(res => {
					expect(res.status).toBe(400);
					// Now send the genuine decrypted callback
					void fetch(
						`http://127.0.0.1:${port}/?user_id=user_zed_1&access_token=${encrypted.toString("base64url")}`,
					).then(res2 => {
						expect(res2.status).toBe(200);
					});
				});
			},
		});

		expect(creds.access).toBe("secret_access_token_123");
		expect(creds.accountId).toBe("user_zed_1");
		expect(creds.email).toBe("user@zed.dev");
		expect(creds.orgId).toBe("org_default_1");
	});
});
