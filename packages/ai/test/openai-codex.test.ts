import { describe, expect, it } from "bun:test";
import {
	createOpenAICodexAuthorizationUrl,
	formatOpenAICodexTokenEndpointError,
} from "@oh-my-pi/pi-ai/oauth/openai-codex";
import { type RequestBody, transformRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import { CodexApiError, parseCodexError } from "@oh-my-pi/pi-ai/providers/openai-codex/response-handler";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { OPENAI_HEADER_VALUES } from "@oh-my-pi/pi-catalog/wire/codex";
import { createCodexModel } from "./helpers";

const DEFAULT_PROMPT_PREFIX =
	"You are an expert coding assistant. You help users with coding tasks by reading files, executing commands";

describe("openai-codex oauth", () => {
	it("uses the same default originator for browser login and API requests", () => {
		const authUrl = createOpenAICodexAuthorizationUrl({
			state: "state",
			redirectUri: "http://localhost:1455/auth/callback",
			challenge: "challenge",
		});

		expect(new URL(authUrl).searchParams.get("originator")).toBe(OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	});

	it("requests Codex connector scopes during browser login", () => {
		const authUrl = createOpenAICodexAuthorizationUrl({
			state: "state",
			redirectUri: "http://localhost:1455/auth/callback",
			challenge: "challenge",
		});

		const scopes = new Set((new URL(authUrl).searchParams.get("scope") ?? "").split(" "));
		expect(scopes.has("api.connectors.read")).toBe(true);
		expect(scopes.has("api.connectors.invoke")).toBe(true);
	});

	it("formats object token endpoint errors without object coercion", () => {
		const detail = formatOpenAICodexTokenEndpointError(
			403,
			JSON.stringify({ error: { code: "access_denied", message: "Connector scope missing" } }),
		);

		expect(detail).toBe("403 access_denied: Connector scope missing");
	});
});

describe("openai-codex tool schemas", () => {
	it("adds empty properties to no-argument object parameter schemas", () => {
		const tools: Tool[] = [
			{
				name: "list_outgoing_messages",
				description: "List outgoing messages",
				parameters: { type: "object" },
			},
		];

		const converted = convertOpenAICodexResponsesTools(tools, createCodexModel("gpt-5.1-codex"));

		expect(converted[0]).toEqual({
			type: "function",
			name: "list_outgoing_messages",
			description: "List outgoing messages",
			parameters: { type: "object", properties: {} },
		});
	});
	it("strips MCP regex lookaround patterns from function parameters", () => {
		const tools: Tool[] = [
			{
				name: "get_design_context",
				description: "Get Figma design context",
				parameters: {
					type: "object",
					properties: {
						fileKey: { type: "string", pattern: "^(?!undefined$|null$)" },
					},
					propertyNames: { pattern: "^(?!undefined$|null$)" },
				},
			},
		];

		const converted = convertOpenAICodexResponsesTools(tools, createCodexModel("gpt-5.5"));

		expect(converted[0]).toEqual({
			type: "function",
			name: "get_design_context",
			description: "Get Figma design context",
			parameters: {
				type: "object",
				properties: {
					fileKey: { type: "string" },
				},
				propertyNames: true,
			},
		});
	});
	it("strips MCP regex lookaround patternProperties from function parameters", () => {
		const tools: Tool[] = [
			{
				name: "read_dynamic_values",
				description: "Read dynamic values",
				parameters: {
					type: "object",
					patternProperties: {
						"^(?!secret_)": { type: "string" },
						"^public_": { type: "string" },
					},
					additionalProperties: false,
				},
			},
		];

		const converted = convertOpenAICodexResponsesTools(tools, createCodexModel("gpt-5.5"));

		expect(converted[0]).toEqual({
			type: "function",
			name: "read_dynamic_values",
			description: "Read dynamic values",
			parameters: {
				type: "object",
				patternProperties: {
					".*": { type: "string" },
					"^public_": { type: "string" },
				},
				additionalProperties: false,
				properties: {},
			},
		});
	});

	it("preserves explicit strict:false on the wire (#4336)", () => {
		const tools: Tool[] = [
			{
				name: "search",
				description: "Search",
				strict: false,
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						name: { type: "string" },
						target: { type: "string" },
					},
					required: ["name"],
				},
			},
		];

		const converted = convertOpenAICodexResponsesTools(tools, createCodexModel("gpt-5.5"));

		// Author-set `strict: false` MUST survive to the wire so backends that
		// distinguish it from an omitted flag stop over-filling optional args.
		expect(converted[0]).toMatchObject({ type: "function", name: "search", strict: false });
	});

	it("omits strict when the tool leaves it unset (#4336)", () => {
		const tools: Tool[] = [
			{
				name: "search",
				description: "Search",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: { name: { type: "string" } },
					required: ["name"],
				},
			},
		];

		const converted = convertOpenAICodexResponsesTools(tools, createCodexModel("gpt-5.5"));
		const payload = converted[0] as { strict?: boolean };

		// Codex responses only enforces strict when the tool opts in; leaving
		// `strict` unset MUST NOT synthesize the field either way.
		expect(payload.strict).toBeUndefined();
	});
});

describe("openai-codex request transformer", () => {
	it("filters item_reference and strips ids", async () => {
		const body: RequestBody = {
			model: "gpt-5.1-codex",
			input: [
				{
					type: "message",
					role: "developer",
					id: "sys-1",
					content: [{ type: "input_text", text: `${DEFAULT_PROMPT_PREFIX}...` }],
				},
				{
					type: "message",
					role: "user",
					id: "user-1",
					content: [{ type: "input_text", text: "hello" }],
				},
				{ type: "item_reference", id: "ref-1" },
				{ type: "function_call_output", call_id: "missing", name: "tool", output: "result" },
			],
			tools: [{ type: "function", name: "tool", description: "", parameters: {} }],
		};

		const transformed = await transformRequestBody(body, createCodexModel(body.model), {});

		expect(transformed.store).toBe(false);
		expect(transformed.stream).toBe(true);
		expect(transformed.include).toEqual(["reasoning.encrypted_content"]);

		const input = transformed.input || [];
		expect(input.some(item => item.type === "item_reference")).toBe(false);
		expect(input.some(item => "id" in item)).toBe(false);
		const first = input[0];
		expect(first?.type).toBe("message");
		expect(first?.role).toBe("developer");
		expect(first?.content).toEqual([{ type: "input_text", text: `${DEFAULT_PROMPT_PREFIX}...` }]);

		const orphaned = input.find(item => item.type === "message" && item.role === "assistant");
		expect(orphaned?.content).toMatch(/Previous tool result/);
	});
});

describe("openai-codex orphan tool-call repair", () => {
	it("synthesizes a function_call_output for a function_call with no result", async () => {
		const body: RequestBody = {
			model: "gpt-5.1-codex",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
				{ type: "function_call", call_id: "call_orphan", name: "read", arguments: "{}" },
				{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
			],
		};

		const transformed = await transformRequestBody(body, createCodexModel(body.model), {});
		const input = transformed.input || [];

		const callIndex = input.findIndex(item => item.type === "function_call" && item.call_id === "call_orphan");
		expect(callIndex).toBeGreaterThanOrEqual(0);
		// The synthesized output sits immediately after the orphan call.
		const output = input[callIndex + 1];
		expect(output?.type).toBe("function_call_output");
		expect(output?.call_id).toBe("call_orphan");
		expect(typeof output?.output).toBe("string");
		expect(output?.output as string).toMatch(/interrupted/i);
	});

	it("leaves a paired function_call untouched", async () => {
		const body: RequestBody = {
			model: "gpt-5.1-codex",
			input: [
				{ type: "function_call", call_id: "call_paired", name: "read", arguments: "{}" },
				{ type: "function_call_output", call_id: "call_paired", output: "real result" },
			],
		};

		const transformed = await transformRequestBody(body, createCodexModel(body.model), {});
		const input = transformed.input || [];

		const outputs = input.filter(item => item.type === "function_call_output" && item.call_id === "call_paired");
		expect(outputs).toHaveLength(1);
		expect(outputs[0]?.output).toBe("real result");
	});

	it("synthesizes a custom_tool_call_output for an orphan custom_tool_call", async () => {
		const body: RequestBody = {
			model: "gpt-5.1-codex",
			input: [{ type: "custom_tool_call", call_id: "call_custom", name: "apply_patch" }],
		};

		const transformed = await transformRequestBody(body, createCodexModel(body.model), {});
		const input = transformed.input || [];

		const output = input.find(item => item.type === "custom_tool_call_output" && item.call_id === "call_custom");
		expect(output).toBeDefined();
		expect(output?.output as string).toMatch(/interrupted/i);
	});

	it("folds an orphan custom_tool_call_output into an assistant message", async () => {
		const body: RequestBody = {
			model: "gpt-5.1-codex",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
				{ type: "custom_tool_call_output", call_id: "call_custom_orphan", name: "apply_patch", output: "Done!" },
			],
		};

		const transformed = await transformRequestBody(body, createCodexModel(body.model), {});
		const input = transformed.input || [];

		expect(input.some(item => item.type === "custom_tool_call_output")).toBe(false);
		const note = input.find(item => item.type === "message" && item.role === "assistant");
		expect(note?.content).toMatch(/call_custom_orphan/);
		expect(note?.content).toMatch(/Done!/);
	});
});

describe("openai-codex reasoning effort validation", () => {
	it("rejects gpt-5.1 xhigh when metadata does not list it", async () => {
		const body: RequestBody = { model: "gpt-5.1", input: [] };
		await expect(
			transformRequestBody(body, createCodexModel(body.model), { reasoningEffort: "xhigh" }),
		).rejects.toThrow(/Supported efforts: minimal, low, medium, high/);
	});

	it("rejects unsupported Codex mini efforts instead of clamping", async () => {
		const body: RequestBody = { model: "gpt-5.1-codex-mini", input: [] };

		await expect(
			transformRequestBody({ ...body }, createCodexModel(body.model), { reasoningEffort: "low" }),
		).rejects.toThrow(/Supported efforts: medium, high/);

		await expect(
			transformRequestBody({ ...body }, createCodexModel(body.model), { reasoningEffort: "xhigh" }),
		).rejects.toThrow(/Supported efforts: medium, high/);
	});

	it("rejects gpt-5.6 minimal now that the wire floor is low", async () => {
		const body: RequestBody = { model: "gpt-5.6-sol", input: [] };
		await expect(
			transformRequestBody(body, createCodexModel(body.model), { reasoningEffort: "minimal" }),
		).rejects.toThrow(/Supported efforts: low, medium, high, xhigh, max/);
	});
});

describe("openai-codex reasoning effort wire mapping", () => {
	it("maps gpt-5.6 user efforts 1:1 onto wire tiers", async () => {
		const model = createCodexModel("gpt-5.6-sol");
		const efforts = ["low", "medium", "high", "xhigh", "max"] as const;

		for (const effort of efforts) {
			const transformed = await transformRequestBody({ model: model.id }, model, {
				reasoningEffort: effort,
			});
			expect(transformed.reasoning?.effort).toBe(effort);
		}
	});

	it("keeps pre-5.6 efforts 1:1 and passes none through unmapped", async () => {
		const gpt55 = createCodexModel("gpt-5.5");
		const unshifted = await transformRequestBody({ model: gpt55.id }, gpt55, { reasoningEffort: "xhigh" });
		expect(unshifted.reasoning?.effort).toBe("xhigh");

		const gpt56 = createCodexModel("gpt-5.6-sol");
		const none = await transformRequestBody({ model: gpt56.id }, gpt56, { reasoningEffort: "none" });
		expect(none.reasoning?.effort).toBe("none");
	});
});

describe("openai-codex error parsing", () => {
	it("produces friendly usage-limit messages and rate limits", async () => {
		const resetAt = Math.floor(Date.now() / 1000) + 600;
		const response = new Response(
			JSON.stringify({
				error: { code: "usage_limit_reached", plan_type: "Plus", resets_at: resetAt },
			}),
			{
				status: 429,
				headers: {
					"x-codex-primary-used-percent": "99",
					"x-codex-primary-window-minutes": "60",
					"x-codex-primary-reset-at": String(resetAt),
				},
			},
		);

		const info = await parseCodexError(response);
		expect(info.friendlyMessage?.toLowerCase()).toContain("usage limit");
		expect(info.rateLimits?.primary?.used_percent).toBe(99);
	});

	it("CodexApiError carries status/headers/code for structural retry classification", async () => {
		const response = new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }), {
			status: 429,
			headers: { "retry-after": "7" },
		});

		const error = await CodexApiError.fromResponse(response);
		// Downstream reads these structurally: extractHttpStatusFromError (.status),
		// getHeadersFromError → retry-after extraction (.headers), copilot/auth
		// retry policies (.code). The message is the friendly text, not raw JSON.
		expect(error.status).toBe(429);
		expect(error.code).toBe("rate_limit_exceeded");
		expect(error.headers?.get("retry-after")).toBe("7");
		expect(error.message).toContain("rate limit exceeded");
	});
});
