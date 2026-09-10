import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describeToolLoadFailure, loadCustomTools } from "../../src/extensibility/custom-tools/loader";

let tempRoot: string | undefined;

afterEach(async () => {
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

async function writeTool(name: string, source: string): Promise<string> {
	tempRoot ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-custom-tool-load-errors-"));
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

/**
 * Recurses until the engine gives up, reproducing the shape of #8900.
 *
 * Two details keep this deterministic rather than fatal to the test runner:
 *
 * 1. The recursive call must stay OUT of tail position. A bare
 *    `return recurse();` is a proper tail call, and since ES modules are
 *    always strict mode JavaScriptCore reuses the frame instead of pushing
 *    one -- the fixture then spins forever rather than throwing. Consuming
 *    the result (`... + 1`) forces the frame to be kept.
 * 2. The depth cap is a hard backstop. A synchronous spin blocks the JS
 *    thread, so neither bun's per-test timeout nor the runner's
 *    `--timeout=30000` can preempt it; only the 600s chunk watchdog can,
 *    by killing the whole chunk. The cap sits far above the real
 *    exhaustion depth, so in practice the engine's own RangeError wins.
 */
const STACK_OVERFLOW_SOURCE = [
	"function recurse(depth) {",
	'\tif (depth > 1e7) throw new RangeError("Maximum call stack size exceeded");',
	"\treturn recurse(depth + 1) + 1;",
	"}",
	"recurse(0);",
].join("\n");

describe("custom tool load error reporting (#8900)", () => {
	it("names the offending file and explains a blown stack at import time", async () => {
		// The reporter saw a bare `RangeError: Maximum call stack size exceeded`
		// with no path and no cause; the only record of which module was at fault
		// lived in ~/.omp/logs/omp*.log.
		const overflowTool = await writeTool("stack-overflow.js", STACK_OVERFLOW_SOURCE);
		const validTool = await writeTool("valid.js", VALID_TOOL_SOURCE);

		const result = await loadCustomTools([{ path: overflowTool }, { path: validTool }], requireTempRoot(), []);

		// Fault isolation still holds: the good tool loads.
		expect(result.tools.map(tool => tool.tool.name)).toEqual(["safe_custom_tool"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.path).toBe(overflowTool);

		const message = result.errors[0]?.error ?? "";
		expect(message).toContain(overflowTool);
		expect(message).toContain("import type");
		expect(message).toContain("@oh-my-pi/pi-coding-agent");
	});

	it("reports the resolved absolute path when the configured path is relative", async () => {
		const absolutePath = await writeTool("relative-fail.js", 'throw new Error("module blew up");');
		const cwd = requireTempRoot();

		const result = await loadCustomTools([{ path: "./relative-fail.js" }], cwd, []);

		expect(result.tools).toEqual([]);
		expect(result.errors).toHaveLength(1);
		// `path` stays as configured so callers can still match their own input...
		expect(result.errors[0]?.path).toBe("./relative-fail.js");
		// ...but the message has to name the file that actually failed.
		const message = result.errors[0]?.error ?? "";
		expect(message).toContain("./relative-fail.js");
		expect(message).toContain(absolutePath);
		expect(message).toContain("module blew up");
	});

	it("does not attach the self-import hint to unrelated load failures", async () => {
		const brokenTool = await writeTool("ordinary-failure.js", 'throw new Error("missing API key");');

		const result = await loadCustomTools([{ path: brokenTool }], requireTempRoot(), []);

		const message = result.errors[0]?.error ?? "";
		expect(message).toContain(brokenTool);
		expect(message).toContain("missing API key");
		expect(message).not.toContain("import type");
	});

	it("still names the file when the module throws a non-Error value", async () => {
		const throwingTool = await writeTool("non-error-throw.js", 'throw "plain string failure";');

		const result = await loadCustomTools([{ path: throwingTool }], requireTempRoot(), []);

		expect(result.errors).toHaveLength(1);
		const message = result.errors[0]?.error ?? "";
		expect(message).toContain(throwingTool);
		expect(message).toContain("plain string failure");
	});

	describe("describeToolLoadFailure", () => {
		it("collapses to a single path when the configured path is already absolute", () => {
			const message = describeToolLoadFailure(new Error("boom"), "/abs/tool.ts", "/abs/tool.ts");
			expect(message).toBe("Failed to load tool /abs/tool.ts: boom");
		});

		it("classifies every engine wording for an exhausted stack", () => {
			for (const wording of [
				"Maximum call stack size exceeded",
				"Maximum call stack size exceeded.",
				"too much recursion",
				"stack overflow",
			]) {
				const message = describeToolLoadFailure(new RangeError(wording), "/abs/tool.ts", "/abs/tool.ts");
				expect(message).toContain(wording);
				expect(message).toContain("import type");
			}
		});

		it("substitutes a descriptor for an error carrying no message", () => {
			expect(describeToolLoadFailure(new TypeError(""), "/abs/tool.ts", "/abs/tool.ts")).toBe(
				"Failed to load tool /abs/tool.ts: TypeError with no message",
			);
			expect(describeToolLoadFailure("   ", "/abs/tool.ts", "/abs/tool.ts")).toBe(
				"Failed to load tool /abs/tool.ts: string with no message",
			);
		});

		it("survives null and undefined throws", () => {
			expect(describeToolLoadFailure(null, "/abs/tool.ts", "/abs/tool.ts")).toBe(
				"Failed to load tool /abs/tool.ts: null",
			);
			expect(describeToolLoadFailure(undefined, "/abs/tool.ts", "/abs/tool.ts")).toBe(
				"Failed to load tool /abs/tool.ts: undefined",
			);
		});
	});
});
