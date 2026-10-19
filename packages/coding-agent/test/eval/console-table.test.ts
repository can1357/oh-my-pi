import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { EvalDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/types";

let runtime: JsRuntime;

function makeHooks(): {
	hooks: RuntimeHooks;
	texts: string[];
	displays: EvalDisplayOutput[];
} {
	const texts: string[] = [];
	const displays: EvalDisplayOutput[] = [];
	const hooks: RuntimeHooks = {
		onText: (chunk: string) => {
			texts.push(chunk);
		},
		onDisplay: (output: EvalDisplayOutput) => {
			displays.push(output);
		},
		callTool: async () => undefined,
	};
	return { hooks, texts, displays };
}

describe("console.table bridge", () => {
	beforeAll(() => {
		runtime = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "console-table-test",
		});
	});

	afterAll(() => {
		runtime.dispose();
	});

	it("renders an array of objects as an ASCII table on text output", async () => {
		const { hooks, texts } = makeHooks();
		await runtime.run("console.table([{ name: 'Ada', age: 36 }, { name: 'Linus', age: 54 }]);", undefined, hooks);
		expect(texts.length).toBe(1);
		const out = texts[0];
		// Box-drawing frame proves we routed through node:console.Console, not util.inspect.
		expect(out).toContain("┌");
		expect(out).toContain("(index)");
		expect(out).toContain("name");
		expect(out).toContain("age");
		expect(out).toContain("Ada");
		expect(out).toContain("Linus");
		expect(out.endsWith("\n")).toBe(true);
	});

	it("emits a table view of the rendered box, with numeric columns flagged", async () => {
		const { hooks, texts, displays } = makeHooks();
		await runtime.run(
			"console.table([{ name: 'Ada', score: -1.5e3 }, { name: 'Linus', score: NaN }, { name: 'Grace' }]);",
			undefined,
			hooks,
		);
		expect(displays).toHaveLength(1);
		const [output] = displays;
		if (output?.type !== "view") throw new Error("expected a table view");
		expect(texts.join("")).toContain(output.text);
		expect(output.view).toEqual({
			kind: "table",
			columns: [{ head: "", numeric: true }, { head: "name" }, { head: "score", numeric: true }],
			rows: [
				["0", "Ada", "-1500"],
				["1", "Linus", "NaN"],
				["2", "Grace", ""],
			],
		});
	});

	it("emits no view when the data is not tabular", async () => {
		const { hooks, texts, displays } = makeHooks();
		await runtime.run("console.table(5);", undefined, hooks);
		expect(texts.join("")).toBe("5\n");
		expect(displays).toEqual([]);
	});

	it("honors the optional columns filter", async () => {
		const { hooks, texts } = makeHooks();
		await runtime.run("console.table([{ name: 'Ada', age: 36, secret: 'hidden' }], ['name']);", undefined, hooks);
		const out = texts.join("");
		expect(out).toContain("name");
		expect(out).toContain("Ada");
		expect(out).not.toContain("secret");
		expect(out).not.toContain("hidden");
		expect(out).not.toContain("age");
	});
});
