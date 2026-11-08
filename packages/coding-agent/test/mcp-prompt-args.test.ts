/**
 * Contract: a prompt command's positional arguments are not dropped.
 *
 * The MCP prompt bridge used to build `prompts/get` arguments from `key=value` tokens only, so a
 * server that declares prompt `arguments` received a bare trailing word as a no-argument call: the
 * user typed `/server:prompt value`, the prompt got `{}`, and a prompt that reasonably refuses to
 * guess its subject answered by asking for the value the user had just typed. Claude Code already
 * maps leftover tokens onto the declared arguments in order; `mapPromptArguments` gives omp the same
 * behavior while keeping `key=value` spellings intact.
 */
import { describe, expect, it } from "bun:test";
import { mapPromptArguments } from "../src/mcp/prompt-args";

const declared = [{ name: "path" }, { name: "ref" }, { name: "depth" }];

describe("mapPromptArguments", () => {
	it("maps a bare word onto the first declared argument", () => {
		expect(mapPromptArguments(declared, ["src/app.ts"])).toEqual({ path: "src/app.ts" });
	});

	it("maps several positionals onto declared arguments in order", () => {
		expect(mapPromptArguments(declared, ["a", "b"])).toEqual({ path: "a", ref: "b" });
	});

	it("keeps key=value tokens under their own names", () => {
		expect(mapPromptArguments(declared, ["path=x"])).toEqual({ path: "x" });
		expect(mapPromptArguments(declared, ["depth=y"])).toEqual({ depth: "y" });
	});

	it("advances past a slot a key=value token already filled", () => {
		expect(mapPromptArguments(declared, ["path=a.ts", "main"])).toEqual({
			path: "a.ts",
			ref: "main",
		});
		expect(mapPromptArguments(declared, ["path=a.ts", "ref=main", "3"])).toEqual({
			path: "a.ts",
			ref: "main",
			depth: "3",
		});
	});

	it("never overwrites a name a key=value token set", () => {
		expect(mapPromptArguments(declared, ["ref=given", "first"])).toEqual({
			ref: "given",
			path: "first",
		});
	});

	it("forwards a declared argument named like an inherited property", () => {
		expect(mapPromptArguments([{ name: "toString" }], ["hello"])).toEqual({ toString: "hello" });
		const proto = mapPromptArguments([{ name: "__proto__" }], ["dotted"]);
		expect(Object.hasOwn(proto, "__proto__")).toBe(true);
		expect(proto["__proto__"]).toBe("dotted");
	});

	it("ignores positionals when the prompt declares no arguments", () => {
		expect(mapPromptArguments(undefined, ["a", "b"])).toEqual({});
		expect(mapPromptArguments([], ["a"])).toEqual({});
	});

	it("ignores positionals past the last declared argument", () => {
		expect(mapPromptArguments([{ name: "path" }], ["a", "b"])).toEqual({ path: "a" });
	});
});
