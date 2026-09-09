#!/usr/bin/env bun
/**
 * Executable adapter for the TypeScript edit benchmark.
 *
 * Two audiences share this entry point:
 * - The metaharness manager spawns it headless (`--model … --output result.json`)
 *   and consumes only the continuously-rewritten report file.
 * - Humans run it directly and get the interactive experience: a config
 *   banner, a live progress bar with per-run failure diffs (stderr, TTY-aware),
 *   a runtime-stats summary, and a markdown or JSON report.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type ResolvedThinkingLevel, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { loadTasksFromDir, validateFixturesFromDir } from "@oh-my-pi/typescript-edit-benchmark/tasks";
import { LiveProgress } from "./live-progress";
import { generateJsonReport, generateReport } from "./report";
import { type BenchmarkConfig, type BenchmarkResult, buildBenchmarkResult, runBenchmark } from "./runner";

const EDIT_PACKAGE = path.resolve(import.meta.dir, "..", "..", "..", "typescript-edit-benchmark");
const RUNS_DIR = path.resolve(import.meta.dir, "..", "..", "..", "..", "runs");

type ReportFormat = "markdown" | "json";

function log(line = ""): void {
	process.stderr.write(`${line}\n`);
}

function fail(message: string): never {
	throw new Error(message);
}

function parseThinkingLevel(value: string): ResolvedThinkingLevel {
	if ([ThinkingLevel.Off, ...THINKING_EFFORTS].includes(value as ResolvedThinkingLevel)) {
		return value as ResolvedThinkingLevel;
	}
	return fail(`Invalid thinking level: ${value}. Valid levels: ${[ThinkingLevel.Off, ...THINKING_EFFORTS].join(", ")}`);
}

function parsePositiveInt(raw: string | undefined, flag: string, fallback: number): number {
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 1) fail(`Invalid ${flag} value: ${raw}. Must be a positive integer.`);
	return parsed;
}

function parseFuzzy(raw: string | undefined): boolean | "auto" | undefined {
	if (raw === undefined) return undefined;
	if (raw === "auto") return "auto";
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	return fail(`Invalid --edit-fuzzy: ${raw}. Must be true, false, 1, 0, or auto.`);
}

function parseFuzzyThreshold(raw: string | undefined): number | "auto" | undefined {
	if (raw === undefined) return undefined;
	if (raw === "auto") return "auto";
	const parsed = Number.parseFloat(raw);
	if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
		fail(`Invalid --edit-fuzzy-threshold: ${raw}. Must be 0-1 or auto.`);
	}
	return parsed;
}

function resolveFormat(explicit: string | undefined, outputPath: string): ReportFormat {
	if (explicit === "markdown" || explicit === "json") return explicit;
	if (explicit !== undefined) fail(`Invalid --format: ${explicit}. Must be markdown or json.`);
	return outputPath.endsWith(".md") || outputPath.endsWith(".markdown") ? "markdown" : "json";
}

function generateReportFilename(config: BenchmarkConfig): string {
	const modelName = config.model
		.split("/")
		.pop()!
		.replace(/[^a-zA-Z0-9-]/g, "_");
	const variant = config.editVariant ?? "auto";
	const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "Z");
	return path.join(RUNS_DIR, `${modelName}_${variant}_${timestamp}.md`);
}

/** Sibling `.dump` directory for an output path, timestamped on collision. */
async function resolveConversationDumpDir(outputPath: string): Promise<string> {
	const parsed = path.parse(outputPath);
	const preferred = path.join(parsed.dir, `${parsed.name}.dump`);
	try {
		await fs.stat(preferred);
	} catch {
		return preferred;
	}
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(parsed.dir, `${parsed.name}.${timestamp}.dump`);
}

interface ResolvedFixtures {
	dir: string;
	cleanup?: () => Promise<void>;
}

/** Resolve `--fixtures` (directory or tarball; default: the built-in tarball). */
async function resolveFixtures(fixturesArg: string | undefined): Promise<ResolvedFixtures> {
	const source = fixturesArg ?? path.join(EDIT_PACKAGE, "fixtures.tar.gz");
	if (!source.endsWith(".tar.gz") && !source.endsWith(".tgz")) {
		return { dir: source };
	}
	const temp = await TempDir.create("@metaharness-edit-fixtures-");
	const archive = new Bun.Archive(await Bun.file(source).arrayBuffer());
	for (const [filePath, file] of await archive.files()) {
		await Bun.write(path.join(temp.path(), filePath), file);
	}
	const entries = await fs.readdir(temp.path(), { withFileTypes: true });
	const directories = entries.filter(entry => entry.isDirectory());
	const files = entries.filter(entry => entry.isFile());
	const dir = directories.length === 1 && files.length === 0 ? path.join(temp.path(), directories[0]!.name) : temp.path();
	return { dir, cleanup: () => temp.remove() };
}

function printUsage(): void {
	log(`
Edit Benchmark - Evaluate patch application success rates

Usage:
  bun adapters/edit/cli.ts --model <provider/model> [options]

Options:
  --model <id>               Provider/model ID, e.g. anthropic/claude-sonnet-4 (required)
  --provider <id>            Override provider (auto-detected from model prefix)
  --thinking <level>         Thinking level: off, minimal, low, medium, high, xhigh, max
  --runs <n>                 Runs per task (default: 1)
  --timeout <ms>             Timeout per run in ms (default: 120000)
  --connection-timeout <ms>  Timeout for first event before fast-retry (default: 30000)
  --max-turns <n>            Max turns per attempt before failing (default: 30)
  --task-concurrency <n>     Max tasks to run in parallel (default: 32)
  --tasks <ids>              Comma-separated task IDs to run (default: sampled)
  --max-tasks <n>            Max tasks to sample evenly (default: 80, 0 = all)
  --fixtures <path>          Fixtures directory or .tar.gz archive (default: built-in)
  --edit-variant <v>         Edit variant, e.g. hashline, replace, apply_patch (default: auto)
  --edit-fuzzy <bool>        Fuzzy matching: true, false, auto
  --edit-fuzzy-threshold <n> Fuzzy threshold 0-1 or auto
  --guided                   Include an authoritative suggested edit payload
  --max-attempts <n>         Max prompt attempts per run (default: 1)
  --no-early-stop-on-match   Don't short-circuit when output matches expected
  --output <file>            Report file (default: runs/<model>_<variant>_<ts>.md)
  --format <fmt>             Report format: markdown, json (default: by extension)
  --check-fixtures           Validate fixtures and exit
  --quiet                    Suppress the live progress view
  --list                     Print task ids as JSON and exit
  --help                     Show this help message

Examples:
  # Full run against the default sample of 80 tasks
  bun adapters/edit/cli.ts --model anthropic/claude-sonnet-4

  # Compare edit variants
  bun adapters/edit/cli.ts --model openai/gpt-5 --edit-variant hashline --output hashline.md
  bun adapters/edit/cli.ts --model openai/gpt-5 --edit-variant apply_patch --output apply_patch.md

  # Specific tasks, more runs
  bun adapters/edit/cli.ts --model anthropic/claude-sonnet-4 --tasks logic-flip-strict-equality-001 --runs 5
`);
}

/** Execute an edit benchmark and continuously materialize its report artifact. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			model: { type: "string" },
			provider: { type: "string" },
			thinking: { type: "string" },
			runs: { type: "string", default: "1" },
			timeout: { type: "string", default: "120000" },
			"connection-timeout": { type: "string", default: "30000" },
			"max-turns": { type: "string", default: "30" },
			"task-concurrency": { type: "string", default: "32" },
			tasks: { type: "string" },
			"max-tasks": { type: "string", default: "80" },
			fixtures: { type: "string" },
			"edit-variant": { type: "string" },
			"edit-fuzzy": { type: "string" },
			"edit-fuzzy-threshold": { type: "string" },
			guided: { type: "boolean", default: false },
			"max-attempts": { type: "string", default: "1" },
			"no-op-retry-limit": { type: "string", default: "2" },
			"max-timeout-retries": { type: "string", default: "3" },
			"max-provider-retries": { type: "string", default: "3" },
			"mutation-scope-window": { type: "string", default: "20" },
			"no-early-stop-on-match": { type: "boolean", default: false },
			output: { type: "string" },
			format: { type: "string" },
			"check-fixtures": { type: "boolean", default: false },
			quiet: { type: "boolean", default: false },
			list: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
		strict: true,
	});

	if (values.help) {
		printUsage();
		return;
	}

	const fixtures = await resolveFixtures(values.fixtures);
	try {
		if (values["check-fixtures"]) {
			const issues = await validateFixturesFromDir(fixtures.dir);
			if (issues.length === 0) {
				log("Fixtures OK");
				return;
			}
			log("Fixture validation failed:");
			for (const issue of issues) log(`  - ${issue.taskId}: ${issue.message}`);
			process.exitCode = 1;
			return;
		}

		let tasks = await loadTasksFromDir(fixtures.dir);
		if (values.list) {
			process.stdout.write(`${JSON.stringify(tasks.map(task => ({ id: task.id, name: task.name })))}\n`);
			return;
		}
		if (!values.model) fail("edit adapter requires --model (see --help)");

		if (values.tasks) {
			const selected = new Set(values.tasks.split(",").map(value => value.trim()));
			tasks = tasks.filter(task => selected.has(task.id));
			if (tasks.length !== selected.size) fail("one or more edit task ids were not found (see --list)");
		} else {
			const limit = Number(values["max-tasks"]);
			if (limit > 0 && tasks.length > limit) {
				// Deterministic even sampling across the id-sorted list keeps
				// mutation-category coverage representative.
				const sorted = tasks.slice().sort((a, b) => a.id.localeCompare(b.id));
				const step = sorted.length / limit;
				tasks = Array.from({ length: limit }, (_, index) => sorted[Math.floor(index * step)]!);
			}
		}

		const model = values.model;
		const slash = model.indexOf("/");
		const config: BenchmarkConfig = {
			provider: values.provider ?? (slash === -1 ? "anthropic" : model.slice(0, slash)),
			model,
			...(values.thinking === undefined ? {} : { thinkingLevel: parseThinkingLevel(values.thinking) }),
			runsPerTask: parsePositiveInt(values.runs, "--runs", 1),
			timeout: parsePositiveInt(values.timeout, "--timeout", 120_000),
			connectionTimeout: parsePositiveInt(values["connection-timeout"], "--connection-timeout", 30_000),
			maxTurns: parsePositiveInt(values["max-turns"], "--max-turns", 30),
			taskConcurrency: parsePositiveInt(values["task-concurrency"], "--task-concurrency", 32),
			guided: values.guided,
			maxAttempts: parsePositiveInt(values["max-attempts"], "--max-attempts", 1),
			noOpRetryLimit: parsePositiveInt(values["no-op-retry-limit"], "--no-op-retry-limit", 2),
			maxTimeoutRetries: parsePositiveInt(values["max-timeout-retries"], "--max-timeout-retries", 3),
			maxProviderFailureRetries: parsePositiveInt(values["max-provider-retries"], "--max-provider-retries", 3),
			mutationScopeWindow: parsePositiveInt(values["mutation-scope-window"], "--mutation-scope-window", 20),
			inProcess: true,
			earlyStopOnMatch: !values["no-early-stop-on-match"],
		};
		const editVariant = values["edit-variant"];
		if (editVariant) config.editVariant = editVariant;
		const editFuzzy = parseFuzzy(values["edit-fuzzy"]);
		if (editFuzzy !== undefined) config.editFuzzy = editFuzzy;
		const editFuzzyThreshold = parseFuzzyThreshold(values["edit-fuzzy-threshold"]);
		if (editFuzzyThreshold !== undefined) config.editFuzzyThreshold = editFuzzyThreshold;

		let outputPath = values.output;
		if (outputPath === undefined) {
			await fs.mkdir(RUNS_DIR, { recursive: true });
			outputPath = generateReportFilename(config);
		}
		const format = resolveFormat(values.format, outputPath);
		config.conversationDumpDir = await resolveConversationDumpDir(outputPath);

		log("Edit Benchmark");
		log("==============");
		log(`Provider: ${config.provider}`);
		log(`Model: ${config.model}`);
		if (config.thinkingLevel) log(`Thinking: ${config.thinkingLevel}`);
		log(`Runs per task: ${config.runsPerTask}`);
		log(`Timeout: ${config.timeout}ms`);
		log(`Task concurrency: ${config.taskConcurrency}`);
		log(`Guided mode: ${config.guided ? "enabled" : "disabled"}`);
		if (config.editVariant) log(`Edit variant: ${config.editVariant}`);
		if (config.editFuzzy !== undefined) log(`Edit fuzzy: ${config.editFuzzy}`);
		if (config.editFuzzyThreshold !== undefined) log(`Edit fuzzy threshold: ${config.editFuzzyThreshold}`);
		log(`Tasks: ${tasks.length}`);
		log(`Report: ${outputPath}`);
		log(`Conversation dumps: ${config.conversationDumpDir}`);
		log();

		const renderReport = (result: BenchmarkResult): string =>
			format === "json" ? generateJsonReport(result) : generateReport(result);

		const progress = values.quiet ? undefined : new LiveProgress(tasks.length * config.runsPerTask, config.runsPerTask);
		let latestResult = buildBenchmarkResult({
			tasks,
			config,
			resultsByTask: new Map(),
			startTime: new Date().toISOString(),
		});
		let writes = Promise.resolve();
		const queueReportWrite = (result: BenchmarkResult) => {
			writes = writes.then(async () => {
				await Bun.write(outputPath, renderReport(result));
			});
		};
		// A killed/interrupted run still leaves a usable partial report behind.
		const unregisterCleanup = postmortem.register("edit-benchmark-report", async reason => {
			if (reason === postmortem.Reason.EXIT) return;
			progress?.finish();
			log("Benchmark interrupted; writing partial report...");
			await Bun.write(outputPath, renderReport(latestResult));
			await fixtures.cleanup?.();
		});

		const result = await runBenchmark(
			tasks,
			config,
			event => progress?.handleEvent(event),
			snapshot => {
				latestResult = snapshot;
				queueReportWrite(snapshot);
			},
		);
		latestResult = result;
		progress?.finish();
		queueReportWrite(result);
		await writes;
		unregisterCleanup();

		log();
		log("Benchmark complete!");
		log(
			`  Task success rate (best of ${config.runsPerTask}): ${(result.summary.taskSuccessRate * 100).toFixed(1)}% (${result.summary.successfulTasks}/${result.summary.totalTasks})`,
		);
		log(`  Total tokens (best): ${result.summary.totalTokens.input} in / ${result.summary.totalTokens.output} out`);
		log(
			`  Tokens/task (best): mean=${result.summary.avgTokensPerTask.total} median=${result.summary.medianTokensPerTask.total} p1=${result.summary.p1TokensPerTask.total} p99=${result.summary.p99TokensPerTask.total} reasoning=${result.summary.avgTokensPerTask.reasoning}`,
		);
		if (result.summary.ghostRuns > 0) log(`  Ghost runs (0/0/0): ${result.summary.ghostRuns}`);
		if (result.summary.timeoutRuns > 0) log(`  Timeout runs: ${result.summary.timeoutRuns}`);
		log(`Report written to: ${outputPath}`);
	} finally {
		await fixtures.cleanup?.();
	}
}

if (import.meta.main) {
	main()
		.then(async () => {
			// In-process benchmark runs can leave provider keep-alive sockets and
			// background AgentSession timers alive after the report is written.
			// Treat the final report as the CLI boundary.
			await postmortem.quit(Number(process.exitCode ?? 0));
		})
		.catch(async error => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			await postmortem.quit(1);
		});
}
