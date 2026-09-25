/**
 * Live board and scoreboard for `omp if-bench`.
 *
 * Interactive terminals get one repainted row per model — a turn ladder that
 * fills as turns pass, the in-flight turn as a spinner cell, and the live
 * position of the cat directive — plus a permanent verdict line per model as it
 * settles. Non-TTY output falls back to one plain line per turn so scripted
 * callers keep a parseable trace.
 */

import { replaceTabs, truncateToWidth } from "../utils";
import { renderTableRow, type TableColumn } from "../components/table";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { fgOrPlain, theme } from "../theme/theme";
import { createLiveBoard, type LiveBoardOutput } from "../chrome/live-board";

/** Failure category displayed in benchmark verdicts. */
export type IfBenchFailure = "result" | "cat" | "result+cat" | "format" | "provider";

/** Scored turn fields consumed by the live board and failure details. */
export interface IfBenchTurnRecord {
	turn: number;
	cumulativeActions: number;
	placement: string;
	durationMs: number;
	passed: boolean;
	failure?: IfBenchFailure;
	expected: string;
	response: string;
}

/** Per-model scoreboard and verdict fields. */
export interface IfBenchModelReport {
	label: string;
	turns: readonly IfBenchTurnRecord[];
	turnsPassed: number;
	actionsPassed: number;
	failure?: { turn: number; kind: IfBenchFailure };
	durationMs: number;
	outputTokens: number;
	cost: number;
}

/** Benchmark results consumed by the ranked scoreboard. */
export interface IfBenchSummary {
	maxTurns: number;
	models: readonly IfBenchModelReport[];
}

/** Optional live-progress callbacks accepted by a benchmark runner. */
export interface IfBenchObserver<
	Turn extends IfBenchTurnRecord = IfBenchTurnRecord,
	Report extends IfBenchModelReport = IfBenchModelReport,
> {
	modelStarted?(label: string): void;
	turnStarted?(label: string, turn: number, actions: number): void;
	turnFinished?(label: string, record: Turn): void;
	modelFinished?(report: Report): void;
}

const LADDER_WIDTH = 28;
const LABEL_WIDTH = 34;
const DETAIL_WIDTH = 120;

/** Human-readable verdict for each scored failure mode. */
const FAILURE_TEXT: Record<IfBenchFailure, string> = {
	result: "wrong array",
	cat: "no cat sound",
	"result+cat": "wrong array + no cat sound",
	format: "no <result> block",
	provider: "provider error",
};

/** Rendering surface for one `omp if-bench` run. */
export interface IfBenchBoard extends IfBenchObserver {
	readonly interactive: boolean;
	/** Print a permanent line above the live rows (plain write when non-TTY). */
	log(text: string): void;
	/** Clear the live area and restore the cursor. Idempotent. */
	close(): void;
}

interface RowState {
	startedAt: number;
	turn: number;
	actions: number;
	passed: number;
	failed: boolean;
	placement: string;
	lastDurationMs: number;
}

/** Static run parameters shown in the board header. */
export interface IfBenchBoardMeta {
	maxTurns: number;
	arrayLength: number;
	nyaMax: number;
}

/**
 * Create the if-bench board bound to `output`.
 *
 * `errors` receives non-TTY failure lines so a piped stdout stays a clean
 * turn-by-turn trace.
 */
export function createIfBenchBoard(
	meta: IfBenchBoardMeta,
	output: LiveBoardOutput = process.stdout,
	errors: LiveBoardOutput = process.stderr,
): IfBenchBoard {
	const rows = new Map<string, RowState>();
	const startedAt = Date.now();
	const board = createLiveBoard(spinner => renderLive(meta, rows, spinner, startedAt), output);

	return {
		interactive: board.interactive,
		log: board.log,
		modelStarted(label) {
			rows.set(label, {
				startedAt: Date.now(),
				turn: 0,
				actions: 0,
				passed: 0,
				failed: false,
				placement: "",
				lastDurationMs: 0,
			});
			board.repaint();
		},
		turnStarted(label, turn) {
			const row = rows.get(label);
			if (!row) return;
			row.turn = turn;
			board.repaint();
		},
		turnFinished(label, record) {
			const row = rows.get(label);
			if (row) {
				row.actions = record.cumulativeActions;
				row.placement = record.placement;
				row.lastDurationMs = record.durationMs;
				if (record.passed) row.passed = record.turn;
				else row.failed = true;
				board.repaint();
			}
			if (!board.interactive) {
				const sink = record.passed ? output : errors;
				sink.write(`${formatTurnLine(label, record)}\n`);
			}
		},
		modelFinished(report) {
			rows.delete(report.label);
			board.log(formatVerdict(report, meta));
			if (report.failure) {
				for (const line of failureDetail(report)) board.log(line);
			}
		},
		close: board.close,
	};
}

function renderLive(
	meta: IfBenchBoardMeta,
	rows: ReadonlyMap<string, RowState>,
	spinner: string,
	startedAt: number,
): string[] {
	if (rows.size === 0) return [];
	const deepest = Math.max(0, ...[...rows.values()].map(row => row.actions));
	const header =
		`${fgOrPlain("accent", spinner)} ${theme ? theme.bold("if-bench") : "if-bench"} ${fgOrPlain("dim", "·")} ` +
		`${rows.size} live ${fgOrPlain("dim", "·")} ${deepest} actions ${fgOrPlain("dim", "·")} ` +
		`${fgOrPlain("dim", `L=${meta.arrayLength} nya{1,${meta.nyaMax}}`)} ${fgOrPlain("dim", "·")} ` +
		`${formatDuration(Date.now() - startedAt)}`;
	const lines = [header];
	for (const [label, row] of rows) {
		const meterCells = ladder(row, meta.maxTurns, spinner);
		const parts = [
			`turn ${Math.max(row.turn, 1)}/${meta.maxTurns}`,
			`${row.actions} acts`,
			formatDuration(Date.now() - row.startedAt),
		];
		if (row.placement) parts.push(fgOrPlain("dim", `cat@${row.placement}`));
		lines.push(
			renderTableRow(
				[
					{ text: spinner, style: text => fgOrPlain("warning", text) },
					{ text: label },
					{ text: meterCells },
					{ text: parts.join(fgOrPlain("dim", " · ")) },
				],
				LIVE_ROW_COLUMNS[Math.min(meta.maxTurns, LADDER_WIDTH)]!,
				undefined,
				{ indent: "  ", gap: " " },
			),
		);
	}
	return lines;
}

const LIVE_ROW_COLUMNS: readonly (readonly TableColumn[])[] = Array.from(
	{ length: LADDER_WIDTH + 1 },
	(_, meterWidth): readonly TableColumn[] => [
		{ width: 1, align: "left", overflow: "truncate" },
		{ width: LABEL_WIDTH, align: "left", overflow: "truncate" },
		{ width: meterWidth, align: "left", overflow: "truncate" },
		{ width: DETAIL_WIDTH, align: "left", overflow: "allow" },
	],
);

/**
 * Turn meter: filled cells for passed turns, a spinner cell for the in-flight
 * turn, dim cells for the remaining budget. Scales to {@link LADDER_WIDTH} when
 * the turn budget is larger so the row never wraps.
 */
function ladder(row: RowState, maxTurns: number, spinner: string): string {
	const width = Math.min(maxTurns, LADDER_WIDTH);
	const scale = width / maxTurns;
	const filled = Math.min(width, Math.round(row.passed * scale));
	const active = row.failed || filled >= width ? 0 : Math.max(0, Math.min(width - filled, Math.round(scale)) || 1);
	const rest = Math.max(0, width - filled - active);
	return (
		fgOrPlain("success", "█".repeat(filled)) +
		(row.failed ? fgOrPlain("error", "▚") : fgOrPlain("warning", spinner.repeat(active))) +
		fgOrPlain("dim", "░".repeat(rest))
	);
}

function formatTurnLine(label: string, record: IfBenchTurnRecord): string {
	const head = `[turn ${record.turn}] ${label} ${record.cumulativeActions} acts cat@${record.placement}`;
	if (record.passed) return `${head} PASS ${formatDuration(Math.round(record.durationMs))}`;
	return `${head} FAIL ${record.failure ?? "format"}`;
}

function formatVerdict(report: IfBenchModelReport, meta: IfBenchBoardMeta): string {
	const stats = [
		`${report.turnsPassed}/${meta.maxTurns} turns`,
		`${report.actionsPassed} actions`,
		`${formatDuration(Math.round(meanTurnMs(report)))}/turn`,
	];
	if (report.outputTokens > 0) stats.push(`${formatNumber(report.outputTokens)} tok`);
	if (report.cost > 0) stats.push(formatCost(report.cost));
	const body = `${theme ? theme.bold(report.label) : report.label} ${stats.join(fgOrPlain("dim", " · "))}`;
	if (!report.failure) return `${fgOrPlain("success", "✓")} ${body}`;
	return `${fgOrPlain("error", "✗")} ${body} ${fgOrPlain("dim", "·")} ${fgOrPlain("error", `broke on turn ${report.failure.turn}: ${FAILURE_TEXT[report.failure.kind]}`)}`;
}

/** Expected/actual pair for the turn that ended a run, clipped for the terminal. */
function failureDetail(report: IfBenchModelReport): string[] {
	const failed = report.turns[report.turns.length - 1];
	if (!failed) return [];
	const oneLine = (text: string): string =>
		truncateToWidth(replaceTabs(text).replace(/\s+/g, " ").trim(), DETAIL_WIDTH);
	if (failed.failure === "provider")
		return [`    ${fgOrPlain("dim", "provider")} ${fgOrPlain("error", oneLine(failed.response))}`];
	return [
		`    ${fgOrPlain("dim", "expected")} <${failed.expected}>`,
		`    ${fgOrPlain("dim", "actual  ")} ${oneLine(failed.response)}`,
	];
}

function meanTurnMs(report: IfBenchModelReport): number {
	if (report.turns.length === 0) return 0;
	return report.durationMs / report.turns.length;
}

function formatCost(cost: number): string {
	return `$${cost >= 0.095 ? cost.toFixed(2) : cost.toFixed(3)}`;
}

interface ScoreboardColumn {
	header: string;
	value(report: IfBenchModelReport): string;
	align?: "right";
}

/**
 * Ranked comparison table: depth first (turns, then actions), latency only as a
 * tie-break, because surviving one more turn always beats answering faster.
 */
export function formatIfBenchScoreboard(summary: IfBenchSummary): string {
	const ranked = [...summary.models].sort(
		(a, b) => b.turnsPassed - a.turnsPassed || b.actionsPassed - a.actionsPassed || meanTurnMs(a) - meanTurnMs(b),
	);
	const columns: ScoreboardColumn[] = [
		{ header: "model", value: report => report.label },
		{ header: "turns", value: report => `${report.turnsPassed}/${summary.maxTurns}`, align: "right" },
		{ header: "actions", value: report => String(report.actionsPassed), align: "right" },
		{
			header: "broke on",
			value: report =>
				report.failure ? `turn ${report.failure.turn} · ${FAILURE_TEXT[report.failure.kind]}` : "survived",
		},
		{ header: "per turn", value: report => formatDuration(Math.round(meanTurnMs(report))), align: "right" },
		{
			header: "tokens",
			value: report => (report.outputTokens > 0 ? formatNumber(report.outputTokens) : "-"),
			align: "right",
		},
		{ header: "cost", value: report => (report.cost > 0 ? formatCost(report.cost) : "-"), align: "right" },
	];
	const cells = ranked.map(report => columns.map(column => column.value(report)));
	const widths = columns.map((column, index) =>
		Math.max(column.header.length, ...cells.map(row => row[index]!.length)),
	);
	const tableColumns: TableColumn[] = columns.map((column, index): TableColumn => ({
		width: widths[index]!,
		align: column.align === "right" ? "right" : "left",
		overflow: "truncate",
	}));
	const layout = (row: string[]): string =>
		renderTableRow(
			row.map(cell => ({ text: cell })),
			tableColumns,
			undefined,
			{ gap: "  " },
		).trimEnd();
	const lines = [fgOrPlain("dim", layout(columns.map(column => column.header)))];
	for (const [index, row] of cells.entries()) {
		const line = layout(row);
		lines.push(index === 0 && ranked[0]!.turnsPassed > 0 ? fgOrPlain("success", line) : line);
	}
	return `${lines.join("\n")}\n`;
}
