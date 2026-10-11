/**
 * Contract: the bundled MCP JSON schema (`src/config/mcp-schema.json`) accepts
 * tool filter fields (`enabledTools`, `disabledTools`) on every transport.
 *
 * Asserted through the in-tree validator (`isJsonSchemaValueValid`) so the
 * contract is checked by the same JSON Schema subset the repo vendors.
 */
import { describe, expect, test } from "bun:test";
import { isJsonSchemaValueValid } from "@oh-my-pi/pi-ai/utils/schema";
import schema from "../../src/config/mcp-schema.json" with { type: "json" };

function valid(server: Record<string, unknown>): boolean {
	return isJsonSchemaValueValid(schema, { mcpServers: { server: server } });
}

describe("MCP config schema", () => {
	const filterFields: Array<[string, unknown]> = [
		["enabledTools", ["search"]],
		["disabledTools", ["admin_*"]],
	];

	const transports: Array<[string, Record<string, unknown>]> = [
		["stdio", { command: "exa-mcp-server", args: ["-y"] }],
		["http", { type: "http", url: "https://example.com/mcp", headers: { "X-A": "b" } }],
		["sse", { type: "sse", url: "https://example.com/sse" }],
	];

	for (const [transport, base] of transports) {
		test(`${transport} accepts tool filter fields`, () => {
			for (const [field, value] of filterFields) {
				expect({ field, accepted: valid({ ...base, [field]: value }) }).toEqual({ field, accepted: true });
			}
		});
	}

	test("rejects unknown server keys", () => {
		expect(valid({ command: "x", bogus: 1 })).toBe(false);
	});

	test("rejects a server with both transports' keys", () => {
		expect(valid({ command: "x", url: "https://example.com/mcp" })).toBe(false);
		expect(valid({ type: "http", url: "https://example.com/mcp", command: "x" })).toBe(false);
	});

	test("rejects a server with neither command nor url", () => {
		expect(valid({ enabledTools: ["search"] })).toBe(false);
	});

	test("rejects malformed tool filters", () => {
		expect(valid({ command: "x", enabledTools: [1] })).toBe(false);
		expect(valid({ command: "x", enabledTools: [] })).toBe(true);
	});
});
