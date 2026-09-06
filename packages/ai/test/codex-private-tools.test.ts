import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	convertCodexResponsesMessages,
	convertOpenAICodexResponsesTools,
	createOpenAICodexCompatibilityMetadata,
	getOpenAICodexContextWindow,
	resetOpenAICodexHistoryAfterCompaction,
	setOpenAICodexHistoryIngestion,
	streamOpenAICodexResponses,
} from "../src/providers/openai-codex-responses";
import {
	applyCodexResponsesLiteShape,
	type CodexLiteShapedBody,
} from "../src/providers/openai-codex/request-transformer";
import type { ProviderSessionState, Tool } from "../src/types";
import { toolWireSchema } from "../src/utils/schema/wire";

const model = buildModel<"openai-codex-responses">({
	...getBundledModel("openai-codex", "gpt-6-astra"),
	api: "openai-codex-responses",
	compat: undefined,
});

describe("Codex private tool wire contract", () => {
	test("opts history into ingestion with native agent and window identities across resets", () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "history-session";
		setOpenAICodexHistoryIngestion(sessionId, providerSessionState, "/root");
		const first = getOpenAICodexContextWindow(sessionId, providerSessionState);
		const metadata = createOpenAICodexCompatibilityMetadata({ sessionId, providerSessionState, requestKind: "turn" });
		const turn = JSON.parse(metadata.clientMetadata["x-codex-turn-metadata"]);
		expect(turn).toMatchObject({
			session_id: sessionId,
			agent_name: "/root",
			history_ingest_requested: true,
			window_number: 1,
			context_window_id: first.windowId,
			window_id: `${first.threadId}:1`,
		});
		expect(JSON.parse(metadata.headers["x-codex-turn-metadata"])).toEqual(turn);
		resetOpenAICodexHistoryAfterCompaction({ sessionId, providerSessionState });
		const second = getOpenAICodexContextWindow(sessionId, providerSessionState);
		const next = createOpenAICodexCompatibilityMetadata({ sessionId, providerSessionState, requestKind: "turn" });
		expect(JSON.parse(next.clientMetadata["x-codex-turn-metadata"])).toMatchObject({
			history_ingest_requested: true,
			window_number: 2,
			context_window_id: second.windowId,
			window_id: `${first.threadId}:2`,
		});
		expect(second.windowId).not.toBe(first.windowId);
	});

	test("does not let caller metadata enable or impersonate history ingestion", () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "disabled-history";
		setOpenAICodexHistoryIngestion(sessionId, providerSessionState, "/root");
		setOpenAICodexHistoryIngestion(sessionId, providerSessionState, undefined);
		const metadata = createOpenAICodexCompatibilityMetadata({
			sessionId,
			providerSessionState,
			requestKind: "turn",
			clientMetadata: {
				history_ingest_requested: "true",
				agent_name: "/root/other",
				context_window_id: "forged",
				window_number: "99",
			},
		});
		const turn = JSON.parse(metadata.clientMetadata["x-codex-turn-metadata"]);
		expect(turn).not.toHaveProperty("history_ingest_requested");
		expect(turn).not.toHaveProperty("agent_name");
		expect(turn).not.toHaveProperty("context_window_id");
		expect(turn).not.toHaveProperty("window_number");
	});

	test("routes identical function names in different namespaces and preserves namespace on replay", async () => {
		const calls = ["history", "notes"].map((namespace, index) => ({
			type: "function_call",
			id: `fc_${index}`,
			call_id: `call_${index}`,
			namespace,
			name: "search_contents",
			arguments: '{"query":"ciphertext"}',
		}));
		const events = calls.flatMap(item => [
			{ type: "response.output_item.added", item: { ...item, arguments: "" } },
			{ type: "response.output_item.done", item },
		]);
		const sse = [
			...events,
			{
				type: "response.completed",
				response: { id: "resp_private", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
			},
		]
			.map(event => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
		const result = await streamOpenAICodexResponses(
			{ ...model, preferWebsockets: false },
			{ messages: [{ role: "user", content: "Find checkpoint", timestamp: 0 }] },
			{
				apiKey: "opaque-test-key",
				fetch: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
			},
		).result();
		expect(result.content.filter(block => block.type === "toolCall").map(block => block.name)).toEqual([
			"history.search_contents",
			"notes.search_contents",
		]);
		const replay = convertCodexResponsesMessages(model, { messages: [result] });
		expect(replay.filter(item => item.type === "function_call")).toMatchObject(
			calls.map(({ namespace, name }) => ({ namespace, name })),
		);
	});
	test("groups namespace children in full and Lite requests without losing encrypted parameter annotations", () => {
		const tools: Tool[] = [
			{
				name: "notes.write_file",
				namespace: "notes",
				namespaceDescription: "Notes group",
				description: "Write",
				deferLoading: true,
				strict: false,
				parameters: {
					type: "object",
					properties: { text: { type: "string", encrypted: true } },
					required: ["text"],
				},
			},
		];
		const converted = convertOpenAICodexResponsesTools(tools, model);
		expect(converted).toMatchObject([
			{
				type: "namespace",
				name: "notes",
				description: "Notes group",
				tools: [
					{
						type: "function",
						name: "write_file",
						defer_loading: true,
						parameters: { properties: { text: { encrypted: true } } },
					},
				],
			},
		]);
		const body: CodexLiteShapedBody = { tools: converted, input: [] };
		applyCodexResponsesLiteShape(body);
		expect(body.input).toMatchObject([{ type: "additional_tools", tools: converted }]);
	});

	test("reserved schemas reach the wire verbatim after a generic serializer processed the same schema object", () => {
		// Astra validates reserved tools byte-for-byte: `anyOf: [string, null]` is
		// accepted while the equivalent `type: [string, null]` is rejected with
		// "must match the configured schema". Wire post-processing rewrites
		// nullable scalars, so a serializer that dropped the model-only flags
		// (token estimation, catalog rendering, exports) must not be able to
		// alter what the Codex transport sends afterwards.
		const parameters = {
			type: "object",
			properties: { agent_name: { anyOf: [{ type: "string" }, { type: "null" }], description: "Agent" } },
		};
		const reserved: Tool = {
			name: "history.list_windows",
			namespace: "history",
			modelOnly: true,
			description: "List",
			strict: false,
			parameters,
		};
		toolWireSchema({ name: "history.list_windows", description: "List", parameters } as Tool);
		const [namespace] = convertOpenAICodexResponsesTools([reserved], model);
		expect(namespace).toMatchObject({
			type: "namespace",
			tools: [{ parameters: { properties: { agent_name: { anyOf: [{ type: "string" }, { type: "null" }] } } } }],
		});
	});

	test("serializes ciphertext only as encrypted_content in the paired function output", () => {
		const messages = convertCodexResponsesMessages(model, {
			messages: [
				{
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [
						{ type: "toolCall", id: "call_notes", name: "notes.write_file", namespace: "notes", arguments: {} },
					],
					stopReason: "toolUse",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "call_notes",
					toolName: "notes.write_file",
					content: [{ type: "encrypted", encryptedContent: "opaque-ciphertext" }],
					isError: false,
					timestamp: 1,
				},
			],
		});
		expect(messages).toContainEqual({
			type: "function_call_output",
			call_id: "call_notes",
			output: [{ type: "encrypted_content", encrypted_content: "opaque-ciphertext" }],
		});
	});
});
