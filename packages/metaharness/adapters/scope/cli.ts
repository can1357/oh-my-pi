#!/usr/bin/env bun
/**
 * Scope benchmark: how long omp takes on small, narrowly scoped requests and where the time
 * goes — model vs tools, unrequested checks (test suites, typechecks, builds, program runs
 * nobody asked for), re-reads of just-edited files, and edits outside the request.
 *
 * ```sh
 * bun adapters/scope/cli.ts --model openrouter/deepseek/deepseek-v4.1-flash --label base
 * bun adapters/scope/cli.ts --model openrouter/deepseek/deepseek-v4.1-flash --label lean \
 *   --append-system-prompt adapters/scope/variants/lean-verification.md
 * bun adapters/scope/cli.ts compare ../../runs/scope/base/result.json ../../runs/scope/lean/result.json
 * ```
 *
 * The metaharness manager spawns it with `--output <jobDir>/result.json` and reads only that file.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { CLI_THINKING_LEVELS, parseCliThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking/levels";
import { postmortem } from "@oh-my-pi/pi-utils";
import { discoverSharedInfra } from "@oh-my-pi/typescript-edit-benchmark/in-process-client";
import { renderComparison, renderReport, type ScopeResult, type ScopeRun, summarize } from "./result";
import { loadTasks, type ScopeTask } from "./tasks";
import { runTrial, type TrialConfig } from "./trial";

const RUNS_DIR = path.resolve(import.meta.dir, "..", "..", "..", "..", "runs", "scope");

function log(line = ""): void {
	process.stderr.write(`${line}\n`);
}

function positiveInt(raw: string | undefined, flag: string, fallback: number): number {
	if (raw === undefined) return fallback;
	const value = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer, got ${raw}`);
	return value;
}

function progressLine(run: ScopeRun): string {
	const unrequested = run.checks.filter(check => check.unrequested);
	const checkSeconds = unrequested.reduce((total, check) => total + check.ms, 0) / 1000;
	const why = [run.error, ...run.failures].filter(Boolean).join("; ");
	return `${run.pass ? "✓" : "✗"} ${run.task}#${run.attempt}  ${(run.wallMs / 1000).toFixed(1)}s  ${run.turns} turns  ${run.toolCalls} calls  ${unrequested.length} unrequested checks (${checkSeconds.toFixed(1)}s)${why ? `  ${why}` : ""}`;
}

async function compare(files: string[]): Promise<void> {
	if (files.length !== 2) throw new Error("usage: compare <a/result.json> <b/result.json>");
	const [a, b]: ScopeResult[] = await Promise.all(files.map(file => Bun.file(file).json()));
	process.stdout.write(renderComparison(a, b));
}

function selectTasks(all: ScopeTask[], list: string | undefined): ScopeTask[] {
	if (list === undefined) return all;
	const wanted = list
		.split(",")
		.map(id => id.trim())
		.filter(Boolean);
	const unknown = wanted.filter(id => !all.some(task => task.id === id));
	if (unknown.length > 0) {
		throw new Error(`unknown task(s) ${unknown.join(", ")}; available: ${all.map(task => task.id).join(", ")}`);
	}
	return all.filter(task => wanted.includes(task.id));
}

async function run(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			model: { type: "string", short: "m" },
			tasks: { type: "string" },
			runs: { type: "string" },
			concurrency: { type: "string" },
			thinking: { type: "string" },
			"append-system-prompt": { type: "string" },
			"system-prompt-template": { type: "string" },
			timeout: { type: "string" },
			label: { type: "string" },
			output: { type: "string" },
		},
		strict: true,
	});
	const model = values.model;
	if (!model) throw new Error("--model <provider/id> is required");
	const thinking = values.thinking === undefined ? undefined : parseCliThinkingLevel(values.thinking);
	if (values.thinking !== undefined && thinking === undefined) {
		throw new Error(`--thinking must be one of ${CLI_THINKING_LEVELS.join(", ")}`);
	}
	const tasks = selectTasks(await loadTasks(), values.tasks);
	const runs = positiveInt(values.runs, "--runs", 1);
	const concurrency = positiveInt(values.concurrency, "--concurrency", 1);
	const timeoutSec = positiveInt(values.timeout, "--timeout", 600);
	const appendFile = values["append-system-prompt"];
	const templateFile = values["system-prompt-template"];

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const output = path.resolve(
		values.output ?? path.join(RUNS_DIR, values.label ?? `${model.replace(/[^a-zA-Z0-9]+/g, "-")}-${stamp}`, "result.json"),
	);
	const jobDir = path.dirname(output);
	const reportPath = path.join(jobDir, "report.md");
	await fs.mkdir(path.join(jobDir, "traces"), { recursive: true });

	const trialConfig: TrialConfig = {
		model,
		thinking,
		appendSystemPrompt: appendFile === undefined ? undefined : await Bun.file(appendFile).text(),
		systemPromptTemplate: templateFile === undefined ? undefined : await Bun.file(templateFile).text(),
		timeoutMs: timeoutSec * 1000,
		jobDir,
	};
	const result: ScopeResult = {
		config: {
			label: values.label ?? path.basename(jobDir),
			model,
			thinking: thinking ?? null,
			appendSystemPrompt: appendFile ?? null,
			systemPromptTemplate: templateFile ?? null,
			tasks: tasks.map(task => task.id),
			runs,
			concurrency,
			timeoutSec,
		},
		startedAt: new Date().toISOString(),
		finishedAt: null,
		total: tasks.length * runs,
		runs: [],
		summary: summarize([]),
	};

	let writes = Promise.resolve();
	const save = (): Promise<void> => {
		const json = JSON.stringify(result, null, "\t");
		const report = renderReport(result);
		writes = writes.then(async () => {
			await Bun.write(output, json);
			await Bun.write(reportPath, report);
		});
		return writes;
	};
	await save();
	// An interrupted run still leaves the finished runs behind.
	const unregister = postmortem.register("scope-benchmark-result", async reason => {
		if (reason !== postmortem.Reason.EXIT) await save();
	});

	log(`scope benchmark · ${result.config.label}`);
	log(`  model ${model} · thinking ${thinking ?? "default"} · ${tasks.length} tasks × ${runs} runs · concurrency ${concurrency}`);
	if (appendFile) log(`  append ${appendFile}`);
	if (templateFile) log(`  template ${templateFile}`);
	log(`  ${output}`);

	const shared = await discoverSharedInfra();
	const queue = tasks.flatMap(task => Array.from({ length: runs }, (_, index) => ({ task, attempt: index + 1 })));
	try {
		const worker = async (): Promise<void> => {
			for (let job = queue.shift(); job; job = queue.shift()) {
				const finished = await runTrial(job.task, job.attempt, trialConfig, shared);
				result.runs.push(finished);
				result.summary = summarize(result.runs);
				log(progressLine(finished));
				await save();
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
	} finally {
		shared.authStorage.close();
	}
	result.finishedAt = new Date().toISOString();
	await save();
	unregister();
	log(`report: ${reportPath}`);
}

/** `compare <a> <b>` prints an arm comparison; anything else runs the benchmark. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
	if (argv[0] === "compare") return compare(argv.slice(1));
	return run(argv);
}

if (import.meta.main) {
	postmortem.installProcessHandlers();
	main()
		.then(async () => {
			// In-process sessions can leave provider keep-alive sockets open after the report is written.
			await postmortem.quit(Number(process.exitCode ?? 0));
		})
		.catch(async error => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			await postmortem.quit(1);
		});
}
