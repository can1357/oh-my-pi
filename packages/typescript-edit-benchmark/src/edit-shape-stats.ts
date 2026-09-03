#!/usr/bin/env bun
/**
 * Measure the empirical shape of real agent edits from session logs.
 *
 * Scans session JSONL files for successful `edit`/`apply_patch` tool calls and
 * parses the diff in each tool result (both the numbered ` NNN|` format and
 * unified `@@` diffs) into change runs — maximal runs of `-`/`+` rows with no
 * context row between them — so unchanged context never counts as changed and
 * every run counts as its own hunk.
 *
 * Shapes are reported at two levels:
 *   - per tool call — one sample per edit call. Fixtures are scored on the
 *     final input→expected diff, and a single call's diff is the closest
 *     measured proxy for a net diff, so **this is the calibration reference**
 *     for `generate.ts`.
 *   - per request × file — all edit calls to one file between one user message
 *     and the next, concatenated. This double-counts retries, overlapping
 *     edits, and reversals (no per-file net reconstruction), so treat it as an
 *     **upper bound** on how much a single-prompt fixture could plausibly ask
 *     for, not as a target.
 *
 * Parse coverage is printed so a format skew cannot silently bias the numbers.
 * Reference measurement (2026-07, 2,000 newest sessions against this repo,
 * 99.9% coverage):
 *
 *   per call:      changed lines: 1 → 23%  2-5 → 30%  6-20 → 29%  21-60 → 14%  61+ → 5%
 *                  hunks: 1 → 48%  2 → 21%  3+ → 31%   (median 5 changed lines)
 *   request×file:  changed lines: 1 → 18%  2-5 → 28%  6-20 → 28%  21-60 → 17%  61+ → 9%
 *                  hunks: 1 → 37%  2 → 21%  3+ → 43%   (median 7; upper bound)
 *   op mix (both levels): replace 55%  insert 32%  delete 12%
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const EDIT_TOOL_NAMES: Record<string, true> = { edit: true, apply_patch: true };
const SIZE_BUCKETS: Array<[string, number]> = [
	["1", 1],
	["2-5", 5],
	["6-20", 20],
	["21-60", 60],
	["61+", Number.POSITIVE_INFINITY],
];

/** One maximal run of removed/added rows with no context row in between. */
interface ChangeRun {
	oldCount: number;
	newCount: number;
}

interface Args {
	sessionsDir: string;
	maxSessions: number;
}

function parseArguments(): Args {
	const { values } = parseArgs({
		options: {
			"sessions-dir": { type: "string" },
			repo: { type: "string", default: path.resolve(import.meta.dir, "../../..") },
			"max-sessions": { type: "string", default: "2000" },
		},
	});
	const repo = path.resolve(values.repo ?? ".");
	return {
		sessionsDir: values["sessions-dir"] ?? computeDefaultSessionDir(repo, new FileSessionStorage()),
		maxSessions: parseInt(values["max-sessions"] ?? "2000", 10),
	};
}

const ROW_PIPE_RE = /^([ +-])\s*\d+\|/;
const ROW_SPACE_RE = /^([ +-])\s*\d+( |$)/;

/** Collects change runs; a context row or elision closes the current run. */
class RunCollector {
	runs: ChangeRun[] = [];
	#current: ChangeRun | null = null;

	mark(kind: string): void {
		if (kind === " ") {
			this.flush();
			return;
		}
		this.#current ??= { oldCount: 0, newCount: 0 };
		if (kind === "-") this.#current.oldCount++;
		else this.#current.newCount++;
	}

	flush(): void {
		if (this.#current && (this.#current.oldCount > 0 || this.#current.newCount > 0)) {
			this.runs.push(this.#current);
		}
		this.#current = null;
	}

	finish(): ChangeRun[] | null {
		this.flush();
		return this.runs.length > 0 ? this.runs : null;
	}
}

/**
 * Parse the numbered diff format emitted in edit tool-result details
 * (` NNN|context`, `-NNN|removed`, `+NNN|added`; older space-delimited rows).
 * Elisions appear as blank rows or `...` rows. Returns null when any row is
 * unparseable.
 */
function runsFromNumberedDiff(diff: string): ChangeRun[] | null {
	const lines = diff.split("\n");
	const usesPipe = lines.slice(0, 10).some(line => ROW_PIPE_RE.test(line));
	const collector = new RunCollector();
	for (const line of lines) {
		const row = ROW_PIPE_RE.exec(line) ?? (usesPipe ? null : ROW_SPACE_RE.exec(line));
		if (row) {
			collector.mark(row[1]);
		} else if (line.trim() === "" || line.trim() === "..." || line.trim() === "…" || line.trim().endsWith("|...")) {
			collector.flush();
		} else {
			return null;
		}
	}
	return collector.finish();
}

/**
 * Parse a unified diff (standard `@@ -a,b +c,d @@` hunks or anchor-style `@@`
 * headers): `-` old, `+` new, leading space or blank = context.
 */
function runsFromUnifiedDiff(diff: string): ChangeRun[] | null {
	const collector = new RunCollector();
	for (const line of diff.split("\n")) {
		if (line.startsWith("@@")) {
			collector.flush();
		} else if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("Index:")) {
			// File headers.
		} else if (line.startsWith("-") || line.startsWith("+")) {
			collector.mark(line[0]);
		} else if (line.startsWith(" ") || line === "") {
			collector.mark(" ");
		} else {
			return null;
		}
	}
	return collector.finish();
}

/** Parse a tool-result diff in whichever format it uses. */
function runsFromDiff(diff: string): { runs: ChangeRun[] | null; format: "numbered" | "unified" } {
	const head = diff.trimStart();
	if (head.startsWith("@@") || head.startsWith("--- ")) {
		return { runs: runsFromUnifiedDiff(diff), format: "unified" };
	}
	return { runs: runsFromNumberedDiff(diff), format: "numbered" };
}

/** Per-session parse results: change runs per edit call and per request×file, plus coverage counters. */
interface SessionScan {
	edits: ChangeRun[][];
	/** All edit-call runs targeting one file between one user message and the next, concatenated. */
	requestFiles: ChangeRun[][];
	formats: Map<string, number>;
	skipped: number;
}

/** Resolve the edited file path from tool-call args across edit-tool variants. */
function extractCallPath(args: Record<string, unknown>): string | null {
	if (typeof args.path === "string" && args.path) return args.path;
	if (typeof args.input === "string") {
		const header =
			args.input.match(/^\u00b6([^#\n]+)#/) ??
			args.input.match(/^\[([^#\]\n]+)#/) ??
			args.input.match(/^@@ ([^\n]+)$/m);
		if (header) return header[1].trim();
	}
	if (Array.isArray(args.edits) && args.edits.length > 0 && args.edits[0] && typeof args.edits[0] === "object") {
		const nested = (args.edits[0] as Record<string, unknown>).path;
		if (typeof nested === "string" && nested) return nested;
	}
	return null;
}

/** Extract change runs for every successful edit in one session JSONL file. */
async function collectSessionEdits(sessionFile: string): Promise<SessionScan> {
	const scan: SessionScan = { edits: [], requestFiles: [], formats: new Map(), skipped: 0 };
	const stream = Bun.file(sessionFile).stream();
	const decoder = new TextDecoder();
	let buffer = "";
	const callPaths = new Map<string, string>();
	let currentRequest = new Map<string, ChangeRun[]>();

	const flushRequest = (): void => {
		for (const runs of currentRequest.values()) {
			if (runs.length > 0) scan.requestFiles.push(runs);
		}
		currentRequest = new Map();
	};

	const handleRecord = (record: unknown): void => {
		if (!record || typeof record !== "object") return;
		const rec = record as Record<string, unknown>;
		if (rec.type !== "message" || !rec.message || typeof rec.message !== "object") return;
		const message = rec.message as Record<string, unknown>;
		// A user message starts a new request; everything until the next one
		// belongs to the same prompt (one benchmark fixture ≙ one prompt on one file).
		if (message.role === "user") {
			flushRequest();
			return;
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!block || typeof block !== "object") continue;
				const call = block as Record<string, unknown>;
				if (call.type !== "toolCall" || !EDIT_TOOL_NAMES[String(call.name)]) continue;
				const args =
					call.arguments && typeof call.arguments === "object" ? (call.arguments as Record<string, unknown>) : {};
				const callPath = extractCallPath(args);
				if (typeof call.id === "string" && callPath) callPaths.set(call.id, callPath);
			}
			return;
		}
		if (message.role !== "toolResult" || !EDIT_TOOL_NAMES[String(message.toolName)] || message.isError) return;
		const details =
			message.details && typeof message.details === "object"
				? (message.details as Record<string, unknown>)
				: undefined;
		const diff = details && typeof details.diff === "string" ? details.diff : null;
		const op = details && typeof details.op === "string" ? details.op : null;
		if (!diff || (op && op !== "update")) return;
		const { runs, format } = runsFromDiff(diff);
		if (runs) {
			scan.edits.push(runs);
			// Unknown path → each call is its own group (conservative: no false merging).
			const callId = typeof message.toolCallId === "string" ? message.toolCallId : `#${scan.edits.length}`;
			const fileKey = callPaths.get(callId) ?? `call:${callId}`;
			const group = currentRequest.get(fileKey) ?? [];
			group.push(...runs);
			currentRequest.set(fileKey, group);
			scan.formats.set(format, (scan.formats.get(format) ?? 0) + 1);
		} else {
			scan.skipped++;
		}
	};

	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		const parsed = Bun.JSONL.parseChunk(buffer);
		for (const value of parsed.values) handleRecord(value);
		buffer = buffer.slice(parsed.read);
	}
	for (const value of Bun.JSONL.parse(`${buffer}\n`)) handleRecord(value);
	flushRequest();
	return scan;
}

function sizeBucket(changedLines: number): string {
	for (const [label, max] of SIZE_BUCKETS) {
		if (changedLines <= max) return label;
	}
	return SIZE_BUCKETS[SIZE_BUCKETS.length - 1][0];
}

function printDistribution(title: string, counts: Map<string, number>, order?: string[]): void {
	const total = [...counts.values()].reduce((a, b) => a + b, 0);
	const keys = order ?? [...counts.keys()].sort();
	console.log(title);
	for (const key of keys) {
		const count = counts.get(key) ?? 0;
		console.log(`  ${key.padEnd(6)} ${String(count).padStart(6)}  ${((count / total) * 100).toFixed(1)}%`);
	}
}

async function main(): Promise<number> {
	const args = parseArguments();
	const sessionFiles = (await fs.readdir(args.sessionsDir))
		.filter(name => name.endsWith(".jsonl"))
		.sort()
		.reverse()
		.slice(0, args.maxSessions > 0 ? args.maxSessions : undefined)
		.map(name => path.join(args.sessionsDir, name));
	console.log(`Scanning ${sessionFiles.length} session files in ${args.sessionsDir}`);

	interface ShapeCounters {
		sizes: Map<string, number>;
		hunks: Map<string, number>;
		ops: Map<string, number>;
		changed: number[];
	}
	const newCounters = (): ShapeCounters => ({ sizes: new Map(), hunks: new Map(), ops: new Map(), changed: [] });
	const accumulate = (counters: ShapeCounters, runs: ChangeRun[]): void => {
		const changed = runs.reduce((sum, run) => sum + Math.max(run.oldCount, run.newCount), 0);
		counters.changed.push(changed);
		counters.sizes.set(sizeBucket(changed), (counters.sizes.get(sizeBucket(changed)) ?? 0) + 1);
		const hunkKey = runs.length >= 3 ? "3+" : String(runs.length);
		counters.hunks.set(hunkKey, (counters.hunks.get(hunkKey) ?? 0) + 1);
		for (const run of runs) {
			const op = run.oldCount === 0 ? "insert" : run.newCount === 0 ? "delete" : "replace";
			counters.ops.set(op, (counters.ops.get(op) ?? 0) + 1);
		}
	};
	const report = (label: string, counters: ShapeCounters): void => {
		counters.changed.sort((a, b) => a - b);
		const median = counters.changed[Math.floor(counters.changed.length / 2)] ?? 0;
		console.log(`\n=== ${label}: ${counters.changed.length} samples, median changed lines: ${median}`);
		printDistribution(
			"changed lines:",
			counters.sizes,
			SIZE_BUCKETS.map(([bucketLabel]) => bucketLabel),
		);
		printDistribution("hunks:", counters.hunks, ["1", "2", "3+"]);
		printDistribution("op mix:", counters.ops, ["replace", "insert", "delete"]);
	};

	const perCall = newCounters();
	const perRequestFile = newCounters();
	const formatCounts = new Map<string, number>();
	let skipped = 0;

	let next = 0;
	const workers = Array.from({ length: 16 }, async () => {
		while (next < sessionFiles.length) {
			const file = sessionFiles[next++];
			const scan = await collectSessionEdits(file).catch((): SessionScan => ({
				edits: [],
				requestFiles: [],
				formats: new Map(),
				skipped: 0,
			}));
			skipped += scan.skipped;
			for (const [format, count] of scan.formats) {
				formatCounts.set(format, (formatCounts.get(format) ?? 0) + count);
			}
			for (const runs of scan.edits) accumulate(perCall, runs);
			for (const runs of scan.requestFiles) accumulate(perRequestFile, runs);
		}
	});
	await Promise.all(workers);

	if (perCall.changed.length === 0) {
		console.error("No parseable edits found.");
		return 1;
	}
	const parsedTotal = [...formatCounts.values()].reduce((a, b) => a + b, 0);
	const coverage = parsedTotal + skipped > 0 ? parsedTotal / (parsedTotal + skipped) : 0;
	const formatSummary = [...formatCounts.entries()].map(([format, count]) => `${format}=${count}`).join(", ");
	console.log(
		`\nParse coverage: ${parsedTotal}/${parsedTotal + skipped} diff results (${(coverage * 100).toFixed(1)}%; ${formatSummary})`,
	);
	report("per tool call (calibration reference)", perCall);
	report("per request × file (cumulative activity — upper bound)", perRequestFile);
	return 0;
}

process.exit(await main());
