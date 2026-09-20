import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { computeNonMessageBreakdown, estimateToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";

const tokenizer = new Tokenizer();

/** External arktype copies expose bind on callable schemas, unlike omptype. */
function bindCapableSchema() {
	return Object.assign((value: unknown) => value, {
		toJsonSchema: () => ({ type: "object", properties: { a: { type: "string" } } }),
		assert: (value: unknown) => value,
	});
}

describe("extension tool context accounting", () => {
	it("counts a proxied bind-capable callable schema by its wire JSON Schema", () => {
		// Binding the schema loses its wire surface and once poisoned token accounting.
		const schema = bindCapableSchema();
		const unwrapped = { name: "ext", description: "ext tool", parameters: schema };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(unwrapped, wrapper);
		const proxied = wrapper as { name: string; description: string; parameters: unknown };
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBe(
			estimateToolSchemaTokens([unwrapped as never], tokenizer),
		);
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBeGreaterThan(0);
	});

	it("runs the full non-message breakdown on a proxied extension tool", () => {
		const schema = bindCapableSchema();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy({ name: "ext", description: "ext tool", parameters: schema }, wrapper);
		const session = { systemPrompt: ["base"], agent: { state: { tools: [wrapper] } } };
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		expect(breakdown.toolsTokens).toBeGreaterThan(0);
	});
});
