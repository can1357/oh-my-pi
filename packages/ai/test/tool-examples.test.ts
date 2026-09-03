import { describe, expect, it } from "bun:test";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { renderToolExamples } from "../src/dialect/examples";
import type { InbandTool } from "../src/dialect/types";

describe("renderToolExamples", () => {
	it("renders call examples as Python keyword calls", () => {
		const tool: InbandTool = {
			name: "find",
			description: "Find files.",
			parameters: {
				type: "object",
				properties: {
					paths: { type: "array", items: { type: "string" } },
				},
				required: ["paths"],
			},
			examples: [
				{
					caption: "Find files",
					call: { paths: ["src/**/*.ts"] },
				},
			],
		};

		const rendered = renderToolExamples(tool);
		expect(rendered).toContain("<examples>");
		expect(rendered).toContain("# Find files");
		expect(rendered).toContain('find(paths=["src/**/*.ts"])');
		expect(rendered).toContain("</examples>");
	});

	it("renders Python literals for booleans, null, numbers, and nested objects", () => {
		const tool: InbandTool = {
			name: "irc",
			description: "IRC.",
			parameters: {
				type: "object",
				properties: {
					op: { type: "string" },
					opts: { type: "object" },
					limit: { type: "number" },
				},
				required: ["op"],
			},
			examples: [
				{
					caption: "Broadcast",
					call: { op: "send", opts: { all: true, from: null }, limit: 5 },
				},
			],
		};

		const rendered = renderToolExamples(tool);
		expect(rendered).toContain('irc(op="send", opts={"all": True, "from": None}, limit=5)');
	});

	it("renders multiline string args as verbatim triple-quoted blocks", () => {
		const tool: InbandTool = {
			name: "edit",
			description: "Edit files.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, input: { type: "string" } },
				required: ["path", "input"],
			},
			examples: [{ caption: "Patch", call: { path: "a.py", input: "[a.py#A1B2]\nPUT 1.=1:\n+x = 1\n" } }],
		};

		const rendered = renderToolExamples(tool);
		expect(rendered).toContain('edit(path="a.py", input="""[a.py#A1B2]\nPUT 1.=1:\n+x = 1\n""")');
	});

	it("falls back to escaped literals when multiline content collides with the fence", () => {
		const tool: InbandTool = {
			name: "write",
			description: "Write files.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			},
			examples: [{ caption: "Fence collision", call: { path: "a.py", content: 'a = """doc"""\nb = 2' } }],
		};

		const rendered = renderToolExamples(tool);
		expect(rendered).toContain('write(path="a.py", content="a = \\"\\"\\"doc\\"\\"\\"\\nb = 2")');
	});

	it("renders a sole string argument as the bare value", () => {
		const tool: InbandTool = {
			name: "bash",
			description: "Runs commands.",
			parameters: {
				type: "object",
				properties: { command: { type: "string" }, timeout: { type: "number" } },
				required: ["command"],
			},
			examples: [{ caption: "Count lines", call: { command: "wc -l src/*.ts | sort -n" } }],
		};

		const rendered = renderToolExamples(tool, INTENT_FIELD);
		// Payload stays bare; the required intent field rides on the envelope.
		expect(rendered).toContain(`<example ${INTENT_FIELD}="…">\nwc -l src/*.ts | sort -n\n</example>`);
		expect(rendered).not.toContain("bash(");
	});

	it("keeps call syntax when the sole argument is not a string", () => {
		const tool: InbandTool = {
			name: "glob",
			description: "Globs files.",
			parameters: {
				type: "object",
				properties: { paths: { type: "array", items: { type: "string" } } },
				required: ["paths"],
			},
			examples: [{ call: { paths: ["src/**/*.ts"] } }],
		};

		expect(renderToolExamples(tool)).toContain('glob(paths=["src/**/*.ts"])');
	});

	it("returns empty string for empty examples", () => {
		const tool: InbandTool = {
			name: "find",
			description: "Find files.",
			parameters: { type: "object", properties: {} },
			examples: [],
		};

		expect(renderToolExamples(tool)).toBe("");
	});

	it("renders compare examples with WRONG and RIGHT", () => {
		const tool: InbandTool = {
			name: "find",
			description: "Find files.",
			parameters: {
				type: "object",
				properties: {
					paths: { type: "array", items: { type: "string" } },
				},
				required: ["paths"],
			},
			examples: [
				{
					caption: "Avoid broad scans",
					bad: { paths: ["**/*.ts"] },
					good: { paths: ["src/**/*.ts"] },
				},
			],
		};

		const rendered = renderToolExamples(tool);
		expect(rendered).toContain("WRONG:");
		expect(rendered).toContain("RIGHT:");
		expect(rendered).toContain('find(paths=["**/*.ts"])');
		expect(rendered).toContain('find(paths=["src/**/*.ts"])');
	});

	it("injects the intent-field placeholder when intentField is provided", () => {
		const tool: InbandTool = {
			name: "find",
			description: "Find files.",
			parameters: {
				type: "object",
				properties: {
					[INTENT_FIELD]: { type: "string" },
					paths: { type: "array", items: { type: "string" } },
				},
				required: [INTENT_FIELD, "paths"],
			},
			examples: [
				{
					caption: "Find files",
					call: { paths: ["src/**/*.ts"] },
				},
			],
		};

		const rendered = renderToolExamples(tool, INTENT_FIELD);
		expect(rendered).toContain(`${INTENT_FIELD}="…"`);
		// Placeholder leads the args, matching schema-injection order.
		expect(rendered.indexOf(`${INTENT_FIELD}=`)).toBeLessThan(rendered.indexOf("paths="));
	});

	it("omits the intent-field placeholder when intentField is undefined", () => {
		const tool: InbandTool = {
			name: "find",
			description: "Find files.",
			parameters: {
				type: "object",
				properties: { paths: { type: "array", items: { type: "string" } } },
				required: ["paths"],
			},
			examples: [{ caption: "Find files", call: { paths: ["src/**/*.ts"] } }],
		};

		expect(renderToolExamples(tool)).not.toContain(`${INTENT_FIELD}=`);
	});
});
