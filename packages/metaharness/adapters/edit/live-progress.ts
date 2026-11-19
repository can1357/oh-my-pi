/**
 * Live terminal renderer for edit benchmark runs.
 *
 * Thin view over {@link runBenchmark}'s `onProgress` stream: a single
 * in-place progress line (bar, pass rates, token/latency averages, in-flight
 * count) on a TTY, plain per-run lines otherwise, plus inline colored diffs
 * for failed runs and a runtime-stats block at the end. Renders to stderr so
 * stdout stays free for machine output (`--list` JSON), and the report file
 * remains the only artifact the manager consumes.
 */
import { percentile, type ProgressEvent } from "./runner";

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
} as const;

function rateColor(percent: number): string {
	if (percent >= 80) return ANSI.green;
	if (percent >= 50) return ANSI.yellow;
	return ANSI.red;
}

export class LiveProgress {
	readonly #totalRuns: number;
	readonly #runsPerTask: number;
	readonly #isTty: boolean;
	readonly #colors: boolean;
	#started = 0;
	#completed = 0;
	#success = 0;
	#totalInput = 0;
	#totalOutput = 0;
	#totalDuration = 0;
	#totalReads = 0;
	#totalEdits = 0;
	#totalWrites = 0;
	#totalEditSuccesses = 0;
	#totalToolInputChars = 0;
	#indentScores: number[] = [];
	#inputTokens: number[] = [];
	#outputTokens: number[] = [];
	#totalTokens: number[] = [];
	#oneShotSuccessTokens: number[] = [];
	#lastLineLength = 0;

	constructor(totalRuns: number, runsPerTask: number) {
		this.#totalRuns = totalRuns;
		this.#runsPerTask = runsPerTask;
		this.#isTty = Boolean(process.stderr.isTTY);
		this.#colors = this.#isTty && !process.env.NO_COLOR;
	}

	#paint(code: string, text: string): string {
		return this.#colors ? `${code}${text}${ANSI.reset}` : text;
	}

	#log(line: string): void {
		process.stderr.write(`${line}\n`);
	}

	handleEvent(event: ProgressEvent): void {
		if (event.status === "started") {
			this.#started += 1;
			if (!this.#isTty) {
				this.#log(`  [${event.taskId}] Run ${event.runIndex + 1}/${this.#runsPerTask} started...`);
			}
			this.#renderLine();
			return;
		}

		this.#completed += 1;
		if (event.result) {
			if (event.result.success) {
				this.#success += 1;
			}
			if (event.result.success && event.runIndex === 0) {
				this.#oneShotSuccessTokens.push(event.result.tokens.total);
			}
			this.#totalInput += event.result.tokens.input;
			this.#totalOutput += event.result.tokens.output;
			this.#inputTokens.push(event.result.tokens.input);
			this.#outputTokens.push(event.result.tokens.output);
			this.#totalTokens.push(event.result.tokens.total);
			this.#totalDuration += event.result.duration;
			this.#totalReads += event.result.toolCalls.read;
			this.#totalEdits += event.result.toolCalls.edit;
			this.#totalWrites += event.result.toolCalls.write;
			this.#totalEditSuccesses += event.result.toolCalls.editSuccesses;
			this.#totalToolInputChars += event.result.toolCalls.totalInputChars;
			if (typeof event.result.indentScore === "number") {
				this.#indentScores.push(event.result.indentScore);
			}
		}

		const result = event.result;
		if (result && !result.success && result.error) {
			this.#flushLine();
			const header = this.#paint(
				ANSI.red,
				`[${event.taskId}] Run ${event.runIndex + 1}/${this.#runsPerTask} failed:`,
			);
			this.#log(`  ${header} ${result.error}`);
			if (result.diff) {
				const changeLines = result.diff
					.split("\n")
					.filter(line => /^[-+@]/.test(line) && !/^(---|\+\+\+)/.test(line));
				const maxLines = 40;
				for (const line of changeLines.slice(0, maxLines)) {
					let color: string | undefined;
					if (line.startsWith("@@")) color = ANSI.cyan;
					else if (line.startsWith("-")) color = ANSI.red;
					else if (line.startsWith("+")) color = ANSI.green;
					this.#log(`    ${color ? this.#paint(color, line) : line}`);
				}
				if (changeLines.length > maxLines) {
					this.#log(this.#paint(ANSI.dim, `    ... (${changeLines.length - maxLines} more change lines)`));
				}
			}
		}

		if (result?.editFailures && result.editFailures.length > 0) {
			this.#flushLine();
			for (const [i, failure] of result.editFailures.entries()) {
				const args = (failure.args ?? {}) as Record<string, unknown>;
				const target =
					typeof args.path === "string" ? args.path : typeof args.file === "string" ? args.file : undefined;
				const op = typeof args.operation === "string" ? args.operation : undefined;
				const oneLine = failure.error.replace(/\s+/g, " ").trim();
				const clipped = oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
				const tag = this.#paint(ANSI.yellow, `[${event.taskId}] schema #${i + 1}`);
				const metaParts = [op, target].filter((value): value is string => Boolean(value));
				const meta = metaParts.length > 0 ? this.#paint(ANSI.dim, metaParts.join(" ")) : "";
				this.#log(`  ${tag}${meta ? ` ${meta}` : ""} ${clipped}`);
				if (failure.rawBlock) {
					const rawLine = failure.rawBlock.replace(/\s+/g, " ").trim();
					const clippedRaw = rawLine.length > 240 ? `${rawLine.slice(0, 237)}...` : rawLine;
					this.#log(`    ${this.#paint(ANSI.dim, "raw")} ${clippedRaw}`);
				}
			}
		}

		if (!this.#isTty) {
			const status = event.result?.success ? "completed" : "failed";
			this.#log(`  [${event.taskId}] Run ${event.runIndex + 1}/${this.#runsPerTask} ${status}`);
		}

		this.#renderLine();
	}

	finish(): void {
		this.#flushLine();
		this.#printSummary();
	}

	#printSummary(): void {
		const n = this.#completed;
		const denom = n || 1;

		const successRate = (this.#success / denom) * 100;
		const editSuccessRate = this.#totalEdits > 0 ? (this.#totalEditSuccesses / this.#totalEdits) * 100 : 100;
		const avgIndent =
			this.#indentScores.length > 0 ? this.#indentScores.reduce((a, b) => a + b, 0) / this.#indentScores.length : 0;

		this.#log("");
		this.#log(this.#paint(ANSI.bold, "Runtime Stats:"));
		this.#log(
			`  Task success:     ${this.#paint(rateColor(successRate), `${successRate.toFixed(1)}% (${this.#success}/${n})`)}`,
		);
		this.#log(
			`  Edit success:     ${this.#paint(rateColor(editSuccessRate), `${editSuccessRate.toFixed(1)}% (${this.#totalEditSuccesses}/${this.#totalEdits})`)}`,
		);
		this.#log(`  Avg indent score: ${avgIndent.toFixed(2)}`);
		this.#log(`  Tool calls:       read=${this.#totalReads} edit=${this.#totalEdits} write=${this.#totalWrites}`);
		this.#log(`  Tool input chars: ${this.#totalToolInputChars.toLocaleString()}`);
		const fmtTokens = (samples: number[]): string => {
			if (samples.length === 0) return "mean=0 median=0 p1=0 p99=0";
			const sorted = [...samples].sort((a, b) => a - b);
			const mean = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
			return `mean=${mean} median=${Math.round(percentile(sorted, 50))} p1=${Math.round(percentile(sorted, 1))} p99=${Math.round(percentile(sorted, 99))}`;
		};
		this.#log(`  Tokens/task in:   ${fmtTokens(this.#inputTokens)}`);
		this.#log(`  Tokens/task out:  ${fmtTokens(this.#outputTokens)}`);
		this.#log(`  Tokens/task tot:  ${fmtTokens(this.#totalTokens)}`);
		this.#log(`  Tokens/task (one-shot successes): ${fmtTokens(this.#oneShotSuccessTokens)}`);
		this.#log(`  Avg time/task:    ${Math.round(this.#totalDuration / denom)}ms`);
	}

	#renderLine(): void {
		if (!this.#isTty) {
			return;
		}
		const successRate = this.#completed > 0 ? (this.#success / this.#completed) * 100 : 0;
		const editRate = this.#totalEdits > 0 ? (this.#totalEditSuccesses / this.#totalEdits) * 100 : 100;
		const avgInput = this.#completed > 0 ? Math.round(this.#totalInput / this.#completed) : 0;
		const avgOutput = this.#completed > 0 ? Math.round(this.#totalOutput / this.#completed) : 0;
		const avgDuration = this.#completed > 0 ? Math.round(this.#totalDuration / this.#completed) : 0;
		const inFlight = this.#started - this.#completed;
		const bar = this.#renderBar(this.#completed, this.#totalRuns, 20);
		const progress = this.#paint(ANSI.bold, `${this.#completed}/${this.#totalRuns}`);
		const taskCol = `task=${this.#paint(rateColor(successRate), `${successRate.toFixed(0)}%`)}`;
		const editCol = `edit=${this.#paint(rateColor(editRate), `${editRate.toFixed(0)}%`)}`;
		const tokCol = this.#paint(ANSI.dim, `tok=${avgInput}/${avgOutput}`);
		const durCol = this.#paint(ANSI.dim, `${avgDuration}ms`);
		const rewCol = this.#paint(ANSI.dim, `r/e/w=${this.#totalReads}/${this.#totalEdits}/${this.#totalWrites}`);
		const flyCol = `fly=${this.#paint(ANSI.cyan, String(inFlight))}`;
		const line = `  ${bar} ${progress} ${taskCol} ${editCol} ${tokCol} ${durCol} ${rewCol} ${flyCol}`;
		this.#writeLine(line);
	}

	#renderBar(done: number, total: number, width: number): string {
		const ratio = total === 0 ? 0 : done / total;
		const filled = Math.round(ratio * width);
		const empty = Math.max(0, width - filled);
		const filledPart = this.#paint(ANSI.green, "#".repeat(filled));
		const emptyPart = this.#paint(ANSI.dim, "-".repeat(empty));
		return `[${filledPart}${emptyPart}]`;
	}

	#writeLine(line: string): void {
		const lineWidth = Bun.stringWidth(line);
		const pad = this.#lastLineLength > lineWidth ? " ".repeat(this.#lastLineLength - lineWidth) : "";
		process.stderr.write(`\r${line}${pad}`);
		this.#lastLineLength = lineWidth;
	}

	#flushLine(): void {
		if (!this.#isTty) {
			return;
		}
		if (this.#lastLineLength > 0) {
			process.stderr.write(`\r${" ".repeat(this.#lastLineLength)}\r`);
			this.#lastLineLength = 0;
		}
	}
}
