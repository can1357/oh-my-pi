import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as cleanseAgent from "@oh-my-pi/pi-coding-agent/cleanse/agent";
import * as cleanseCheckers from "@oh-my-pi/pi-coding-agent/cleanse/checkers";
import { runCleanseCommand } from "@oh-my-pi/pi-coding-agent/cleanse/index";
import { runCleanseLoop } from "@oh-my-pi/pi-coding-agent/cleanse/loop";
import { type CleanseParserKind, parseCleanseDiagnostics } from "@oh-my-pi/pi-coding-agent/cleanse/parsers";
import type {
	CleanseAgentOutcome,
	CleanseAssignment,
	CleanseDiagnostic,
	CleanseDiagnosticReport,
} from "@oh-my-pi/pi-coding-agent/cleanse/types";
import { createProgressReporter } from "@oh-my-pi/pi-coding-agent/cli/progress-reporter";
import { resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("cleanse diagnostics", () => {
	test("parses cargo clippy JSON into a project-relative actionable diagnostic", () => {
		const stdout = JSON.stringify({
			reason: "compiler-message",
			message: {
				message: "useless use of vec!",
				code: { code: "clippy::useless_vec" },
				level: "warning",
				spans: [
					{
						file_name: "src/main.rs",
						is_primary: true,
						line_start: 2,
						column_start: 18,
						line_end: 2,
						column_end: 31,
						suggested_replacement: "[1, 2, 3]",
					},
				],
			},
		});

		const diagnostics = parseCleanseDiagnostics("rust", {
			checker: "cargo clippy (.)",
			projectCwd: "/repo",
			checkerCwd: "/repo",
			stdout,
			stderr: "",
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			checker: "cargo clippy (.)",
			file: "src/main.rs",
			line: 2,
			column: 18,
			endLine: 2,
			endColumn: 31,
			code: "clippy::useless_vec",
			severity: "warning",
			message: "useless use of vec!",
			suggestion: "[1, 2, 3]",
		});
	});

	test("discovers package test scripts only when test mode is enabled", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanse-tests-"));
		try {
			await Bun.write(
				path.join(root, "package.json"),
				JSON.stringify({
					packageManager: "bun@1.3.14",
					scripts: { test: `bun -e "process.exit(3)"` },
				}),
			);
			await Bun.write(path.join(root, "src", "index.ts"), "export const value = 1;\n");

			const withoutTests = await cleanseCheckers.discoverCleanseDiagnosticSuite(root);
			const withTests = await cleanseCheckers.discoverCleanseDiagnosticSuite(root, { includeTests: true });
			const report = await withTests.run();

			expect(withoutTests.checkers).toHaveLength(0);
			expect(withTests.checkers).toHaveLength(1);
			expect(report.checks[0]).toMatchObject({
				label: "bun test (.)",
				exitCode: 3,
			});
			expect(report.diagnostics[0]?.message).toContain("bun test (.) failed with exit code 3");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("excludes generated Bazel trees from checker discovery", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanse-ignore-"));
		try {
			await Bun.write(path.join(root, "src", "index.ts"), "export const value = 1;\n");
			await Bun.write(
				path.join(root, "bazel-output", "fixture", "package.json"),
				JSON.stringify({ scripts: { test: `bun -e "process.exit(3)"` } }),
			);

			const suite = await cleanseCheckers.discoverCleanseDiagnosticSuite(root, { includeTests: true });

			expect(suite.checkers).toHaveLength(0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("cleanse progress", () => {
	test("updates an interactive completion bar as workers finish", () => {
		const writes: string[] = [];
		const progress = createProgressReporter("Repairing", {
			isTTY: true,
			write(text) {
				writes.push(text);
				return true;
			},
		});

		progress.start(2);
		progress.complete();
		progress.complete();
		progress.finish();

		expect(writes).toHaveLength(4);
		for (const update of writes.slice(0, 3)) {
			expect(update.startsWith("\rRepairing [")).toBe(true);
			expect(update.endsWith("\x1b[K")).toBe(true);
		}
		expect(writes[0]).toContain("0/2");
		expect(writes[1]).toContain("1/2");
		expect(writes[2]).toContain("2/2");
		expect(writes[3]).toBe("\n");
	});

	test("renders a live repair board and permanent outcome lines on TTY output", async () => {
		const output: string[] = [];
		const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		const initial = report([...fileDiagnostics("a.rs", 1), ...fileDiagnostics("b.rs", 1)]);
		const clean = report([]);
		let runCount = 0;
		const descriptors = [{ id: "mock", label: "mock checker", language: "Test", cwd: ".", command: "mock" }];
		const suite: cleanseCheckers.CleanseDiagnosticSuite = {
			checkers: descriptors,
			selected: descriptors,
			skipped: [],
			select() {},
			async run(options) {
				runCount += 1;
				const current = runCount === 1 ? initial : clean;
				const descriptor = suite.checkers[0];
				if (descriptor) {
					options?.events?.onCheckerStart?.(descriptor);
					if (current.diagnostics.length > 0) {
						options?.events?.onDiagnostics?.(descriptor, current.diagnostics);
					}
					options?.events?.onCheckerEnd?.(
						{
							id: descriptor.id,
							label: descriptor.label,
							language: descriptor.language,
							cwd: "/repo",
							command: descriptor.command,
							exitCode: current.diagnostics.length === 0 ? 0 : 1,
							diagnostics: current.diagnostics,
						},
						5,
					);
				}
				return current;
			},
		};
		let hooks: cleanseAgent.CleanseAgentHooks | undefined;
		const runtime: cleanseAgent.CleanseAgentRuntime = {
			model: "test/model",
			sessionFile: "/tmp/cleanse.jsonl",
			async discoverCheckers() {
				return [];
			},
			async dispatchWorker(assignment, context) {
				const name = `CleanseA${context.worker}`;
				hooks?.onStart?.(name, assignment);
				const outcome: CleanseAgentOutcome = { name, success: true, output: "" };
				hooks?.onFinish?.(outcome, assignment);
				return outcome;
			},
			async followUp() {
				return false;
			},
			async close() {},
		};
		vi.spyOn(cleanseCheckers, "discoverCleanseDiagnosticSuite").mockResolvedValue(suite);
		vi.spyOn(cleanseAgent, "createCleanseAgentRuntime").mockImplementation(async options => {
			hooks = options.hooks;
			return runtime;
		});

		try {
			const result = await runCleanseCommand({ maxAgents: 2, all: true });

			expect(result.status).toBe("clean");
			// Strip ANSI control sequences; the board's repaint framing is not the contract.
			const text = output.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
			// Live repair header painted while workers stream in.
			expect(text).toContain("Repairing [");
			// Checker results and agent outcomes promoted to permanent lines.
			expect(text).toMatch(/●.*mock checker.*2 issues/);
			expect(text).toMatch(/✓.*mock checker.*clean/);
			expect(text).toMatch(/✓.*CleanseA1/);
			expect(text).toMatch(/✓.*CleanseA2/);
			expect(text).toContain("a.rs");
			expect(text).toContain("b.rs");
		} finally {
			if (isTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}
	});

	test("stays silent for non-TTY output", () => {
		const writes: string[] = [];
		const progress = createProgressReporter("Repairing", {
			isTTY: false,
			write(text) {
				writes.push(text);
				return true;
			},
		});

		progress.start(1);
		progress.complete();
		progress.finish();

		expect(writes).toEqual([]);
	});
});

describe("cleanse orchestration", () => {
	test("dispatches streamed diagnostics while checkers are still running", async () => {
		const firstDispatch = Promise.withResolvers<void>();
		let collectSettled = false;
		let dispatchedBeforeCollectEnd = false;

		const result = await runCleanseLoop(
			{ maxAgents: 4 },
			{
				collect: async onDiagnostics => {
					onDiagnostics(fileDiagnostics("a.rs", 2));
					await firstDispatch.promise;
					onDiagnostics(fileDiagnostics("b.rs", 1));
					collectSettled = true;
					return report([...fileDiagnostics("a.rs", 2), ...fileDiagnostics("b.rs", 1)]);
				},
				verify: async () => report([]),
				dispatch: async (_assignment, worker) => {
					if (!collectSettled) dispatchedBeforeCollectEnd = true;
					firstDispatch.resolve();
					return { name: `CleanseA${worker}`, success: true, output: "" };
				},
			},
		);

		expect(dispatchedBeforeCollectEnd).toBe(true);
		expect(result.status).toBe("clean");
		expect(result.workers).toBe(2);
	});

	test("steers late diagnostics for an owned file into the running worker's chat", async () => {
		const workerStarted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const followUps: { worker: number; diagnostics: readonly CleanseDiagnostic[] }[] = [];
		const lateDiagnostic: CleanseDiagnostic = {
			checker: "checker",
			file: "a.rs",
			line: 99,
			severity: "error",
			message: "late problem",
		};

		const result = await runCleanseLoop(
			{ maxAgents: 4 },
			{
				collect: async onDiagnostics => {
					onDiagnostics(fileDiagnostics("a.rs", 1));
					await workerStarted.promise;
					onDiagnostics([lateDiagnostic]);
					return report([...fileDiagnostics("a.rs", 1), lateDiagnostic]);
				},
				verify: async () => report([]),
				dispatch: async (_assignment, worker) => {
					workerStarted.resolve();
					await release.promise;
					return { name: `CleanseA${worker}`, success: true, output: "" };
				},
				followUp: async (worker, diagnostics) => {
					followUps.push({ worker, diagnostics });
					release.resolve();
					return true;
				},
			},
		);

		expect(result.workers).toBe(1);
		expect(followUps).toEqual([{ worker: 1, diagnostics: [lateDiagnostic] }]);
	});

	test("requeues held diagnostics for a fresh worker when follow-up delivery fails", async () => {
		const workerStarted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const assignments: CleanseAssignment[] = [];
		const active = new Set<string>();
		let overlapped = false;

		const result = await runCleanseLoop(
			{ maxAgents: 4 },
			{
				collect: async onDiagnostics => {
					onDiagnostics(fileDiagnostics("a.rs", 1));
					await workerStarted.promise;
					onDiagnostics([{ ...fileDiagnostics("a.rs", 1)[0], line: 99, message: "late problem" }]);
					release.resolve();
					return report(fileDiagnostics("a.rs", 1));
				},
				verify: async () => report([]),
				dispatch: async (assignment, worker) => {
					assignments.push(assignment);
					for (const group of assignment.groups) {
						if (active.has(group.file ?? "")) overlapped = true;
						active.add(group.file ?? "");
					}
					if (worker === 1) {
						workerStarted.resolve();
						await release.promise;
					}
					for (const group of assignment.groups) active.delete(group.file ?? "");
					return { name: `CleanseA${worker}`, success: true, output: "" };
				},
				followUp: async () => false,
			},
		);

		expect(overlapped).toBe(false);
		expect(result.workers).toBe(2);
		expect(assignments[1]?.groups[0]?.diagnostics).toMatchObject([{ line: 99, message: "late problem" }]);
	});

	test("caps concurrent workers while draining the queue", async () => {
		const started: number[] = [];
		const gates = new Map<number, PromiseWithResolvers<void>>();
		const thirdStarted = Promise.withResolvers<void>();

		const result = await runCleanseLoop(
			{ maxAgents: 2 },
			{
				collect: async onDiagnostics => {
					onDiagnostics(fileDiagnostics("a.rs", 1));
					onDiagnostics(fileDiagnostics("b.rs", 1));
					onDiagnostics(fileDiagnostics("c.rs", 1));
					// Both slots are busy, so the third file must queue.
					expect(started).toEqual([1, 2]);
					gates.get(1)?.resolve();
					await thirdStarted.promise;
					gates.get(2)?.resolve();
					return report([
						...fileDiagnostics("a.rs", 1),
						...fileDiagnostics("b.rs", 1),
						...fileDiagnostics("c.rs", 1),
					]);
				},
				verify: async () => report([]),
				dispatch: async (_assignment, worker) => {
					started.push(worker);
					if (worker === 3) {
						thirdStarted.resolve();
						return { name: `CleanseA${worker}`, success: true, output: "" };
					}
					const gate = Promise.withResolvers<void>();
					gates.set(worker, gate);
					await gate.promise;
					return { name: `CleanseA${worker}`, success: true, output: "" };
				},
			},
		);

		expect(started).toEqual([1, 2, 3]);
		expect(result.status).toBe("clean");
		expect(result.workers).toBe(3);
	});

	test("skips verification when no diagnostics stream in", async () => {
		let verified = false;

		const result = await runCleanseLoop(
			{ maxAgents: 2 },
			{
				collect: async () => report([]),
				verify: async () => {
					verified = true;
					return report([]);
				},
				dispatch: async () => {
					throw new Error("no dispatch expected");
				},
			},
		);

		expect(result).toMatchObject({ status: "clean", workers: 0 });
		expect(verified).toBe(false);
	});

	test("reports stalled when verification still finds diagnostics", async () => {
		const initial = fileDiagnostics("a.rs", 1);

		const result = await runCleanseLoop(
			{ maxAgents: 8 },
			{
				collect: async onDiagnostics => {
					onDiagnostics(initial);
					return report(initial);
				},
				verify: async () => report(initial),
				dispatch: async (_assignment, worker) => ({ name: `CleanseA${worker}`, success: true, output: "" }),
			},
		);

		expect(result.status).toBe("stalled");
		expect(result.workers).toBe(1);
		expect(result.report.diagnostics).toHaveLength(1);
	});

	test("routes cleanse as a top-level command", () => {
		expect(resolveCliArgv(["cleanse", "-n", "4", "-m", "opus"])).toEqual({
			argv: ["cleanse", "-n", "4", "-m", "opus"],
		});
	});
});

describe("cleanse alternative-tooling parsers", () => {
	const parse = (kind: CleanseParserKind, stdout: string) =>
		parseCleanseDiagnostics(kind, {
			checker: "checker",
			projectCwd: "/repo",
			checkerCwd: "/repo",
			stdout,
			stderr: "",
		});

	test("normalizes staticcheck JSON lines into project-relative diagnostics", () => {
		const stdout = `{"code":"S1002","severity":"error","location":{"file":"/repo/main.go","line":5,"column":7},"end":{"line":5,"column":20},"message":"should omit comparison to bool constant"}`;
		expect(parse("staticcheck", stdout)).toEqual([
			{
				checker: "checker",
				file: "main.go",
				line: 5,
				column: 7,
				endLine: 5,
				endColumn: 20,
				code: "S1002",
				severity: "error",
				message: "should omit comparison to bool constant",
				suggestion: undefined,
			},
		]);
	});

	test("parses golangci-lint text output with the linter name as code", () => {
		const diagnostics = parse("golangci", "main.go:10:2: ineffectual assignment to err (ineffassign)\n");
		expect(diagnostics).toMatchObject([
			{ file: "main.go", line: 10, column: 2, code: "ineffassign", severity: "warning" },
		]);
	});

	test("converts pylint JSON zero-based columns to one-based", () => {
		const stdout = JSON.stringify([
			{
				type: "error",
				path: "src/app.py",
				line: 3,
				column: 0,
				endLine: 3,
				endColumn: 10,
				symbol: "undefined-variable",
				"message-id": "E0602",
				message: "Undefined variable 'x'",
			},
		]);
		expect(parse("pylint", stdout)).toMatchObject([
			{ file: "src/app.py", line: 3, column: 1, endColumn: 11, code: "undefined-variable", severity: "error" },
		]);
	});

	test("classifies flake8 pyflakes codes as errors and style codes as warnings", () => {
		const diagnostics = parse(
			"flake8",
			["src/app.py:1:1: F401 'os' imported but unused", "src/app.py:2:80: W291 trailing whitespace"].join("\n"),
		);
		expect(diagnostics).toMatchObject([
			{ file: "src/app.py", line: 1, code: "F401", severity: "error" },
			{ file: "src/app.py", line: 2, code: "W291", severity: "warning" },
		]);
	});

	test("parses ty concise output", () => {
		const diagnostics = parse(
			"ty",
			"src/main.py:1:8: error[unresolved-import] Cannot resolve imported module `foo`\nFound 1 diagnostic\n",
		);
		expect(diagnostics).toEqual([
			{
				checker: "checker",
				file: "src/main.py",
				line: 1,
				column: 8,
				endLine: undefined,
				endColumn: undefined,
				code: "unresolved-import",
				severity: "error",
				message: "Cannot resolve imported module `foo`",
				suggestion: undefined,
			},
		]);
	});

	test("parses oxlint unix-format lines with bracketed severity and rule", () => {
		const diagnostics = parse(
			"oxlint",
			"src/index.ts:4:10: Variable 'x' is declared but never used. [Warning/no-unused-vars]\n",
		);
		expect(diagnostics).toMatchObject([
			{ file: "src/index.ts", line: 4, column: 10, code: "no-unused-vars", severity: "warning" },
		]);
	});

	test("resolves deno lint file URLs and zero-based columns", () => {
		const stdout = JSON.stringify({
			diagnostics: [
				{
					filename: "file:///repo/mod.ts",
					range: { start: { line: 2, col: 4 }, end: { line: 2, col: 9 } },
					code: "no-var",
					message: "`var` keyword is not allowed.",
					hint: "Use `let` or `const` instead.",
				},
			],
			errors: [],
		});
		expect(parse("deno-lint", stdout)).toMatchObject([
			{
				file: "mod.ts",
				line: 2,
				column: 5,
				code: "no-var",
				severity: "warning",
				suggestion: "Use `let` or `const` instead.",
			},
		]);
	});

	test("flattens stylelint per-file warnings", () => {
		const stdout = JSON.stringify([
			{
				source: "/repo/styles/site.css",
				warnings: [
					{
						line: 7,
						column: 3,
						rule: "color-no-invalid-hex",
						severity: "error",
						text: "Unexpected invalid hex color",
					},
				],
			},
		]);
		expect(parse("stylelint", stdout)).toMatchObject([
			{ file: "styles/site.css", line: 7, column: 3, code: "color-no-invalid-hex", severity: "error" },
		]);
	});

	test("parses actionlint JSON output", () => {
		const stdout = JSON.stringify([
			{
				message: "shellcheck reported issue",
				filepath: ".github/workflows/ci.yml",
				line: 12,
				column: 9,
				kind: "shellcheck",
			},
		]);
		expect(parse("actionlint", stdout)).toMatchObject([
			{ file: ".github/workflows/ci.yml", line: 12, column: 9, code: "shellcheck", severity: "error" },
		]);
	});
});

describe("cleanse custom suite", () => {
	test("builds runnable plans from discovery specs and skips unrunnable ones", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanse-custom-"));
		try {
			await Bun.write(path.join(root, "src", "a.ts"), "export const value = 1;\n");
			const suite = await cleanseCheckers.buildCustomCleanseSuite(root, [
				{
					label: "fake tsc",
					language: "TypeScript",
					command: ["bun", "-e", "console.log('src/a.ts:1:1: error: boom'); process.exit(1)"],
				},
				{ label: "missing tool", command: ["definitely-not-a-real-binary-xyz"] },
				{ label: "escaping cwd", cwd: "../outside", command: ["bun", "-e", "1"] },
			]);

			expect(suite.checkers).toMatchObject([{ id: "custom-1", label: "fake tsc", language: "TypeScript" }]);
			expect(suite.skipped).toMatchObject([
				{ label: "missing tool", reason: "executable not found: definitely-not-a-real-binary-xyz" },
				{ label: "escaping cwd" },
			]);

			const report = await suite.run();
			expect(report.checks).toHaveLength(1);
			expect(report.diagnostics).toMatchObject([
				{ checker: "fake tsc", file: "src/a.ts", line: 1, severity: "error", message: "boom" },
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("select() narrows which checkers a run executes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanse-select-"));
		try {
			const suite = await cleanseCheckers.buildCustomCleanseSuite(root, [
				{ label: "first", command: ["bun", "-e", "console.log('ok')"] },
				{ label: "second", command: ["bun", "-e", "console.log('ok')"] },
			]);
			suite.select(["custom-2"]);

			const report = await suite.run();
			expect(report.checks.map(check => check.id)).toEqual(["custom-2"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	test("streams partial diagnostics before a long-running checker exits", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanse-stream-"));
		try {
			await Bun.write(path.join(root, "f.ts"), "export const a = 1;\n");
			await Bun.write(path.join(root, "g.ts"), "export const b = 2;\n");
			// Integration test of real streaming: the child sleeps to keep the
			// checker alive across flush ticks; fake timers cannot drive a
			// subprocess clock.
			const suite = await cleanseCheckers.buildCustomCleanseSuite(root, [
				{
					label: "slow checker",
					command: [
						"bun",
						"-e",
						"console.log('f.ts:1:1: error: first'); await Bun.sleep(700); console.log('g.ts:1:1: error: second')",
					],
				},
			]);
			const batches: CleanseDiagnostic[][] = [];
			const report = await suite.run({
				flushMs: 25,
				events: {
					onDiagnostics(_checker, diagnostics) {
						batches.push([...diagnostics]);
					},
				},
			});

			// The first batch is parsed from partial output while the checker is
			// still sleeping; the rest arrive by the final parse at exit.
			expect(batches.length).toBeGreaterThanOrEqual(2);
			expect(batches[0]).toMatchObject([{ file: "f.ts", severity: "error", message: "first" }]);
			expect(batches.flat()).toMatchObject([
				{ file: "f.ts", message: "first" },
				{ file: "g.ts", message: "second" },
			]);
			expect(report.diagnostics).toMatchObject([
				{ file: "f.ts", message: "first" },
				{ file: "g.ts", message: "second" },
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

function fileDiagnostics(file: string, count: number): CleanseDiagnostic[] {
	return Array.from({ length: count }, (_, index) => ({
		checker: "checker",
		file,
		line: index + 1,
		code: `E${index + 1}`,
		severity: "error",
		message: `problem ${index + 1}`,
		suggestion: "known fix",
	}));
}

function report(diagnostics: CleanseDiagnostic[]): CleanseDiagnosticReport {
	return {
		checks: [],
		diagnostics,
		skipped: [],
	};
}
