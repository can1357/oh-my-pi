#!/usr/bin/env bun
/**
 * Summarize benchmark runs across (separator × model) by parsing the markdown
 * reports produced by `bun run bench:edit`.
 *
 * Usage:
 *   bun scripts/eval-bench-runs.ts runs/hashline-sep-2026-05-03T06-17-44-702Z
 *   bun scripts/eval-bench-runs.ts <dir> --format md > eval.md
 *   bun scripts/eval-bench-runs.ts <dir> --format csv > eval.csv
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface ReportRow {
	file: string;
	sepSlug: string;
	model: string;
	totalTasks: number;
	totalRuns: number;
	successfulRuns: number;
	taskSuccessPct: number;
	verifiedPct: number;
	editToolUsagePct: number;
	editSuccessPct: number;
	patchFailurePct: number;
	patchFailures: number;
	patchAttempts: number;
	mutationIntentPct: number;
	autocorrectFreePct: number;
	tasksAllPassing: number;
	tasksFlakyFailing: number;
	timeoutRuns: number;
	inputTokensTotal: number;
	outputTokensTotal: number;
	totalTokens: number;
	inputTokensAvg: number;
	outputTokensAvg: number;
	totalTokensAvg: number;
	durationTotal: string;
	durationAvg: string;
	avgIndentScore: number | null;
	readTotal: number;
	editTotal: number;
	writeTotal: number;
}

const SEPARATOR_DISPLAY: Record<string, string> = {
	gt: ">",
	plus: "+",
	div: "÷",
	pipe: "|",
	bslash: "\\",
	tilde: "~",
	pct: "%",
	colon: ":",
};

const args = process.argv.slice(2);
const dirs: string[] = [];
type OutputFormat = "table" | "md" | "csv" | "json";
type SortKey = "sep" | "model" | "task" | "edit" | "tokens";
let format: OutputFormat = "table";
let sortBy: SortKey = "sep";
let aggregate = false;

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--format") {
		format = args[++i] as OutputFormat;
	} else if (a === "--sort") {
		sortBy = args[++i] as SortKey;
	} else if (a === "--aggregate") {
		aggregate = true;
	} else if (!a.startsWith("--")) {
		dirs.push(a);
	}
}

if (dirs.length === 0) {
	console.error(
		"usage: bun scripts/eval-bench-runs.ts <runs-dir> [<runs-dir>...] [--aggregate] [--format table|md|csv|json] [--sort sep|model|task|edit|tokens]",
	);
	process.exit(2);
}

const resolvedDirs = dirs.map(d => path.resolve(d));

function parseNumber(text: string): number {
	return Number.parseFloat(text.replace(/,/g, ""));
}

function getCell(text: string, label: string): string | null {
	const re = new RegExp(
		`^\\|\\s*\\*?\\*?${escapeRegex(label)}\\*?\\*?\\s*\\|\\s*\\*?\\*?(.+?)\\*?\\*?\\s*\\|\\s*$`,
		"m",
	);
	const m = text.match(re);
	return m ? m[1].trim() : null;
}

function getRow(text: string, label: string): string[] | null {
	const re = new RegExp(`^\\|\\s*\\*?\\*?${escapeRegex(label)}\\*?\\*?\\s*\\|(.+)\\|\\s*$`, "m");
	const m = text.match(re);
	if (!m) return null;
	return m[1].split("|").map(s => s.trim().replace(/^\*\*|\*\*$/g, ""));
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePercent(value: string | null): number {
	if (!value) return Number.NaN;
	const m = value.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
	return m ? Number.parseFloat(m[1]) : Number.NaN;
}

function parseRatePair(value: string | null): { numerator: number; denominator: number; pct: number } {
	if (!value) return { numerator: 0, denominator: 0, pct: Number.NaN };
	const m = value.match(/([0-9.]+)\s*%\s*\(\s*([0-9,]+)\s*\/\s*([0-9,]+)\s*\)/);
	if (!m) {
		return { numerator: 0, denominator: 0, pct: parsePercent(value) };
	}
	return {
		pct: Number.parseFloat(m[1]),
		numerator: parseNumber(m[2]),
		denominator: parseNumber(m[3]),
	};
}

async function parseReport(file: string): Promise<ReportRow> {
	const text = await Bun.file(file).text();

	const base = path.basename(file, ".md");
	const [sepSlug, ...modelParts] = base.split("__");
	const model = modelParts.join("__").replace(/_/g, "/");

	const totalTasks = Number.parseInt(getCell(text, "Total Tasks") ?? "0", 10);
	const totalRuns = Number.parseInt(getCell(text, "Total Runs") ?? "0", 10);
	const successfulRuns = Number.parseInt(getCell(text, "Successful Runs") ?? "0", 10);
	const taskSuccessPct = parsePercent(getCell(text, "Task Success Rate"));
	const verifiedPct = parsePercent(getCell(text, "Verified Rate"));
	const editTool = parseRatePair(getCell(text, "Edit Tool Usage Rate"));
	const editSuccessPct = parsePercent(getCell(text, "Edit Success Rate"));
	const patchFailure = parseRatePair(getCell(text, "Patch Failure Rate"));
	const mutationIntentPct = parsePercent(getCell(text, "Mutation Intent Match Rate"));
	const autocorrectFreePct = parsePercent(getCell(text, "Autocorrect-Free Success Rate"));
	const tasksAllPassing = Number.parseInt(getCell(text, "Tasks All Passing") ?? "0", 10);
	const tasksFlakyFailing = Number.parseInt(getCell(text, "Tasks Flaky/Failing") ?? "0", 10);
	const timeoutRuns = Number.parseInt(getCell(text, "Timeout Runs") ?? "0", 10);

	const inRow = getRow(text, "Input Tokens") ?? ["0", "0"];
	const outRow = getRow(text, "Output Tokens") ?? ["0", "0"];
	const totalRow = getRow(text, "Total Tokens") ?? ["0", "0"];
	const durationRow = getRow(text, "Duration") ?? ["", ""];
	const indentRow = getRow(text, "Avg Indent Score") ?? ["—", "—"];

	const readRow = getRow(text, "Read") ?? ["0", "0"];
	const editRow = getRow(text, "Edit") ?? ["0", "0"];
	const writeRow = getRow(text, "Write") ?? ["0", "0"];

	const indentValue = indentRow[1]?.replace(/[*\s—-]/g, "");

	return {
		file,
		sepSlug,
		model,
		totalTasks,
		totalRuns,
		successfulRuns,
		taskSuccessPct,
		verifiedPct,
		editToolUsagePct: editTool.pct,
		editSuccessPct,
		patchFailurePct: patchFailure.pct,
		patchFailures: patchFailure.numerator,
		patchAttempts: patchFailure.denominator,
		mutationIntentPct,
		autocorrectFreePct,
		tasksAllPassing,
		tasksFlakyFailing,
		timeoutRuns,
		inputTokensTotal: parseNumber(inRow[0]),
		outputTokensTotal: parseNumber(outRow[0]),
		totalTokens: parseNumber(totalRow[0]),
		inputTokensAvg: parseNumber(inRow[1]),
		outputTokensAvg: parseNumber(outRow[1]),
		totalTokensAvg: parseNumber(totalRow[1]),
		durationTotal: durationRow[0] ?? "",
		durationAvg: durationRow[1] ?? "",
		avgIndentScore: indentValue && indentValue !== "" ? Number.parseFloat(indentValue) : null,
		readTotal: parseNumber(readRow[0]),
		editTotal: parseNumber(editRow[0]),
		writeTotal: parseNumber(writeRow[0]),
	};
}

function fmtPct(value: number): string {
	return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}

function fmtNum(value: number): string {
	return Number.isFinite(value) ? value.toLocaleString() : "—";
}

function shortModel(model: string): string {
	const segs = model.split("/");
	return segs[segs.length - 1].replace(/:nitro/, "");
}

function sortRows(rows: ReportRow[], by: typeof sortBy): ReportRow[] {
	const sepOrder = ["gt", "plus", "div", "pipe", "bslash", "tilde", "pct", "colon"];
	const modelOrder = (m: string) => {
		if (m.includes("glm")) return 0;
		if (m.includes("gpt")) return 1;
		if (m.includes("claude")) return 2;
		return 3;
	};
	const cmp: Record<typeof sortBy, (a: ReportRow, b: ReportRow) => number> = {
		sep: (a, b) =>
			sepOrder.indexOf(a.sepSlug) - sepOrder.indexOf(b.sepSlug) || modelOrder(a.model) - modelOrder(b.model),
		model: (a, b) =>
			modelOrder(a.model) - modelOrder(b.model) || sepOrder.indexOf(a.sepSlug) - sepOrder.indexOf(b.sepSlug),
		task: (a, b) => b.taskSuccessPct - a.taskSuccessPct,
		edit: (a, b) => b.editSuccessPct - a.editSuccessPct,
		tokens: (a, b) => a.totalTokensAvg - b.totalTokensAvg,
	};
	return [...rows].sort(cmp[by]);
}

const entries = (
	await Promise.all(
		resolvedDirs.map(async d =>
			(
				await fs.readdir(d, { withFileTypes: true })
			)
				.filter(e => e.isFile() && e.name.endsWith(".md"))
				.map(e => path.join(d, e.name)),
		),
	)
).flat();

const rawRows = await Promise.all(entries.map(parseReport));
const rows = aggregate ? mergeRows(rawRows) : rawRows;
const sorted = sortRows(rows, sortBy);

function mergeRows(input: ReportRow[]): ReportRow[] {
	const groups = new Map<string, ReportRow[]>();
	for (const r of input) {
		const key = `${r.sepSlug}::${r.model}`;
		const list = groups.get(key);
		if (list) list.push(r);
		else groups.set(key, [r]);
	}
	const out: ReportRow[] = [];
	for (const [, list] of groups) {
		if (list.length === 1) {
			out.push(list[0]);
			continue;
		}
		const totalRuns = sumField(list, r => r.totalRuns);
		const successfulRuns = sumField(list, r => r.successfulRuns);
		const patchFailures = sumField(list, r => r.patchFailures);
		const patchAttempts = sumField(list, r => r.patchAttempts);
		const totalTokens = sumField(list, r => r.totalTokens);
		const inputTokensTotal = sumField(list, r => r.inputTokensTotal);
		const outputTokensTotal = sumField(list, r => r.outputTokensTotal);
		const editTotal = sumField(list, r => r.editTotal);
		const readTotal = sumField(list, r => r.readTotal);
		const writeTotal = sumField(list, r => r.writeTotal);
		const ratio = (n: number, d: number) => (d === 0 ? Number.NaN : (n / d) * 100);
		const indentVals = list.map(r => r.avgIndentScore).filter((v): v is number => v !== null);
		const indent = indentVals.length === 0 ? null : indentVals.reduce((a, b) => a + b, 0) / indentVals.length;
		out.push({
			file: list.map(r => r.file).join(","),
			sepSlug: list[0].sepSlug,
			model: list[0].model,
			totalTasks: sumField(list, r => r.totalTasks),
			totalRuns,
			successfulRuns,
			taskSuccessPct: ratio(successfulRuns, totalRuns),
			verifiedPct: ratio(successfulRuns, totalRuns),
			editToolUsagePct: ratio(
				sumField(list, r => Math.round((r.editToolUsagePct / 100) * r.totalRuns)),
				totalRuns,
			),
			editSuccessPct: ratio(patchAttempts - patchFailures, patchAttempts),
			patchFailurePct: ratio(patchFailures, patchAttempts),
			patchFailures,
			patchAttempts,
			mutationIntentPct:
				list.reduce((a, r) => a + (Number.isFinite(r.mutationIntentPct) ? r.mutationIntentPct : 0), 0) /
				list.length,
			autocorrectFreePct:
				list.reduce((a, r) => a + (Number.isFinite(r.autocorrectFreePct) ? r.autocorrectFreePct : 0), 0) /
				list.length,
			tasksAllPassing: sumField(list, r => r.tasksAllPassing),
			tasksFlakyFailing: sumField(list, r => r.tasksFlakyFailing),
			timeoutRuns: sumField(list, r => r.timeoutRuns),
			inputTokensTotal,
			outputTokensTotal,
			totalTokens,
			inputTokensAvg: totalRuns === 0 ? 0 : Math.round(inputTokensTotal / totalRuns),
			outputTokensAvg: totalRuns === 0 ? 0 : Math.round(outputTokensTotal / totalRuns),
			totalTokensAvg: totalRuns === 0 ? 0 : Math.round(totalTokens / totalRuns),
			durationTotal: list.map(r => r.durationTotal).join(" + "),
			durationAvg: list.map(r => r.durationAvg).join(" / "),
			avgIndentScore: indent,
			readTotal,
			editTotal,
			writeTotal,
		});
	}
	return out;
}

function sumField(list: ReportRow[], pick: (r: ReportRow) => number): number {
	return list.reduce((a, r) => a + (Number.isFinite(pick(r)) ? pick(r) : 0), 0);
}

if (format === "json") {
	console.log(JSON.stringify(sorted, null, 2));
	process.exit(0);
}

if (format === "csv") {
	const cols: Array<keyof ReportRow> = [
		"sepSlug",
		"model",
		"totalRuns",
		"successfulRuns",
		"taskSuccessPct",
		"editToolUsagePct",
		"editSuccessPct",
		"patchFailurePct",
		"patchFailures",
		"patchAttempts",
		"mutationIntentPct",
		"avgIndentScore",
		"inputTokensTotal",
		"outputTokensTotal",
		"totalTokens",
		"totalTokensAvg",
		"durationTotal",
		"durationAvg",
		"editTotal",
		"readTotal",
	];
	console.log(cols.join(","));
	for (const r of sorted) {
		console.log(cols.map(c => JSON.stringify(r[c] ?? "")).join(","));
	}
	process.exit(0);
}

const headers = [
	"sep",
	"model",
	"task ✓",
	"edit ✓",
	"patch fail",
	"intent",
	"in tok/run",
	"out tok/run",
	"tok/run",
	"avg time",
	"indent",
];

const data: string[][] = sorted.map(r => [
	SEPARATOR_DISPLAY[r.sepSlug] ?? r.sepSlug,
	shortModel(r.model),
	`${fmtPct(r.taskSuccessPct)} (${r.successfulRuns}/${r.totalRuns})`,
	fmtPct(r.editSuccessPct),
	`${fmtPct(r.patchFailurePct)} (${r.patchFailures}/${r.patchAttempts})`,
	fmtPct(r.mutationIntentPct),
	fmtNum(r.inputTokensAvg),
	fmtNum(r.outputTokensAvg),
	fmtNum(r.totalTokensAvg),
	r.durationAvg,
	r.avgIndentScore !== null ? r.avgIndentScore.toFixed(2) : "—",
]);

if (format === "md") {
	const align = headers.map(() => "---");
	const out: string[] = [];
	out.push(`| ${headers.join(" | ")} |`);
	out.push(`|${align.map(a => `${a}`).join("|")}|`);
	for (const row of data) out.push(`| ${row.join(" | ")} |`);
	console.log(out.join("\n"));
	console.log();
	groupAggregates(sorted, "md");
	process.exit(0);
}

// Plain text aligned table
const widths = headers.map((h, i) => Math.max(h.length, ...data.map(r => r[i].length)));
const fmtRow = (row: string[]) => row.map((c, i) => c.padEnd(widths[i])).join("  ");
console.log(fmtRow(headers));
console.log(widths.map(w => "-".repeat(w)).join("  "));
for (const row of data) console.log(fmtRow(row));

groupAggregates(sorted, "table");

function groupAggregates(rows: ReportRow[], fmt: "md" | "table"): void {
	const bySep = new Map<string, ReportRow[]>();
	const byModel = new Map<string, ReportRow[]>();
	for (const r of rows) {
		(bySep.get(r.sepSlug) ?? bySep.set(r.sepSlug, []).get(r.sepSlug)!).push(r);
		(byModel.get(r.model) ?? byModel.set(r.model, []).get(r.model)!).push(r);
	}

	const sepHeaders = ["sep", "task ✓ (avg)", "edit ✓ (avg)", "patch fail (sum)", "tok/run (avg)"];
	const sepData: string[][] = [];
	for (const [slug, list] of bySep) {
		sepData.push([
			SEPARATOR_DISPLAY[slug] ?? slug,
			fmtPct(avg(list, r => r.taskSuccessPct)),
			fmtPct(avg(list, r => r.editSuccessPct)),
			`${sum(list, r => r.patchFailures)}/${sum(list, r => r.patchAttempts)}`,
			fmtNum(Math.round(avg(list, r => r.totalTokensAvg))),
		]);
	}

	const modelHeaders = ["model", "task ✓ (avg)", "edit ✓ (avg)", "patch fail (sum)", "tok/run (avg)"];
	const modelData: string[][] = [];
	for (const [model, list] of byModel) {
		modelData.push([
			shortModel(model),
			fmtPct(avg(list, r => r.taskSuccessPct)),
			fmtPct(avg(list, r => r.editSuccessPct)),
			`${sum(list, r => r.patchFailures)}/${sum(list, r => r.patchAttempts)}`,
			fmtNum(Math.round(avg(list, r => r.totalTokensAvg))),
		]);
	}

	if (fmt === "md") {
		console.log("### Per separator (avg across models)\n");
		printMd(sepHeaders, sepData);
		console.log("\n### Per model (avg across separators)\n");
		printMd(modelHeaders, modelData);
	} else {
		console.log("\nPer separator (avg across models):");
		printTable(sepHeaders, sepData);
		console.log("\nPer model (avg across separators):");
		printTable(modelHeaders, modelData);
	}
}

function avg(list: ReportRow[], pick: (r: ReportRow) => number): number {
	const vals = list.map(pick).filter(Number.isFinite);
	return vals.length === 0 ? Number.NaN : vals.reduce((a, b) => a + b, 0) / vals.length;
}
function sum(list: ReportRow[], pick: (r: ReportRow) => number): number {
	return list.reduce((a, r) => a + (Number.isFinite(pick(r)) ? pick(r) : 0), 0);
}
function printMd(headers: string[], data: string[][]): void {
	console.log(`| ${headers.join(" | ")} |`);
	console.log(`|${headers.map(() => "---").join("|")}|`);
	for (const r of data) console.log(`| ${r.join(" | ")} |`);
}
function printTable(headers: string[], data: string[][]): void {
	const widths = headers.map((h, i) => Math.max(h.length, ...data.map(r => r[i].length)));
	const row = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
	console.log(row(headers));
	console.log(widths.map(w => "-".repeat(w)).join("  "));
	for (const r of data) console.log(row(r));
}
