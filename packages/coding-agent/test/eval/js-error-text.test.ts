import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { formatCellError } from "@oh-my-pi/pi-coding-agent/eval/js/error-text";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/** The checkout this test runs from; every frame under it is omp's own code or one of its dependencies. */
const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const ERROR_TEXT = path.resolve(import.meta.dir, "../../src/eval/js/error-text.ts");

const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: Settings.isolated(),
};

describe("uncaught JavaScript cell errors", () => {
	afterAll(async () => {
		await disposeAllVmContexts();
	});

	const options = { cwd: "/tmp", sessionId: `js-error-text-${crypto.randomUUID()}`, session };

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

	it("keep the frames of a cell file that lives inside omp's own tree", async () => {
		const filename = path.join(REPO_ROOT, "scripts", "cell-under-omp-root.js");
		const result = await executeJs('function inner() {\n  throw new Error("file cell");\n}\ninner();', {
			...options,
			filename,
		});
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`(${filename}:`);
	});

	it("do not tell the cell to catch an error it never saw", async () => {
		const result = await executeJs("process.exit(3);", options);
		expect(result.exitCode).toBe(1);
		expect(result.output).not.toContain("catch the error");
	});

	it("take omp's tree from its own code, not from PI_PACKAGE_DIR", async () => {
		const script = `import { formatCellError } from ${JSON.stringify(ERROR_TEXT)};
console.log(formatCellError("Error: x\\n    at f (/home/me/project/lib.ts:1:2)", { filename: "js-cell-1.js", cwd: "/tmp" }));`;
		const child = Bun.spawn(["bun", "-e", script], {
			env: { ...process.env, PI_PACKAGE_DIR: "/opt/omp" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(code).toBe(0);
		expect(stdout).toContain("at f (/home/me/project/lib.ts:1:2)");
	});
});

describe("formatCellError", () => {
	const source = { filename: "js-cell-1d89.js", cwd: "/home/me/project", ompRoot: "/opt/omp/node_modules" };

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
		expect(formatCellError(stack, source)).toBe(
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

	it("keeps code under a working directory inside omp's tree and hides the rest of the tree", () => {
		const stack = [
			"Error: x",
			"    at mine (/opt/omp/node_modules/my-project/a.ts:1:2)",
			"    at theirs (/opt/omp/node_modules/puppeteer-core/lib/b.js:3:4)",
		].join("\n");
		expect(formatCellError(stack, { ...source, cwd: "/opt/omp/node_modules/my-project" })).toBe(
			["Error: x", "    at mine (/opt/omp/node_modules/my-project/a.ts:1:2)", "    (1 omp frame hidden)"].join("\n"),
		);
	});

	it("keeps project dependency frames when omp shares the project's node_modules", () => {
		const stack = [
			"Error: x",
			"    at parse (/proj/node_modules/zod/lib/x.js:1:2)",
			"    at run (js-cell-1d89.js:1:2)",
			"    at map (native:1:11)",
		].join("\n");
		const output = formatCellError(stack, { ...source, cwd: "/proj", ompRoot: "/proj/node_modules" });
		expect(output).toContain("at parse (/proj/node_modules/zod/lib/x.js:1:2)");
		expect(output).toContain("at run (js-cell-1d89.js:1:2)");
		expect(output).toContain("(1 omp frame hidden;");
	});
});
