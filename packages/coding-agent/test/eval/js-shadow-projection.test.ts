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

	it("expands provider-literal branches and bounded loops with dynamic paths", async () => {
		const plan = await projectJavaScriptShadowPlan(`
const enabled = true;
const paths = ["a", "b"];
if (enabled) {
  for (const path of paths) {
    await tool.read({ path });
  }
} else {
  await tool.read({ path: "fallback" });
}
`);
		expect(plan.barrier).toBeUndefined();
		expect(plan.operations.map(operation => operation.call.dynamicPath)).toEqual([
			["if:true", "loop:0"],
			["if:true", "loop:1"],
		]);
		expect(plan.controls).toEqual([expect.objectContaining({ kind: "loop", iterations: 2 })]);
	});

	it("does not project operations from a retained-state branch", async () => {
		const plan = await projectJavaScriptShadowPlan('if (secretBit) await tool.read({ path: "selected" });', {
			snapshot: { secretBit: true },
		});

		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("persistent state cannot select speculative JavaScript operations");
	});

	it("rejects removed parallel helpers and shadowed tool bindings", async () => {
		const parallel = await projectJavaScriptShadowPlan(`
const values = await parallel([
  tool.read({ path: "a" }),
  tool.read({ path: "b" }),
]);
`);
		expect(parallel.operations).toEqual([]);
		expect(parallel.barrier?.reason).toBe("unsupported JavaScript declaration value");

		const shadowedTool = await projectJavaScriptShadowPlan(`
const tool = {};
tool.read({ path: "secret" });
`);
		expect(shadowedTool.operations).toEqual([]);
		expect(shadowedTool.barrier?.reason).toBe("JavaScript tool binding changed");
	});

	it("rejects a loop binding that shadows the tool bridge", async () => {
		const plan = await projectJavaScriptShadowPlan(`
for (const tool of [{}]) {
  tool.read({ path: "secret.txt" });
}
`);

		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("unsupported JavaScript loop binding");
	});

	it("rejects writes to a const binding before a projected read", async () => {
		const plan = await projectJavaScriptShadowPlan(`
const path = "old.txt";
path = "secret.txt";
tool.read({ path });
`);

		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("JavaScript const binding changed");
	});

	it("rejects a hoisted tool binding before reads in its block", async () => {
		const plan = await projectJavaScriptShadowPlan(`
if (true) {
  tool.read({ path: "secret.txt" });
  let tool = {};
}
`);

		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("JavaScript tool binding changed");
	});

	it("models hoisted vars before a projected read", async () => {
		const plan = await projectJavaScriptShadowPlan(`tool.read({ path }); var path = "new.txt";`, {
			snapshot: { path: "retained.txt" },
		});

		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("unsupported JavaScript statement");
	});

	it("models rewritten import bindings as hoisted before a projected read", async () => {
		const plan = await projectJavaScriptShadowPlan(`await tool.read({ path });\nimport path from "./module.js";`, {
			snapshot: { path: "retained.txt" },
		});

		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("unsupported JavaScript statement");
	});
	it("models a hoisted function binding as undefined before a projected read", async () => {
		const plan = await projectJavaScriptShadowPlan(`await tool.read({ path });\nfunction path() {}`, {
			snapshot: { path: "retained.txt" },
		});

		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("unsupported JavaScript statement");
	});

	it("models a demoted class binding as undefined before a projected read", async () => {
		const plan = await projectJavaScriptShadowPlan(`await tool.read({ path });\nclass path {}`, {
			snapshot: { path: "retained.txt" },
		});

		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("unsupported JavaScript statement");
	});
	it("rejects a block-hoisted function binding before a read in a taken branch", async () => {
		const plan = await projectJavaScriptShadowPlan(
			`const enabled = true;\nif (enabled) {\n  await tool.read({ path });\n  function path() {}\n}`,
			{ snapshot: { path: "retained.txt" } },
		);

		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("JavaScript block binding changed");
	});

	it("rejects block-hoisted function and class bindings before reads in a dynamic branch", async () => {
		const fn = await projectJavaScriptShadowPlan(
			`if (enabled) {\n  await tool.read({ path });\n  function path() {}\n}`,
			{
				snapshot: { path: "retained.txt" },
			},
		);

		expect(fn.operations).toEqual([]);
		expect(fn.barrier?.reason).toBe("JavaScript block binding changed");

		const cls = await projectJavaScriptShadowPlan(
			`if (enabled) {\n  await tool.read({ path });\n} else {\n  await tool.read({ path });\n  class path {}\n}`,
			{ snapshot: { path: "retained.txt" } },
		);

		expect(cls.operations).toHaveLength(1);
		expect(cls.operations[0]?.call.dynamicPath).toEqual(["if:true"]);
		expect(cls.barrier?.reason).toBe("JavaScript block binding changed");
	});

	it("rejects an import binding that shadows the tool bridge", async () => {
		const plan = await projectJavaScriptShadowPlan(`
import tool from "./module.js";
await tool.read({ path: "secret.txt" });
`);

		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("JavaScript tool binding changed");
	});
	it("rejects a hoisted function binding that shadows the tool bridge", async () => {
		const plan = await projectJavaScriptShadowPlan(`
await tool.read({ path: "secret.txt" });
function tool() {}
`);

		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("JavaScript tool binding changed");
	});

	it("rejects a hoisted class binding that shadows the tool bridge", async () => {
		const plan = await projectJavaScriptShadowPlan(`
await tool.read({ path: "secret.txt" });
class tool {}
`);

		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("JavaScript tool binding changed");
	});

	it("keeps safe independent operations before a later unsupported barrier", async () => {
		const plan = await projectJavaScriptShadowPlan('tool.read({ path: "safe" });\nunknownCall();');
		expect(plan.operations).toHaveLength(1);
		expect(plan.barrier?.reason).toBe("unsupported JavaScript statement");
	});
	it("rejects helper syntax that disables runtime instrumentation", async () => {
		const plan = await projectJavaScriptShadowPlan('await tool.read({ path: "a.txt" });\n__omp_with_call_site__();');
		expect(plan.operations).toEqual([]);
		expect(plan.barrier?.reason).toBe("JavaScript call-site helper present");

		const clean = await projectJavaScriptShadowPlan('await tool.read({ path: "a.txt" });');
		expect(clean.barrier).toBeUndefined();
		expect(clean.operations).toHaveLength(1);
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

	it("models destructured bindings as hoisted before a projected read", async () => {
		for (const declaration of [
			"const { path } = value;",
			"const [path] = parts;",
			"const { nested: { path } } = value;",
			"const { path = fallback } = value;",
		]) {
			const plan = await projectJavaScriptShadowPlan(`await tool.read({ path });\n${declaration}`, {
				snapshot: { path: "retained.txt" },
			});
			expect(plan.operations).toEqual([]);
		}
	});

	it("rejects a destructured binding that shadows the tool bridge", async () => {
		const plan = await projectJavaScriptShadowPlan(`const { tool } = bridges;\nawait tool.read({ path: "x" });`);
		expect(plan.barrier?.reason).toBe("JavaScript tool binding changed");
	});

	it("preserves loop-carried assignments across static iterations", async () => {
		const plan = await projectJavaScriptShadowPlan(
			`let path = "";\nfor (const part of ["a", "b"]) {\n  path = path + part;\n  await tool.read({ path });\n}`,
		);
		expect(plan.barrier).toBeUndefined();
		expect(plan.operations).toHaveLength(2);
		expect(plan.operations[0]?.call.args).toMatchObject({
			kind: "object",
			entries: [
				{
					key: "path",
					value: {
						kind: "concat",
						items: [
							{ kind: "literal", value: "" },
							{ kind: "literal", value: "a" },
						],
					},
				},
			],
		});
		// The second iteration must build on the first iteration's result ("ab"),
		// not the pre-loop value (which would project a stale "b" read).
		expect(plan.operations[1]?.call.args).toMatchObject({
			kind: "object",
			entries: [
				{
					key: "path",
					value: {
						kind: "concat",
						items: [{ kind: "concat" }, { kind: "literal", value: "b" }],
					},
				},
			],
		});
	});

	it("removes block-scoped loop bindings after the loop", async () => {
		const plan = await projectJavaScriptShadowPlan(
			`for (const path of ["secret.txt"]) {}\nawait tool.read({ path });`,
			{ snapshot: { path: "retained.txt" } },
		);
		expect(plan.operations).toEqual([]);
	});

	it("restores a shadowed outer binding after the loop", async () => {
		const plan = await projectJavaScriptShadowPlan(
			`let path = "outer";\nfor (const path of ["x"]) {}\nawait tool.read({ path });`,
		);
		expect(plan.barrier).toBeUndefined();
		expect(plan.operations).toHaveLength(1);
		expect(plan.operations[0]?.call.args).toMatchObject({
			kind: "object",
			entries: [{ key: "path", value: { kind: "literal", value: "outer" } }],
		});
	});

	it("rejects builtin transforms when retained cells replaced the intrinsic", async () => {
		const intact = {
			String: true,
			JSON: true,
			"JSON.stringify": true,
			"Array.prototype.join": true,
		};
		for (const [code, overridden] of [
			['await tool.read({ path: String("secret.txt") })', "String"],
			['await tool.read({ path: JSON.stringify({ path: "secret.txt" }) })', "JSON.stringify"],
			['await tool.read({ path: ["secret.txt"].join() })', "Array.prototype.join"],
		] as Array<[string, keyof typeof intact]>) {
			const plan = await projectJavaScriptShadowPlan(code, {
				snapshot: {},
				initialGlobals: { ...intact, [overridden]: false },
			});
			expect(plan.operations).toEqual([]);
		}
		const control = await projectJavaScriptShadowPlan('await tool.read({ path: String("note.txt") })', {
			snapshot: {},
			initialGlobals: intact,
		});
		expect(control.barrier).toBeUndefined();
		expect(control.operations).toHaveLength(1);
	});
	it("rejects tool reads when a retained cell replaced the bridge dispatcher", async () => {
		const intact = {
			String: true,
			JSON: true,
			"JSON.stringify": true,
			"Array.prototype.join": true,
			"Object.prototype.toString": true,
			__omp_call_tool__: true,
		};
		const control = await projectJavaScriptShadowPlan('await tool.read({ path: "note.txt" })', {
			snapshot: {},
			initialGlobals: intact,
		});
		expect(control.barrier).toBeUndefined();
		expect(control.operations).toHaveLength(1);
		// The prelude tool proxy resolves `__omp_call_tool__` per call, so a
		// poisoned installation must refuse admission even though the
		// syntactic `tool.read` match still looks intact.
		const spoofed = await projectJavaScriptShadowPlan('await tool.read({ path: "note.txt" })', {
			snapshot: {},
			initialGlobals: { ...intact, __omp_call_tool__: false },
		});
		expect(spoofed.operations).toEqual([]);
		expect(spoofed.barrier).toBeDefined();
	});
	it("rejects implicit coercion when retained cells replaced join or toString", async () => {
		const intact = {
			String: true,
			JSON: true,
			"JSON.stringify": true,
			"Array.prototype.join": true,
			"Object.prototype.toString": true,
			__omp_call_tool__: true,
		};
		// Pristine realm: array templates, snapshot templates, and plus-concat
		// all project from identical host/authoritative conversions.
		for (const code of [
			'await tool.read({ path: `${["secret.txt"]}` })',
			"await tool.read({ path: `${name}.txt` })",
			'await tool.read({ path: ["secret"] + ".txt" })',
		]) {
			const plan = await projectJavaScriptShadowPlan(code, {
				snapshot: { name: "secret" },
				initialGlobals: intact,
			});
			expect(plan.barrier).toBeUndefined();
			expect(plan.operations).toHaveLength(1);
		}
		// A replaced join changes what array coercions produce.
		for (const code of [
			'await tool.read({ path: `${["secret.txt"]}` })',
			'await tool.read({ path: ["secret"] + ".txt" })',
		]) {
			const plan = await projectJavaScriptShadowPlan(code, {
				snapshot: {},
				initialGlobals: { ...intact, "Array.prototype.join": false },
			});
			expect(plan.operations).toEqual([]);
			expect(plan.barrier).toBeDefined();
		}
		// Opaque snapshot values may reach `toString` (directly, or through
		// array elements), so they refuse without its flag too.
		const spoofed = await projectJavaScriptShadowPlan("await tool.read({ path: `${name}.txt` })", {
			snapshot: { name: "secret" },
			initialGlobals: { ...intact, "Object.prototype.toString": false },
		});
		expect(spoofed.operations).toEqual([]);
		expect(spoofed.barrier).toBeDefined();
	});
});
