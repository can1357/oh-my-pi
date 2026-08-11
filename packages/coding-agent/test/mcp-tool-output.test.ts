import { describe, expect, it } from "bun:test";
import type { CustomToolContext } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/custom-tools";
import { listTools } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/client";
import { formatMCPStructuredContent } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/render";
import { DeferredMCPTool, MCPTool } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/tool-bridge";
import type {
	MCPJsonValue,
	MCPServerConnection,
	MCPToolCallOperationResult,
	MCPToolDefinition,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

const unusedContext = {} as CustomToolContext;

const objectOutputSchema = {
	type: "object",
	properties: {
		count: { type: "integer" },
		label: { type: "string" },
	},
	required: ["count", "label"],
	additionalProperties: false,
} satisfies Record<string, unknown>;

function makeDefinition(outputSchema?: Record<string, unknown>): MCPToolDefinition {
	return {
		name: "inspect",
		description: "Inspect a value",
		inputSchema: { type: "object", properties: {} },
		outputSchema,
	};
}

function connectionFor(responses: unknown[], modern = false): MCPServerConnection {
	const connection = createMockConnection({ tools: {} }, createMockTransport(new Map([["tools/call", responses]])));
	if (modern) {
		connection.protocol = {
			era: "modern",
			version: "2026-07-28",
			supportedVersions: ["2026-07-28"],
			clientCapabilities: {},
			capabilities: { tools: {} },
		};
	}
	return connection;
}

async function executeActive(response: unknown, definition = makeDefinition(), modern = false) {
	const tool = new MCPTool(connectionFor([response], modern), definition);
	return tool.execute("call-1", {}, undefined, unusedContext);
}

describe("MCP structured tool output bridge", () => {
	it("round-trips tools/list outputSchema onto active and deferred bridge definitions", async () => {
		const definition = makeDefinition(objectOutputSchema);
		const connection = createMockConnection(
			{ tools: {} },
			createMockTransport(new Map([["tools/list", [{ tools: [definition] }]]])),
		);
		const listed = await listTools(connection);
		const active = MCPTool.fromTools(connection, listed)[0];
		const deferred = new DeferredMCPTool("test-server", listed[0], async () => connection);

		expect(listed[0].outputSchema).toEqual(objectOutputSchema);
		expect(active.outputSchema).toEqual(objectOutputSchema);
		expect(deferred.outputSchema).toEqual(objectOutputSchema);
	});

	it("converts structured-only objects to stable model text and retains structured details", async () => {
		const structuredContent = { label: "ready", count: 2 };
		const result = await executeActive(
			{ resultType: "complete", structuredContent },
			makeDefinition(objectOutputSchema),
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([
			{ type: "text", text: 'Structured content:\n{\n  "count": 2,\n  "label": "ready"\n}' },
		]);
		expect(result.details?.structuredContent).toEqual(structuredContent);
		expect(result.details?.outputSchema).toEqual(objectOutputSchema);
	});

	it("validates and represents structured-only arrays without requiring an object root", async () => {
		const outputSchema = { type: "array", items: { type: "integer" } };
		const result = await executeActive(
			{ resultType: "complete", structuredContent: [3, 1, 2] },
			makeDefinition(outputSchema),
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Structured content:\n[\n  3,\n  1,\n  2\n]" }]);
		expect(result.details?.structuredContent).toEqual([3, 1, 2]);
	});

	it("preserves text-only results without manufacturing structured output", async () => {
		const result = await executeActive({ resultType: "complete", content: [{ type: "text", text: "plain" }] });

		expect(result.content).toEqual([{ type: "text", text: "plain" }]);
		expect(result.details?.structuredContent).toBeUndefined();
	});

	it("retains every text block plus deterministic structured data for dual-form results", async () => {
		const structuredContent = { zeta: 2, alpha: 1 };
		const result = await executeActive({
			resultType: "complete",
			content: [
				{ type: "text", text: "first block" },
				{ type: "text", text: "second block" },
			],
			structuredContent,
		});

		expect(result.content).toEqual([
			{ type: "text", text: "first block" },
			{ type: "text", text: "second block" },
			{ type: "text", text: formatMCPStructuredContent(structuredContent) },
		]);
	});

	it("returns a controlled protocol error on outputSchema mismatch without dropping the server payload", async () => {
		const result = await executeActive(
			{
				resultType: "complete",
				content: [{ type: "text", text: "server explanation" }],
				structuredContent: { count: "wrong", label: "bad" },
			},
			makeDefinition(objectOutputSchema),
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("MCP protocol error");
		expect(result.content).toContainEqual({ type: "text", text: "server explanation" });
		expect(result.content).toContainEqual({
			type: "text",
			text: formatMCPStructuredContent({ count: "wrong", label: "bad" }),
		});
		expect(result.details?.structuredContent).toEqual({ count: "wrong", label: "bad" });
	});

	it("keeps MCP isError observable", async () => {
		const result = await executeActive({
			resultType: "complete",
			content: [{ type: "text", text: "denied" }],
			isError: true,
		});

		expect(result.isError).toBe(true);
		expect(result.details?.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "denied" }]);
	});

	it("keeps active and deferred tool conversion behavior in parity", async () => {
		const response: MCPToolCallOperationResult = {
			resultType: "complete",
			content: [
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			],
			structuredContent: [true, false],
		};
		const active = new MCPTool(connectionFor([response]), makeDefinition());
		const deferredConnection = connectionFor([response]);
		const deferred = new DeferredMCPTool("test-server", makeDefinition(), async () => deferredConnection);

		const [activeResult, deferredResult] = await Promise.all([
			active.execute("active", {}, undefined, unusedContext),
			deferred.execute("deferred", {}, undefined, unusedContext),
		]);
		expect(deferredResult).toEqual(activeResult);
	});

	it("fails closed before formatting an unhandled input_required result", async () => {
		const result = await executeActive(
			{
				resultType: "input_required",
				requestState: "state-1",
				inputRequests: {
					choice: { method: "elicitation/create", params: { mode: "form", message: "Choose" } },
				},
				content: [{ type: "text", text: "interim content" }],
			},
			makeDefinition(),
			true,
		);

		expect(result.isError).toBe(true);
		expect(result.content).toHaveLength(1);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("no host interaction policy");
		expect(JSON.stringify(result)).not.toContain("interim content");
		expect(result.details?.rawContent).toBeUndefined();
		expect(result.details?.inputRequired).toBeUndefined();
	});
	it("preserves audio and resource_link blocks as stable informative model content", async () => {
		const result = await executeActive({
			resultType: "complete",
			content: [
				{ type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
				{
					type: "resource_link",
					uri: "https://example.test/report",
					name: "report",
					description: "Generated report",
					mimeType: "application/json",
				},
			],
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: 'Audio content:\n{\n  "data": "YXVkaW8=",\n  "mimeType": "audio/wav",\n  "type": "audio"\n}',
			},
			{
				type: "text",
				text: 'Resource link:\n{\n  "description": "Generated report",\n  "mimeType": "application/json",\n  "name": "report",\n  "type": "resource_link",\n  "uri": "https://example.test/report"\n}',
			},
		]);
		expect(result.details?.rawContent).toHaveLength(2);
	});

	it("requires an explicit complete resultType on modern connections while retaining legacy omission", async () => {
		const legacy = await executeActive({ content: [{ type: "text", text: "legacy complete" }] });
		const modernMissing = await executeActive(
			{ content: [{ type: "text", text: "not complete" }] },
			makeDefinition(),
			true,
		);
		const modernUnknown = await executeActive(
			{ resultType: "future_state", content: [{ type: "text", text: "not complete" }] },
			makeDefinition(),
			true,
		);

		expect(legacy.isError).toBeUndefined();
		expect(legacy.content).toEqual([{ type: "text", text: "legacy complete" }]);
		expect(modernMissing.isError).toBe(true);
		expect(modernMissing.content[0]?.type === "text" ? modernMissing.content[0].text : "").toContain(
			'resultType must be "complete" or "input_required"',
		);
		expect(modernMissing.content).not.toContainEqual({ type: "text", text: "not complete" });
		expect(modernUnknown.isError).toBe(true);
		expect(modernUnknown.content[0]?.type === "text" ? modernUnknown.content[0].text : "").toContain(
			'resultType must be "complete" or "input_required"',
		);
	});

	it("preserves __proto__ and harness-like structured keys without prototype mutation", async () => {
		const structuredContent: MCPJsonValue = JSON.parse(
			'{"__proto__":{"polluted":true},"__partialJson":"wire data","i":"result data"}',
		);
		const result = await executeActive({ resultType: "complete", structuredContent });

		expect(result.content).toEqual([
			{
				type: "text",
				text: 'Structured content:\n{\n  "__partialJson": "wire data",\n  "__proto__": {\n    "polluted": true\n  },\n  "i": "result data"\n}',
			},
		]);
		expect(
			typeof result.details?.structuredContent === "object" &&
				result.details.structuredContent !== null &&
				Object.hasOwn(result.details.structuredContent, "__proto__"),
		).toBe(true);
		expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
	});

	it("validates Draft 2020-12 schemas without the former output-schema allowlist", async () => {
		const unsupportedDialect = await executeActive(
			{ resultType: "complete", structuredContent: { value: "ok" } },
			makeDefinition({ $schema: "http://json-schema.org/draft-07/schema#", type: "object" }),
		);
		const validUnevaluated = await executeActive(
			{ resultType: "complete", structuredContent: { value: "ok" } },
			makeDefinition({
				type: "object",
				properties: { value: { type: "string" } },
				unevaluatedProperties: false,
			}),
		);
		const invalidUnevaluated = await executeActive(
			{ resultType: "complete", structuredContent: { value: "ok", extra: true } },
			makeDefinition({
				type: "object",
				properties: { value: { type: "string" } },
				unevaluatedProperties: false,
			}),
		);
		const customVocabulary = await executeActive(
			{ resultType: "complete", structuredContent: "ok" },
			makeDefinition({
				$vocabulary: { "https://schemas.example.test/vocabulary": true },
				type: "string",
			}),
		);

		expect(unsupportedDialect.isError).toBe(true);
		expect(unsupportedDialect.content[0]?.type === "text" ? unsupportedDialect.content[0].text : "").toContain(
			"unsupported JSON Schema dialect",
		);
		expect(validUnevaluated.isError).toBeUndefined();
		expect(invalidUnevaluated.isError).toBe(true);
		expect(customVocabulary.isError).toBe(true);
		expect(customVocabulary.content[0]?.type === "text" ? customVocabulary.content[0].text : "").toContain(
			"$vocabulary is not permitted",
		);
	});
	it("treats required property names as own properties rather than inherited prototype members", async () => {
		const missingProto = await executeActive(
			{ resultType: "complete", structuredContent: {} },
			makeDefinition({ type: "object", required: ["__proto__"] }),
		);
		const missingToString = await executeActive(
			{ resultType: "complete", structuredContent: {} },
			makeDefinition({ type: "object", required: ["toString"] }),
		);
		const ownProto: MCPJsonValue = JSON.parse('{"__proto__":"present"}');
		const presentProto = await executeActive(
			{ resultType: "complete", structuredContent: ownProto },
			makeDefinition({ type: "object", required: ["__proto__"] }),
		);

		expect(missingProto.isError).toBe(true);
		expect(missingToString.isError).toBe(true);
		expect(presentProto.isError).toBeUndefined();
	});

	it("supports anchors, ref assertion siblings, dynamic references, and controlled missing references", async () => {
		const validAnchor = await executeActive(
			{ resultType: "complete", structuredContent: "ok" },
			makeDefinition({ $defs: { value: { $anchor: "value", type: "string" } }, $ref: "#value" }),
		);
		const invalidRefSibling = await executeActive(
			{ resultType: "complete", structuredContent: "" },
			makeDefinition({ $defs: { value: { type: "string" } }, $ref: "#/$defs/value", minLength: 1 }),
		);
		const validDynamicReference = await executeActive(
			{ resultType: "complete", structuredContent: { child: { child: "ok" } } },
			makeDefinition({
				$dynamicAnchor: "node",
				anyOf: [
					{ type: "string", minLength: 1 },
					{
						type: "object",
						properties: { child: { $dynamicRef: "#node" } },
						required: ["child"],
						unevaluatedProperties: false,
					},
				],
			}),
		);
		const invalidDynamicReference = await executeActive(
			{ resultType: "complete", structuredContent: { child: "" } },
			makeDefinition({
				$dynamicAnchor: "node",
				anyOf: [
					{ type: "string", minLength: 1 },
					{
						type: "object",
						properties: { child: { $dynamicRef: "#node" } },
						required: ["child"],
						unevaluatedProperties: false,
					},
				],
			}),
		);
		const validExternalDynamicReference = await executeActive(
			{ resultType: "complete", structuredContent: "x" },
			makeDefinition({
				$defs: {
					external: {
						$id: "urn:ompk:mcp-output-schema:test:external",
						$dynamicAnchor: "node",
						type: "string",
						maxLength: 1,
					},
				},
				$dynamicRef: "urn:ompk:mcp-output-schema:test:external#node",
			}),
		);
		const invalidExternalDynamicReference = await executeActive(
			{ resultType: "complete", structuredContent: "xx" },
			makeDefinition({
				$defs: {
					external: {
						$id: "urn:ompk:mcp-output-schema:test:external-invalid",
						$dynamicAnchor: "node",
						type: "string",
						maxLength: 1,
					},
				},
				$dynamicRef: "urn:ompk:mcp-output-schema:test:external-invalid#node",
			}),
		);
		const unresolvedReference = await executeActive(
			{ resultType: "complete", structuredContent: "ok" },
			makeDefinition({ $ref: "https://schemas.example.test/output" }),
		);

		expect(validAnchor.isError).toBeUndefined();
		expect(invalidRefSibling.isError).toBe(true);
		expect(invalidRefSibling.content[0]?.type === "text" ? invalidRefSibling.content[0].text : "").toContain(
			"minLength",
		);
		expect(validDynamicReference.isError).toBeUndefined();
		expect(invalidDynamicReference.isError).toBe(true);
		expect(validExternalDynamicReference.isError).toBeUndefined();
		expect(invalidExternalDynamicReference.isError).toBe(true);
		expect(unresolvedReference.isError).toBe(true);
		expect(unresolvedReference.content[0]?.type === "text" ? unresolvedReference.content[0].text : "").toContain(
			"resource not embedded",
		);
	});

	it("validates minLength and maxLength by Unicode code points in applicator contexts", async () => {
		const oneCodePoint = await executeActive(
			{ resultType: "complete", structuredContent: "💩" },
			makeDefinition({ anyOf: [{ type: "number" }, { type: "string", minLength: 1, maxLength: 1 }] }),
		);
		const twoCodePoints = await executeActive(
			{ resultType: "complete", structuredContent: ["💩💩"] },
			makeDefinition({ contains: { type: "string", maxLength: 1 }, type: "array", minContains: 1 }),
		);

		expect(oneCodePoint.isError).toBeUndefined();
		expect(twoCodePoints.isError).toBe(true);
		expect(twoCodePoints.content[0]?.type === "text" ? twoCodePoints.content[0].text : "").toContain("maxLength");
	});
	it("retains process-wide Hyperjump URI scheme plugins while locally enforcing embedded-reference-only policy", async () => {
		const browser = await import("@hyperjump/browser");
		expect(typeof browser.addUriSchemePlugin).toBe("function");
		expect(typeof browser.removeUriSchemePlugin).toBe("function");

		const httpRef = await executeActive(
			{ resultType: "complete", structuredContent: { data: 123 } },
			makeDefinition({ $ref: "http://example.com/external-schema.json" }),
		);
		const fileRef = await executeActive(
			{ resultType: "complete", structuredContent: { data: 123 } },
			makeDefinition({ $ref: "file:///etc/passwd" }),
		);

		expect(httpRef.isError).toBe(true);
		expect(httpRef.content[0]?.type === "text" ? httpRef.content[0].text : "").toContain(
			"references a resource not embedded in this outputSchema",
		);

		expect(fileRef.isError).toBe(true);
		expect(fileRef.content[0]?.type === "text" ? fileRef.content[0].text : "").toContain(
			"references a resource not embedded in this outputSchema",
		);
	});
});
