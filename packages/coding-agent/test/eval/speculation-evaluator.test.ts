import { describe, expect, it } from "bun:test";
import {
	completionEgressIsSafe,
	evaluateShadowExpression,
	evaluateShadowOperation,
} from "../../src/eval/speculation/evaluator";
import type { ShadowOperation, ShadowValue } from "../../src/eval/speculation/types";

function completionOperation(): ShadowOperation {
	return {
		kind: "tool",
		call: {
			id: "completion-1",
			siteId: "js:10",
			dynamicPath: [],
			occurrence: 0,
			name: "completion",
			args: { kind: "snapshot", name: "prompt" },
			dependencies: [],
			controlDependencies: [],
			sourceOrder: 0,
			span: { start: 10, end: 20 },
		},
	};
}

describe("shadow IR evaluator", () => {
	it("propagates transitive origins through property access and concatenation", () => {
		const results = new Map<string, ShadowValue>([
			[
				"read-1",
				{
					value: { content: [{ text: "secret" }] },
					origins: [{ kind: "local_read", resource: "/tmp/source" }],
				},
			],
		]);
		const value = evaluateShadowExpression(
			{
				kind: "concat",
				items: [
					{ kind: "literal", value: "prefix:" },
					{
						kind: "property",
						target: {
							kind: "property",
							target: {
								kind: "property",
								target: { kind: "operation_result", operationId: "read-1" },
								property: "content",
							},
							property: 0,
						},
						property: "text",
					},
				],
			},
			{ snapshot: {}, results },
		);
		expect(value).toEqual({
			value: "prefix:secret",
			origins: [{ kind: "provider_literal" }, { kind: "local_read", resource: "/tmp/source" }],
		});
	});

	it("preserves Python string conversion only when JavaScript formatting is identical", () => {
		const expression = {
			kind: "transform" as const,
			name: "Python.str" as const,
			input: { kind: "snapshot" as const, name: "value" },
		};

		expect(evaluateShadowExpression(expression, { snapshot: { value: "note.txt" }, results: new Map() }).value).toBe(
			"note.txt",
		);
		expect(() => evaluateShadowExpression(expression, { snapshot: { value: true }, results: new Map() })).toThrow(
			"Python str() projection requires a string shadow value",
		);
	});
	it("blocks persistent and local-read values from completion egress", () => {
		const operation = completionOperation();
		expect(() =>
			evaluateShadowOperation(
				operation,
				{
					snapshot: { prompt: "private" },
					results: new Map(),
				},
				{ provider: "openai", authority: "https://api.example/" },
			),
		).toThrow("unsafe completion information flow");
		expect(
			completionEgressIsSafe(
				{ value: "private", origins: [{ kind: "local_read", resource: "/tmp/source" }] },
				"openai",
				"https://api.example/",
			),
		).toBe(false);
	});

	it("allows prior model output only for the same provider authority", () => {
		const args: ShadowValue = {
			value: "follow up",
			origins: [{ kind: "model_completion", provider: "openai", authority: "https://api.example/" }],
		};
		expect(completionEgressIsSafe(args, "openai", "https://api.example/")).toBe(true);
		expect(completionEgressIsSafe(args, "openai", "https://other.example/")).toBe(false);
	});
});
