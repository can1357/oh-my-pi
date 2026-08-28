import { describe, expect, it } from "bun:test";
import { projectJavaScriptShadowPlan } from "../../src/eval/js/speculation";

describe("projectJavaScriptShadowPlan", () => {
	it("projects a static read with a source-derived site identity", async () => {
		const plan = await projectJavaScriptShadowPlan('tool.read({ path: "src/a.ts", limit: 2 });');
		expect(plan.barrier).toBeUndefined();
		expect(plan.operations).toHaveLength(1);
		expect(plan.operations[0]).toMatchObject({
			kind: "tool",
			call: {
				id: "js:0::0",
				siteId: "js:0",
				dynamicPath: [],
				occurrence: 0,
				name: "read",
				args: {
					kind: "object",
					entries: [
						{ key: "path", value: { kind: "literal", value: "src/a.ts" } },
						{ key: "limit", value: { kind: "literal", value: 2 } },
					],
				},
				dependencies: [],
				controlDependencies: [],
				sourceOrder: 0,
			},
		});
	});

	it("tracks read dependencies through declarations and safe transformations", async () => {
		const interpolation = "$" + "{source.content[0].text}";
		const plan = await projectJavaScriptShadowPlan(`
const source = await tool.read({ path: "src/path.txt" });
const path = \`src/${interpolation}\`;
const target = await tool.read({ path });
display(target);
`);
		expect(plan.barrier).toBeUndefined();
		expect(plan.operations).toHaveLength(2);
		const [source, target] = plan.operations;
		expect(target?.call.dependencies).toEqual([source?.call.id]);
		expect(target?.call.args).toMatchObject({ kind: "object" });
	});

	it("rejects numeric addition while retaining proven string concatenation", async () => {
		const numeric = await projectJavaScriptShadowPlan(`
const value = 1 + 2;
await tool.read({ path: String(value) });
`);
		expect(numeric.operations).toEqual([]);
		expect(numeric.barrier?.reason).toBe("unsupported JavaScript declaration value");

		const text = await projectJavaScriptShadowPlan(`
const path = "src/" + "a.ts";
await tool.read({ path });
`);
		expect(text.barrier).toBeUndefined();
		expect(text.operations).toHaveLength(1);
		expect(text.operations[0]?.call.args).toMatchObject({
			kind: "object",
			entries: [{ key: "path", value: { kind: "concat" } }],
		});
	});

	it("does not project completion calls", async () => {
		const plan = await projectJavaScriptShadowPlan('await completion("constant");');
		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("unsupported JavaScript statement");
	});

	it("expands deterministic branches and bounded loops with dynamic paths", async () => {
		const plan = await projectJavaScriptShadowPlan(
			`
if (enabled) {
  for (const path of paths) {
    await tool.read({ path });
  }
} else {
  await tool.read({ path: "fallback" });
}
`,
			{ snapshot: { enabled: true, paths: ["a", "b"] } },
		);
		expect(plan.barrier).toBeUndefined();
		expect(plan.operations.map(operation => operation.call.dynamicPath)).toEqual([
			["if:true", "loop:0"],
			["if:true", "loop:1"],
		]);
		expect(plan.controls).toEqual([expect.objectContaining({ kind: "loop", iterations: 2 })]);
	});

	it("preserves parallel input order and lowest-index failure order", async () => {
		const plan = await projectJavaScriptShadowPlan(`
const values = await parallel([
  tool.read({ path: "a" }),
  tool.read({ path: "b" }),
]);
`);
		expect(plan.operations.map(operation => operation.call.dynamicPath)).toEqual([["parallel:0"], ["parallel:1"]]);
		expect(plan.controls?.[0]).toMatchObject({
			kind: "join",
			operationIds: plan.operations.map(operation => operation.call.id),
			failureOrder: plan.operations.map(operation => operation.call.id),
		});
	});

	it("keeps safe independent operations before a later unsupported barrier", async () => {
		const plan = await projectJavaScriptShadowPlan('tool.read({ path: "safe" });\nunknownCall();');
		expect(plan.operations).toHaveLength(1);
		expect(plan.barrier?.reason).toBe("unsupported JavaScript statement");
	});
	it("does not leak dynamic branch assignments into later operations", async () => {
		const plan = await projectJavaScriptShadowPlan(`
let selected = "base";
if (enabled) {
  selected = "first";
} else {
  selected = "second";
}
tool.read({ path: selected });
`);

		expect(plan.operations).toHaveLength(1);
		expect(plan.operations[0]?.call.args).toMatchObject({
			kind: "object",
			entries: [{ key: "path", value: { kind: "literal", value: "base" } }],
		});
	});
});
