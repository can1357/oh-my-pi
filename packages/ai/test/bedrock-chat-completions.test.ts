import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { clearAwsCredentialCache } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, FetchImpl, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const cleanAwsEnv = {
	AWS_BEARER_TOKEN_BEDROCK: undefined,
	AWS_ACCESS_KEY_ID: undefined,
	AWS_SECRET_ACCESS_KEY: undefined,
	AWS_SESSION_TOKEN: undefined,
	AWS_PROFILE: undefined,
	AWS_DEFAULT_PROFILE: undefined,
	AWS_SDK_LOAD_CONFIG: undefined,
	AWS_REGION: undefined,
	AWS_DEFAULT_REGION: undefined,
	AWS_CONFIG_FILE: "/missing/bedrock-chat-config",
	AWS_SHARED_CREDENTIALS_FILE: "/missing/bedrock-chat-credentials",
	AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
	AWS_ROLE_ARN: undefined,
	AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
	AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
	AWS_EC2_METADATA_DISABLED: "true",
	AWS_CONTAINER_AUTHORIZATION_TOKEN: undefined,
	AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: undefined,
	AWS_BEDROCK_SKIP_AUTH: undefined,
};
const iamEnv = {
	AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
	AWS_SECRET_ACCESS_KEY: "example-secret",
	AWS_SESSION_TOKEN: "example-session",
	AWS_REGION: "us-west-2",
};
const context: Context = { messages: [{ role: "user", content: "Reply OK", timestamp: 0 }] };

function chatModel(id = "global.moonshotai.kimi-k3"): Model<"openai-completions"> {
	return buildModel({
		id,
		name: "Kimi K3",
		provider: "amazon-bedrock",
		api: "openai-completions",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: Effort.Max,
			requiresEffort: true,
		},
	});
}

function chatResponse(): Response {
	const chunk = {
		id: "chat-bedrock",
		object: "chat.completion.chunk",
		created: 0,
		model: "global.moonshotai.kimi-k3",
		choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

type CapturedRequest = { url: string; headers: Headers; body: Record<string, unknown>; signal?: AbortSignal | null };
function capturingFetch(requests: CapturedRequest[], response: () => Response = chatResponse): FetchImpl {
	return async (input, init) => {
		const body = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array);
		requests.push({
			url: String(input instanceof Request ? input.url : input),
			headers: new Headers(init?.headers),
			body: JSON.parse(body),
			signal: init?.signal,
		});
		return response();
	};
}

async function runSimple(env: Record<string, string | undefined>, options: SimpleStreamOptions = {}, id?: string) {
	const requests: CapturedRequest[] = [];
	let result!: AssistantMessage;
	await withEnv({ ...cleanAwsEnv, ...env }, async () => {
		clearAwsCredentialCache();
		result = await streamSimple(chatModel(id), context, {
			reasoning: Effort.Max,
			maxTokens: 64,
			...options,
			fetch: capturingFetch(requests),
		}).result();
	});
	return { result, requests };
}

describe("Bedrock Chat Completions authentication", () => {
	test("signs the actual Chat request with AWS credentials rather than the registry marker", async () => {
		const requests: CapturedRequest[] = [];
		await withEnv({ ...cleanAwsEnv, ...iamEnv }, async () => {
			clearAwsCredentialCache();
			const result = await streamSimple(chatModel(), context, {
				reasoning: Effort.Max,
				maxTokens: 64,
				headers: { "x-trace": "caller-trace" },
				fetch: capturingFetch(requests),
			}).result();
			expect(result.stopReason).toBe("stop");
		});
		const request = requests[0]!;
		expect(request.url).toBe("https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/chat/completions");
		expect(request.headers.get("authorization")).toContain("Credential=AKIAEXAMPLE/");
		expect(request.headers.get("authorization")).toContain("/us-west-2/bedrock/aws4_request");
		expect(request.headers.get("x-amz-security-token")).toBe("example-session");
		expect(request.headers.get("x-trace")).toBe("caller-trace");
		expect(request.body.reasoning_effort).toBe("max");
		expect(request.body.thinking).toBeUndefined();
	});

	test("uses a Bedrock bearer token without falling through to IAM", async () => {
		const { result, requests } = await runSimple({
			AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
			AWS_REGION: "us-east-2",
		});
		expect(result.stopReason).toBe("stop");
		expect(requests[0]!.headers.get("authorization")).toBe("Bearer bedrock-token");
		expect(requests[0]!.headers.has("x-amz-date")).toBeFalse();
		expect(requests[0]!.url).toContain("bedrock-runtime.us-east-2.amazonaws.com/");
	});

	test("preserves request-scoped bearer and region through streamSimple", async () => {
		const { result, requests } = await runSimple(
			{ AWS_BEARER_TOKEN_BEDROCK: "ambient-token", AWS_REGION: "us-west-2" },
			{ providerOptions: { bearerToken: "request-token", region: "us-east-2" } },
		);
		expect(result.stopReason).toBe("stop");
		expect(requests[0]!.headers.get("authorization")).toBe("Bearer request-token");
		expect(requests[0]!.url).toContain("bedrock-runtime.us-east-2.amazonaws.com/");
	});

	test("resolves an explicit profile when the optional API-key resolver is empty", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-chat-profile-"));
		try {
			const credentials = path.join(dir, "credentials");
			const config = path.join(dir, "config");
			await fs.writeFile(
				credentials,
				"[regional]\naws_access_key_id = AKIAPROFILE\naws_secret_access_key = profile-secret\n",
			);
			await fs.writeFile(config, "[profile regional]\nregion = eu-west-2\n");
			const { result, requests } = await runSimple(
				{ AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_CONFIG_FILE: config },
				{ apiKey: async () => undefined, providerOptions: { profile: "regional" } },
			);
			expect(result.stopReason).toBe("stop");
			expect(requests[0]!.url).toContain("bedrock-runtime.eu-west-2.amazonaws.com/");
			expect(requests[0]!.headers.get("authorization")).toContain("Credential=AKIAPROFILE/");
			expect(requests[0]!.headers.get("authorization")).toContain("/eu-west-2/bedrock/aws4_request");
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("keeps US-profile endpoint and signature regions consistent outside the US", async () => {
		const { result, requests } = await runSimple({ ...iamEnv, AWS_REGION: "eu-west-2" }, {}, "us.moonshotai.kimi-k3");
		expect(result.stopReason).toBe("stop");
		expect(requests[0]!.url).toContain("bedrock-runtime.us-east-1.amazonaws.com/");
		expect(requests[0]!.headers.get("authorization")).toContain("/us-east-1/bedrock/aws4_request");
	});

	test("keeps configured model guardrails in signed Chat requests", async () => {
		const requests: CapturedRequest[] = [];
		await withEnv({ ...cleanAwsEnv, ...iamEnv }, async () => {
			clearAwsCredentialCache();
			const model = {
				...chatModel(),
				guardrailIdentifier: "model-guardrail",
				guardrailVersion: "2",
				guardrailTrace: "enabled" as const,
			};
			const result = await streamSimple(model, context, {
				maxTokens: 64,
				guardrailIdentifier: "call-guardrail",
				guardrailVersion: "3",
				fetch: capturingFetch(requests),
			}).result();
			expect(result.stopReason).toBe("stop");
		});
		const headers = requests[0]!.headers;
		expect(headers.get("x-amzn-bedrock-guardrailidentifier")).toBe("model-guardrail");
		expect(headers.get("x-amzn-bedrock-guardrailversion")).toBe("2");
		expect(headers.get("x-amzn-bedrock-trace")).toBe("ENABLED");
		expect(headers.get("authorization")).toContain("x-amzn-bedrock-guardrailidentifier");
	});

	test("signs custom gateway path and query without putting the API suffix inside the query", async () => {
		const requests: CapturedRequest[] = [];
		await withEnv({ ...cleanAwsEnv, ...iamEnv }, async () => {
			clearAwsCredentialCache();
			const model = { ...chatModel(), baseUrl: "https://bedrock-gateway.example/prefix/openai/v1?tenant=example" };
			const result = await streamSimple(model, context, { maxTokens: 64, fetch: capturingFetch(requests) }).result();
			expect(result.stopReason).toBe("stop");
		});
		expect(requests[0]!.url).toBe("https://bedrock-gateway.example/prefix/openai/v1/chat/completions?tenant=example");
		expect(requests[0]!.headers.get("authorization")).toContain("/us-west-2/bedrock/aws4_request");
	});

	test("fails without AWS credentials instead of sending an OpenAI key", async () => {
		const requests: CapturedRequest[] = [];
		await withEnv({ ...cleanAwsEnv, OPENAI_API_KEY: "unrelated-openai-key" }, async () => {
			clearAwsCredentialCache();
			const result = await streamSimple(chatModel(), context, {
				maxTokens: 64,
				fetch: capturingFetch(requests),
			}).result();
			expect(result.stopReason).toBe("error");
			expect(AIError.is(result.errorId ?? 0, AIError.Flag.AuthFailed)).toBe(true);
		});
		expect(requests).toHaveLength(0);
	});

	test("refreshes resolved IAM credentials after an authentication rejection", async () => {
		const requests: CapturedRequest[] = [];
		await withEnv({ ...cleanAwsEnv, ...iamEnv }, async () => {
			clearAwsCredentialCache();
			const model = chatModel();
			const fetch = capturingFetch(requests, () => new Response("forbidden", { status: 403 }));
			await stream(model, context, { maxTokens: 64, fetch }).result();
			Bun.env.AWS_ACCESS_KEY_ID = "AKIAROTATED";
			Bun.env.AWS_SECRET_ACCESS_KEY = "rotated-secret";
			await stream(model, context, { maxTokens: 64, fetch }).result();
		});
		expect(requests).toHaveLength(2);
		expect(requests[0]!.headers.get("authorization")).toContain("Credential=AKIAEXAMPLE/");
		expect(requests[1]!.headers.get("authorization")).toContain("Credential=AKIAROTATED/");
	});

	test("does not send an inference request after cancellation", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled by caller"));
		const { result, requests } = await runSimple(iamEnv, { signal: controller.signal });
		expect(result.stopReason).toBe("aborted");
		expect(requests).toHaveLength(0);
	});

	test("keeps pi-native gateway authentication ahead of local AWS authentication", async () => {
		const requests: CapturedRequest[] = [];
		await withEnv({ ...cleanAwsEnv, ...iamEnv }, async () => {
			const model = { ...chatModel(), baseUrl: "http://gateway.internal", transport: "pi-native" as const };
			await expect(
				streamSimple(model, context, {
					apiKey: "gateway-token",
					fetch: capturingFetch(requests, () => new Response("captured", { status: 418 })),
				}).result(),
			).rejects.toThrow("auth-gateway 418");
		});
		expect(requests[0]!.url).toBe("http://gateway.internal/v1/pi/stream");
		expect(requests[0]!.headers.get("authorization")).toBe("Bearer gateway-token");
	});
});

describe("Bedrock credential-service retries", () => {
	async function withSsoProfile(
		token: Record<string, unknown>,
		run: (cacheFile: string) => Promise<void>,
	): Promise<void> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-chat-sso-"));
		const homedir = spyOn(os, "homedir").mockReturnValue(dir);
		try {
			const config = path.join(dir, "config");
			const cacheDir = path.join(dir, ".aws", "sso", "cache");
			await fs.mkdir(cacheDir, { recursive: true });
			const cacheFile = path.join(cacheDir, `${new Bun.CryptoHasher("sha1").update("chat-sso").digest("hex")}.json`);
			await Bun.write(
				config,
				"[profile chat-sso]\nsso_session = chat-sso\nsso_account_id = 111122223333\nsso_role_name = TestRole\nregion = us-east-1\n[sso-session chat-sso]\nsso_start_url = https://example.awsapps.com/start\nsso_region = us-east-1\n",
			);
			await Bun.write(
				cacheFile,
				JSON.stringify({
					startUrl: "https://example.awsapps.com/start",
					region: "us-east-1",
					accessToken: "cached-access-token",
					expiresAt: "2099-01-01T00:00:00Z",
					...token,
				}),
			);
			await withEnv({ ...cleanAwsEnv, AWS_CONFIG_FILE: config, AWS_PROFILE: "chat-sso" }, async () => {
				clearAwsCredentialCache();
				await run(cacheFile);
			});
		} finally {
			clearAwsCredentialCache();
			homedir.mockRestore();
			await removeWithRetries(dir);
		}
	}

	function ssoRoleResponse(): Response {
		return Response.json({
			roleCredentials: {
				accessKeyId: "ASIASSO",
				secretAccessKey: "sso-secret",
				sessionToken: "sso-session",
				expiration: Date.parse("2099-01-01T00:00:00Z"),
			},
		});
	}

	test("recovers an STS 503 before sending the signed inference request", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-chat-sts-"));
		try {
			const config = path.join(dir, "config");
			await Bun.write(
				config,
				"[profile chat-role]\nrole_arn = arn:aws:iam::111122223333:role/TestRole\nsource_profile = base\nregion = us-east-1\n[profile base]\naws_access_key_id = AKIABASE\naws_secret_access_key = base-secret\n",
			);
			await withEnv({ ...cleanAwsEnv, AWS_CONFIG_FILE: config, AWS_PROFILE: "chat-role" }, async () => {
				clearAwsCredentialCache();
				let exchanges = 0;
				const requests: CapturedRequest[] = [];
				const inference = capturingFetch(requests);
				const result = await streamSimple(chatModel(), context, {
					maxTokens: 64,
					fetch: async (input, init) => {
						if (new URL(String(input)).hostname.startsWith("sts.")) {
							if (++exchanges === 1)
								return new Response("<Error><Message>Service Unavailable</Message></Error>", { status: 503 });
							return new Response(
								"<Credentials><AccessKeyId>ASIAASSUMED</AccessKeyId><SecretAccessKey>assumed-secret</SecretAccessKey><SessionToken>assumed-session</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials>",
							);
						}
						return inference(input, init);
					},
				}).result();
				expect(result.stopReason).toBe("stop");
				expect(result.content.find(block => block.type === "text")).toMatchObject({ text: "OK" });
				expect(exchanges).toBe(2);
				expect(requests).toHaveLength(1);
				expect(requests[0]!.headers.get("authorization")).toContain("Credential=ASIAASSUMED/");
			});
		} finally {
			clearAwsCredentialCache();
			await removeWithRetries(dir);
		}
	});

	test.each([429, 503])("recovers an SSO role-service %i before inference", async status => {
		await withSsoProfile({}, async () => {
			let exchanges = 0;
			const requests: CapturedRequest[] = [];
			const inference = capturingFetch(requests);
			const result = await streamSimple(chatModel(), context, {
				maxTokens: 64,
				fetch: async (input, init) => {
					if (new URL(String(input)).hostname.startsWith("portal.sso.")) {
						if (++exchanges === 1) return Response.json({ message: "temporary failure" }, { status });
						return ssoRoleResponse();
					}
					return inference(input, init);
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content.find(block => block.type === "text")).toMatchObject({ text: "OK" });
			expect(exchanges).toBe(2);
			expect(requests).toHaveLength(1);
			expect(requests[0]!.headers.get("authorization")).toContain("Credential=ASIASSO/");
		});
	});

	test("stops after one rejected SSO role exchange without inference", async () => {
		await withSsoProfile({}, async () => {
			const requests: string[] = [];
			const result = await streamSimple(chatModel(), context, {
				maxTokens: 64,
				fetch: async input => {
					requests.push(String(input));
					return Response.json({ message: "Access denied" }, { status: 403 });
				},
			}).result();
			expect(result.stopReason).toBe("error");
			expect(AIError.is(result.errorId ?? 0, AIError.Flag.AuthFailed)).toBe(true);
			expect(requests).toHaveLength(1);
			expect(new URL(requests[0]!).hostname).toBe("portal.sso.us-east-1.amazonaws.com");
		});
	});

	test("retries a mandatory SSO refresh after 503 and persists the new token", async () => {
		await withSsoProfile(
			{
				expiresAt: "2000-01-01T00:00:00Z",
				refreshToken: "refresh-token",
				clientId: "client-id",
				clientSecret: "client-secret",
				registrationExpiresAt: "2099-01-01T00:00:00Z",
			},
			async cacheFile => {
				let refreshes = 0;
				const portalTokens: (string | null)[] = [];
				const requests: CapturedRequest[] = [];
				const inference = capturingFetch(requests);
				const result = await streamSimple(chatModel(), context, {
					maxTokens: 64,
					fetch: async (input, init) => {
						const host = new URL(String(input)).hostname;
						if (host.startsWith("oidc.")) {
							if (++refreshes === 1) return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
							return Response.json({
								accessToken: "fresh-access-token",
								refreshToken: "rotated-refresh-token",
								expiresIn: 3600,
							});
						}
						if (host.startsWith("portal.sso.")) {
							portalTokens.push(new Headers(init?.headers).get("x-amz-sso_bearer_token"));
							return ssoRoleResponse();
						}
						return inference(input, init);
					},
				}).result();
				expect(result.stopReason).toBe("stop");
				expect(refreshes).toBe(2);
				expect(portalTokens).toEqual(["fresh-access-token"]);
				expect(requests).toHaveLength(1);
				clearAwsCredentialCache();
				const replay = await streamSimple(chatModel(), context, {
					maxTokens: 64,
					fetch: async (input, init) => {
						if (new URL(String(input)).hostname.startsWith("portal.sso.")) {
							portalTokens.push(new Headers(init?.headers).get("x-amz-sso_bearer_token"));
							return ssoRoleResponse();
						}
						return inference(input, init);
					},
				}).result();
				expect(replay.stopReason).toBe("stop");
				expect(portalTokens).toEqual(["fresh-access-token", "fresh-access-token"]);
				expect((await Bun.file(cacheFile).json()).refreshToken).toBe("rotated-refresh-token");
			},
		);
	});

	test("keeps a still-valid SSO token when optional refresh returns 503", async () => {
		await withSsoProfile(
			{
				expiresAt: new Date(Date.now() + 30_000).toISOString(),
				refreshToken: "refresh-token",
				clientId: "client-id",
				clientSecret: "client-secret",
				registrationExpiresAt: "2099-01-01T00:00:00Z",
			},
			async () => {
				const portalTokens: (string | null)[] = [];
				const requests: CapturedRequest[] = [];
				const inference = capturingFetch(requests);
				const result = await streamSimple(chatModel(), context, {
					maxTokens: 64,
					fetch: async (input, init) => {
						const host = new URL(String(input)).hostname;
						if (host.startsWith("oidc."))
							return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
						if (host.startsWith("portal.sso.")) {
							portalTokens.push(new Headers(init?.headers).get("x-amz-sso_bearer_token"));
							return ssoRoleResponse();
						}
						return inference(input, init);
					},
				}).result();
				expect(result.stopReason).toBe("stop");
				expect(portalTokens).toEqual(["cached-access-token"]);
				expect(requests).toHaveLength(1);
			},
		);
	});

	test("does not retry a revoked SSO refresh grant", async () => {
		await withSsoProfile(
			{
				expiresAt: "2000-01-01T00:00:00Z",
				refreshToken: "revoked-refresh-token",
				clientId: "client-id",
				clientSecret: "client-secret",
				registrationExpiresAt: "2099-01-01T00:00:00Z",
			},
			async () => {
				const requests: string[] = [];
				const result = await streamSimple(chatModel(), context, {
					maxTokens: 64,
					fetch: async input => {
						requests.push(String(input));
						return Response.json({ error: "invalid_grant" }, { status: 400 });
					},
				}).result();
				expect(result.stopReason).toBe("error");
				expect(AIError.is(result.errorId ?? 0, AIError.Flag.AuthFailed)).toBe(true);
				expect(requests).toHaveLength(1);
				expect(new URL(requests[0]!).hostname).toBe("oidc.us-east-1.amazonaws.com");
			},
		);
	});
});

describe("Bedrock K3 Chat effort and continuation", () => {
	test("sends max with required tools and replays the returned reasoning and tool ID", async () => {
		const model = getBundledModel<"openai-completions">("amazon-bedrock", "global.moonshotai.kimi-k3");
		const requests: CapturedRequest[] = [];
		const reasoning = "I need the value from the client before I can answer.";
		const toolId = "call_k3_probe_1";
		const toolContext: Context = {
			messages: [{ role: "user", content: "Get the client value.", timestamp: 0 }],
			tools: [
				{
					name: "get_value",
					description: "Return the client value",
					parameters: { type: "object", properties: {}, additionalProperties: false },
				},
			],
		};
		const firstChunk = {
			id: "chat-k3-tool",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [
				{
					index: 0,
					delta: {
						reasoning_content: reasoning,
						tool_calls: [
							{ index: 0, id: toolId, type: "function", function: { name: "get_value", arguments: "{}" } },
						],
					},
					finish_reason: "tool_calls",
				},
			],
		};
		await withEnv({ ...cleanAwsEnv, ...iamEnv }, async () => {
			clearAwsCredentialCache();
			const fetch = capturingFetch(requests, () =>
				requests.length === 1
					? new Response(`data: ${JSON.stringify(firstChunk)}\n\ndata: [DONE]\n\n`, {
							headers: { "content-type": "text/event-stream" },
						})
					: chatResponse(),
			);
			const first = await streamSimple(model, toolContext, {
				reasoning: Effort.Max,
				toolChoice: "required",
				fetch,
				maxTokens: 128,
			}).result();
			expect(first.stopReason).toBe("toolUse");
			expect(first.content.find(block => block.type === "toolCall")).toMatchObject({
				id: toolId,
				name: "get_value",
				arguments: {},
			});
			toolContext.messages.push(first, {
				role: "toolResult",
				toolCallId: toolId,
				toolName: "get_value",
				content: [{ type: "text", text: "client-value-42" }],
				isError: false,
				timestamp: 1,
			});
			const last = await streamSimple(model, toolContext, { reasoning: Effort.Max, fetch, maxTokens: 128 }).result();
			expect(last.stopReason).toBe("stop");
		});
		for (const request of requests) {
			expect(request.body.reasoning_effort).toBe("max");
			expect(request.body.thinking).toBeUndefined();
		}
		const history = requests[1]!.body.messages as Array<Record<string, unknown>>;
		const assistant = history.find(message => message.role === "assistant")!;
		expect(assistant.reasoning_content).toBe(reasoning);
		expect(assistant.tool_calls).toEqual([
			{ id: toolId, type: "function", function: { name: "get_value", arguments: "{}" } },
		]);
		expect(history.find(message => message.role === "tool")).toMatchObject({
			tool_call_id: toolId,
			content: "client-value-42",
		});
	});
});
