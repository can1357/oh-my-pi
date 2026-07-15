/**
 * Contract: tool schema token estimation reflects the wire JSON Schema.
 *
 * Tools authored with arktype must be counted by the JSON Schema providers
 * actually receive — not by stringifying the arktype instance's enumerable
 * internals, which massively overcounts.
 */
import { describe, expect, it } from "bun:test";
import { arkToWireSchema } from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import { estimateToolSchemaTokens } from "@pk-nerdsaver-ai/pi-coding-agent/modes/utils/context-usage";
import { type } from "arktype";

describe("estimateToolSchemaTokens", () => {
	it("counts arktype tool schemas by their wire JSON Schema, not arktype internals", () => {
		const parameters = type({
			"query /** search query */": "string",
			"limit?": "number",
		});
		const arktypeEstimate = estimateToolSchemaTokens([
			{ name: "web_search", description: "Searches the web.", parameters } as never,
		]);
		const wireEstimate = estimateToolSchemaTokens([
			{ name: "web_search", description: "Searches the web.", parameters: arkToWireSchema(parameters) } as never,
		]);
		expect(arktypeEstimate).toBe(wireEstimate);
	});
});
