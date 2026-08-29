#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";
import { connect } from "@stencil-hq/vibemon";
import { prepareAgentBinaries } from "./agent";
import { loadTasks, resolveDataset } from "./dataset";
import { TbStore, type TbSummaryRow } from "./store";
import { runTrial } from "./trial";
import type { GatewayConfig, OpenRouterVariant, TbTask, TrialResult, TrialRow, VmonConfig } from "./types";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");

const FLASH_POOL = [
	"openrouter/inclusionai/ling-3.0-flash",
	"openrouter/deepseek/deepseek-v4-flash-0731",
	"openrouter/deepseek/deepseek-v4-flash",
	"openrouter/nvidia/nemotron-3.5-lightning",
	"openrouter/poolside/laguna-s-2.1",
	"openrouter/tencent/hy3",
	"openrouter/stepfun/step-3.7-flash",
];

const OPENROUTER_VARIANTS: Record<OpenRouterVariant, true> = {
	default: true,
	nitro: true,
	floor: true,
	online: true,
	exacto: true,
};

function isOpenRouterVariant(value: string): value is OpenRouterVariant {
	return value in OPENROUTER_VARIANTS;
}

interface Config {
	models: string[];
	dataset: string;
	include: string[];
	exclude: string[];
	attempts: number;
	concurrency: number;
	epochs: number;
	forever: boolean;
	budget: number | null;
	jobsDir: string;
	gatewayUrl: string;
	gatewayToken: string;
	openrouterVariant: OpenRouterVariant;
	rebuildAgent: boolean;
	vmonUrl: string;
	vmonToken: string;
	list: boolean;
	help: boolean;
}

interface WorkItem {
	model: string;
	task: TbTask;
	attempt: number;
}

const HELP = `Terminal-Bench 2.1 runner (local omp, remote Vibemon microVMs)

Usage: bun src/tb/cli.ts [options]

Options:
  -m, --model <provider/model>  Replace the default seven-model flash pool (repeatable)
      --dataset <path|git-url>  Dataset (default terminal-bench-2-1 GitHub repo)
  -i, --include <glob>          Include task names (repeatable)
  -x, --exclude <glob>          Exclude task names (repeatable)
  -k, --attempts <n>            Attempts per model/task (default 1)
  -c, --concurrency <n>         Concurrent trials (default 4)
      --epochs <n>              Epochs to run (default 1)
      --forever                 Run epochs until interrupted
      --budget <usd>            Stop scheduling in an epoch after this spend
      --jobs-dir <path>         Artifacts directory (default <repo>/runs/tb)
      --gateway-url <url>       Local omp auth gateway (default http://127.0.0.1:4000)
      --gateway-token <token>   Gateway token (default no-auth)
      --openrouter-variant <v>  Vendor routing: floor (default), nitro, default, online, exacto
      --rebuild-agent           Rebuild cached omp binaries
      --vmon-url <url>          vmond gateway URL (default http://xeon.internal:17970)
      --vmon-token <token>      vmond bearer token (default empty)
      --list                    Print resolved task names and exit
  -h, --help                    Show this help
`;

export function parseArgs(argv: string[]): Config {
	const config: Config = {
		models: [...FLASH_POOL],
		dataset: "https://github.com/harbor-framework/terminal-bench-2-1",
		include: [],
		exclude: [],
		attempts: 1,
		concurrency: 4,
		epochs: 1,
		forever: false,
		budget: null,
		jobsDir: path.join(REPO_ROOT, "runs", "tb"),
		gatewayUrl: "http://127.0.0.1:4000",
		gatewayToken: "no-auth",
		openrouterVariant: "floor",
		rebuildAgent: false,
		vmonUrl: "http://xeon.internal:17970",
		vmonToken: "",
		list: false,
		help: false,
	};
	let modelsSpecified = false;

	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i];
		let inlineValue: string | null = null;
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		if (equals !== -1) {
			inlineValue = arg.slice(equals + 1);
			arg = arg.slice(0, equals);
		}
		const take = (): string => {
			if (inlineValue !== null) return inlineValue;
			const value = argv[++i];
			if (value === undefined) throw new Error(`missing value for ${arg}`);
			return value;
		};
		switch (arg) {
			case "-m":
			case "--model":
				if (!modelsSpecified) {
					config.models = [];
					modelsSpecified = true;
				}
				config.models.push(take());
				break;
			case "--dataset":
				config.dataset = take();
				break;
			case "-i":
			case "--include":
				config.include.push(take());
				break;
			case "-x":
			case "--exclude":
				config.exclude.push(take());
				break;
			case "-k":
			case "--attempts":
				config.attempts = Number(take());
				break;
			case "-c":
			case "--concurrency":
				config.concurrency = Number(take());
				break;
			case "--epochs":
				config.epochs = Number(take());
				break;
			case "--forever":
				config.forever = true;
				break;
			case "--budget":
				config.budget = Number(take());
				break;
			case "--jobs-dir":
				config.jobsDir = path.resolve(take());
				break;
			case "--gateway-url":
				config.gatewayUrl = take();
				break;
			case "--gateway-token":
				config.gatewayToken = take();
				break;
			case "--openrouter-variant": {
				const value = take();
				if (!isOpenRouterVariant(value)) {
					throw new Error("--openrouter-variant must be default, nitro, floor, online, or exacto");
				}
				config.openrouterVariant = value;
				break;
			}
			case "--rebuild-agent":
				config.rebuildAgent = true;
				break;
			case "--vmon-url":
				config.vmonUrl = take();
				break;
			case "--vmon-token":
				config.vmonToken = take();
				break;
			case "--list":
				config.list = true;
				break;
			case "-h":
			case "--help":
				config.help = true;
				break;
			default:
				throw new Error(`unknown option: ${arg}`);
		}
	}

	if (config.help) return config;
	if (config.models.length === 0) throw new Error("at least one --model is required");
	for (const model of config.models) {
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1) throw new Error(`invalid model ${model}; expected provider/model`);
	}
	for (const [flag, value] of [
		["--attempts", config.attempts],
		["--concurrency", config.concurrency],
		["--epochs", config.epochs],
	] as const) {
		if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`);
	}
	if (config.budget !== null && (!Number.isFinite(config.budget) || config.budget < 0)) {
		throw new Error("--budget must be a non-negative number");
	}
	return config;
}

class Semaphore {
	#available: number;
	#queue: Array<() => void> = [];

	constructor(available: number) {
		this.#available = available;
	}

	async acquire(): Promise<void> {
		if (this.#available > 0) {
			this.#available--;
			return;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#queue.push(resolve);
		await promise;
	}

	release(): void {
		const next = this.#queue.shift();
		if (next) next();
		else this.#available++;
	}
}

function shuffled<T>(values: T[]): T[] {
	const result = [...values];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j]!, result[i]!];
	}
	return result;
}

function duration(ms: number): string {
	const totalSeconds = Math.round(ms / 1_000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function pad(value: string | number, width: number, right = false): string {
	const text = String(value);
	return right ? text.padEnd(width) : text.padStart(width);
}

function printSummary(epoch: number, rows: TbSummaryRow[], overall: TbSummaryRow[]): void {
	console.log(`\nEpoch ${epoch} summary`);
	console.log(
		`${pad("model", 28, true)} ${pad("trials", 6)} ${pad("pass", 5)} ${pad("pass%", 7)} ${pad("reward", 7)} ${pad("timeouts", 8)} ${pad("errors", 6)} ${pad("tokens in/out", 19)} ${pad("cost", 9)} ${pad("turns", 7)} ${pad("agent min", 9)}`,
	);
	for (const row of rows) {
		const passPercent = row.trials === 0 ? 0 : (row.passed / row.trials) * 100;
		console.log(
			`${pad(row.model, 28, true)} ${pad(row.trials, 6)} ${pad(row.passed, 5)} ${pad(`${passPercent.toFixed(1)}%`, 7)} ${pad(row.meanReward.toFixed(3), 7)} ${pad(row.agentTimeouts, 8)} ${pad(row.errors, 6)} ${pad(`${row.inputTokens}/${row.outputTokens}`, 19)} ${pad(`$${row.costUsd.toFixed(3)}`, 9)} ${pad(row.meanTurns.toFixed(1), 7)} ${pad((row.meanAgentMs / 60_000).toFixed(1), 9)}`,
		);
	}
	console.log("\nCumulative pass rate");
	for (const row of overall) {
		const passPercent = row.trials === 0 ? 0 : (row.passed / row.trials) * 100;
		console.log(`${pad(row.model, 28, true)} ${row.passed}/${row.trials} (${passPercent.toFixed(1)}%)`);
	}
}

async function probeGateway(gatewayUrl: string): Promise<void> {
	try {
		const url = new URL(gatewayUrl);
		url.pathname = "/healthz";
		url.search = "";
		url.hash = "";
		const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
		if (!response.ok) console.warn(`warning: gateway health probe returned HTTP ${response.status}`);
	} catch (error) {
		console.warn(`warning: gateway health probe failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function preflightVmon(url: string, token: string): Promise<void> {
	const client = connect(url, { token: token || undefined });
	try {
		await client.health();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Cannot reach vmond at ${url}: ${detail}. Ensure vmon serve is running and the URL/token are correct.`,
		);
	} finally {
		await client.close();
	}
}

function trialRow(epoch: number, item: WorkItem, result: TrialResult, trialDir: string, startedAt: number): TrialRow {
	return {
		epoch,
		model: item.model,
		task: item.task.name,
		attempt: item.attempt,
		status: result.status,
		reward: result.reward,
		agentTimedOut: result.agentTimedOut,
		inputTokens: result.usage.input,
		outputTokens: result.usage.output,
		cacheReadTokens: result.usage.cacheRead,
		cacheWriteTokens: result.usage.cacheWrite,
		costUsd: result.usage.costUsd,
		turns: result.usage.turns,
		agentMs: result.agentMs,
		verifierMs: result.verifierMs,
		wallMs: result.wallMs,
		error: result.error ?? null,
		trialDir,
		startedAt,
		finishedAt: Date.now(),
	};
}

export async function main(argv: string[]): Promise<void> {
	const config = parseArgs(argv);
	if (config.help) {
		console.log(HELP);
		return;
	}
	fs.mkdirSync(config.jobsDir, { recursive: true });
	const tasksDir = await resolveDataset(config.dataset, path.join(config.jobsDir, "_dataset"));
	const tasks = await loadTasks(tasksDir, { include: config.include, exclude: config.exclude });
	if (config.list) {
		for (const task of tasks) console.log(task.name);
		return;
	}
	if (tasks.length === 0) throw new Error("no tasks matched the requested filters");

	const providers = [...new Set(config.models.map(model => model.slice(0, model.indexOf("/"))))];
	const gateway: GatewayConfig = {
		url: config.gatewayUrl,
		token: config.gatewayToken,
		providers,
		openrouterVariant: config.openrouterVariant,
	};
	await probeGateway(config.gatewayUrl);
	console.log(`vmon: checking ${config.vmonUrl}`);
	await preflightVmon(config.vmonUrl, config.vmonToken);
	const vmon: VmonConfig = {
		url: config.vmonUrl,
		token: config.vmonToken,
		arch: "x64",
	};
	const binaries = await prepareAgentBinaries({
		arches: [vmon.arch],
		cacheDir: path.join(config.jobsDir, "_agent"),
		rebuild: config.rebuildAgent,
	});
	const store = new TbStore(path.join(config.jobsDir, "tb.sqlite"));
	let stopping = false;
	let signals = 0;
	const onSignal = (): void => {
		signals++;
		if (signals > 1) process.exit(130);
		stopping = true;
		console.log("\ninterrupt received; stopping new trials and waiting for in-flight trials");
	};
	process.on("SIGINT", onSignal);

	try {
		let epoch = store.resumeEpoch() ?? store.beginEpoch();
		let epochsStarted = 0;
		while (!stopping && (config.forever || epochsStarted < config.epochs)) {
			epochsStarted++;
			const completedKeys = store.completedKeys(epoch);
			const work = shuffled(
				config.models
					.flatMap(model =>
						tasks.flatMap(task =>
							Array.from({ length: config.attempts }, (_, index) => ({ model, task, attempt: index + 1 })),
						),
					)
					.filter(item => !completedKeys.has(`${item.model}\u0000${item.task.name}\u0000${item.attempt}`)),
			);
			const total = work.length;
			let completed = 0;
			let budgetLogged = false;
			const semaphore = new Semaphore(config.concurrency);
			await Promise.all(
				work.map(async item => {
					await semaphore.acquire();
					try {
						if (stopping) return;
						if (config.budget !== null && store.epochSpend(epoch) >= config.budget) {
							if (!budgetLogged) {
								budgetLogged = true;
								console.log(
									`epoch ${epoch} budget reached ($${store.epochSpend(epoch).toFixed(3)} / $${config.budget.toFixed(3)}); stopping new trials`,
								);
							}
							return;
						}
						const modelDir = item.model.replaceAll("/", "_");
						const absoluteTrialDir = path.join(
							config.jobsDir,
							"trials",
							`e${epoch}`,
							modelDir,
							`${item.task.name}-a${item.attempt}`,
						);
						const startedAt = Date.now();
						const result = await runTrial({
							task: item.task,
							model: item.model,
							binaries,
							gateway,
							vmon,
							trialDir: absoluteTrialDir,
							log: line => console.log(`[${item.task.name}] ${line}`),
						});
						store.insertTrial(
							trialRow(epoch, item, result, path.relative(config.jobsDir, absoluteTrialDir), startedAt),
						);
						completed++;
						console.log(
							`[e${epoch} ${completed}/${total}] ${result.status} ${item.task.name} ${item.model} reward=${result.reward ?? "-"} $${result.usage.costUsd.toFixed(3)} ${duration(result.wallMs)}`,
						);
					} finally {
						semaphore.release();
					}
				}),
			);

			if (stopping) break;
			store.finishEpoch(epoch);
			printSummary(epoch, store.epochSummary(epoch), store.overallSummary());
			if (!config.forever && epochsStarted >= config.epochs) break;
			epoch = store.beginEpoch();
		}
	} finally {
		process.off("SIGINT", onSignal);
		store.close();
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
