import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { formatCellError } from "@oh-my-pi/pi-coding-agent/eval/js/error-text";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/** The checkout this test runs from; every frame under it is omp's own code or one of its dependencies. */
const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");

const failingPrelude: EvalPreludeDefinition = {
	name: "fixture",
	documentation: "fixture",
	javascript: `{ globalThis.fixture = { invoke: parameters => __omp_prelude__("fixture", parameters) }; }`,
	python: "",
	exports: ["fixture"],
	async invoke() {
		throw new Error("host helper failed");
	},
};

function session(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getEvalPreludes: () => [failingPrelude],
	};
}

describe("uncaught JavaScript cell errors", () => {
	afterAll(async () => {
		await disposeAllVmContexts();
	});

	const options = { cwd: process.cwd(), sessionId: `js-error-text-${crypto.randomUUID()}`, session: session() };

	it("print the message and the cell's own frames, not omp's", async () => {
		const result = await executeJs(
			["function inner() {", '  throw new Error("boom");', "}", "inner();"].join("\n"),
			options,
		);
		expect(result.exitCode).toBe(1);
		expect(result.output).toStartWith("Error: boom\n");
		const shown = result.output.split("\n").filter(line => /^\s+at /.test(line));
		expect(shown.length).toBeGreaterThan(0);
		for (const frame of shown) expect(frame).toMatch(/\(js-cell-[0-9a-f-]+\.js:\d+:\d+\)$/);
		expect(result.output).not.toContain(REPO_ROOT);
		expect(result.output).toMatch(
			/\n {4}\(\d+ omp frames? hidden; catch the error and print e\.stack to see them\)$/,
		);
	});

	it("print a bridged helper's failure with the cell it came from, not the host stack", async () => {
		const result = await executeJs("await fixture.invoke({});", options);
		expect(result.exitCode).toBe(1);
		expect(result.output).toStartWith("Error: host helper failed\n");
		expect(result.output.split("\n").filter(line => /^\s+at /.test(line))).toEqual([
			expect.stringMatching(/^ {4}at fixture \(js-cell-[0-9a-f-]+\.js\)$/),
		]);
		expect(result.output).not.toContain(REPO_ROOT);
	});

	it("leave the whole stack on the error for a cell that prints it", async () => {
		const result = await executeJs(
			"try { await fixture.invoke({}); } catch (error) { print(error.stack); }",
			options,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(REPO_ROOT);
	});
});

describe("formatCellError", () => {
	it("hides engine, compiled-omp, prelude and install-tree frames and keeps everything else", () => {
		const stack = [
			"TypeError: x is not a function",
			"1 | foo()",
			"    ^",
			"    at <anonymous> (browser-run-15c8.js:2:43)",
			"    at #f (/$bunfs/root/chunks/cli-z5kk.js:10905:16)",
			"    at B:/~BUN/root/chunks/cli.js:1:2",
			"    at map (native:1:11)",
			"    at eval (unknown)",
			"    at processTicksAndRejections (node:internal/process/task_queues:105:5)",
			"    at open ([eval-prelude:browser]:262:24)",
			"    at run (/opt/omp/node_modules/@oh-my-pi/pi-coding-agent/src/eval/js/shared/runtime.ts:556:14)",
			"    at helper (/home/me/project/lib/helper.ts:3:9)",
			"    at <anonymous> (:0:43)",
			"    at browser.call (js-cell-1d89.js)",
		].join("\n");
		expect(formatCellError(stack, "/opt/omp/node_modules")).toBe(
			[
				"TypeError: x is not a function",
				"1 | foo()",
				"    ^",
				"    at <anonymous> (browser-run-15c8.js:2:43)",
				"    at helper (/home/me/project/lib/helper.ts:3:9)",
				"    at <anonymous> (:0:43)",
				"    at browser.call (js-cell-1d89.js)",
				"    (7 omp frames hidden; catch the error and print e.stack to see them)",
			].join("\n"),
		);
	});

	it("returns a stack with nothing to hide unchanged", () => {
		const stack = "Error: boom\n    at <anonymous> (js-cell-1.js:1:7)";
		expect(formatCellError(stack, "/opt/omp/node_modules")).toBe(stack);
		expect(formatCellError("plain message", undefined)).toBe("plain message");
	});
});
