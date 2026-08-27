import { getProjectDir } from "@oh-my-pi/pi-utils";
import { pickCleanseTarget, promptCleanseRequest } from "../cli/cleanse-picker";
import { shortenPath } from "../tools/render-utils";
import { type CleanseAgentHooks, type CleanseAgentRuntime, createCleanseAgentRuntime } from "./agent";
import { groupDiagnosticsByFile } from "./balance";
import { type CleanseStatusBoard, createCleanseStatusBoard } from "./board";
import {
	buildCustomCleanseSuite,
	type CleanseCheckerDescriptor,
	type CleanseCheckerRunEvents,
	type CleanseDiagnosticSuite,
	discoverCleanseDiagnosticSuite,
} from "./checkers";
import { runCleanseLoop } from "./loop";
import type { CleanseCommandResult, CleanseDiagnosticReport, CleanseLoopResult, CleanseTargetChoice } from "./types";

const DEFAULT_MODEL = "@smol";
const DISPLAY_FILE_LIMIT = 50;

/** User-facing options for `omp cleanse`. */
export interface CleanseCommandOptions {
	maxAgents?: number;
	model?: string;
	includeTests?: boolean;
	/** Free-form description handed to a discovery agent instead of built-in checker discovery. */
	request?: string;
	/** Run every discovered checker without the interactive picker. */
	all?: boolean;
}

/** Rendering and prompting seam for one cleanse run; satisfied by the CLI streams and the TUI overlay. */
export interface CleanseRunUi {
	board: CleanseStatusBoard;
	/** Permanent user-facing summary line. */
	print(text: string): void;
	/** Permanent failure/cancellation line. */
	printError(text: string): void;
	/** Choose between discovered checkers; omit to run every checker without prompting. */
	pickTarget?(checkers: readonly CleanseCheckerDescriptor[]): Promise<CleanseTargetChoice>;
	/** Free-form request prompt when no runnable checker was discovered; `null` cancels. */
	promptRequest?(): Promise<string | null>;
}

/**
 * Detect project diagnostics, dispatch one bounded repair batch, and verify it.
 *
 * Cancellation flows exclusively through `signal`; the caller owns signal
 * sources (SIGINT for the CLI, Esc for the interactive overlay).
 */
export async function runCleanse(
	options: CleanseCommandOptions,
	ui: CleanseRunUi,
	signal: AbortSignal,
): Promise<CleanseCommandResult> {
	const maxAgents = options.maxAgents ?? 32;
	if (!Number.isInteger(maxAgents) || maxAgents <= 0) throw new Error("--agents must be a positive integer");
	const model = options.model?.trim() || DEFAULT_MODEL;
	const cwd = getProjectDir();
	let runtime: CleanseAgentRuntime | undefined;
	let runtimePromise: Promise<CleanseAgentRuntime> | undefined;
	let loopResult: CleanseLoopResult | undefined;
	const board = ui.board;
	const hooks: CleanseAgentHooks = {
		onStart: (name, assignment) => board.agentStarted(name, assignment),
		onProgress: (name, _assignment, progress) => board.agentProgress(name, progress),
		onFinish: (outcome, assignment) => board.agentFinished(outcome, assignment),
	};
	const checkerEvents: CleanseCheckerRunEvents = {
		onCheckerStart: checker => board.checkerStarted(checker),
		onCheckerEnd: (check, durationMs) => board.checkerFinished(check, durationMs),
	};
	const ensureRuntime = async (): Promise<CleanseAgentRuntime> => {
		runtimePromise ??= (async () => {
			board.phase(`Resolving model ${model}...`);
			try {
				runtime = await createCleanseAgentRuntime({ cwd, model, hooks });
			} finally {
				board.phase(undefined);
			}
			board.log(`Model: ${runtime.model}`);
			board.log(`Session: ${shortenPath(runtime.sessionFile)}`);
			return runtime;
		})();
		return runtimePromise;
	};

	try {
		let request = options.request?.trim() || undefined;
		let suite: CleanseDiagnosticSuite | undefined;
		if (!request) {
			board.phase("Detecting configured project checkers...");
			suite = await discoverCleanseDiagnosticSuite(cwd, { includeTests: options.includeTests });
			board.phase(undefined);
			const pickTarget = options.all === true ? undefined : ui.pickTarget;
			if (pickTarget) {
				if (suite.checkers.length > 0) {
					const choice = await pickTarget(suite.checkers);
					if (choice.kind === "cancel") {
						ui.printError("Cleanse cancelled.");
						return {
							exitCode: 130,
							status: "cancelled",
							report: { checks: [], diagnostics: [], skipped: [...suite.skipped] },
						};
					}
					if (choice.kind === "checker") suite.select([choice.id]);
					if (choice.kind === "request") {
						request = choice.request;
						suite = undefined;
					}
				} else {
					printSkippedChecks(ui, { checks: [], diagnostics: [], skipped: [...suite.skipped] });
					ui.print("No supported checker with an available executable was found.");
					const answer = (await ui.promptRequest?.()) ?? null;
					if (answer === null) {
						return {
							exitCode: 1,
							status: "unsupported",
							report: { checks: [], diagnostics: [], skipped: [...suite.skipped] },
						};
					}
					request = answer;
					suite = undefined;
				}
			}
		}
		if (request) {
			const activeRuntime = await ensureRuntime();
			board.phase(`Discovering checkers for "${request}"...`);
			try {
				const specs = await activeRuntime.discoverCheckers(request, signal);
				suite = await buildCustomCleanseSuite(cwd, specs);
			} finally {
				board.phase(undefined);
			}
			for (const checker of suite.checkers) {
				board.log(`[checker] ${checker.label}: ${checker.command}`);
			}
		}
		if (!suite || suite.checkers.length === 0) {
			const report: CleanseDiagnosticReport = { checks: [], diagnostics: [], skipped: [...(suite?.skipped ?? [])] };
			printSkippedChecks(ui, report);
			ui.printError(
				request
					? "Checker discovery produced no runnable command."
					: "No supported checker with an available executable was found.",
			);
			return { exitCode: 1, status: "unsupported", report, sessionFile: runtime?.sessionFile };
		}
		printSkippedChecks(ui, { checks: [], diagnostics: [], skipped: [...suite.skipped] });
		const activeSuite = suite;
		loopResult = await runCleanseLoop(
			{ maxAgents, signal },
			{
				collect: (onDiagnostics, loopSignal) =>
					activeSuite.run({
						signal: loopSignal,
						events: {
							...checkerEvents,
							onDiagnostics: (_checker, diagnostics) => onDiagnostics(diagnostics),
						},
					}),
				verify: loopSignal => activeSuite.run({ signal: loopSignal, events: checkerEvents }),
				dispatch: async (assignment, worker, peers, loopSignal) => {
					const activeRuntime = await ensureRuntime();
					return activeRuntime.dispatchWorker(
						assignment,
						{ worker, peers, checkers: activeSuite.selected },
						loopSignal,
					);
				},
				followUp: async (worker, diagnostics) => {
					const delivered = (await runtime?.followUp(worker, diagnostics)) ?? false;
					if (delivered) {
						board.log(
							`CleanseA${worker} ← ${diagnostics.length} follow-up diagnostic${diagnostics.length === 1 ? "" : "s"}`,
						);
					}
					return delivered;
				},
				onCollected(report) {
					if (report.diagnostics.length === 0) return;
					const groups = groupDiagnosticsByFile(report.diagnostics);
					const fileCount = groups.filter(group => group.file !== undefined).length;
					board.log(
						`Checkers done: ${report.diagnostics.length} diagnostic${report.diagnostics.length === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"}.`,
					);
				},
				onVerified(report) {
					board.repairFinished();
					board.log(
						`Verification: ${report.diagnostics.length} diagnostic${report.diagnostics.length === 1 ? "" : "s"} remaining.`,
					);
				},
			},
		);
		board.close();
		await runtime?.close(loopResult);
		if (loopResult.status === "cancelled") {
			ui.printError("Cleanse cancelled.");
			return {
				exitCode: 130,
				status: "cancelled",
				report: loopResult.report,
				sessionFile: runtime?.sessionFile,
			};
		}
		if (loopResult.status === "clean") {
			ui.print(
				loopResult.workers === 0
					? `Clean: ${loopResult.report.checks.length} checker${loopResult.report.checks.length === 1 ? "" : "s"} passed.`
					: "Clean: all detected diagnostics are resolved.",
			);
			return { exitCode: 0, status: "clean", report: loopResult.report, sessionFile: runtime?.sessionFile };
		}
		printRemaining(ui, loopResult.report);
		return { exitCode: 1, status: "unresolved", report: loopResult.report, sessionFile: runtime?.sessionFile };
	} catch (error) {
		if (!signal.aborted) throw error;
		const report: CleanseDiagnosticReport = loopResult?.report ?? { checks: [], diagnostics: [], skipped: [] };
		board.close();
		ui.printError("Cleanse cancelled.");
		return { exitCode: 130, status: "cancelled", report, sessionFile: runtime?.sessionFile };
	} finally {
		board.close();
		await runtime?.close(loopResult);
	}
}

/** CLI adapter for {@link runCleanse}: stdout board, one-shot pickers, SIGINT/SIGTERM cancellation. */
export async function runCleanseCommand(options: CleanseCommandOptions = {}): Promise<CleanseCommandResult> {
	const abortController = new AbortController();
	const abort = (): void => abortController.abort(new Error("Cleanse interrupted"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
	const ui: CleanseRunUi = {
		board: createCleanseStatusBoard(),
		print: text => process.stdout.write(`${text}\n`),
		printError: text => process.stderr.write(`${text}\n`),
		pickTarget: interactive ? pickCleanseTarget : undefined,
		promptRequest: interactive ? promptCleanseRequest : undefined,
	};
	try {
		return await runCleanse(options, ui, abortController.signal);
	} finally {
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
	}
}

function printSkippedChecks(ui: CleanseRunUi, report: CleanseDiagnosticReport): void {
	for (const skipped of report.skipped) {
		ui.print(`- ${skipped.label}: skipped (${skipped.reason})`);
	}
}

function printRemaining(ui: CleanseRunUi, report: CleanseDiagnosticReport): void {
	const groups = groupDiagnosticsByFile(report.diagnostics);
	ui.printError(`Unresolved: ${report.diagnostics.length} diagnostic${report.diagnostics.length === 1 ? "" : "s"}.`);
	for (const group of groups.slice(0, DISPLAY_FILE_LIMIT)) {
		ui.printError(`- ${group.file ?? "<project>"}: ${group.diagnostics.length}`);
	}
	if (groups.length > DISPLAY_FILE_LIMIT) {
		ui.printError(`- ... ${groups.length - DISPLAY_FILE_LIMIT} more files`);
	}
}
