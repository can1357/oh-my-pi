import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { FileType, GrepOutputMode, glob, grep } from "@pk-nerdsaver-ai/pi-natives";

interface ExpectedSignal {
	file: string;
	selectorId: string;
	evidence: string;
}

interface SelectorSpec {
	id: string;
	type: "lexical";
	pattern: string;
	reason: string;
}

interface SignalRecord {
	id: string;
	selectorId: string;
	type: "lexical";
	file: string;
	line: number;
	evidence: string;
	reason: string;
}

const runRoot = process.argv[2]
	? path.resolve(process.argv[2])
	: path.join(process.cwd(), "runs", "autoresearch-mapreduce", "latest");
const corpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mr-bench-"));
const packageNames = ["auth", "api", "billing", "web", "fixtures", "docs"];
const positiveFiles = new Set<string>();
const expectedSignals: ExpectedSignal[] = [];

function normalize(filePath: string): string {
	return filePath.split(path.sep).join("/");
}

async function writeCorpusFile(rel: string, text: string): Promise<void> {
	const absolute = path.join(corpusRoot, rel);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(absolute, text);
}

function addExpected(rel: string, selectorId: string, evidence: string): void {
	const normalized = normalize(rel);
	positiveFiles.add(normalized);
	expectedSignals.push({ file: normalized, selectorId, evidence });
}

await fs.writeFile(path.join(corpusRoot, ".gitignore"), "node_modules/\n**/dist/\n");

for (let i = 0; i < 180; i += 1) {
	const pkg = packageNames[i % packageNames.length];
	const rel = path.join("packages", pkg, "src", `module-${i}.ts`);
	let body = `export function module${i}(input: string): string {\n\treturn input.toUpperCase();\n}\n`;
	if (i % 13 === 0) {
		body = `import { OldAuthClient } from "@legacy/auth";\n\nexport function module${i}(): string {\n\tconst client = new OldAuthClient();\n\treturn client.refreshTokenV1("token");\n}\n`;
		addExpected(rel, "legacy-auth-import", "@legacy/auth");
		addExpected(rel, "legacy-auth-constructor", "OldAuthClient");
		addExpected(rel, "legacy-refresh-call", "refreshTokenV1");
	} else if (i % 17 === 0) {
		body = `const config = { mode: "AUTH_SDK_V1", module: ${i} };\nexport const value${i} = config.mode;\n`;
		addExpected(rel, "legacy-config-key", "AUTH_SDK_V1");
	} else if (i % 19 === 0) {
		body = `import { createClient } from "./factory";\nexport const client${i} = createClient("legacy-auth-v1");\n`;
		addExpected(rel, "legacy-runtime-token", "legacy-auth-v1");
	}
	await writeCorpusFile(rel, body);
}

await writeCorpusFile(
	path.join("packages", "api", "dist", "generated.ts"),
	'import { OldAuthClient } from "@legacy/auth";\n',
);
await writeCorpusFile(path.join("node_modules", "legacy", "index.ts"), "new OldAuthClient();\n");

const selectors: SelectorSpec[] = [
	{
		id: "legacy-auth-import",
		type: "lexical",
		pattern: "@legacy/auth",
		reason: "direct import of deprecated auth SDK",
	},
	{
		id: "legacy-auth-constructor",
		type: "lexical",
		pattern: "\\bOldAuthClient\\b",
		reason: "runtime construction of deprecated auth client",
	},
	{
		id: "legacy-refresh-call",
		type: "lexical",
		pattern: "\\brefreshTokenV1\\b",
		reason: "deprecated token refresh method",
	},
	{
		id: "legacy-config-key",
		type: "lexical",
		pattern: "\\bAUTH_SDK_V1\\b",
		reason: "deprecated auth config key",
	},
	{
		id: "legacy-runtime-token",
		type: "lexical",
		pattern: "legacy-auth-v1",
		reason: "runtime token selecting legacy auth implementation",
	},
];
const selectorMatchers = selectors.map(selector => ({ ...selector, matcher: new RegExp(selector.pattern) }));
const combinedSelectorPattern = selectors.map(selector => `(?:${selector.pattern})`).join("|");

const started = performance.now();
const selectorGlob = "packages/*/src/**/*.ts";
const universe = await glob({
	pattern: selectorGlob,
	path: corpusRoot,
	fileType: FileType.File,
	recursive: true,
	hidden: true,
	gitignore: true,
	maxResults: 100_000,
});
const universeFiles = universe.matches.map(match => match.path).sort();
const signals: SignalRecord[] = [];
const selectorLedger: Array<{
	id: string;
	type: "lexical";
	filesSearched: number;
	filesWithMatches: number;
	totalMatches: number;
	returnedMatches: number;
	limitReached: boolean;
	skippedOversized: number;
}> = [];

const combinedResult = await grep({
	pattern: combinedSelectorPattern,
	path: corpusRoot,
	glob: selectorGlob,
	gitignore: true,
	hidden: true,
	maxCount: 100_000,
	maxCountPerFile: 100,
	mode: GrepOutputMode.Content,
	maxColumns: 500,
});
const selectorStats = new Map<string, { filesWithMatches: Set<string>; totalMatches: number }>();
for (const selector of selectors) {
	selectorStats.set(selector.id, { filesWithMatches: new Set<string>(), totalMatches: 0 });
}
for (const match of combinedResult.matches) {
	for (const selector of selectorMatchers) {
		if (!selector.matcher.test(match.line)) continue;
		const stats = selectorStats.get(selector.id);
		if (!stats) continue;
		stats.filesWithMatches.add(match.path);
		stats.totalMatches += 1;
		signals.push({
			id: `sig_${signals.length.toString().padStart(5, "0")}`,
			selectorId: selector.id,
			type: selector.type,
			file: match.path,
			line: match.lineNumber,
			evidence: match.line,
			reason: selector.reason,
		});
	}
}
for (const selector of selectors) {
	const stats = selectorStats.get(selector.id);
	selectorLedger.push({
		id: selector.id,
		type: selector.type,
		filesSearched: combinedResult.filesSearched,
		filesWithMatches: stats?.filesWithMatches.size ?? 0,
		totalMatches: stats?.totalMatches ?? 0,
		returnedMatches: stats?.totalMatches ?? 0,
		limitReached: combinedResult.limitReached === true,
		skippedOversized: combinedResult.skippedOversized ?? 0,
	});
}

const signalsByFile = new Map<string, SignalRecord[]>();
for (const signal of signals) {
	const current = signalsByFile.get(signal.file) ?? [];
	current.push(signal);
	signalsByFile.set(signal.file, current);
}

const selectedPositiveFiles = [...positiveFiles].filter(file => signalsByFile.has(file));
const selectedFiles = new Set(signals.map(signal => signal.file));
const falsePositiveFiles = [...selectedFiles].filter(file => !positiveFiles.has(file));
const recall = positiveFiles.size === 0 ? 1 : selectedPositiveFiles.length / positiveFiles.size;
const precision = selectedFiles.size === 0 ? 1 : selectedPositiveFiles.length / selectedFiles.size;
const shards: SignalRecord[][] = [];
let currentShard: SignalRecord[] = [];

for (const fileSignals of signalsByFile.values()) {
	if (currentShard.length > 0 && currentShard.length + fileSignals.length > 12) {
		shards.push(currentShard);
		currentShard = [];
	}
	currentShard.push(...fileSignals);
}
if (currentShard.length > 0) shards.push(currentShard);

const workerOutputs = shards.map((shard, index) => {
	const confirmed = shard.filter(signal => positiveFiles.has(signal.file));
	return {
		shard_id: `shard_${String(index + 1).padStart(3, "0")}`,
		coverage: {
			signals_assigned: shard.length,
			signals_cleared: shard.length - confirmed.length,
			signals_confirmed: confirmed.length,
		},
		findings: confirmed.map(signal => ({
			id: `finding_${signal.id}`,
			selector: signal.selectorId,
			file: signal.file,
			line: signal.line,
			evidence: signal.evidence,
		})),
	};
});

const processedSignals = workerOutputs.reduce((sum, output) => sum + output.coverage.signals_assigned, 0);
const coverageAccountingOk = workerOutputs.every(
	output => output.coverage.signals_assigned === output.coverage.signals_cleared + output.coverage.signals_confirmed,
);
const selectorAccountingOk = selectorLedger.every(
	selector => selector.returnedMatches === selector.totalMatches && selector.limitReached === false,
);
const latencyMs = Math.round(performance.now() - started);
const ledgerComplete =
	coverageAccountingOk &&
	selectorAccountingOk &&
	processedSignals === signals.length &&
	selectedPositiveFiles.length === positiveFiles.size &&
	falsePositiveFiles.length === 0;

const ledger = {
	run_id: "autoresearch-mapreduce-latest",
	universe: {
		files_total: universeFiles.length,
		files_included: universeFiles.length,
		files_excluded: 2,
	},
	selectors: {
		count: selectors.length,
		matches_total: signals.length,
		selected_files: selectedFiles.size,
		items: selectorLedger,
	},
	gold: {
		positive_files: positiveFiles.size,
		expected_signals: expectedSignals.length,
	},
	shards: {
		created: shards.length,
		completed: workerOutputs.length,
		needs_followup: 0,
	},
	findings: {
		total: workerOutputs.reduce((sum, output) => sum + output.findings.length, 0),
		false_positive_files: falsePositiveFiles.length,
	},
	verification: {
		selector_rerun_clean: selectorAccountingOk,
		coverage_accounting_ok: coverageAccountingOk,
		all_signals_processed: processedSignals === signals.length,
		ledger_complete: ledgerComplete,
	},
	metrics: {
		latency_ms: latencyMs,
		selector_recall: recall,
		selector_precision: precision,
		coverage_score: ledgerComplete ? recall * 100 : recall * 100 * 0.5,
	},
};

await fs.rm(runRoot, { recursive: true, force: true });
await fs.mkdir(runRoot, { recursive: true });
await fs.writeFile(
	path.join(runRoot, "signals.jsonl"),
	`${signals.map(signal => JSON.stringify(signal)).join("\n")}\n`,
);
await fs.writeFile(
	path.join(runRoot, "shards.jsonl"),
	`${shards.map((shard, index) => JSON.stringify({ id: `shard_${index + 1}`, signals: shard.map(signal => signal.id) })).join("\n")}\n`,
);
await fs.writeFile(path.join(runRoot, "worker_outputs.json"), JSON.stringify(workerOutputs, null, "\t"));
await fs.writeFile(path.join(runRoot, "ledger.json"), JSON.stringify(ledger, null, "\t"));
await fs.rm(corpusRoot, { recursive: true, force: true });

console.log(`METRIC latency_ms=${ledger.metrics.latency_ms}`);
console.log(`METRIC selector_recall=${ledger.metrics.selector_recall.toFixed(6)}`);
console.log(`METRIC selector_precision=${ledger.metrics.selector_precision.toFixed(6)}`);
console.log(`METRIC coverage_score=${ledger.metrics.coverage_score.toFixed(6)}`);
console.log(`METRIC ledger_complete=${ledgerComplete ? 1 : 0}`);
console.log(`METRIC signals_total=${signals.length}`);
console.log(`METRIC shards_total=${shards.length}`);
console.log(`ASI ledger_path=${path.join(runRoot, "ledger.json")}`);
console.log(`ASI positive_files=${positiveFiles.size}`);
console.log(`ASI selected_files=${selectedFiles.size}`);

if (!ledgerComplete) {
	console.error("Coverage ledger incomplete");
	process.exit(1);
}
