/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The stdout board of `omp cleanse`.
 *
 * Interactive terminals get a transient live area repainted in place (the
 * `/cleanse` sheet's live rows: phase and checker spinners, the repair head
 * with its lane meter and the running lanes) while settled work — checker
 * verdicts, agent outcomes — prints permanently above it.
 *
 * Non-TTY output keeps the plain-line protocol (`[start]`/`[done]`/`[fail]`),
 * so scripted callers see unchanged output.
 */
import { untrack } from "@oh-my-pi/pi-tui";
import { sanitizeDisplaySingleLine } from "../extensibility/inventory/display-text";
import type { CleanseStatusBoard } from "../modes/view-model/apps/cleanse-board";
import { createLiveBoard, type LiveBoardOutput } from "../modes/view-model/chrome/live-board";
import { CleanseLive, CleanseLogLine, CleanseRun } from "../ui/overlays/panels/cleanse-panel";
import { printRows } from "../ui/print-rows";
import { truncateToWidth } from "../utils/text-width";

const ERROR_WIDTH = 300;

function outputWidth(output: LiveBoardOutput): number {
	const columns = output.columns ?? 0;
	return Number.isFinite(columns) && columns > 0 ? Math.trunc(columns) : 80;
}

/** Create the cleanse status board bound to `output` (default `process.stdout`). */
export function createCleanseStatusBoard(
	output: LiveBoardOutput = process.stdout,
	errors: LiveBoardOutput = process.stderr,
): CleanseStatusBoard {
	const run = new CleanseRun();
	const board = createLiveBoard(
		(_spinner, width) => printRows(() => <CleanseLive run={run} />, width, { motion: true }),
		output,
	);
	let printed = -1;
	/** Print the log entries the run added since the last call, permanently. */
	const settle = (): void => {
		for (const entry of untrack(run.log$)) {
			if (entry.id <= printed) continue;
			printed = entry.id;
			for (const row of printRows(() => <CleanseLogLine entry={entry} />, outputWidth(output))) board.log(row);
		}
		board.repaint();
	};

	return {
		interactive: board.interactive,
		log: board.log,
		phase(text) {
			if (!board.interactive) {
				if (text) output.write(`${text}\n`);
				return;
			}
			run.phase(text);
			board.repaint();
		},
		checkerStarted(checker) {
			if (!board.interactive) return;
			run.checkerStarted(checker);
			board.repaint();
		},
		checkerFinished(check, durationMs) {
			run.checkerFinished(check, durationMs);
			settle();
		},
		repairFinished() {
			run.repairFinished();
			board.repaint();
		},
		agentStarted(name, assignment) {
			if (!board.interactive) {
				const files = assignment.groups.map(group => group.file ?? "<project>").join(", ");
				output.write(`[start] ${name}: ${files} (weight ${assignment.weight})\n`);
				return;
			}
			run.agentStarted(name, assignment);
			board.repaint();
		},
		agentProgress(name, progress) {
			run.agentProgress(name, progress);
		},
		agentFinished(outcome, assignment) {
			if (board.interactive) {
				run.agentFinished(outcome, assignment);
				settle();
				return;
			}
			if (outcome.success) {
				output.write(`[done] ${outcome.name}${outcome.resolvedModel ? ` (${outcome.resolvedModel})` : ""}\n`);
				return;
			}
			const message = truncateToWidth(
				sanitizeDisplaySingleLine(outcome.error ?? "subagent failed")
					.replace(/\s+/g, " ")
					.trim(),
				ERROR_WIDTH,
			);
			errors.write(`[fail] ${outcome.name}: ${message}\n`);
		},
		close: () => {
			run.close();
			board.close();
		},
	};
}
