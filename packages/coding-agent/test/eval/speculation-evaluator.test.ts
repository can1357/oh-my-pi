import { describe, expect, it } from "bun:test";
import { evaluateShadowExpression } from "../../src/eval/speculation/evaluator";
import type { ShadowValue } from "../../src/eval/speculation/types";

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
});
