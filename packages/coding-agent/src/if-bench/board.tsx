/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Live board and scoreboard for `omp if-bench`.
 *
 * Interactive terminals get one repainted row per model — a turn ladder that
 * fills as turns pass, the in-flight turn as a warning cell, and the live
 * position of the cat directive — plus a permanent verdict line per model as it
 * settles. Non-TTY output falls back to one plain line per turn so scripted
 * callers keep a parseable trace.
 */
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type {
	IfBenchFailure,
	IfBenchModelReport,
	IfBenchObserver,
	IfBenchTurnRecord,
} from "../modes/view-model/apps/if-bench-board";
import { createLiveBoard, type LiveBoardOutput } from "../modes/view-model/chrome/live-board";
import { printRows } from "../ui/print-rows";
import { replaceTabs, truncateToWidth } from "../utils/text-width";
import type { IfBenchSummary } from "./runner";

const LADDER_WIDTH = 28;
const LABEL_WIDTH = 34;
const DETAIL_WIDTH = 120;
/** Width of the scoreboard and verdicts when the output is not a terminal. */
const PLAIN_WIDTH = 160;

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
}

/** Static run parameters shown in the board header. */
export interface IfBenchBoardMeta {
	maxTurns: number;
	arrayLength: number;
	nyaMax: number;
}

function outputWidth(output: LiveBoardOutput): number {
	const columns = output.columns ?? 0;
	return output.isTTY && Number.isFinite(columns) && columns > 0 ? Math.trunc(columns) : PLAIN_WIDTH;
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
	const board = createLiveBoard(
		(_spinner, width) =>
			rows.size === 0
				? []
				: printRows(() => <IfBenchLive meta={meta} rows={[...rows]} startedAt={startedAt} />, width, {
						motion: true,
					}),
		output,
	);
	const print = (spans: TspSpan[]): void => {
		for (const row of printRows(() => <text wrap="word" spans={spans} />, outputWidth(output))) board.log(row);
	};

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
			print(verdictSpans(report, meta));
			if (report.failure) for (const line of failureDetail(report)) print(line);
		},
		close: board.close,
	};
}

/** The live rows: the run header, then one row per model in flight. */
function IfBenchLive(props: {
	readonly meta: IfBenchBoardMeta;
	readonly rows: ReadonlyArray<readonly [string, RowState]>;
	readonly startedAt: number;
}) {
	const { meta, rows } = props;
	const now = Date.now();
	const deepest = Math.max(0, ...rows.map(([, row]) => row.actions));
	const dot: TspSpan = { s: "dim", t: " · " };
	const labelWidth = Math.min(LABEL_WIDTH, Math.max(...rows.map(([label]) => label.length)));
	return (
		<col gap="none">
			<spinner
				key="head"
				tone="accent"
				label={[
					{ s: "strong", t: "if-bench" },
					dot,
					{ t: `${rows.length} live` },
					dot,
					{ t: `${deepest} actions` },
					dot,
					{ s: "dim", t: `L=${meta.arrayLength} nya{1,${meta.nyaMax}}` },
					dot,
					{ t: formatDuration(now - props.startedAt) },
				]}
			/>
			{rows.map(([label, row]) => {
				const parts: TspSpan[] = [
					{ t: `turn ${Math.max(row.turn, 1)}/${meta.maxTurns}` },
					dot,
					{ t: `${row.actions} acts` },
					dot,
					{ t: formatDuration(now - row.startedAt) },
				];
				if (row.placement) parts.push(dot, { s: "dim", t: `cat@${row.placement}` });
				return (
					<row key={`model-${label}`} gap="sm">
						<text text=" " />
						<spinner tone="warning" />
						<text lines={1} truncate="end" text={truncateToWidth(label, labelWidth).padEnd(labelWidth)} />
						<text spans={ladder(row, meta.maxTurns)} />
						<text lines={1} truncate="end" spans={parts} />
					</row>
				);
			})}
		</col>
	);
}

/**
 * Turn meter: filled cells for passed turns, a warning cell for the in-flight
 * turn, dim cells for the remaining budget. Scales to {@link LADDER_WIDTH} when
 * the turn budget is larger so the row never wraps.
 */
function ladder(row: RowState, maxTurns: number): TspSpan[] {
	const width = Math.min(maxTurns, LADDER_WIDTH);
	const scale = width / maxTurns;
	const filled = Math.min(width, Math.round(row.passed * scale));
	const active = row.failed || filled >= width ? 0 : Math.max(0, Math.min(width - filled, Math.round(scale)) || 1);
	const rest = Math.max(0, width - filled - active);
	const spans: TspSpan[] = [{ s: "success", t: "█".repeat(filled) }];
	spans.push(row.failed ? { s: "error", t: "▚" } : { s: "warning", t: "▒".repeat(active) });
	spans.push({ s: "dim", t: "░".repeat(rest) });
	return spans.filter(span => span.t !== "");
}

function formatTurnLine(label: string, record: IfBenchTurnRecord): string {
	const head = `[turn ${record.turn}] ${label} ${record.cumulativeActions} acts cat@${record.placement}`;
	if (record.passed) return `${head} PASS ${formatDuration(Math.round(record.durationMs))}`;
	return `${head} FAIL ${record.failure ?? "format"}`;
}

function verdictSpans(report: IfBenchModelReport, meta: IfBenchBoardMeta): TspSpan[] {
	const stats = [
		`${report.turnsPassed}/${meta.maxTurns} turns`,
		`${report.actionsPassed} actions`,
		`${formatDuration(Math.round(meanTurnMs(report)))}/turn`,
	];
	if (report.outputTokens > 0) stats.push(`${formatNumber(report.outputTokens)} tok`);
	if (report.cost > 0) stats.push(formatCost(report.cost));
	const spans: TspSpan[] = [
		report.failure ? { s: "error", t: "✗ " } : { s: "success", t: "✓ " },
		{ s: "strong", t: report.label },
		{ t: ` ${stats.join(" · ")}` },
	];
	if (report.failure) {
		spans.push(
			{ s: "dim", t: " · " },
			{
				s: "error",
				t: `broke on turn ${report.failure.turn}: ${FAILURE_TEXT[report.failure.kind]}`,
			},
		);
	}
	return spans;
}

/** Expected/actual pair for the turn that ended a run, clipped for the terminal. */
function failureDetail(report: IfBenchModelReport): TspSpan[][] {
	const failed = report.turns[report.turns.length - 1];
	if (!failed) return [];
	const oneLine = (text: string): string =>
		truncateToWidth(replaceTabs(text).replace(/\s+/g, " ").trim(), DETAIL_WIDTH);
	if (failed.failure === "provider") {
		return [[{ t: "    " }, { s: "dim", t: "provider " }, { s: "error", t: oneLine(failed.response) }]];
	}
	return [
		[{ t: "    " }, { s: "dim", t: "expected " }, { t: `<${failed.expected}>` }],
		[{ t: "    " }, { s: "dim", t: "actual   " }, { t: oneLine(failed.response) }],
	];
}

function meanTurnMs(report: IfBenchModelReport): number {
	if (report.turns.length === 0) return 0;
	return report.durationMs / report.turns.length;
}

function formatCost(cost: number): string {
	return `$${cost >= 0.095 ? cost.toFixed(2) : cost.toFixed(3)}`;
}

/**
 * Ranked comparison table: depth first (turns, then actions), latency only as a
 * tie-break, because surviving one more turn always beats answering faster.
 */
export function formatIfBenchScoreboard(summary: IfBenchSummary, width = PLAIN_WIDTH): string {
	const ranked = [...summary.models].sort(
		(a, b) => b.turnsPassed - a.turnsPassed || b.actionsPassed - a.actionsPassed || meanTurnMs(a) - meanTurnMs(b),
	);
	const cols = [
		{ id: "model", head: "model" },
		{ id: "turns", head: "turns", align: "end" as const },
		{ id: "actions", head: "actions", align: "end" as const },
		{ id: "broke", head: "broke on" },
		{ id: "turn", head: "per turn", align: "end" as const },
		{ id: "tokens", head: "tokens", align: "end" as const },
		{ id: "cost", head: "cost", align: "end" as const },
	];
	const rows = ranked.map((report, index) => {
		const leader = index === 0 && report.turnsPassed > 0;
		const cell = (t: string): TspSpan[] => [leader ? { s: "success", t } : { t }];
		return {
			id: `${index}`,
			cells: {
				model: cell(report.label),
				turns: cell(`${report.turnsPassed}/${summary.maxTurns}`),
				actions: cell(String(report.actionsPassed)),
				broke: cell(
					report.failure ? `turn ${report.failure.turn} · ${FAILURE_TEXT[report.failure.kind]}` : "survived",
				),
				turn: cell(formatDuration(Math.round(meanTurnMs(report)))),
				tokens: cell(report.outputTokens > 0 ? formatNumber(report.outputTokens) : "-"),
				cost: cell(report.cost > 0 ? formatCost(report.cost) : "-"),
			},
		};
	});
	return `${printRows(() => <table cols={cols} rows={rows} />, width).join("\n")}\n`;
}
