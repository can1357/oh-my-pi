import { describe, expect, it } from "bun:test";
import { formatJuliaForDisplay } from "@oh-my-pi/pi-coding-agent/tools/eval-format/julia";

describe("formatJuliaForDisplay", () => {
	it("expands genuinely compact nested blocks", () => {
		const source =
			"module Demo;function classify(xs);for x in xs;if x > 0;println(x);else;map(xs) do y;println(y);end;end;end;end;end";

		expect(formatJuliaForDisplay(source)).toBe(
			[
				"module Demo;",
				"    function classify(xs);",
				"        for x in xs;",
				"            if x > 0;",
				"                println(x);",
				"            else;",
				"                map(xs) do y;",
				"                    println(y);",
				"                end;",
				"            end;",
				"        end;",
				"    end;",
				"end",
			].join("\n"),
		);
	});

	it("leaves separators and block words inside literals and comments untouched", () => {
		const source =
			String.raw`function demo();text = "if; end \"quoted; else\" $(join(["catch;", "finally"], ";"))";mark = ';';hash = '#';# elseif; end` +
			"\n#= outer; #= inner; end =# catch =#;return text;end";

		expect(formatJuliaForDisplay(source)).toBe(
			[
				"function demo();",
				String.raw`    text = "if; end \"quoted; else\" $(join(["catch;", "finally"], ";"))";`,
				"    mark = ';';",
				"    hash = '#';",
				"    # elseif; end",
				"    #= outer; #= inner; end =# catch =#;",
				"    return text;",
				"end",
			].join("\n"),
		);
	});

	it("aligns branches around nested begin and try blocks", () => {
		const source =
			"try;value = begin;if ready;1;elseif waiting;2;else;3;end;end;catch err;handle(err);finally;cleanup();end";

		expect(formatJuliaForDisplay(source)).toBe(
			[
				"try;",
				"    value = begin;",
				"        if ready;",
				"            1;",
				"        elseif waiting;",
				"            2;",
				"        else;",
				"            3;",
				"        end;",
				"    end;",
				"catch err;",
				"    handle(err);",
				"finally;",
				"    cleanup();",
				"end",
			].join("\n"),
		);
	});

	it("formats unfinished triple-string, nested-comment, and block prefixes without closing them", () => {
		const prefixes = [
			{
				source: 'function f();text = """if; end\nstill',
				expected: 'function f();\n    text = """if; end\nstill',
			},
			{
				source: "if ready;#= outer; #= inner; end",
				expected: "if ready;\n    #= outer; #= inner; end",
			},
			{
				source: "module Prefix;function run();if ready;work()",
				expected: "module Prefix;\n    function run();\n        if ready;\n            work()",
			},
		];

		for (const prefix of prefixes) {
			expect(() => formatJuliaForDisplay(prefix.source)).not.toThrow();
			expect(formatJuliaForDisplay(prefix.source)).toBe(prefix.expected);
		}
	});

	it("is idempotent", () => {
		const compact =
			"baremodule Stable;mutable struct Box;value;end;function run(box);if box.value > 0;box.value;else;0;end;end;end";
		const formatted = formatJuliaForDisplay(compact);

		expect(formatJuliaForDisplay(formatted)).toBe(formatted);
	});

	it("never changes committed lines while a source prefix grows", () => {
		const source =
			`function stream();if ready;message = "end; $(join(["a;b"], ";"))";` +
			"\n#= outer #= ; end =# catch =#\nwork();else;wait();end;end";
		let prefix = "";
		let committed = "";

		for (const character of source) {
			prefix += character;
			const formatted = formatJuliaForDisplay(prefix);
			expect(formatted.startsWith(committed)).toBe(true);
			const lastNewline = formatted.lastIndexOf("\n");
			if (lastNewline >= 0) committed = formatted.slice(0, lastNewline + 1);
		}
	});
});
