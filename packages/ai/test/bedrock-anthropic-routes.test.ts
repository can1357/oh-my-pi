import { describe, expect, it } from "bun:test";
import { resolveAnthropicMetadataUserId, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model, ModelSpec, TJsonSchema } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withEnv, withOfficialAnthropicEndpoint } from "./helpers";

const RUNTIME_URL = "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic";
const SESSION_ID = "01a0d8ae-cf8c-74ee-b93b-d12f887b3488";
const JSON_USER_ID = JSON.stringify({ session_id: SESSION_ID });
const GENERATED_USER_ID = resolveAnthropicMetadataUserId(undefined, true, SESSION_ID, "account-1") ?? "";

const context: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: 0 }],
	tools: [
		{
			name: "bash",
			description: "run a bash command",
			parameters: {
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
			} satisfies TJsonSchema,
		},
	],
};

function claude(provider: string, id: string, baseUrl: string): Model<"anthropic-messages"> {
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

async function sentPayload(
	model: Model<"anthropic-messages">,
	options: Parameters<typeof streamAnthropic>[2] = {},
): Promise<WirePayload> {
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
	await streamAnthropic(model, context, { apiKey: "bedrock-api-key", ...options, fetch: fetchMock }).result();
	if (!payload) throw new Error("request was not sent");
	return payload;
}

async function sentThroughClient(model: Model<"anthropic-messages">, baseURL: string): Promise<WirePayload> {
	let payload: WirePayload | undefined;
	await streamAnthropic(model, context, {
		apiKey: "bedrock-api-key",
		metadata: { user_id: JSON_USER_ID },
		client: {
			...{ baseURL },
			messages: {
				create: value => {
					payload = { ...value } as WirePayload;
					throw new Error("captured");
				},
			},
		},
	}).result();
	if (!payload) throw new Error("request was not sent");
	return payload;
}

function expectBedrockShape(payload: WirePayload): void {
	const bash = payload.tools?.find(tool => tool.name === "bash");
	expect(bash).toBeDefined();
	expect(bash?.strict).toBeUndefined();
	expect(payload.metadata?.user_id).toBe(SESSION_ID);
}

withOfficialAnthropicEndpoint();

describe("Amazon Bedrock /anthropic requests", () => {
	it.each([
		["bedrock-runtime", runtime],
		["bedrock-mantle", mantle],
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

	it("follows an ANTHROPIC_BASE_URL reroute to a Bedrock route", async () => {
		await withEnv({ ANTHROPIC_BASE_URL: RUNTIME_URL }, async () => {
			expectBedrockShape(await sentPayload(official, { isOAuth: false, metadata: { user_id: GENERATED_USER_ID } }));
		});
	});

	it("follows an injected client pointed at a Bedrock route", async () => {
		expectBedrockShape(await sentThroughClient(official, RUNTIME_URL));
	});

	it("omits metadata whose user id cannot fit Bedrock's pattern", async () => {
		const payload = await sentPayload(runtime, { isOAuth: false, metadata: { user_id: "user{with}braces" } });
		expect(payload.metadata).toBeUndefined();
	});

	it("keeps strict tools and caller metadata on the Claude API", async () => {
		const payload = await sentPayload(official, { isOAuth: false, metadata: { user_id: JSON_USER_ID } });
		expect(payload.tools?.find(tool => tool.name === "bash")?.strict).toBe(true);
		expect(payload.metadata?.user_id).toBe(JSON_USER_ID);
	});
});
