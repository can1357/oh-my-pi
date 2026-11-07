import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
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
} from "../src/registry/oauth/zed-hosted";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AssistantMessage, Context, FetchImpl, Model, UserMessage } from "../src/types";

describe("zed-hosted provider and auth", () => {
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

		// Encrypt with OAEP padding
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
		// Also verify verifier encoding and decoding with decryptZedAccessToken
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

	it("unwraps zed NDJSON lines properly", () => {
		expect(unwrapZedLine("data: [DONE]")).toEqual({ done: true });
		expect(unwrapZedLine('data: {"status": "waiting"}')).toEqual({ status: { type: "waiting" } });
		expect(unwrapZedLine('data: {"status": {"failed": {"message": "out of quota"}}}')).toEqual({
			status: { type: "failed", message: "out of quota" },
		});

		const eventLine = JSON.stringify({ event: { type: "text_delta", text: "hello" } });
		expect(unwrapZedLine(`data: ${eventLine}`)).toEqual({
			event: { type: "text_delta", text: "hello" },
		});
	});

	it("normalizes provider names from model ids", () => {
		expect(normalizeZedProvider(null, "claude-3-7-sonnet")).toBe("anthropic");
		expect(normalizeZedProvider(null, "claude-opus-4-6")).toBe("anthropic");
		expect(normalizeZedProvider(null, "gemini-2.5-pro")).toBe("google");
		expect(normalizeZedProvider(null, "gpt-4o")).toBe("openai");
		expect(normalizeZedProvider("google", "custom-model")).toBe("google");
	});

	it("builds provider requests correctly for anthropic, google, and openai", () => {
		const context: Context = {
			systemPrompt: ["You are a helpful coding assistant."],
			messages: [
				{ role: "user", content: "Hello Zed", timestamp: Date.now() } satisfies UserMessage,
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi there!" }],
					api: "zed-hosted",
					provider: "zed-hosted",
					model: "claude-3-7-sonnet",
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
			],
			tools: [
				{
					name: "test_tool",
					description: "A tool for testing",
					parameters: { type: "object", properties: { query: { type: "string" } } },
				},
			],
		};

		const anthropicReq = buildZedProviderRequest("anthropic", "claude-3-7-sonnet", context);
		expect(anthropicReq.model).toBe("claude-3-7-sonnet");
		expect(anthropicReq.system).toBe("You are a helpful coding assistant.");
		expect(Array.isArray(anthropicReq.messages)).toBe(true);
		expect(Array.isArray(anthropicReq.tools)).toBe(true);

		const googleReq = buildZedProviderRequest("google", "gemini-2.5-pro", context);
		expect(Array.isArray(googleReq.contents)).toBe(true);
		expect(googleReq.systemInstruction).toBeDefined();

		const openaiReq = buildZedProviderRequest("openai", "gpt-4o", context);
		expect(Array.isArray(openaiReq.messages)).toBe(true);
		expect(Array.isArray(openaiReq.tools)).toBe(true);
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

		// Cache hit
		const token2 = await fetchZedLlmToken(creds, { fetch: mockFetch });
		expect(token2).toBe("llm_tok_12345");
		expect(postCount).toBe(1);

		// Force refresh
		const token3 = await fetchZedLlmToken(creds, { forceRefresh: true, fetch: mockFetch });
		expect(token3).toBe("llm_tok_12345");
		expect(postCount).toBe(2);
	});

	it("streams zed completion events end-to-end", async () => {
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
							"[DONE]",
						];
						for (const l of lines) {
							controller.enqueue(encoder.encode(`data: ${l}\n\n`));
						}
						controller.close();
					},
				});
				return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			}
			return new Response("Not found", { status: 404 });
		};

		const model = buildModel({
			id: "claude-3-7-sonnet",
			name: "Claude 3.7 Sonnet",
			api: "zed-hosted",
			provider: "zed-hosted",
			baseUrl: ZED_CLOUD_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		}) as Model<"zed-hosted">;

		const context: Context = {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() } satisfies UserMessage],
		};

		const stream = streamZedHosted(model, context, {
			apiKey: "usr_123:acc_456",
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

	it("completes loginZedHostedHook with simulated browser redirect", async () => {
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
				void fetch(`http://127.0.0.1:${port}/?user_id=user_zed_1&access_token=${encrypted.toString("base64url")}`);
			},
		});

		expect(creds.access).toBe("secret_access_token_123");
		expect(creds.accountId).toBe("user_zed_1");
		expect(creds.email).toBe("user@zed.dev");
		expect(creds.orgId).toBe("org_default_1");
	});
});
