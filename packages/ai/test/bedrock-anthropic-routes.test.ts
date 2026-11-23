import { describe, expect, it } from "bun:test";
import { clearAwsCredentialCache } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import type { AnthropicOptions } from "@oh-my-pi/pi-ai/providers/anthropic";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, ModelSpec, TJsonSchema } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withEnv, withOfficialAnthropicEndpoint } from "./helpers";

const RUNTIME_URL = "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic";
const SESSION_ID = "01a0d8ae-cf8c-74ee-b93b-d12f887b3488";
const JSON_USER_ID = JSON.stringify({ session_id: SESSION_ID });

const context: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: 0 }],
	tools: [
		{
			name: "edit",
			description: "edit a file",
			parameters: {
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
			} satisfies TJsonSchema,
		},
	],
};

function claude(
	provider: string,
	id: string,
	baseUrl: string,
	compat?: ModelSpec<"anthropic-messages">["compat"],
): Model<"anthropic-messages"> {
	const spec: ModelSpec<"anthropic-messages"> = {
		id,
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		compat,
	};
	return buildModel(spec);
}

const runtime = claude("amazon-bedrock", "us.anthropic.claude-opus-5-5", RUNTIME_URL);
const mantle = claude(
	"bedrock-mantle",
	"anthropic.claude-opus-5-5",
	"https://bedrock-mantle.us-east-1.api.aws/anthropic",
);
const official = claude("anthropic", "claude-opus-5-5", "https://api.anthropic.com");

type WirePayload = { metadata?: { user_id?: string }; tools?: Array<{ name: string; strict?: unknown }> };

/** Send through stream dispatch so the Bedrock providers' request hooks run, as in a live turn. */
async function sentPayload(model: Model<"anthropic-messages">, options: AnthropicOptions = {}): Promise<WirePayload> {
	let payload: WirePayload | undefined;
	const fetchMock: typeof fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			payload = JSON.parse(String(init?.body ?? "{}")) as WirePayload;
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "x" } }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		},
		{ preconnect: fetch.preconnect },
	);
	await stream(model, context, { apiKey: "bedrock-api-key", ...options, fetch: fetchMock }).result();
	if (!payload) throw new Error("request was not sent");
	return payload;
}

function expectBedrockShape(payload: WirePayload): void {
	const edit = payload.tools?.find(tool => tool.name === "edit");
	expect(edit).toBeDefined();
	expect(edit?.strict).toBeUndefined();
	expect(payload.metadata?.user_id).toBe(SESSION_ID);
}

withOfficialAnthropicEndpoint();

describe("Amazon Bedrock /anthropic requests", () => {
	it("resolves strict-tool rejection into catalog compat for Bedrock routes only", () => {
		expect(runtime.compat.disableStrictTools).toBe(true);
		expect(mantle.compat.disableStrictTools).toBe(true);
		expect(
			claude("bedrock-mantle", "anthropic.claude-opus-5-5", "https://bedrock-mantle.{region}.api.aws/anthropic")
				.compat.disableStrictTools,
		).toBe(true);
		// Converse root and a proxy path embedding the Bedrock host are not the `/anthropic` route.
		expect(
			claude("amazon-bedrock", "us.anthropic.claude-opus-5-5", "https://bedrock-runtime.us-east-1.amazonaws.com")
				.compat.disableStrictTools,
		).toBe(false);
		expect(
			claude(
				"custom",
				"claude-opus-5-5",
				"https://proxy.example.com/bedrock-runtime.us-east-1.amazonaws.com/anthropic",
			).compat.disableStrictTools,
		).toBe(false);
		expect(official.compat.disableStrictTools).toBe(false);
	});

	it("resolves a Mantle region template before sending an Anthropic Messages request", async () => {
		const templateModel = claude(
			"bedrock-mantle",
			"anthropic.claude-opus-5-5",
			"https://bedrock-mantle.{region}.api.aws/anthropic",
		);
		let request: { url: string; payload: WirePayload } | undefined;
		const fetchMock: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				request = {
					url: String(input instanceof Request ? input.url : input),
					payload: JSON.parse(String(init?.body ?? "{}")) as WirePayload,
				};
				return new Response(
					JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "x" } }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);
		await stream(templateModel, context, {
			apiKey: "bedrock-api-key",
			providerOptions: { region: "us-east-2" },
			metadata: { user_id: JSON_USER_ID },
			fetch: fetchMock,
		}).result();
		expect(request?.url).toBe("https://bedrock-mantle.us-east-2.api.aws/anthropic/v1/messages");
		expectBedrockShape(request?.payload ?? {});
	});

	it.each([
		["bedrock-runtime", runtime],
		["bedrock-mantle", mantle],
		[
			"bedrock-runtime FIPS",
			claude(
				"amazon-bedrock",
				"us.anthropic.claude-opus-5-5",
				"https://bedrock-runtime-fips.us-east-1.amazonaws.com/anthropic",
			),
		],
		[
			"bedrock-runtime PrivateLink",
			claude(
				"amazon-bedrock",
				"us.anthropic.claude-opus-5-5",
				"https://vpce-0a1b2c3d4e5f67890-abcd1234.bedrock-runtime.us-east-1.vpce.amazonaws.com/anthropic",
			),
		],
		[
			"bedrock-mantle zonal PrivateLink",
			claude(
				"bedrock-mantle",
				"anthropic.claude-opus-5-5",
				"https://vpce-0a1b2c3d4e5f67890-abcd1234-us-east-1a.bedrock-mantle.us-east-1.vpce.amazonaws.com/anthropic",
			),
		],
	])("drops strict tools and sends the session id from caller metadata on %s", async (_route, model) => {
		expectBedrockShape(await sentPayload(model, { isOAuth: false, metadata: { user_id: JSON_USER_ID } }));
	});

	it("reshapes strict tools and metadata that an onPayload hook restores", async () => {
		const payload = await sentPayload(runtime, {
			isOAuth: false,
			onPayload: params => {
				const built = params as { tools?: Array<Record<string, unknown>> };
				return {
					...built,
					tools: built.tools?.map(tool => ({ ...tool, strict: true })),
					metadata: { user_id: JSON_USER_ID },
				};
			},
		});
		expectBedrockShape(payload);
	});

	it("leaves the first-party Anthropic provider's request unchanged when rerouted to a Bedrock route", async () => {
		await withEnv({ ANTHROPIC_BASE_URL: RUNTIME_URL }, async () => {
			const payload = await sentPayload(official, { isOAuth: false, metadata: { user_id: JSON_USER_ID } });
			expect(payload.tools?.find(tool => tool.name === "edit")?.strict).toBe(true);
			expect(payload.metadata?.user_id).toBe(JSON_USER_ID);
		});
	});

	it("shapes a rerouted first-party request when compat.bedrockMessagesApi opts in", async () => {
		const optedIn = claude("anthropic", "claude-opus-5-5", "https://api.anthropic.com", { bedrockMessagesApi: true });
		await withEnv({ ANTHROPIC_BASE_URL: RUNTIME_URL }, async () => {
			expectBedrockShape(await sentPayload(optedIn, { isOAuth: false, metadata: { user_id: JSON_USER_ID } }));
		});
	});

	it("shapes a custom provider id on a Bedrock route", async () => {
		const custom = claude("my-bedrock", "us.anthropic.claude-opus-5-5", RUNTIME_URL);
		expectBedrockShape(await sentPayload(custom, { isOAuth: false, metadata: { user_id: JSON_USER_ID } }));
	});

	it("keeps caller metadata when compat.bedrockMessagesApi opts a Bedrock route out", async () => {
		const optedOut = claude("amazon-bedrock", "us.anthropic.claude-opus-5-5", RUNTIME_URL, {
			bedrockMessagesApi: false,
		});
		const payload = await sentPayload(optedOut, { isOAuth: false, metadata: { user_id: JSON_USER_ID } });
		expect(payload.metadata?.user_id).toBe(JSON_USER_ID);
	});

	it("omits metadata whose user id cannot fit Bedrock's pattern", async () => {
		const payload = await sentPayload(runtime, { isOAuth: false, metadata: { user_id: "user{with}braces" } });
		expect(payload.metadata).toBeUndefined();
	});

	it("keeps strict tools and caller metadata on the Claude API", async () => {
		const payload = await sentPayload(official, { isOAuth: false, metadata: { user_id: JSON_USER_ID } });
		expect(payload.tools?.find(tool => tool.name === "edit")?.strict).toBe(true);
		expect(payload.metadata?.user_id).toBe(JSON_USER_ID);
	});

	it("signs Mantle requests with SigV4 and sends no placeholder x-api-key without a bearer token", async () => {
		const model = claude(
			"bedrock-mantle",
			"anthropic.claude-opus-5-5",
			"https://bedrock-mantle.{region}.api.aws/anthropic",
		);
		let headers: Headers | undefined;
		let url: string | undefined;
		const fetchMock: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				url = String(input instanceof Request ? input.url : input);
				headers = new Headers(init?.headers);
				return new Response(
					JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "x" } }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);
		await withEnv(
			{
				AWS_REGION: "us-west-2",
				AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
				AWS_SECRET_ACCESS_KEY: "secret",
				AWS_SESSION_TOKEN: undefined,
				AWS_PROFILE: undefined,
				AWS_BEARER_TOKEN_BEDROCK: undefined,
				AWS_CONFIG_FILE: "/nonexistent/aws-config",
				AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/aws-credentials",
				AWS_EC2_METADATA_DISABLED: "true",
			},
			async () => {
				clearAwsCredentialCache();
				try {
					// The registry's ambient-credentials sentinel, as a live SigV4 session passes it.
					await stream(model, context, { apiKey: "<authenticated>", fetch: fetchMock }).result();
				} finally {
					clearAwsCredentialCache();
				}
			},
		);
		expect(url).toBe("https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages");
		expect(headers?.get("authorization")).toContain("/us-west-2/bedrock-mantle/aws4_request");
		expect(headers?.get("x-api-key")).toBeNull();
	});
});
