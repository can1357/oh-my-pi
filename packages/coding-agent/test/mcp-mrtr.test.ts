import { describe, expect, it } from "bun:test";
import type { CustomToolContext } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/custom-tools";
import {
	callTool,
	callToolWithMRTR,
	completeMCPRequest,
	connectToServer,
	getPromptWithMRTR,
	MCP_MAX_INPUT_REQUIRED_ROUNDS,
	readResourceWithMRTR,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/client";
import { MCPTool } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/tool-bridge";
import {
	type MCPHostInteraction,
	MCPInputRequestUnsupportedError,
	MCPInputRequiredMalformedError,
	MCPInputRequiredRoundsExceededError,
	type MCPModernClientCapabilities,
	type MCPToolDefinition,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import { createMockTransport, createModernMockConnection } from "./mcp-test-utils";

const unusedContext = {} as CustomToolContext;
const policy: MCPHostInteraction = {
	clientCapabilities: { elicitation: { form: {} } },
	async collectInput() {
		return { approval: { action: "accept" } };
	},
};

function inputRequired(requestState: string, keys: Record<string, unknown> = { approval: {} }) {
	return {
		resultType: "input_required" as const,
		requestState,
		inputRequests: Object.fromEntries(
			Object.keys(keys).map(key => [key, { method: "elicitation/create", params: { mode: "form" } }]),
		),
	};
}

function connection(responses: unknown[], calls: Array<Record<string, unknown>>) {
	const connection = createModernMockConnection(
		{ tools: {} },
		createMockTransport(new Map([["tools/call", responses]]), (_method, params) => calls.push(params ?? {})),
	);
	if (connection.protocol?.era === "modern") connection.protocol.clientCapabilities = policy.clientCapabilities;
	return connection;
}

describe("MCP MRTR", () => {
	it("retries with original tool params, exact opaque state, and only the prior round responses", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const seenRounds: number[] = [];
		const conn = connection(
			[
				inputRequired("opaque-state-one"),
				inputRequired("opaque-state-two"),
				{ resultType: "complete", content: [{ type: "text", text: "finished" }] },
			],
			calls,
		);
		const interaction: MCPHostInteraction = {
			clientCapabilities: { elicitation: { form: {} } },
			async collectInput(context) {
				seenRounds.push(context.round);
				return { approval: { action: `round-${context.round}` } };
			},
		};

		const result = await callToolWithMRTR(
			conn,
			"deploy",
			{ target: "prod", nested: { retained: true } },
			interaction,
		);
		expect(result.content).toEqual([{ type: "text", text: "finished" }]);
		expect(seenRounds).toEqual([1, 2]);
		expect(calls).toHaveLength(3);
		for (const call of calls) {
			expect(call.name).toBe("deploy");
			expect(call.arguments).toEqual({ target: "prod", nested: { retained: true } });
		}
		expect(calls[1]?.requestState).toBe("opaque-state-one");
		expect(calls[1]?.inputResponses).toEqual({ approval: { action: "round-1" } });
		expect(calls[2]?.requestState).toBe("opaque-state-two");
		expect(calls[2]?.inputResponses).toEqual({ approval: { action: "round-2" } });
	});

	it("collects every server key atomically and rejects absent or unsupported policy without retrying", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const conn = connection(
			[inputRequired("state", { first: {}, second: {} }), { resultType: "complete", content: [] }],
			calls,
		);
		let collections = 0;
		const interaction: MCPHostInteraction = {
			clientCapabilities: { elicitation: { form: {} } },
			async collectInput(context) {
				collections += 1;
				expect(Object.keys(context.inputRequired.inputRequests ?? {})).toEqual(["first", "second"]);
				return { first: { action: "accept" }, second: { action: "decline" } };
			},
		};
		await callToolWithMRTR(conn, "multi", {}, interaction);
		expect(collections).toBe(1);
		expect(calls[1]?.inputResponses).toEqual({ first: { action: "accept" }, second: { action: "decline" } });

		const unsupportedCalls: Array<Record<string, unknown>> = [];
		await expect(
			callToolWithMRTR(connection([inputRequired("state")], unsupportedCalls), "no-policy", {}),
		).rejects.toBeInstanceOf(MCPInputRequestUnsupportedError);
		expect(unsupportedCalls).toHaveLength(1);
	});

	it("rejects unadvertised kinds and malformed response maps without replaying", async () => {
		const unsupportedCalls: Array<Record<string, unknown>> = [];
		let collections = 0;
		await expect(
			callToolWithMRTR(
				connection(
					[
						{
							resultType: "input_required",
							inputRequests: { sample: { method: "sampling/createMessage", params: {} } },
						},
					],
					unsupportedCalls,
				),
				"unadvertised",
				{},
				{
					clientCapabilities: { elicitation: { form: {} } },
					async collectInput() {
						collections += 1;
						return {};
					},
				},
			),
		).rejects.toBeInstanceOf(MCPInputRequestUnsupportedError);
		expect(collections).toBe(0);
		expect(unsupportedCalls).toHaveLength(1);

		const malformedCalls: Array<Record<string, unknown>> = [];
		await expect(
			callToolWithMRTR(
				connection([inputRequired("state", { first: {}, second: {} })], malformedCalls),
				"bad-response",
				{},
				{
					clientCapabilities: { elicitation: { form: {} } },
					async collectInput() {
						return { first: { action: "accept" } };
					},
				},
			),
		).rejects.toBeInstanceOf(MCPInputRequiredMalformedError);
		expect(malformedCalls).toHaveLength(1);
	});

	it("bounds interaction to four response rounds", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const conn = connection(
			Array.from({ length: MCP_MAX_INPUT_REQUIRED_ROUNDS + 1 }, (_, index) => inputRequired(`state-${index}`)),
			calls,
		);
		await expect(callToolWithMRTR(conn, "bounded", {}, policy)).rejects.toBeInstanceOf(
			MCPInputRequiredRoundsExceededError,
		);
		expect(calls).toHaveLength(MCP_MAX_INPUT_REQUIRED_ROUNDS + 1);
	});

	it("does not send a retry when aborted during collection", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const conn = connection([inputRequired("state")], calls);
		const controller = new AbortController();
		const gate = Promise.withResolvers<Record<string, unknown>>();
		const collecting = Promise.withResolvers<void>();
		const interaction: MCPHostInteraction = {
			clientCapabilities: { elicitation: { form: {} } },
			async collectInput() {
				collecting.resolve();
				return gate.promise;
			},
		};
		const pending = callToolWithMRTR(conn, "cancel", {}, interaction, { signal: controller.signal });
		await collecting.promise;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toHaveLength(1);
	});

	it("does not reconnect and replay the original operation after an MRTR round begins", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const conn = connection([inputRequired("state")], calls);
		let reconnects = 0;
		const definition: MCPToolDefinition = { name: "non-replay", inputSchema: { type: "object" } };
		const result = await new MCPTool(
			conn,
			definition,
			async () => {
				reconnects += 1;
				return conn;
			},
			{
				clientCapabilities: { elicitation: { form: {} } },
				async collectInput() {
					throw new Error("ECONNRESET while collecting input");
				},
			},
		).execute("call", {}, undefined, unusedContext);
		expect(reconnects).toBe(0);
		expect(calls).toHaveLength(1);
		expect(result.isError).toBe(true);
	});

	it("formats only the final complete bridge result", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const conn = connection(
			[
				{
					...inputRequired("state"),
					content: [{ type: "text", text: "interim secret" }],
					structuredContent: { interim: true },
				},
				{ resultType: "complete", content: [{ type: "text", text: "final answer" }] },
			],
			calls,
		);
		const definition: MCPToolDefinition = { name: "guarded", inputSchema: { type: "object" } };
		const result = await new MCPTool(conn, definition, undefined, policy).execute(
			"call",
			{},
			undefined,
			unusedContext,
		);
		expect(result.content).toEqual([{ type: "text", text: "final answer" }]);
		expect(JSON.stringify(result)).not.toContain("interim secret");
	});

	it("supports resources and prompts through the same coordinator", async () => {
		const requests: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
		const conn = createModernMockConnection(
			{ resources: {}, prompts: {} },
			createMockTransport(
				new Map([
					[
						"resources/read",
						[
							inputRequired("resource-state"),
							{ resultType: "complete", ttlMs: 60_000, cacheScope: "public", contents: [] },
						],
					],
					["prompts/get", [inputRequired("prompt-state"), { resultType: "complete", messages: [] }]],
				]),
				(method, params) => requests.push({ method, params }),
			),
		);
		if (conn.protocol?.era === "modern") conn.protocol.clientCapabilities = policy.clientCapabilities;
		await readResourceWithMRTR(conn, "file:///project/a", policy);
		await readResourceWithMRTR(conn, "file:///project/a", policy);
		await getPromptWithMRTR(conn, "review", { language: "ts" }, policy);
		expect(
			requests.filter(request => request.method === "resources/read").map(request => request.params?.uri),
		).toEqual(["file:///project/a", "file:///project/a"]);
		expect(requests.filter(request => request.method === "prompts/get").map(request => request.params?.name)).toEqual(
			["review", "review"],
		);
		await expect(completeMCPRequest(conn, "tools/list" as never, {}, policy)).rejects.toThrow("not MRTR-enabled");
	});

	it("supports parameterless roots and omitted-mode elicitation only when the connection advertised them", async () => {
		const rootsCalls: Array<Record<string, unknown>> = [];
		const rootsConnection = connection(
			[
				{
					resultType: "input_required",
					inputRequests: { roots: { method: "roots/list" } },
				},
				{ resultType: "complete", content: [] },
			],
			rootsCalls,
		);
		if (rootsConnection.protocol?.era === "modern") rootsConnection.protocol.clientCapabilities = { roots: {} };
		await callToolWithMRTR(
			rootsConnection,
			"roots",
			{},
			{
				clientCapabilities: {},
				async collectInput() {
					return { roots: { roots: [] } };
				},
			},
		);
		expect(rootsCalls).toHaveLength(2);

		const formCalls: Array<Record<string, unknown>> = [];
		const formConnection = connection(
			[
				{
					resultType: "input_required",
					inputRequests: { form: { method: "elicitation/create", params: {} } },
				},
				{ resultType: "complete", content: [] },
			],
			formCalls,
		);
		if (formConnection.protocol?.era === "modern") formConnection.protocol.clientCapabilities = { elicitation: {} };
		await callToolWithMRTR(
			formConnection,
			"form",
			{},
			{
				clientCapabilities: {},
				async collectInput() {
					return { form: { action: "accept" } };
				},
			},
		);
		expect(formCalls).toHaveLength(2);
		const urlOnlyCalls: Array<Record<string, unknown>> = [];
		const urlOnlyConnection = connection(
			[
				{
					resultType: "input_required",
					inputRequests: { form: { method: "elicitation/create", params: {} } },
				},
			],
			urlOnlyCalls,
		);
		if (urlOnlyConnection.protocol?.era === "modern") {
			urlOnlyConnection.protocol.clientCapabilities = { elicitation: { url: {} } };
		}
		await expect(callToolWithMRTR(urlOnlyConnection, "url-only", {}, policy)).rejects.toBeInstanceOf(
			MCPInputRequestUnsupportedError,
		);
		expect(urlOnlyCalls).toHaveLength(1);
	});

	it("rejects unsupported sampling subcapabilities, invalid requestState, and direct modern interim results", async () => {
		const samplingCalls: Array<Record<string, unknown>> = [];
		const samplingConnection = connection(
			[
				{
					resultType: "input_required",
					inputRequests: {
						sample: { method: "sampling/createMessage", params: { includeContext: "allServers" } },
					},
				},
			],
			samplingCalls,
		);
		if (samplingConnection.protocol?.era === "modern") {
			samplingConnection.protocol.clientCapabilities = { sampling: { tools: {} } };
		}
		await expect(callToolWithMRTR(samplingConnection, "sampling", {}, policy)).rejects.toBeInstanceOf(
			MCPInputRequestUnsupportedError,
		);
		expect(samplingCalls).toHaveLength(1);

		const basicSamplingCalls: Array<Record<string, unknown>> = [];
		const basicSamplingConnection = connection(
			[
				{
					resultType: "input_required",
					inputRequests: { sample: { method: "sampling/createMessage", params: { includeContext: "none" } } },
				},
				{ resultType: "complete", content: [] },
			],
			basicSamplingCalls,
		);
		if (basicSamplingConnection.protocol?.era === "modern") {
			basicSamplingConnection.protocol.clientCapabilities = { sampling: {} };
		}
		await callToolWithMRTR(
			basicSamplingConnection,
			"basic-sampling",
			{},
			{
				clientCapabilities: {},
				async collectInput() {
					return { sample: { content: {} } };
				},
			},
		);
		expect(basicSamplingCalls).toHaveLength(2);

		await expect(
			callToolWithMRTR(
				connection(
					[
						{
							resultType: "input_required",
							inputRequests: { sample: { method: "sampling/createMessage", params: { includeContext: true } } },
						},
					],
					[],
				),
				"invalid-sampling",
				{},
				policy,
			),
		).rejects.toBeInstanceOf(MCPInputRequiredMalformedError);

		await expect(
			callToolWithMRTR(connection([{ resultType: "input_required", requestState: 1 }], []), "bad-state", {}, policy),
		).rejects.toBeInstanceOf(MCPInputRequiredMalformedError);

		await expect(callTool(connection([inputRequired("state")], []), "direct", {})).rejects.toBeInstanceOf(
			MCPInputRequestUnsupportedError,
		);
	});

	it("propagates only explicitly supplied modern client capabilities", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const capabilities: MCPModernClientCapabilities = { elicitation: { form: {} } };
		const transport = createMockTransport(
			new Map([
				[
					"server/discover",
					[
						{
							resultType: "complete",
							supportedVersions: ["2026-07-28"],
							capabilities: {},
							ttlMs: 60_000,
							cacheScope: "public",
						},
					],
				],
			]),
			(_method, params) => requests.push(params ?? {}),
		);
		const conn = await connectToServer(
			"policy",
			{ type: "stdio", command: "echo" },
			{ modernClientCapabilities: capabilities, transportFactory: async () => transport },
		);
		expect(conn.protocol?.era).toBe("modern");
		expect(conn.protocol?.era === "modern" ? conn.protocol.clientCapabilities : undefined).toEqual(capabilities);
		expect(conn.protocol?.era === "modern" ? Object.isFrozen(conn.protocol.clientCapabilities) : false).toBe(true);
		expect(conn.protocol?.era === "modern" ? conn.protocol.clientCapabilities : undefined).not.toBe(capabilities);
		capabilities.elicitation = undefined;
		expect(conn.protocol?.era === "modern" ? conn.protocol.clientCapabilities : undefined).toEqual({
			elicitation: { form: {} },
		});
		expect((requests[0]?._meta as Record<string, unknown>)?.["io.modelcontextprotocol/clientCapabilities"]).toEqual({
			elicitation: { form: {} },
		});
	});
});
