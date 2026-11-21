import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { EvalDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/types";

let runtime: JsRuntime;
const cellGlobals = ["found", "ompEchoItems", "ompA", "ompEchoParen", "ompEchoAfter", "await"];
const savedCellGlobals = new Map(cellGlobals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

function collect(): {
	hooks: RuntimeHooks;
	displays: EvalDisplayOutput[];
	texts: string[];
} {
	const displays: EvalDisplayOutput[] = [];
	const texts: string[] = [];
	const hooks: RuntimeHooks = {
		onText: (chunk: string) => {
			texts.push(chunk);
		},
		onDisplay: (output: EvalDisplayOutput) => {
			displays.push(output);
		},
		callTool: async () => undefined,
	};
	return { hooks, displays, texts };
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");
const PNG_IMAGE: ImageContent = { type: "image", data: PNG_BASE64, mimeType: "image/png" };

describe("JS console output", () => {
	beforeAll(() => {
		runtime = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "console-output-test",
		});
	});

	afterAll(() => {
		runtime.dispose();
		for (const [name, descriptor] of savedCellGlobals) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	});

	it("prints a long plain object as inspect text and a JSON view of that exact text", async () => {
		const { hooks, displays, texts } = collect();
		await runtime.run(
			"console.log('rows:', { items: Array.from({ length: 12 }, (_, i) => ({ id: i })), total: 12n });",
			undefined,
			hooks,
		);
		const printed = texts.join("");
		expect(printed.startsWith("rows: {")).toBe(true);
		expect(displays).toHaveLength(1);
		const [output] = displays;
		if (output?.type !== "view") throw new Error("expected a JSON view");
		expect(printed).toContain(output.text);
		expect(output.text.startsWith("{")).toBe(true);
		expect(output.view).toEqual({
			kind: "json",
			value: { items: Array.from({ length: 12 }, (_, i) => ({ id: i })), total: "12" },
		});
	});

	it("prints JSON text as text plus a JSON view, other long strings as text only", async () => {
		const { hooks, displays, texts } = collect();
		const value = { items: Array.from({ length: 30 }, (_, i) => i) };
		const text = JSON.stringify(value);
		await runtime.run(`console.log(${JSON.stringify(text)}); console.log('{' + 'x'.repeat(100));`, undefined, hooks);
		expect(texts.join("")).toBe(`${text}\n{${"x".repeat(100)}\n`);
		expect(displays).toEqual([{ type: "view", text, view: { kind: "json", value } }]);
	});

	it("keeps short objects and class instances as text only", async () => {
		const { hooks, displays, texts } = collect();
		await runtime.run(
			"console.log({ a: 1 }); console.log(new Map(Array.from({ length: 20 }, (_, i) => [i, 'value']))); ",
			undefined,
			hooks,
		);
		expect(texts[0]).toBe("{ a: 1 }\n");
		expect(displays).toEqual([]);
	});

	it("echoes a final expression exactly as console.log does", async () => {
		const value = "({ nested: { list: Array.from({ length: 30 }, (_, i) => i) }, label: 'x' })";
		const logged = collect();
		await runtime.run(`console.log(${value});`, undefined, logged.hooks);
		const echoed = collect();
		runtime.echo(await runtime.run(value, undefined, echoed.hooks), echoed.hooks);
		expect(echoed.texts).toEqual(logged.texts);
		expect(echoed.displays).toEqual(logged.displays);
		expect(echoed.displays[0]?.type).toBe("view");

		const nothing = collect();
		runtime.echo(undefined, nothing.hooks);
		expect(nothing.texts).toEqual([]);
		expect(nothing.displays).toEqual([]);
	});

	it.each([
		["a trailing assignment", "const found = [1, 2, 3]; globalThis.ompEchoItems = found;"],
		["a trailing block statement", "if (true) { 42; }"],
		["a destructuring assignment in its required parentheses", "let ompA; ({ a: ompA } = { a: 1, b: 2 });"],
		["a trailing sequence of assignments", "globalThis.ompEchoItems = 1, globalThis.ompA = 2"],
		["an expression followed by a declaration", "42; const ompEchoAfter = 1;"],
		["an assigned promise", "globalThis.ompEchoItems = Promise.resolve(42)"],
		["an async-wrapped assigned promise", "await 0; globalThis.ompEchoItems = Promise.resolve(42)"],
	])("returns nothing for %s", async (_label, code) => {
		const { hooks } = collect();
		expect(await runtime.run(code, undefined, hooks)).toBeUndefined();
	});

	it("still returns a parenthesized assignment, a string-only cell and a top-level return before the end", async () => {
		const { hooks } = collect();
		expect(await runtime.run("(globalThis.ompEchoParen = 9)", undefined, hooks)).toBe(9);
		expect(await runtime.run('"hello"', undefined, hooks)).toBe("hello");
		expect(await runtime.run("(globalThis.ompEchoItems = 1, globalThis.ompA = 2)", undefined, hooks)).toBe(2);
		expect(await runtime.run("globalThis.ompEchoItems = 1, 3", undefined, hooks)).toBe(3);
		expect(await runtime.run("await 0; if (true) return 7; const ompEchoAfter = 1;", undefined, hooks)).toBe(7);
	});

	it("preserves the engine completion when parsing cannot classify a valid sloppy script", async () => {
		const { hooks } = collect();
		await runtime.run("globalThis.await = 2", undefined, hooks);
		expect(await runtime.run("await", undefined, hooks)).toBe(2);
	});

	it.each(["", "await 0; "])("reports rejected assigned promises as run errors with prefix %j", async prefix => {
		const { hooks } = collect();
		await expect(
			runtime.run(
				`${prefix}globalThis.ompEchoItems = Promise.reject(new Error('assignment failed'))`,
				undefined,
				hooks,
			),
		).rejects.toThrow("assignment failed");
	});

	it("prints an image record as a placeholder and emits the image with its metadata", async () => {
		const { hooks, displays, texts } = collect();
		runtime.echo({ ...PNG_IMAGE, detail: "high", url: "https://images.example/a.png" }, hooks);
		expect(texts).toEqual(["<image image/png>\n"]);
		expect(displays).toEqual([
			{
				type: "image",
				data: PNG_BASE64,
				mimeType: "image/png",
				detail: "high",
				url: "https://images.example/a.png",
			},
		]);
	});

	it.each<[string, unknown]>([
		["Uint8Array", PNG_BYTES],
		["ArrayBuffer", PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength)],
		// The puppeteer footgun: `uint8array.toString("base64")` falls through to Array.toString.
		["decimal CSV", Array.from(PNG_BYTES).toString()],
		["JSON-serialized Buffer", JSON.parse(JSON.stringify(Buffer.from(PNG_BYTES)))],
	])("base64-encodes %s image data", (_label, data) => {
		const { hooks, displays } = collect();
		runtime.echo({ type: "image", data, mimeType: "image/png" }, hooks);
		expect(displays).toEqual([PNG_IMAGE]);
	});

	it("prints records whose image data is unusable as plain text", () => {
		// Padding mid-string is not strict base64; the Anthropic API rejects it.
		for (const data of [{ not: "a buffer" }, "abcd=efg"]) {
			const { hooks, displays, texts } = collect();
			runtime.echo({ type: "image", data, mimeType: "image/png" }, hooks);
			expect(displays).toEqual([]);
			expect(texts.join("")).toContain("type: 'image'");
		}
	});
});
