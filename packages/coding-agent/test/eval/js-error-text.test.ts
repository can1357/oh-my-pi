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

	it("keeps frame-looking lines inside a multiline error message", async () => {
		const message = "first\n    at map (native:1:11)\nlast";
		const result = await executeJs(`throw new Error(${JSON.stringify(message)});`, options);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`Error: ${message}\n`);
		expect(result.output).not.toContain(REPO_ROOT);
		expect(result.output).toContain("omp frames hidden;");
	});

	it("keeps cached multiline diagnostics after the error message changes", async () => {
		const message = "first\n    at map (native:1:11)\nlast";
		const result = await executeJs(
			`const error = new Error(${JSON.stringify(message)}); void error.stack; error.message = "changed"; throw error;`,
			options,
		);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`Error: ${message}\n`);
		expect(result.output).not.toContain("omp frames hidden");
	});

	it("filters decorated assertion stacks without removing their diagnostic", async () => {
		const result = await executeJs('import assert from "node:assert"; assert.strictEqual(1, 2);', options);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("AssertionError [ERR_ASSERTION]");
		expect(result.output).toContain("omp frames hidden;");
		expect(result.output).not.toContain(REPO_ROOT);
	});

	it("keeps multiline diagnostics when folding an unawaited rejection", async () => {
		const message = "first $& $$\n    at map (native:1:11)\nlast";
		const result = await executeJs(
			`Promise.reject(new Error(${JSON.stringify(message)})); const { promise, resolve } = Promise.withResolvers(); setImmediate(resolve); await promise;`,
			options,
		);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`Unhandled rejection (missing await?): ${message}\n`);
		expect(result.output).not.toContain(REPO_ROOT);
	});

	it("annotates a rejection with an empty message", async () => {
		const result = await executeJs(
			"Promise.reject(new Error()); const { promise, resolve } = Promise.withResolvers(); setImmediate(resolve); await promise;",
			options,
		);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("Error: Unhandled rejection (missing await?): ");
	});

	it("annotates cached rejection stacks without losing old or current diagnostics", async () => {
		const oldMessage = "old\n    at map (native:1:11)\nlast";
		const currentMessage = "new $& $$\n    at eval (unknown)\ncurrent";
		const result = await executeJs(
			`const error = new Error(${JSON.stringify(oldMessage)}); void error.stack; error.message = ${JSON.stringify(currentMessage)}; Promise.reject(error); const { promise, resolve } = Promise.withResolvers(); setImmediate(resolve); await promise;`,
			options,
		);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`Error: ${oldMessage}\n`);
		expect(result.output).toContain(`Error: Unhandled rejection (missing await?): ${currentMessage}`);
		expect(result.output).not.toContain("omp frames hidden");
	});

	it("does not rewrite a current header embedded in a stale rejection diagnostic", async () => {
		const oldMessage = "old\nError: new\n    at map (native:1:11)\nlast";
		const result = await executeJs(
			`const error = new Error(${JSON.stringify(oldMessage)}); void error.stack; error.message = "new"; Promise.reject(error); const { promise, resolve } = Promise.withResolvers(); setImmediate(resolve); await promise;`,
			options,
		);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`Error: ${oldMessage}\n`);
		expect(result.output).toContain("Error: Unhandled rejection (missing await?): new");
	});

	it("take omp's tree from its own code, not from PI_PACKAGE_DIR", async () => {
		const stack = `Error: x\n    at asset (/opt/omp/lib.ts:1:2)\n    at host (${ERROR_TEXT}:1:2)`;
		const script = `import { formatCellError } from ${JSON.stringify(ERROR_TEXT)};
console.log(formatCellError(${JSON.stringify(stack)}, { filename: "js-cell-1.js", cwd: "/tmp" }));`;
		const child = Bun.spawn(["bun", "-e", script], {
			env: { ...process.env, PI_PACKAGE_DIR: "/opt/omp" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(code).toBe(0);
		expect(stdout).toContain("at asset (/opt/omp/lib.ts:1:2)");
		expect(stdout).not.toContain(ERROR_TEXT);
		expect(stdout).toContain("(1 omp frame hidden)");
	});
});

describe("formatCellError", () => {
	// Stack frames carry the platform's own paths, so the fixtures build them the same way.
	const at = (...parts: string[]) => path.join(path.sep, ...parts);
	const source = { filename: "js-cell-1d89.js", cwd: at("home/me/project"), ompRoot: at("opt/omp/node_modules") };

	it("hides engine, compiled-omp, prelude and install-tree frames and keeps everything else", () => {
		const helper = `    at helper (${at("home/me/project/lib/helper.ts")}:3:9)`;
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
			`    at run (${at("opt/omp (copy)/node_modules/@oh-my-pi/pi-coding-agent/src/eval/js/shared/runtime.ts")}:556:14)`,
			helper,
			"    at <anonymous> (:0:43)",
			"    at browser.call (js-cell-1d89.js)",
		].join("\n");
		expect(formatCellError(stack, { ...source, ompRoot: at("opt/omp (copy)/node_modules") })).toBe(
			[
				"TypeError: x is not a function",
				"1 | foo()",
				"    ^",
				"    at <anonymous> (browser-run-15c8.js:2:43)",
				helper,
				"    at <anonymous> (:0:43)",
				"    at browser.call (js-cell-1d89.js)",
				"    (7 omp frames hidden; catch the error and print e.stack to see them)",
			].join("\n"),
		);
	});

	it("keeps code under a working directory inside omp's tree and hides the rest of the tree", () => {
		const mine = `    at mine (${at("opt/omp/node_modules/my-project/a.ts")}:1:2)`;
		const stack = [
			"Error: x",
			mine,
			`    at theirs (${at("opt/omp/node_modules/puppeteer-core/lib/b.js")}:3:4)`,
		].join("\n");
		expect(formatCellError(stack, { ...source, cwd: at("opt/omp/node_modules/my-project") })).toBe(
			["Error: x", mine, "    (1 omp frame hidden)"].join("\n"),
		);
	});

	it("keeps project dependency frames when omp shares the project's node_modules", () => {
		const parse = `at parse (${at("proj/node_modules/zod/lib/x.js")}:1:2)`;
		const stack = [
			"Error: x",
			`    ${parse}`,
			"    at run (js-cell-1d89.js:1:2)",
			"    at map (native:1:11)",
			`    at execute (${at("proj/node_modules/@oh-my-pi/pi-coding-agent/src/eval/js/executor.ts")}:1:2)`,
		].join("\n");
		const output = formatCellError(stack, { ...source, cwd: at("proj"), ompRoot: at("proj/node_modules") });
		expect(output).toContain(parse);
		expect(output).toContain("at run (js-cell-1d89.js:1:2)");
		expect(output).not.toContain("pi-coding-agent");
		expect(output).toContain("(2 omp frames hidden;");
	});

	it("hides a global install below the working directory rather than treating it as project-local", () => {
		const helper = `at helper (${at("home/me/project/lib.ts")}:1:2)`;
		const stack = [
			"Error: x",
			`    ${helper}`,
			`    at run (${at("home/me/.bun/install/global/node_modules/puppeteer-core/lib/b.js")}:3:4)`,
		].join("\n");
		const output = formatCellError(stack, {
			...source,
			cwd: at("home/me"),
			ompRoot: at("home/me/.bun/install/global/node_modules"),
		});
		expect(output).toContain(helper);
		expect(output).not.toContain("puppeteer-core");
		expect(output).toContain("(1 omp frame hidden)");
	});
});
