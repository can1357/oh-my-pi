import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { loadCustomTools, type ToolPathWithSource } from "../../src/extensibility/custom-tools/loader";

let tempRoot: string | undefined;

afterEach(async () => {
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

async function writeTool(name: string, source: string): Promise<string> {
	tempRoot ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-custom-tool-loader-"));
	const filePath = path.join(tempRoot, name);
	await Bun.write(filePath, source);
	return filePath;
}

function requireTempRoot(): string {
	if (!tempRoot) throw new Error("Temporary custom tool root was not created.");
	return tempRoot;
}

const VALID_TOOL_SOURCE = [
	"export default api => ({",
	'\tname: "safe_custom_tool",',
	'\tlabel: "Safe Custom Tool",',
	'\tdescription: "Returns a fixed response",',
	"\tparameters: api.arktype({}),",
	"\tasync execute() {",
	'\t\treturn { content: [{ type: "text", text: "ok" }] };',
	"\t},",
	"});",
].join("\n");

const TEST_SOURCE: NonNullable<ToolPathWithSource["source"]> = {
	provider: "plugin",
	providerName: "Regression Plugin",
	level: "user",
};

const ARRAY_WITH_NULL_SOURCE = ["export default () => [null];"].join("\n");

const MIXED_ARRAY_SOURCE = [
	"export default api => [",
	"\t{",
	'\t\tname: "mixed_valid_tool",',
	'\t\tlabel: "Mixed Valid Tool",',
	'\t\tdescription: "Returns a fixed response from a mixed tool factory result",',
	"\t\tparameters: api.arktype({}),",
	"\t\tasync execute() {",
	'\t\t\treturn { content: [{ type: "text", text: "ok" }] };',
	"\t\t},",
	"\t},",
	"\tnull,",
	"];",
].join("\n");

const MISSING_NAME_SOURCE = [
	"export default api => ({",
	'\tdescription: "Missing name but otherwise loadable shape",',
	"\tparameters: api.arktype({}),",
	"\tasync execute() {",
	'\t\treturn { content: [{ type: "text", text: "ok" }] };',
	"\t},",
	"});",
].join("\n");

describe("custom tool loader", () => {
	it("injects callable omptype-backed zod schemas through validation and wire emission", async () => {
		const toolPath = await writeTool(
			"zod-wire.js",
			[
				"export default api => ({",
				'\tname: "zod_wire_tool",',
				'\t\tdescription: "Validates an injected schema",',
				'\tparameters: api.arktype({ path: api.arktype("string") }),',
				"\tasync execute() {",
				'\t\treturn { content: [{ type: "text", text: "ok" }] };',
				"\t},",
				"});",
			].join("\n"),
		);
		const result = await loadCustomTools([{ path: toolPath }], requireTempRoot(), []);
		const tool = result.tools[0]?.tool;

		expect(result.errors).toEqual([]);
		expect(tool).toBeDefined();
		expect(
			validateToolArguments(tool!, {
				type: "toolCall",
				id: "valid",
				name: tool!.name,
				arguments: { path: "README.md" },
			}),
		).toEqual({ path: "README.md" });
		expect(() =>
			validateToolArguments(tool!, {
				type: "toolCall",
				id: "invalid",
				name: tool!.name,
				arguments: {},
			}),
		).toThrow('Validation failed for tool "zod_wire_tool"');
		expect(toolWireSchema(tool!)).toMatchObject({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});
	});

	it("skips a tool that calls process.exit synchronously at import time and still loads later valid tools", async () => {
		// CLI-shaped module: main() at the bottom, exit on failure (issue #1704).
		// Without the exit guard this terminates the test process before the
		// assertions run.
		const exitingTool = await writeTool(
			"sync-exit.js",
			[
				"function main() {",
				"\ttry {",
				"\t\tdoWork();",
				"\t} catch {",
				"\t\tprocess.exit(1);",
				"\t}",
				"}",
				"main();",
			].join("\n"),
		);
		const validTool = await writeTool("valid.js", VALID_TOOL_SOURCE);

		const result = await loadCustomTools([{ path: exitingTool }, { path: validTool }], requireTempRoot(), []);

		expect(result.tools.map(tool => tool.tool.name)).toEqual(["safe_custom_tool"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.path).toBe(exitingTool);
		expect(result.errors[0]?.error).toContain("process.exit(1)");
	});

	it("skips a tool whose factory calls process.exit and still loads later valid tools", async () => {
		const factoryExitTool = await writeTool(
			"factory-exit.js",
			["export default () => {", "\tprocess.exit(3);", "};"].join("\n"),
		);
		const validTool = await writeTool("valid.js", VALID_TOOL_SOURCE);

		const result = await loadCustomTools([{ path: factoryExitTool }, { path: validTool }], requireTempRoot(), []);

		expect(result.tools.map(tool => tool.tool.name)).toEqual(["safe_custom_tool"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.path).toBe(factoryExitTool);
		expect(result.errors[0]?.error).toContain("process.exit(3)");
	});

	it("reports a null array entry instead of throwing", async () => {
		const nullArrayTool = await writeTool("null-array.js", ARRAY_WITH_NULL_SOURCE);

		const result = await loadCustomTools([{ path: nullArrayTool, source: TEST_SOURCE }], requireTempRoot(), []);

		expect(result.tools).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({
			path: nullArrayTool,
			source: TEST_SOURCE,
		});
		expect(result.errors[0]?.error.toLowerCase()).toContain("invalid");
		expect(result.errors[0]?.error).toContain("index 0");
	});

	it("reports a tool entry missing a name instead of throwing", async () => {
		const missingNameTool = await writeTool("missing-name.js", MISSING_NAME_SOURCE);

		const loadResult = loadCustomTools([{ path: missingNameTool, source: TEST_SOURCE }], requireTempRoot(), []);
		await expect(loadResult).resolves.toMatchObject({
			tools: [],
			errors: [
				{
					path: missingNameTool,
					source: TEST_SOURCE,
				},
			],
		});
		const result = await loadResult;

		expect(result.tools).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({
			path: missingNameTool,
			source: TEST_SOURCE,
		});
		expect(result.errors[0]?.error.toLowerCase()).toContain("invalid");
		expect(result.errors[0]?.error).toContain("index 0");
		expect(result.errors[0]?.error).toContain("string name");
	});

	it("keeps valid tools from a mixed array and reports the null entry", async () => {
		const mixedArrayTool = await writeTool("mixed-array.js", MIXED_ARRAY_SOURCE);

		const result = await loadCustomTools([{ path: mixedArrayTool, source: TEST_SOURCE }], requireTempRoot(), []);

		expect(result.tools.map(tool => tool.tool.name)).toEqual(["mixed_valid_tool"]);
		expect(result.tools[0]).toMatchObject({
			path: mixedArrayTool,
			source: TEST_SOURCE,
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({
			path: mixedArrayTool,
			source: TEST_SOURCE,
		});
		expect(result.errors[0]?.error.toLowerCase()).toContain("invalid");
		expect(result.errors[0]?.error).toContain("index 1");
	});

	it("restores host stdin after a tool hijacks it at import time (#5618)", async () => {
		// A ~/.claude/tools MCP server attaches a stdin consumer at module top
		// level (a bare `resume()` here stands in for `new StdioServerTransport()`).
		// Without the stdin guard this steals Bun's single stdin reader and the
		// TUI goes permanently deaf after one keypress. The tool also exports a
		// valid default, so the guard must restore stdin on the success path too.
		const hijackTool = await writeTool(
			"stdin-hijack.js",
			[
				'process.stdin.on("data", () => {});',
				"process.stdin.resume();",
				"export default api => ({",
				'\tname: "stdin_hijack_tool",',
				'\tdescription: "Loads fine but hijacks stdin at import",',
				"\tparameters: api.arktype({}),",
				"\tasync execute() {",
				'\t\treturn { content: [{ type: "text", text: "ok" }] };',
				"\t},",
				"});",
			].join("\n"),
		);

		const dataBefore = process.stdin.listenerCount("data");
		const pausedBefore = process.stdin.isPaused();
		try {
			const result = await loadCustomTools([{ path: hijackTool }], requireTempRoot(), []);
			expect(result.tools.map(tool => tool.tool.name)).toEqual(["stdin_hijack_tool"]);
			expect(process.stdin.listenerCount("data")).toBe(dataBefore);
			expect(process.stdin.isPaused()).toBe(pausedBefore);
		} finally {
			// Defensive: if the guard regressed and leaked a listener, drop the
			// extras so this test cannot poison later files in the suite.
			const leaked = process.stdin.listeners("data").slice(dataBefore);
			for (const listener of leaked) {
				process.stdin.removeListener("data", listener as (...args: unknown[]) => void);
			}
			if (pausedBefore && !process.stdin.isPaused()) process.stdin.pause();
		}
	});

	it("resumes host stdin when a tool pauses it at import time", async () => {
		const pausedBefore = process.stdin.isPaused();
		if (pausedBefore) process.stdin.resume();
		const pauseTool = await writeTool(
			"stdin-pause.js",
			[
				"process.stdin.pause();",
				"export default api => ({",
				'\tname: "stdin_pause_tool",',
				'\tdescription: "Pauses host stdin at import",',
				"\tparameters: api.arktype({}),",
				"\tasync execute() {",
				'\t\treturn { content: [{ type: "text", text: "ok" }] };',
				"\t},",
				"});",
			].join("\n"),
		);
		try {
			const result = await loadCustomTools([{ path: pauseTool }], requireTempRoot(), []);
			expect(result.tools.map(tool => tool.tool.name)).toEqual(["stdin_pause_tool"]);
			expect(process.stdin.isPaused()).toBeFalse();
		} finally {
			if (pausedBefore) process.stdin.pause();
			else process.stdin.resume();
		}
	});

	it("reinstates a host stdin listener a tool removes at import time (#5744)", async () => {
		// A tool factory that calls process.stdin.removeAllListeners("data")
		// during (re)load — e.g. a subagent re-running preloaded factories while
		// the parent TUI is live — must not permanently strip ProcessTerminal's
		// input handler. The guard reconciles stdin back to the pre-load snapshot,
		// reinstating any listener the module removed.
		const stripTool = await writeTool(
			"stdin-strip.js",
			[
				'process.stdin.removeAllListeners("data");',
				"export default api => ({",
				'\tname: "stdin_strip_tool",',
				'\tdescription: "Removes host data listeners at import",',
				"\tparameters: api.arktype({}),",
				"\tasync execute() {",
				'\t\treturn { content: [{ type: "text", text: "ok" }] };',
				"\t},",
				"});",
			].join("\n"),
		);

		const hostListener = (): void => {};
		process.stdin.on("data", hostListener);
		const dataBefore = process.stdin.listenerCount("data");
		try {
			const result = await loadCustomTools([{ path: stripTool }], requireTempRoot(), []);
			expect(result.tools.map(tool => tool.tool.name)).toEqual(["stdin_strip_tool"]);
			expect(process.stdin.listenerCount("data")).toBe(dataBefore);
			expect(process.stdin.listeners("data")).toContain(hostListener);
		} finally {
			process.stdin.removeListener("data", hostListener);
		}
	});
});
