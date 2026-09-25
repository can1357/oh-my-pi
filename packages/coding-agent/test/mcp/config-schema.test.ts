/**
 * Contract: the bundled MCP JSON schema (`src/config/mcp-schema.json`) accepts
 * every documented server field on every transport.
 *
 * Regression: the shared fields lived only in `$defs.serverBase`, which each
 * transport referenced through `allOf` while declaring
 * `additionalProperties: false` in the sibling branch. A sibling branch cannot
 * see the other branch's properties, so schema-aware editors rejected a valid
 * config such as `{ "command": "x", "timeout": 5 }` — the fields had to be
 * declared where the `additionalProperties` check happens. Unknown keys and
 * transport-conflicting keys must still be rejected.
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
	const sharedFields: Array<[string, unknown]> = [
		["enabled", false],
		["timeout", 5000],
		["requestIdFormat", "string"],
		["enabledTools", ["search"]],
		["disabledTools", ["admin_*"]],
		["auth", { type: "oauth" }],
		["oauth", { clientId: "c" }],
	];

	const transports: Array<[string, Record<string, unknown>]> = [
		["stdio", { command: "exa-mcp-server", args: ["-y"] }],
		["http", { type: "http", url: "https://example.com/mcp", headers: { "X-A": "b" } }],
		["sse", { type: "sse", url: "https://example.com/sse" }],
	];

	for (const [transport, base] of transports) {
		test(`${transport} accepts every shared server field`, () => {
			for (const [field, value] of sharedFields) {
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
		expect(valid({ timeout: 5 })).toBe(false);
	});

	test("rejects malformed tool filters", () => {
		expect(valid({ command: "x", enabledTools: [1] })).toBe(false);
		expect(valid({ command: "x", enabledTools: [] })).toBe(true);
	});
});
