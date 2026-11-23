import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";

describe("cell syntax error position", () => {
	const hooks: RuntimeHooks = { onText: () => {}, onDisplay: () => {}, callTool: async () => undefined };
	let runtime: JsRuntime;

	beforeAll(() => {
		runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "syntax-error-position-test" });
	});

	afterAll(() => {
		runtime.dispose();
	});

	async function runError(code: string): Promise<unknown> {
		try {
			await runtime.run(code, undefined, hooks);
		} catch (error) {
			return error;
		}
		throw new Error("expected the cell to throw");
	}

	it("reports the cell line and column with a code frame for a raw backtick inside a template literal", async () => {
		const cell = [
			"const script = `#!/usr/bin/env bash",
			"now=`date +%s`",
			'echo "stamp: $now"',
			"`;",
			'await write("/tmp/t1.sh", script);',
			'"written"',
		].join("\n");
		const error = await runError(cell);
		expect(error).toBeInstanceOf(SyntaxError);
		expect((error as SyntaxError).message).toBe(
			[
				"Unexpected token (line 2, column 12)",
				"1 | const script = `#!/usr/bin/env bash",
				"2 | now=`date +%s`",
				"  |            ^",
			].join("\n"),
		);
	});

	it("keeps the position on the original cell when call-site instrumentation applies", async () => {
		const error = await runError('await tool.read({ path: "a.txt" });\nconst x = ;');
		expect(error).toBeInstanceOf(SyntaxError);
		expect((error as SyntaxError).message).toContain("(line 2, column 11)");
		expect((error as SyntaxError).message).toContain("2 | const x = ;");
	});

	it("reports a position for errors Babel recovers from", async () => {
		const error = await runError("break;");
		expect(error).toBeInstanceOf(SyntaxError);
		expect((error as SyntaxError).message).toBe(
			["Unsyntactic break. (line 1, column 1)", "1 | break;", "  | ^"].join("\n"),
		);
	});

	it("aligns the caret by terminal width after wide characters", async () => {
		const error = await runError("const 汉 = ;");
		expect(error).toBeInstanceOf(SyntaxError);
		// `汉` takes two terminal columns, so the caret pad is "const " (6) + 2 + " = " (3) = 11 spaces.
		expect((error as SyntaxError).message).toBe(
			["Unexpected token (line 1, column 11)", "1 | const 汉 = ;", `  | ${" ".repeat(11)}^`].join("\n"),
		);
	});

	it("keeps a runtime JSON.parse SyntaxError for sloppy-legal code Babel rejects as a module", async () => {
		const error = await runError('const package = "{"; JSON.parse(package)');
		expect(error).toBeInstanceOf(SyntaxError);
		expect((error as SyntaxError).message).not.toContain("line 1, column");
		expect((error as SyntaxError).message).not.toContain("reserved word");
	});

	it("keeps a plain runtime JSON.parse SyntaxError", async () => {
		const error = await runError('JSON.parse("{")');
		expect(error).toBeInstanceOf(SyntaxError);
		expect((error as SyntaxError).message).not.toContain("line 1, column");
	});

	it("keeps a runtime RegExp SyntaxError unchanged", async () => {
		const error = await runError('new RegExp("(")');
		expect(error).toBeInstanceOf(SyntaxError);
		expect((error as SyntaxError).message).not.toContain("line 1, column");
	});

	it("marks a truncated code frame line with an ellipsis on each cut side", async () => {
		const pad = "a".repeat(200);
		const middle = await runError(`const ${pad} = 1; const x = ; const ${pad} = 2;`);
		const frameLine = (middle as SyntaxError).message.split("\n")[1];
		expect(frameLine.startsWith("1 | …")).toBe(true);
		expect(frameLine.endsWith("…")).toBe(true);
		const tail = await runError(`const x = ; ${pad}`);
		const tailLine = (tail as SyntaxError).message.split("\n")[1];
		expect(tailLine.startsWith("1 | const x = ;")).toBe(true);
		expect(tailLine.endsWith("…")).toBe(true);
	});

	it("leaves valid cells unchanged", async () => {
		const cell = "const ok = `a$" + "{1 + 1}b`;\nok";
		expect(await runtime.run(cell, undefined, hooks)).toBe("a2b");
	});

	it("does not mask a runtime error thrown by a cell that parses", async () => {
		const error = await runError('throw new SyntaxError("from user code");');
		expect((error as SyntaxError).message).toBe("from user code");
	});
});
