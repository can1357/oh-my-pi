import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import {
	buildParams,
	mapOpenAIResponsesToolChoiceForTools,
	streamOpenAIResponses,
} from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { AssistantMessage, Context, FetchImpl, Tool, ToolChoice } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";

const encodedMuseCredential = JSON.stringify({
	oauthAccessToken: "meta-account-access",
	apiKey: "LLM|subscription-key",
});

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sseResponse(events: unknown[]): Response {
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Muse Code provider", () => {
	test("unwraps only the subscription Model API key for inference and discovery", () => {
		const provider = getProviderDefinition("muse-code");
		if (!provider?.prepareRequest || !provider.prepareModelDiscovery) {
			throw new Error("Muse Code transport is not registered");
		}
		const model = buildModel(seedModels("muse-code")[0]!);
		const request = provider.prepareRequest(model, { apiKey: encodedMuseCredential });
		const discovery = provider.prepareModelDiscovery({ apiKey: encodedMuseCredential });

		expect(request.options.apiKey).toBe("LLM|subscription-key");
		expect(request.options.headers).toMatchObject({ "x-api-version": "1.0.0" });
		expect(discovery).toMatchObject({ apiKey: "LLM|subscription-key", authenticated: true });
	});

	test("keeps Meta PAYG and Muse subscription credentials in separate provider pools", async () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: () => undefined,
		});
		try {
			await storage.credentials.reload();
			await storage.credentials.set("meta", [{ type: "api_key", key: "LLM|payg-key", source: "login" }]);
			await storage.credentials.set("muse-code", [
				{
					type: "oauth",
					access: encodedMuseCredential,
					refresh: "meta-refresh",
					expires: Date.now() + 3_600_000,
					accountId: "meta-account-1",
				},
			]);

			expect(await storage.keys.get("meta", "payg-session")).toBe("LLM|payg-key");
			expect(await storage.keys.get("muse-code", "muse-session")).toBe(encodedMuseCredential);
			expect(
				await storage.limits.markReached("muse-code", "muse-session", {
					apiKey: encodedMuseCredential,
					retryAfterMs: 60_000,
				}),
			).toMatchObject({ switched: false });
			expect(await storage.keys.get("muse-code", "muse-session")).toBe(encodedMuseCredential);
			expect(await storage.keys.get("meta", "payg-session")).toBe("LLM|payg-key");
		} finally {
			storage.close();
		}
	});

	test("accepts stale stored expiry for Muse device credentials without refresh", async () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: () => undefined,
		});
		try {
			await storage.credentials.reload();
			await storage.credentials.set("muse-code", [
				{
					type: "oauth",
					access: encodedMuseCredential,
					refresh: "",
					expires: Date.now() - 60_000,
					accountId: "meta-account-1",
				},
			]);

			expect(await storage.keys.get("muse-code", "stale-expiry-session")).toBe(encodedMuseCredential);
		} finally {
			storage.close();
		}
	});

	test("omits tool_choice on api.meta.ai, which accepts only auto", () => {
		// Verified 2026-09-10 against muse-spark-1.3: "none", "required" and named
		// function choices all 400 with `only "auto" is supported for tool_choice`.
		const tool: Tool = { name: "yield", description: "Finish.", parameters: type({}) };
		const choices: ToolChoice[] = ["none", "required", { type: "tool", name: "yield" }];
		for (const spec of [
			seedModels<"openai-responses">("meta")[0]!,
			seedModels<"openai-responses">("muse-code")[0]!,
		]) {
			const model = buildModel(spec);
			for (const choice of choices) {
				expect(mapOpenAIResponsesToolChoiceForTools(choice, [tool], model)).toBeUndefined();
			}
		}
	});

	test("declares and replays function tools under `_` and returns calls under their own names", async () => {
		// 2026-11-03: a subscription key answers 403 `client_attestation_denied`
		// when the declared tools include `bash`, `web_search` and other reserved
		// exact names; the same tools prefixed with `_` are accepted.
		// api.meta.ai also rejects tool names over 64 characters (#9130), and omp
		// caps MCP names at exactly 64, so such a name must go out unprefixed.
		const mcpName = "mcp__long_server_name_tool_name_tool_name_tool_name_too_139vuzq6";
		expect(mcpName).toHaveLength(64);
		const tools: Tool[] = [
			{ name: "bash", description: "Run a command.", parameters: type({ command: "string" }) },
			{ name: "web_search", description: "Search the web.", parameters: type({ query: "string" }) },
			{ name: mcpName, description: "An MCP tool.", parameters: type({ query: "string" }) },
		];
		const runTurn = async (provider: "muse-code" | "meta") => {
			const model = buildModel(seedModels<"openai-responses">(provider).find(spec => spec.id === "muse-spark-1.3")!);
			const context: Context = {
				tools,
				messages: [
					{ role: "user", content: "list files", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call_ls", name: "bash", arguments: { command: "ls" } }],
						api: "openai-responses",
						provider,
						model: model.id,
						usage,
						stopReason: "toolUse",
						timestamp: 2,
					},
					{
						role: "toolResult",
						toolCallId: "call_ls",
						toolName: "bash",
						content: [{ type: "text", text: "README.md" }],
						isError: false,
						timestamp: 3,
					},
					{ role: "user", content: "search for omp", timestamp: 4 },
				],
			};
			const searchName = provider === "muse-code" ? "_web_search" : "web_search";
			const calls = [
				{ type: "function_call", id: "fc_1", call_id: "call_1", name: searchName, arguments: "" },
				{ type: "function_call", id: "fc_2", call_id: "call_2", name: mcpName, arguments: "" },
			];
			let body: { tools: Array<{ name: string }>; input: Array<{ type?: string; name?: string }> } | undefined;
			const fetch: FetchImpl = async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return sseResponse([
					...calls.flatMap((call, outputIndex) => [
						{ type: "response.output_item.added", output_index: outputIndex, item: call },
						{
							type: "response.output_item.done",
							output_index: outputIndex,
							item: { ...call, arguments: '{"query":"omp"}', status: "completed" },
						},
					]),
					{ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } },
				]);
			};
			const result = await streamOpenAIResponses(model, context, { apiKey: "LLM|key", fetch }).result();
			return { body: body!, result };
		};

		const muse = await runTurn("muse-code");
		expect(muse.body.tools.map(tool => tool.name)).toEqual(["_bash", "_web_search", mcpName]);
		expect(muse.body.input.filter(item => item.type === "function_call").map(item => item.name)).toEqual(["_bash"]);
		expect(muse.result.content).toEqual([
			expect.objectContaining({ type: "toolCall", name: "web_search", arguments: { query: "omp" } }),
			expect.objectContaining({ type: "toolCall", name: mcpName, arguments: { query: "omp" } }),
		]);

		// Direct Meta API keys are not attested and keep the plain names.
		const meta = await runTurn("meta");
		expect(meta.body.tools.map(tool => tool.name)).toEqual(["bash", "web_search", mcpName]);
		expect(meta.body.input.filter(item => item.type === "function_call").map(item => item.name)).toEqual(["bash"]);
		expect(meta.result.content).toEqual([
			expect.objectContaining({ type: "toolCall", name: "web_search" }),
			expect.objectContaining({ type: "toolCall", name: mcpName }),
		]);
	});

	test("forces a named tool_choice under the wire name it declares", () => {
		const bash: Tool = { name: "bash", description: "Run a command.", parameters: type({ command: "string" }) };
		const read: Tool = { name: "read", description: "Read a file.", parameters: type({ path: "string" }) };
		const build = (supportsNamedToolChoice: boolean) =>
			buildParams(
				buildModel({
					...seedModels<"openai-responses">("muse-code")[0]!,
					compat: { supportsToolChoice: true, supportsForcedToolChoice: true, supportsNamedToolChoice },
				}),
				{ messages: [{ role: "user", content: "list files", timestamp: 1 }], tools: [bash, read] },
				{ toolChoice: { type: "tool", name: "bash" } },
				undefined,
			).params;
		expect(build(true).tool_choice).toEqual({ type: "function", name: "_bash" });
		// A string-only host gets the catalogue restricted to the forced tool instead.
		const stringOnly = build(false);
		expect(stringOnly.tools?.map(tool => (tool as { name?: string }).name)).toEqual(["_bash"]);
		expect(stringOnly.tool_choice).toBe("required");
	});

	test("derives wire names from the tools that survive schema quarantine", () => {
		// A 63-character name prefixes to 64, the wire name of the unprefixable
		// 64-character `_` + name.
		const long63 = "a".repeat(63);
		const good: Tool = { name: long63, description: "valid", parameters: type({}) };
		const twin: Tool = { name: `_${long63}`, description: "valid", parameters: type({}) };
		const quarantined: Tool = {
			...twin,
			parameters: {
				type: "object",
				properties: { choice: { enum: ["A", "B"], type: "null" } },
				required: ["choice"],
			},
		};
		const model = buildModel({
			...seedModels<"openai-responses">("muse-code")[0]!,
			compat: { supportsToolChoice: true, supportsForcedToolChoice: true, supportsNamedToolChoice: true },
		});
		const build = (tools: Tool[], toolChoice?: ToolChoice) =>
			buildParams(
				model,
				{ messages: [{ role: "user", content: "go", timestamp: 1 }], tools },
				{ toolChoice },
				undefined,
			);

		// Two declared tools on one wire name could not be told apart.
		expect(() => build([twin, good])).toThrow(`both encode as "_${long63}"`);
		// A quarantined twin never reaches the wire: no collision, and forcing it
		// must not resolve to the surviving tool's wire name.
		const { params } = build([quarantined, good], { type: "tool", name: quarantined.name });
		expect(params.tools?.map(tool => (tool as { name?: string }).name)).toEqual([`_${long63}`]);
		expect(params.tool_choice).toBeUndefined();
	});
});
