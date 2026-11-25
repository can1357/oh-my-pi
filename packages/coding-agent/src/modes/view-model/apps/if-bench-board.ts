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
