/**
 * `omp if-bench` — instruction-following and working-memory benchmark.
 *
 * One cacheable conversation per model: turn N issues N glyph actions over the
 * array the model itself reported last turn, while a `nya{1,N}` directive
 * rotates through the start, middle, and end of the prompt. A model's score is
 * the depth it reaches before it either loses the array or drops the cat sound,
 * which makes the two failure modes separable from a single reply.
 */
import { streamSimple } from "@oh-my-pi/pi-ai";
import chalk from "@oh-my-pi/pi-utils/chalk";
import {
	type BenchRuntime,
	createDefaultBenchRuntime,
	resolveBenchTargets,
	type StreamSimpleFn,
} from "../cli/bench-runtime";
import type { LiveBoardOutput } from "../cli/live-board";
import { initialArray } from "./actions";
import { createIfBenchBoard, formatIfBenchScoreboard } from "./board";
import { DEFAULT_NYA_MAX } from "./protocol";
import { type IfBenchSummary, runIfBench } from "./runner";

const DEFAULT_TURNS = 24;
const DEFAULT_ARRAY_LENGTH = 24;
const DEFAULT_MAX_TOKENS = 32_768;
const DEFAULT_PAR = 4;

export interface IfBenchCommandArgs {
	models: string[];
	flags: {
		turns?: number;
		length?: number;
		maxTokens?: number;
		nyaMax?: number;
		par?: number;
		json?: boolean;
	};
}

export interface IfBenchDependencies {
	createRuntime?: () => Promise<BenchRuntime>;
	streamSimple?: StreamSimpleFn;
	now?: () => number;
	randomSessionId?: () => string;
	sleep?: (ms: number) => Promise<void>;
	writeStdout?: (text: string) => void;
	writeStderr?: (text: string) => void;
	setExitCode?: (code: number) => void;
	stdoutIsTTY?: boolean;
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`Expected --${name} to be a positive integer, got ${value}`);
	}
	return value;
}

/** Resolve selectors, run every thread, and render the live board plus scoreboard. */
export async function runIfBenchCommand(
	command: IfBenchCommandArgs,
	deps: IfBenchDependencies = {},
): Promise<IfBenchSummary> {
	if (command.models.length === 0) {
		throw new Error("Pass at least one model selector, e.g. `omp if-bench opus gpt-5.2`");
	}
	const maxTurns = positiveInteger("turns", command.flags.turns, DEFAULT_TURNS);
	const arrayLength = positiveInteger("length", command.flags.length, DEFAULT_ARRAY_LENGTH);
	const maxTokens = positiveInteger("max-tokens", command.flags.maxTokens, DEFAULT_MAX_TOKENS);
	const nyaMax = positiveInteger("nya-max", command.flags.nyaMax, DEFAULT_NYA_MAX);
	const par = positiveInteger("par", command.flags.par, DEFAULT_PAR);
	const json = command.flags.json === true;
	// Fail on an unusable array length before opening the auth vault.
	initialArray(arrayLength);

	const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
	const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
	const setExitCode =
		deps.setExitCode ??
		((code: number) => {
			process.exitCode = code;
		});
	const interactive = deps.stdoutIsTTY ?? process.stdout.isTTY === true;
	const stdout: LiveBoardOutput = {
		isTTY: interactive && !json,
		get columns() {
			return process.stdout.columns;
		},
		get rows() {
			return process.stdout.rows;
		},
		write(text: string): boolean {
			writeStdout(text);
			return true;
		},
	};
	const stderr: LiveBoardOutput = {
		write(text: string): boolean {
			writeStderr(text);
			return true;
		},
	};
	const board = json ? undefined : createIfBenchBoard({ maxTurns, arrayLength, nyaMax }, stdout, stderr);

	const runtime = await (deps.createRuntime ?? createDefaultBenchRuntime)();
	try {
		const targets = resolveBenchTargets(command.models, runtime.modelRegistry, runtime.settings, writeStderr);
		board?.log(
			chalk.dim(
				`if-bench · ${targets.length} model${targets.length === 1 ? "" : "s"} · up to ${maxTurns} turns · array ${arrayLength} · nya{1,${nyaMax}} · temperature 0`,
			),
		);
		const summary = await runIfBench({
			targets,
			runtime,
			maxTurns,
			arrayLength,
			nyaMax,
			maxTokens,
			par,
			stream: deps.streamSimple ?? streamSimple,
			now: deps.now ?? (() => performance.now()),
			randomSessionId: deps.randomSessionId ?? (() => Bun.randomUUIDv7()),
			sleep: deps.sleep,
			observer: board,
		});
		board?.close();
		if (json) writeStdout(`${JSON.stringify(summary, null, 2)}\n`);
		else if (summary.models.length > 0) writeStdout(`\n${formatIfBenchScoreboard(summary)}`);
		if (summary.models.every(report => report.turnsPassed === 0)) setExitCode(1);
		return summary;
	} finally {
		board?.close();
		runtime.close?.();
	}
}
