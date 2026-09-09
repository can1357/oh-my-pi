import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearAwsCredentialCache } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import type { BedrockMantleOptions } from "@oh-my-pi/pi-ai/providers/bedrock-mantle";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const mantleModel: Model<"openai-responses"> = buildModel({
	id: "openai.gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-responses",
	provider: "bedrock-mantle",
	baseUrl: "https://bedrock-mantle.{region}.api.aws/openai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.88 },
	contextWindow: 272_000,
	maxTokens: 128_000,
});

const context: Context = { messages: [{ role: "user", content: "Say hello", timestamp: 0 }] };
const cleanAwsEnv = {
	AWS_BEARER_TOKEN_BEDROCK: undefined,
	AWS_ACCESS_KEY_ID: undefined,
	AWS_SECRET_ACCESS_KEY: undefined,
	AWS_SESSION_TOKEN: undefined,
	AWS_PROFILE: undefined,
	AWS_REGION: undefined,
	AWS_CONFIG_FILE: undefined,
	AWS_SHARED_CREDENTIALS_FILE: undefined,
	AWS_EC2_METADATA_SERVICE_ENDPOINT: undefined,
	AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE: undefined,
	AWS_DEFAULT_REGION: undefined,
	AWS_EC2_METADATA_DISABLED: "true",
};

interface Capture {
	url?: string;
	authorization?: string | null;
	securityToken?: string | null;
	body?: RequestInit["body"];
}

function captureFetch(capture: Capture): FetchImpl {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			capture.url = String(input instanceof Request ? input.url : input);
			const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
			capture.authorization = headers.get("authorization");
			capture.securityToken = headers.get("x-amz-security-token");
			capture.body = init?.body;
			return new Response("captured", { status: 418 });
		},
		{ preconnect: fetch.preconnect },
	);
}

async function runDirect(
	env: Record<string, string | undefined>,
	options: BedrockMantleOptions = {},
): Promise<Capture> {
	const capture: Capture = {};
	await withEnv({ ...cleanAwsEnv, ...env }, async () => {
		clearAwsCredentialCache();
		await stream(mantleModel, context, { ...options, fetch: captureFetch(capture), maxTokens: 16 }).result();
	});
	return capture;
}

describe("Bedrock Mantle authentication", () => {
	test("uses the configured region and Bedrock bearer token", async () => {
		const capture = await runDirect({
			AWS_BEARER_TOKEN_BEDROCK: "test-token",
			AWS_REGION: "us-east-2",
		});
		expect(capture.url).toStartWith("https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses");
		expect(capture.authorization).toBe("Bearer test-token");
	});

	test("uses the selected profile region when environment regions are absent", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-mantle-region-"));
		try {
			const configPath = path.join(tmp, "config");
			await Bun.write(configPath, "[profile regional]\nregion = eu-west-2\n");
			const capture = await runDirect({
				AWS_BEARER_TOKEN_BEDROCK: "test-token",
				AWS_PROFILE: "regional",
				AWS_CONFIG_FILE: configPath,
				AWS_SHARED_CREDENTIALS_FILE: path.join(tmp, "missing-credentials"),
			});
			expect(capture.url).toStartWith("https://bedrock-mantle.eu-west-2.api.aws/openai/v1/responses");
		} finally {
			await removeWithRetries(tmp);
		}
	});

	test("prepares bearer-authenticated model discovery", async () => {
		const capture: Capture = {};
		await withEnv(
			{
				...cleanAwsEnv,
				AWS_BEARER_TOKEN_BEDROCK: "discovery-token",
				AWS_REGION: "eu-west-2",
			},
			async () => {
				const config = getProviderDefinition("bedrock-mantle")?.prepareModelDiscovery?.({
					fetch: captureFetch(capture),
				});
				expect(config?.authenticated).toBeTrue();
				expect(config?.baseUrl).toBe("https://bedrock-mantle.eu-west-2.api.aws/openai/v1");
				await config?.fetch?.("https://bedrock-mantle.eu-west-2.api.aws/v1/models", { method: "GET" });
			},
		);
		expect(capture.authorization).toBe("Bearer discovery-token");
		expect(capture.body).toBeUndefined();
	});

	test("does not enable account-scoped discovery for SigV4-only credentials", async () => {
		await withEnv(
			{
				...cleanAwsEnv,
				AWS_ACCESS_KEY_ID: "AKIADISCOVERY",
				AWS_SECRET_ACCESS_KEY: "discovery-secret",
				AWS_REGION: "eu-west-2",
			},
			async () => {
				const config = getProviderDefinition("bedrock-mantle")?.prepareModelDiscovery?.({});
				expect(config?.authenticated).toBeFalse();
				expect(config?.baseUrl).toBeUndefined();
			},
		);
	});

	test("SigV4-signs with the standard AWS credential chain", async () => {
		const capture = await runDirect({
			AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
			AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			AWS_SESSION_TOKEN: "test-session-token",
			AWS_REGION: "us-west-2",
		});
		expect(capture.url).toStartWith("https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses");
		expect(capture.authorization).toContain("/us-west-2/bedrock-mantle/aws4_request");
		expect(capture.securityToken).toBe("test-session-token");
	});

	test("invalidates cached SigV4 credentials after an authentication rejection", async () => {
		const authorizations: string[] = [];
		const rejectingFetch: FetchImpl = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
				authorizations.push(headers.get("authorization") ?? "");
				return new Response("rejected", { status: 403 });
			},
			{ preconnect: fetch.preconnect },
		);
		await withEnv(
			{
				...cleanAwsEnv,
				AWS_ACCESS_KEY_ID: "AKIAFIRST",
				AWS_SECRET_ACCESS_KEY: "first-secret",
				AWS_REGION: "us-west-2",
			},
			async () => {
				clearAwsCredentialCache();
				await stream(mantleModel, context, { fetch: rejectingFetch, maxTokens: 16 }).result();
				Bun.env.AWS_ACCESS_KEY_ID = "AKIASECOND";
				Bun.env.AWS_SECRET_ACCESS_KEY = "second-secret";
				await stream(mantleModel, context, { fetch: rejectingFetch, maxTokens: 16 }).result();
			},
		);
		expect(authorizations).toHaveLength(2);
		expect(authorizations[0]).toContain("Credential=AKIAFIRST/");
		expect(authorizations[1]).toContain("Credential=AKIASECOND/");
	});

	test("streamSimple preserves AWS options and resolver-supplied keys", async () => {
		const capture: Capture = {};
		let resolverCalls = 0;
		const options: SimpleStreamOptions = {
			apiKey: async () => {
				resolverCalls++;
				return "resolved-token";
			},
			providerOptions: {
				region: "us-east-2",
				profile: "ignored-for-bearer",
			},
			fetch: captureFetch(capture),
			maxTokens: 16,
		};
		await withEnv(cleanAwsEnv, async () => {
			await streamSimple(mantleModel, context, options).result();
		});
		expect(resolverCalls).toBe(1);
		expect(capture.url).toStartWith("https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses");
		expect(capture.authorization).toBe("Bearer resolved-token");
	});

	test("streamSimple falls back to SigV4 when its optional key resolver is empty", async () => {
		const capture: Capture = {};
		let resolverCalls = 0;
		await withEnv(
			{
				...cleanAwsEnv,
				AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
				AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				AWS_REGION: "us-east-2",
			},
			async () => {
				await streamSimple(mantleModel, context, {
					apiKey: async () => {
						resolverCalls++;
						return undefined;
					},
					fetch: captureFetch(capture),
					maxTokens: 16,
				}).result();
			},
		);
		expect(resolverCalls).toBe(1);
		expect(capture.authorization).toContain("/us-east-2/bedrock-mantle/aws4_request");
	});

	test("pi-native transport wins over local Mantle authentication", async () => {
		const capture: Capture = {};
		const gatewayModel = {
			...mantleModel,
			baseUrl: "http://gateway.internal",
			transport: "pi-native" as const,
		};
		await expect(
			streamSimple(gatewayModel, context, {
				apiKey: "gateway-token",
				fetch: captureFetch(capture),
				maxTokens: 16,
			}).result(),
		).rejects.toThrow("auth-gateway 418");
		expect(capture.url).toBe("http://gateway.internal/v1/pi/stream");
	});
});
