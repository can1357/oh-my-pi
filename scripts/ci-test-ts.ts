#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";

type Mode =
	| "all"
	| "local"
	| "local-ts"
	| "workspace"
	| "native"
	| "coding-agent-singleton"
	| "coding-agent-ui"
	| "coding-agent-runtime"
	| "coding-agent-native"
	| "coding-agent-heavy";

type CodingAgentBucket = "singleton" | "ui" | "runtime" | "native";

interface TestCommand {
	label: string;
	cwd: string;
	/** argv without `--parallel`; the runner appends it from `parallel` and the pool's CPU budget. */
	command: string[];
	/** `bun test --parallel` width this chunk wants when it has the machine to itself. */
	parallel?: number;
	/** Expected wall seconds from the timing history, set by weighted chunk planning; orders pool dispatch. */
	estimatedSeconds?: number;
}

type CodingAgentTestPartition = Record<CodingAgentBucket, string[]>;

const repoRoot = path.join(import.meta.dir, "..");
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const requestedMode = args.find(arg => !arg.startsWith("--")) ?? "all";
// `--only-failures` is Bun's output filter — it hides passing tests within each
// chunk, keeping the log terse, and is the default here (CI and the root
// `test:ts` aggregate append it). It does NOT skip tests or share any
// cross-process cache, so chunks are safe to run concurrently. The package-level
// `test` script passes `--full` for verbose output (every test line); an explicit
// `--only-failures` still wins.
const onlyFailures = args.includes("--only-failures") || !args.includes("--full");
const onlyFailuresArgs = onlyFailures ? ["--only-failures"] : [];
// Quiet mode (the default) collapses each parallel chunk to a one-line pass/fail
// progress entry and replays full stdout/stderr only for chunks that failed, so
// the failure is never buried under thousands of passing-chunk lines. `--full`
// opts back into inline replay of every chunk. Tied to `onlyFailures` so the
// quiet path is whatever the verbose filter is not.
const quiet = onlyFailures;

const validModes: Record<Mode, true> = {
	all: true,
	local: true,
	"local-ts": true,
	workspace: true,
	native: true,
	"coding-agent-singleton": true,
	"coding-agent-ui": true,
	"coding-agent-runtime": true,
	"coding-agent-native": true,
	"coding-agent-heavy": true,
};

// `chunkSize` caps how many files of a bucket share one `bun test` child process.
// A fresh process per chunk resets Bun's heap and reaps any dangling spawned
// children between groups, keeping peak RSS under the CI runner's OOM ceiling (a
// single 170–370-file invocation gets SIGKILLed at 137). A bucket always gets
// `ceil(files / chunkSize)` chunks. Which files share a chunk comes from the
// timing history (see TimingHistory): files are dealt heaviest-first onto the
// lightest chunk with room, so slow suites spread out instead of clustering in
// one alphabetical run (ten `cli-*` files once made a 67s chunk beside a 5s
// median), and chunks are numbered heaviest-first. With no history for any of a
// bucket's files the plan falls back to consecutive alphabetical runs. The
// singleton/global-state bucket is left whole: its suites co-locate in one
// process to exercise process-wide state, so they must not split.
//
// The UI/TUI bucket uses a smaller chunk (5) than the others: its suites build up
// native ghostty-vt cells, and bun 1.3.14's GC aborts (SIGTRAP/SIGABRT, exit
// 133/134 inside DOMGCOutputConstraint marking) once ~10 such files share a heap,
// even with the GC-marker knobs below. Bisection showed no single file is at
// fault — the crash is cumulative heap volume. Under a 256MB-forced heap, a
// 10-file chunk aborts ~50% of runs while either 5-file half is 0/20; halving the
// chunk keeps each process under the threshold.
const codingAgentBucketPlans: Record<CodingAgentBucket, { label: string; parallel: number; chunkSize?: number }> = {
	singleton: { label: "singleton/global-state bucket", parallel: 1 },
	ui: { label: "UI/TUI bucket", parallel: 1, chunkSize: 5 },
	runtime: { label: "runtime/session bucket", parallel: 1, chunkSize: 10 },
	native: { label: "native/tooling/browser/unit bucket", parallel: 1, chunkSize: 10 },
};

// Smaller workspace packages stay separate from native/TUI/integration suites so
// their short TS suites can run together. CI still downloads the Linux x64 native
// addon before this bucket: shared utility barrels may load native-backed modules.
const fastWorkspacePackages = [
	"packages/omptype",
	"packages/utils",
	"packages/catalog",
	"packages/ai",
	"packages/snapcompact",
	"packages/agent",
	"packages/mnemopi",
];

// These suites cover the native package, TUI/browser-ish behavior, local servers,
// or coding-agent-adjacent benchmark paths. Keep them low-concurrency and in jobs
// that have downloaded the Linux x64 native addon artifacts.
const nativeAndIntegrationPackages = [
	"packages/natives",
	"packages/tui",
	"packages/collab-web",
	"packages/typescript-edit-benchmark",
];

const projectToolTestCommand: TestCommand = {
	label: ".omp/tests (project-local TUI debug tool)",
	cwd: ".",
	command: ["bun", "test", ...onlyFailuresArgs, "./.omp/tests/tui.test.ts"],
	parallel: 1,
};

// Packages the CI buckets deliberately skip but a local full run should still
// cover. robomp-web lives under python/robomp and is outside every CI TS bucket.
const localOnlyWorkspacePackages = ["python/robomp/web"];

const codingAgentNativePathPatterns = [
	/(^|\/)[^/]*(bash|native|browser|cmux|mnemopi|hindsight|memory)[^/]*\.test\.ts$/i,
	/^test\/[^/]*(ask|gh|irc|task|eval|search|read|write|edit|ast|resolve|sqlite|web-search|fetch|image|ssh|tool)[^/]*\.test\.ts$/,
	/^test\/core\/python-[^/]*\.test\.ts$/,
	/^test\/core\/[^/]*executor[^/]*\.test\.ts$/,
	/^test\/tools\/[^/]*(ask|gh|irc|task|eval|search|read|edit|ast|resolve|sqlite|web-search|fetch|image|ssh)[^/]*\.test\.ts$/,
	/^test\/tools\/web-scrapers\//,
	/^test\/web\//,
	/^test\/ssh\//,
	/^test\/tools\.test\.ts$/,
];

const codingAgentSingletonPathPatterns = [
	/^test\/(settings|config|fast-mode-scope|autocomplete-max-visible)[^/]*\.test\.ts$/,
	/^test\/[^/]*(singleton|global-state|fake-timer)[^/]*\.test\.ts$/,
];

const codingAgentUiPathPatterns = [
	/^test\/modes\//,
	/^test\/(interactive-mode|main-interactive|input-controller|streaming|status-line|keybindings|editor|hook|theme|setup-wizard|job-renderer|tool-args-reveal|tool-execution)[^/]*\.test\.ts$/,
];

const codingAgentRuntimePathPatterns = [
	/^test\/agent-session[^/]*\.test\.ts$/,
	/^test\/(acp|mcp|rpc|sdk)[^/]*\.test\.ts$/,
	/^test\/(session|session-manager|task|collab|internal-urls)\//,
	/^test\/session[^/]*\.test\.ts$/,
	/^test\/session-manager[^/]*\.test\.ts$/,
	/^test\/(extensions?|plugin|autolearn|skills|marketplace|oauth)[^/]*\.test\.ts$/,
	/^test\/[^/]*oauth[^/]*\.test\.ts$/,
	/^test\/(extensibility|discovery|tool-discovery|goals|marketplace)\//,
	/^test\/(model|model-|model-registry|model-resolver|compaction)[^/]*\.test\.ts$/,
];

const codingAgentNativeContentMarkers = [
	"@oh-my-pi/pi-natives",
	"omp-natives",
	"native",
	"readImageMetadata",
	"Bun.spawn",
	"Bun.spawnSync",
	"child_process",
	"Bun.serve",
	"new Worker",
	"Worker(",
	"puppeteer",
	"bun:sqlite",
	"Redis",
	"redis",
	"WebSocket",
];

const codingAgentSingletonContentMarkers = [
	"Settings.init(",
	"Settings.instance",
	"resetSettingsForTest",
	"setAgentDir(",
	"vi.useFakeTimers(",
	"vi.useRealTimers(",
	"vi.stubEnv(",
	"vi.unstubAllEnvs(",
];

const codingAgentSingletonContentPatterns = [
	/(^|[^\w$.])(process\.env|Bun\.env)\.[A-Za-z0-9_]+\s*=/,
	/(^|[^\w$.])(process\.env|Bun\.env)\[[^\]]+\]\s*=/,
	/delete\s+(process\.env|Bun\.env)(\.[A-Za-z0-9_]+|\[[^\]]+\])/,
	/Object\.assign\((process\.env|Bun\.env),/,
];

const codingAgentUiContentMarkers = [
	"@oh-my-pi/pi-tui",
	"InteractiveMode",
	"InputController",
	"StatusLine",
	"ToolExecutionComponent",
	"render(",
	"renderToString",
];

const codingAgentRuntimeContentMarkers = ["AgentSession", "SessionManager", "AuthStorage", "Bun.sleep", "setTimeout("];

let codingAgentTestPartitionPromise: Promise<CodingAgentTestPartition> | null = null;

// A test whose own junit `time` exceeds this many seconds is called out in its
// chunk's progress line and in the end-of-run slow-test section. A warning
// only: it never fails the run.
const SLOW_TEST_SECONDS = 5;

// Observed durations from earlier non-dry runs, used to balance coding-agent
// chunks and to start the longest pool commands first. `files` maps a
// repo-relative test file to the seconds of its file-level junit suite;
// `commands` maps the label of a command that lists no test files (a whole
// package, the Rust task — labels that stay stable across runs) to its wall
// seconds. A machine-local cache: missing or malformed reads as empty, which is
// the cold-start plan.
interface TimingHistory {
	files: Record<string, number>;
	commands: Record<string, number>;
}

const timingHistoryPath = path.join(repoRoot, "node_modules/.cache/omp-test-timings.json");
const codingAgentCwd = "packages/coding-agent";
const TEST_FILE_ARG_RE = /\.test\.[cm]?[jt]sx?$/;

let timingHistoryPromise: Promise<TimingHistory> | null = null;

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function workspaceTestCommand(pkg: string, parallel: number, options: { extraArgs?: string[] } = {}): TestCommand {
	const { extraArgs = [] } = options;
	return {
		label: pkg,
		cwd: pkg,
		command: ["bun", "test", ...extraArgs],
		parallel,
	};
}

// The Rust suite as one pooled command, so root `bun run test` reports TS and
// Rust under the same progress stream / failure report. Delegates to
// run-rs-task.ts, which self-skips when the branch changed no Rust-affecting file
// since its merge base with main, committed or not (printing a one-line notice),
// and resolves the cargo/nextest invocation.
function rustTestCommand(): TestCommand {
	return {
		label: "rust (cargo nextest; skipped if no Rust changes)",
		cwd: ".",
		command: ["bun", "scripts/run-rs-task.ts", "test:rs"],
	};
}

async function collectTestsUnder(root: string, baseDir: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const filePath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectTestsUnder(filePath, baseDir)));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".test.ts")) {
			continue;
		}
		files.push(path.relative(baseDir, filePath).split(path.sep).join("/"));
	}
	return files;
}

function hasAnyMarker(content: string, markers: string[]): boolean {
	return markers.some(marker => content.includes(marker));
}

function matchesAnyPath(testFile: string, patterns: RegExp[]): boolean {
	return patterns.some(pattern => pattern.test(testFile));
}

function matchesAnyContentPattern(content: string, patterns: RegExp[]): boolean {
	return patterns.some(pattern => pattern.test(content));
}
// Native/tooling tests are classified first because they need the lowest
// concurrency; all coding-agent buckets run with the native addon available in CI.
function classifyCodingAgentTest(testFile: string, content: string): CodingAgentBucket {
	if (
		matchesAnyPath(testFile, codingAgentNativePathPatterns) ||
		hasAnyMarker(content, codingAgentNativeContentMarkers)
	) {
		return "native";
	}
	if (matchesAnyPath(testFile, codingAgentUiPathPatterns) || hasAnyMarker(content, codingAgentUiContentMarkers)) {
		return "ui";
	}
	if (
		matchesAnyPath(testFile, codingAgentSingletonPathPatterns) ||
		hasAnyMarker(content, codingAgentSingletonContentMarkers) ||
		matchesAnyContentPattern(content, codingAgentSingletonContentPatterns)
	) {
		return "singleton";
	}
	if (
		matchesAnyPath(testFile, codingAgentRuntimePathPatterns) ||
		hasAnyMarker(content, codingAgentRuntimeContentMarkers)
	) {
		return "runtime";
	}
	return "native";
}

async function getCodingAgentTestPartition(): Promise<CodingAgentTestPartition> {
	codingAgentTestPartitionPromise ??= (async () => {
		const codingAgentDir = path.join(repoRoot, "packages/coding-agent");
		const testFiles = (await collectTestsUnder(path.join(codingAgentDir, "test"), codingAgentDir)).sort();
		const partition: CodingAgentTestPartition = {
			singleton: [],
			ui: [],
			runtime: [],
			native: [],
		};

		for (const testFile of testFiles) {
			const content = await Bun.file(path.join(codingAgentDir, testFile)).text();
			partition[classifyCodingAgentTest(testFile, content)].push(testFile);
		}

		return partition;
	})();
	return codingAgentTestPartitionPromise;
}

// Keep the finite numeric entries of an untrusted JSON object.
function numberRecord(value: unknown): Record<string, number> {
	const record: Record<string, number> = {};
	if (typeof value !== "object" || value === null) return record;
	for (const key in value) {
		const entry: unknown = Reflect.get(value, key);
		if (typeof entry === "number" && Number.isFinite(entry)) record[key] = entry;
	}
	return record;
}

// Read the timing history from disk; a missing or corrupt file is an empty one.
async function readTimingHistory(): Promise<TimingHistory> {
	let raw: unknown;
	try {
		raw = await Bun.file(timingHistoryPath).json();
	} catch (err) {
		if (isEnoent(err) || err instanceof SyntaxError) return { files: {}, commands: {} };
		throw err;
	}
	if (typeof raw !== "object" || raw === null) return { files: {}, commands: {} };
	return {
		files: numberRecord("files" in raw ? raw.files : undefined),
		commands: numberRecord("commands" in raw ? raw.commands : undefined),
	};
}

// The history as it stood when this run started, read once for planning and dispatch.
function getTimingHistory(): Promise<TimingHistory> {
	timingHistoryPromise ??= readTimingHistory();
	return timingHistoryPromise;
}

function roundSeconds(seconds: number): number {
	return Math.round(seconds * 1000) / 1000;
}

// Whether the argv names test files; commands that don't run a whole package or task.
function listsTestFiles(testCommand: TestCommand): boolean {
	return testCommand.command.some(arg => TEST_FILE_ARG_RE.test(arg));
}

// Merge this run's observations into the on-disk history: re-read it (another
// run may have written since this one started), let every observed file and
// whole-package command overwrite its entry, keep everything not seen this run.
async function recordTimingHistory(runs: CommandRun[]): Promise<void> {
	if (runs.length === 0) return;
	const history = await readTimingHistory();
	for (const run of runs) {
		Object.assign(history.files, run.report?.fileSeconds);
		if (!listsTestFiles(run.command)) history.commands[run.command.label] = roundSeconds(run.seconds);
	}
	await Bun.write(timingHistoryPath, `${JSON.stringify(history, null, "\t")}\n`);
}

// A test slower than SLOW_TEST_SECONDS: where it lives (repo-relative
// `file:line`) and its `describe > test` name.
interface SlowTest {
	seconds: number;
	location: string;
	name: string;
}

// What one bun junit report says about timing: seconds per repo-relative test
// file (its file-level suite) and the slow tests.
interface JunitReport {
	fileSeconds: Record<string, number>;
	slowTests: SlowTest[];
}

// One finished command's contribution to the run's timing record: wall seconds
// (crash retries included) and its junit report, null when the command is not
// a `bun test` child or its child died before writing one.
interface CommandRun {
	command: TestCommand;
	seconds: number;
	report: JunitReport | null;
}

const JUNIT_TAG_RE = /<(\/?)(testsuites|testsuite|testcase)\b([^>]*)>/g;
const XML_ATTR_RE = /([\w:-]+)="([^"]*)"/g;
const XML_ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;
const XML_NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlText(value: string): string {
	return value.replace(XML_ENTITY_RE, (_match: string, dec?: string, hex?: string, named?: string) => {
		if (dec) return String.fromCodePoint(Number(dec));
		if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
		return named ? XML_NAMED_ENTITIES[named] : "";
	});
}

function parseXmlAttributes(source: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const [, key, value] of source.matchAll(XML_ATTR_RE)) attributes[key] = decodeXmlText(value);
	return attributes;
}

// Parse a bun junit report written by a child running in repo-relative `cwd`.
// Bun nests one `<testsuite>` per file directly under `<testsuites>`, then one
// per `describe`, with `<testcase>`s at any depth; `file` attributes are
// relative to the child's cwd. Only the tags are scanned (attribute values are
// entity-escaped, so they hold no `<`/`>`). Returns null for a truncated report.
function parseJunitReport(xml: string, cwd: string): JunitReport | null {
	if (!xml.includes("</testsuites>")) return null;
	const report: JunitReport = { fileSeconds: {}, slowTests: [] };
	let depth = 0;
	for (const [, closing, tag, rawAttributes] of xml.matchAll(JUNIT_TAG_RE)) {
		if (tag === "testsuites" || (closing && tag === "testcase")) continue;
		if (closing) {
			depth -= 1;
			continue;
		}
		const attributes = parseXmlAttributes(rawAttributes);
		const seconds = Number(attributes.time);
		const file = path.posix.join(cwd, attributes.file ?? "");
		if (tag === "testsuite") {
			depth += 1;
			if (depth === 1 && attributes.file && Number.isFinite(seconds)) {
				report.fileSeconds[file] = roundSeconds(seconds);
			}
			if (rawAttributes.trimEnd().endsWith("/")) depth -= 1;
		} else if (seconds > SLOW_TEST_SECONDS) {
			const name = attributes.name ?? "";
			report.slowTests.push({
				seconds,
				location: `${file}:${attributes.line ?? "?"}`,
				// Bun lists a nested test's describes innermost-first in `classname`.
				name: [...(attributes.classname?.split(" > ").reverse() ?? []), name].filter(Boolean).join(" > "),
			});
		}
	}
	return report;
}

// The junit report a finished child left at `junitPath`, or null when it wrote
// none (crashed, killed, or not a `bun test` child) or left it unparseable.
async function readJunitReport(junitPath: string, cwd: string): Promise<JunitReport | null> {
	try {
		return parseJunitReport(await Bun.file(junitPath).text(), cwd);
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

// One chunk of a bucket plan; `seconds` is its estimate, absent without history.
interface ChunkPlan {
	files: string[];
	seconds?: number;
}

// Per-file weights for a coding-agent bucket from the timing history; files with
// no entry weigh the mean of those that have one. Null when none has one.
function bucketFileWeights(testFiles: string[], history: TimingHistory): Map<string, number> | null {
	const known = testFiles
		.map(file => history.files[`${codingAgentCwd}/${file}`])
		.filter(seconds => seconds !== undefined);
	if (known.length === 0) return null;
	const mean = known.reduce((sum, seconds) => sum + seconds, 0) / known.length;
	return new Map(testFiles.map(file => [file, history.files[`${codingAgentCwd}/${file}`] ?? mean]));
}

// Cold-start plan: consecutive runs of `chunkSize` alphabetical files.
function consecutiveChunks(testFiles: string[], chunkSize: number): ChunkPlan[] {
	const chunks: ChunkPlan[] = [];
	for (let i = 0; i < testFiles.length; i += chunkSize) {
		chunks.push({ files: testFiles.slice(i, i + chunkSize) });
	}
	return chunks;
}

// Weighted plan: `ceil(n / chunkSize)` chunks, each capped at `chunkSize` files.
// Files are dealt in descending weight onto the currently lightest chunk with
// room (ties → lowest index), then each chunk's files are put back in
// alphabetical order and the chunks ordered heaviest-first.
function balancedChunks(testFiles: string[], chunkSize: number, weights: Map<string, number>): ChunkPlan[] {
	const weightOf = (file: string): number => weights.get(file) ?? 0;
	const chunks: Required<ChunkPlan>[] = Array.from({ length: Math.ceil(testFiles.length / chunkSize) }, () => ({
		files: [],
		seconds: 0,
	}));
	for (const file of [...testFiles].sort((a, b) => weightOf(b) - weightOf(a))) {
		let target = chunks[0];
		for (const chunk of chunks) {
			if (chunk.files.length >= chunkSize) continue;
			if (target.files.length >= chunkSize || chunk.seconds < target.seconds) target = chunk;
		}
		target.files.push(file);
		target.seconds += weightOf(file);
	}
	for (const chunk of chunks) chunk.files.sort();
	return chunks.sort((a, b) => b.seconds - a.seconds);
}

async function codingAgentTestCommands(bucket: CodingAgentBucket): Promise<TestCommand[]> {
	const partition = await getCodingAgentTestPartition();
	const testFiles = partition[bucket];
	if (testFiles.length === 0) {
		throw new Error(`No coding-agent ${bucket} tests matched`);
	}
	const plan = codingAgentBucketPlans[bucket];
	const chunkSize = plan.chunkSize ?? testFiles.length;
	const weights = bucketFileWeights(testFiles, await getTimingHistory());
	const chunks = weights ? balancedChunks(testFiles, chunkSize, weights) : consecutiveChunks(testFiles, chunkSize);
	return chunks.map((chunk, index) => {
		const chunkLabel = chunks.length > 1 ? ` chunk ${index + 1}/${chunks.length}` : "";
		return {
			label: `packages/coding-agent (${plan.label}; ${testFiles.length} files; parallel=${plan.parallel}${chunkLabel}; ${chunk.files.length} files)`,
			cwd: codingAgentCwd,
			command: ["bun", "test", ...onlyFailuresArgs, ...chunk.files],
			parallel: plan.parallel,
			estimatedSeconds: chunk.seconds === undefined ? undefined : roundSeconds(chunk.seconds),
		};
	});
}

async function commandsForMode(mode: Mode): Promise<TestCommand[]> {
	switch (mode) {
		case "workspace":
			return fastWorkspacePackages.map(pkg => workspaceTestCommand(pkg, 8));
		case "native":
			return [...nativeAndIntegrationPackages.map(pkg => workspaceTestCommand(pkg, 4)), projectToolTestCommand];
		case "coding-agent-singleton":
			return await codingAgentTestCommands("singleton");
		case "coding-agent-ui":
			return await codingAgentTestCommands("ui");
		case "coding-agent-runtime":
			return await codingAgentTestCommands("runtime");
		case "coding-agent-native":
			return await codingAgentTestCommands("native");
		case "coding-agent-heavy":
			return [
				...(await codingAgentTestCommands("singleton")),
				...(await codingAgentTestCommands("ui")),
				...(await codingAgentTestCommands("runtime")),
				...(await codingAgentTestCommands("native")),
			];
		case "all":
			return [
				...(await commandsForMode("workspace")),
				...(await commandsForMode("native")),
				...(await commandsForMode("coding-agent-heavy")),
			];
		// `local-ts` is the full local TypeScript run that root `bun run test:ts`
		// drives: every package the old `--workspaces` fan-out covered (the CI
		// `all` set plus robomp-web, which CI omits), routed through
		// this one quiet runner so the whole suite shares one progress stream and
		// one failure report.
		case "local-ts":
			return [
				...fastWorkspacePackages.map(pkg => workspaceTestCommand(pkg, 8, { extraArgs: onlyFailuresArgs })),
				...nativeAndIntegrationPackages.map(pkg => workspaceTestCommand(pkg, 4, { extraArgs: onlyFailuresArgs })),
				projectToolTestCommand,
				...localOnlyWorkspacePackages.map(pkg => workspaceTestCommand(pkg, 4, { extraArgs: onlyFailuresArgs })),
				...(await commandsForMode("coding-agent-heavy")),
			];
		// `local` is what root `bun run test` drives: the full TS suite plus the
		// Rust task, so a single invocation reports TS and Rust together. The Rust
		// command self-skips when no Rust-affecting files changed (see run-rs-task).
		case "local":
			return [...(await commandsForMode("local-ts")), rustTestCommand()];
	}
}

// Self-hosted runners may carry cloud credentials (`AWS_*`) in their
// environment, GitHub Actions injects `GITHUB_TOKEN`,
// and a host may carry provider API keys. Any of these make env-sensitive code
// non-deterministic in tests — e.g. leaked AWS creds make `amazon-bedrock` look
// authenticated and win the provider startup fallback over `anthropic`. Run the
// suites in a hermetic environment with all credential / cloud-config variables
// stripped so resolution depends only on the test's own fixtures.
const SCRUBBED_ENV_PREFIXES = ["AWS_", "GOOGLE_CLOUD_"];
const SCRUBBED_ENV_NAMES = new Set([
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"COPILOT_GITHUB_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"ANTHROPIC_OAUTH_TOKEN",
	"XAI_OAUTH_TOKEN",
]);

function isScrubbedEnvVar(key: string): boolean {
	if (SCRUBBED_ENV_NAMES.has(key)) {
		return true;
	}
	if (SCRUBBED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
		return true;
	}
	// Any provider credential, e.g. ANTHROPIC_API_KEY / XAI_OAUTH_TOKEN / bedrock bearer.
	return /_(API_KEY|OAUTH_TOKEN)$/.test(key) || key.includes("BEARER_TOKEN");
}

// Print a command's `==> label` / `$ argv` header; returns the rendered argv.
function printCommandHeader(testCommand: TestCommand): string {
	const renderedCommand = testCommand.command.map(shellQuote).join(" ");
	console.log(`\n==> ${testCommand.label}`);
	console.log(`$ ${renderedCommand}`);
	return renderedCommand;
}

// The argv actually spawned. Every `bun test` child (the commands
// applyChunkBudget gave a `parallel` width) also writes a junit report to
// `junitPath`, the runner's only per-test timing source; bun keeps its console
// reporter alongside it, so the captured output and `--only-failures` are
// unchanged. The displayed command omits it and stays the one to paste for a
// rerun. Crash retries overwrite the same file.
function spawnArgv(testCommand: TestCommand, junitPath: string): string[] {
	if (testCommand.parallel === undefined) return testCommand.command;
	return [...testCommand.command, "--reporter=junit", `--reporter-outfile=${junitPath}`];
}

// The sequential path: each command streams straight to the terminal in
// planned order and the first failure throws. Every finished command (failed
// ones too) lands in `runs`, and the slow-test section prints before the
// failure propagates.
async function runTestCommandsSequentially(
	commands: TestCommand[],
	junitDir: string,
	runs: CommandRun[],
): Promise<void> {
	try {
		for (const [index, testCommand] of commands.entries()) {
			await runTestCommand(testCommand, path.join(junitDir, `${index}.xml`), runs);
		}
	} finally {
		process.stdout.write(formatSlowTests(runs));
	}
}

async function runTestCommand(testCommand: TestCommand, junitPath: string, runs: CommandRun[]): Promise<void> {
	const cwd = path.join(repoRoot, testCommand.cwd);
	const renderedCommand = printCommandHeader(testCommand);
	const env = buildChildEnv();
	const startedAt = performance.now();
	try {
		for (let attempt = 1; ; attempt++) {
			const proc = Bun.spawn(spawnArgv(testCommand, junitPath), {
				cwd,
				env,
				stdout: "inherit",
				stderr: "inherit",
			});
			// Watchdog, mirroring the parallel path: record that *we* killed the child,
			// otherwise the resulting 137 is indistinguishable from an OOM kill.
			let timedOut = false;
			const killTimer = setTimeout(async () => {
				timedOut = true;
				try {
					process.stdout.write(await describeStuckProcessTree(proc.pid));
				} finally {
					proc.kill("SIGKILL");
				}
			}, chunkTimeoutMs());
			const exitCode = await proc.exited;
			clearTimeout(killTimer);
			if (exitCode === 0) {
				return;
			}
			if (!timedOut && BUN_CRASH_EXITS[exitCode] && attempt < MAX_CHUNK_ATTEMPTS) {
				console.log(
					`==> ${testCommand.label}: bun crashed (exit ${exitCode}); retrying (attempt ${attempt + 1}/${MAX_CHUNK_ATTEMPTS})`,
				);
				continue;
			}
			throw new Error(`${testCommand.label} ${describeChunkFailure(exitCode, timedOut)}: ${renderedCommand}`);
		}
	} finally {
		runs.push({
			command: testCommand,
			seconds: (performance.now() - startedAt) / 1000,
			report: await readJunitReport(junitPath, testCommand.cwd),
		});
	}
}

// Child env shared by every spawned test process: the parent env with the
// private test-runtime marker set, all CI credential / cloud-config variables
// scrubbed (see SCRUBBED_ENV_* above), and GITHUB_ACTIONS cleared. Clearing it
// would also clear run-rs-task.ts's "always run in GitHub Actions" rule for the
// Rust child, so under GitHub Actions OMP_FORCE_RUST_TASKS carries it instead.
//
// GC knobs (both needed — they gate different JSC mechanisms):
// - `BUN_JSC_useConcurrentGC=0` stops the collector from marking concurrently
//   with the mutator (868789972, an earlier GC crash under bun test).
// - `BUN_JSC_numberOfGCMarkers=1` removes the ParallelHelperPool marker
//   threads. Bun 1.3.14 segfaults/aborts inside parallel marking
//   (`DOMGCOutputConstraint::executeImplImpl` → `visitOutputConstraints` on a
//   dead cell; also "Pure virtual function called!") on heap-heavy
//   coding-agent chunks (~1.3GB RSS, native ghostty-vt cells). Repro: UI
//   bucket chunk crashed ~25% of runs with `BUN_JSC_forceRAMSize=256MB`,
//   0/10 with markers=1, at zero measured wall-time cost. useConcurrentGC=0
//   alone did not prevent it — the crash predates this knob.
//
// The knobs are necessary but not sufficient: the same GC bug also fires on
// the *mutator* thread (`Heap::collectInMutatorThread` →
// `MarkingConstraintSolver::runExecutionThread` → `DOMGCOutputConstraint` →
// `JSAbortSignal::visitAdditionalChildrenInGCThread` reading a dead `reason`
// cell), where no marker/concurrency knob applies. That residual crash is
// handled by retrying crashed chunks in a fresh process (MAX_CHUNK_ATTEMPTS).
function buildChildEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...Bun.env,
		GITHUB_ACTIONS: "",
		...(Bun.env.GITHUB_ACTIONS === "true" ? { OMP_FORCE_RUST_TASKS: "1" } : {}),
		PI_TEST_RUNTIME: "1",
		BUN_JSC_useConcurrentGC: "0",
		BUN_JSC_numberOfGCMarkers: "1",
	};
	for (const key of Object.keys(env)) {
		if (isScrubbedEnvVar(key)) {
			delete env[key];
		}
	}
	return env;
}

// Per-chunk watchdog. A bun child that wedges (e.g. the panic handler
// deadlocking after a GC crash) would otherwise stall the whole run: the
// parallel path awaits the child's stdout/stderr pipes, which stay open as
// long as the wedged process — or any grandchild that inherited them — lives.
// After this many seconds the child is SIGKILLed and reported as a failure.
// Override with OMP_TEST_CHUNK_TIMEOUT (seconds).
function chunkTimeoutMs(): number {
	const raw = Number(Bun.env.OMP_TEST_CHUNK_TIMEOUT?.trim());
	if (Number.isFinite(raw) && raw >= 1) return raw * 1000;
	return 600_000;
}

// What a watchdog-killed chunk was still doing, captured just before the
// SIGKILL: every process left in the chunk's tree (the `bun test` coordinator,
// its `--test-worker`s, anything they spawned) with state, CPU, RSS and kernel
// wait channel, plus the sockets those processes hold (via `ss`, or the raw
// `/proc/<pid>/fd` targets when `ss` is absent, as on the CI runner image). A
// chunk can report every test and still never exit; this is the only evidence
// of which process refused to and what it was blocked on. Linux-only (ps column
// names, /proc); "" elsewhere or without `ps`. Never throws: callers kill the
// chunk right after, and a snapshot failure must not stop that.
async function describeStuckProcessTree(rootPid: number): Promise<string> {
	if (process.platform !== "linux" || !Bun.which("ps")) return "";
	try {
		return await snapshotProcessTree(rootPid);
	} catch (err) {
		return `[watchdog] process tree snapshot failed: ${err instanceof Error ? err.message : String(err)}\n`;
	}
}

async function snapshotProcessTree(rootPid: number): Promise<string> {
	const ps = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,stat=,etimes=,pcpu=,rss=,wchan:24=,args="]);
	if (!ps.success) return "";
	const rows = ps.stdout
		.toString()
		.split("\n")
		.map(line => line.trim().split(/\s+/))
		.filter(cols => cols.length >= 8);
	const tree = new Set([String(rootPid)]);
	for (let grew = true; grew;) {
		grew = false;
		for (const cols of rows) {
			if (tree.has(cols[1]) && !tree.has(cols[0])) {
				tree.add(cols[0]);
				grew = true;
			}
		}
	}
	const lines = ["[watchdog] live process tree (pid ppid stat elapsed_s cpu% rss_kb wchan args):"];
	for (const cols of rows) {
		if (tree.has(cols[0])) lines.push(`  ${cols.slice(0, 7).join(" ")} ${cols.slice(7).join(" ").slice(0, 200)}`);
	}
	const ss = Bun.which("ss") ? Bun.spawnSync(["ss", "-tuanpH"]) : null;
	if (ss?.success) {
		const owned = ss.stdout
			.toString()
			.split("\n")
			.filter(line => [...tree].some(pid => line.includes(`pid=${pid},`)));
		lines.push(`[watchdog] sockets held by that tree (${owned.length}):`, ...owned.map(line => `  ${line.trim()}`));
		return `${lines.join("\n")}\n`;
	}
	// No `ss`: list each process's non-tty fds (sockets, pipes, files). A
	// process gone between `ps` and here just yields nothing.
	lines.push("[watchdog] open fds per process (no ss on PATH):");
	for (const pid of tree) {
		const fdDir = `/proc/${pid}/fd`;
		const targets = await fs.readdir(fdDir).then(
			fds => Promise.all(fds.map(fd => fs.readlink(`${fdDir}/${fd}`).catch(() => ""))),
			() => [],
		);
		const kept = targets.filter(target => target && !target.startsWith("/dev/"));
		if (kept.length > 0) lines.push(`  ${pid}: ${kept.join(" ").slice(0, 400)}`);
	}
	return `${lines.join("\n")}\n`;
}

// Exit codes that mean the bun process itself died to a runtime fault
// (128 + fatal signal) rather than reporting failing tests (which exit 1).
// Bun's panic handler exits via SIGTRAP (133) on macOS; raw SIGILL/SIGBUS/
// SIGABRT/SIGFPE/SIGSEGV surface as 132/135|138/134/136/139. 137 (SIGKILL)
// is deliberately excluded: that's the watchdog or the OOM killer, and
// retrying an OOM-killed chunk just OOMs again.
const BUN_CRASH_EXITS: Record<number, true> = {
	132: true,
	133: true,
	134: true,
	135: true,
	136: true,
	138: true,
	139: true,
};

// Total attempts a chunk gets when bun itself crashes. Bun 1.3.14's residual
// GC crash (JSAbortSignal `reason` visited on a dead cell during marking) is
// heap-timing dependent — a fresh process nearly always passes — while a
// deterministic crash still fails every attempt and is reported normally.
const MAX_CHUNK_ATTEMPTS = 3;

// Why a chunk failed, in words. Exit 137 is SIGKILL, which this runner reaches
// two very different ways -- the per-chunk watchdog firing, or the kernel OOM
// killer reaping a chunk that outgrew the runner -- and the bare exit code
// cannot tell them apart. Which one it was is the difference between "raise
// OMP_TEST_CHUNK_TIMEOUT" and "lower this bucket's chunkSize", so say it.
function describeChunkFailure(exitCode: number, timedOut: boolean): string {
	if (timedOut) {
		return `exceeded the ${Math.round(chunkTimeoutMs() / 1000)}s chunk watchdog and was killed (exit ${exitCode}; OMP_TEST_CHUNK_TIMEOUT to change)`;
	}
	if (exitCode === 137) {
		return "was SIGKILLed (exit 137) without reaching the chunk watchdog, which on a CI runner means the OOM killer; lower this bucket's chunkSize";
	}
	return `failed with exit code ${exitCode}`;
}

// The standard `CI` signal is authoritative. In CI each bucket is its own
// memory-capped runner job (a single fat invocation gets OOM-killed at 137), so
// chunks run sequentially within a job and parallelism happens across jobs.
// Locally we trade memory for wall-clock and fan the chunks out across cores.
function isCI(): boolean {
	const value = Bun.env.CI;
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

// Fan-out width for the local parallel path, clamped to the command count and
// to `cores`. Defaults to `cores`; `OMP_TEST_CONCURRENCY` (`spec`) dials it down
// on a memory-constrained machine, and `all`/`max` name the cap explicitly.
// Never wider than `cores`: every chunk is a full `bun test` process (~1 GB
// resident on coding-agent), so launching all ~190 at once only trades a
// CPU-bound run for an OOM kill.
function testConcurrency(total: number, spec: string | undefined, cores: number): number {
	const cap = Math.min(Math.max(1, cores), total);
	const raw = spec?.trim().toLowerCase();
	if (!raw || raw === "all" || raw === "max") return cap;
	const override = Number(raw);
	if (Number.isFinite(override) && override >= 1) {
		return Math.min(Math.floor(override), cap);
	}
	throw new Error(`Invalid OMP_TEST_CONCURRENCY=${JSON.stringify(raw)}; expected a positive integer, all, or max`);
}

// Test files interleave real IO — sqlite writes, temp dirs, spawned CLIs — with
// CPU, so keeping every core busy needs more in-flight files than cores. This is
// the factor by which the shared budget exceeds `availableParallelism()`.
const FILE_OVERSUBSCRIBE = 2;

// Two independent parallelism knobs stack multiplicatively: the chunk pool runs
// `poolWidth` `bun test` processes at once, and each of those runs its own
// `--parallel=N` test files concurrently, so up to `poolWidth * N` files are in
// flight. Left unbudgeted that oversubscribes the runner by design — the
// workspace bucket asked for 4 x 8 = 32 files on a 4-core box — and because
// bun's per-test timeout is wall-clock, CPU-starved suites blow it and fail at
// random (mnemopi's sqlite/CLI files did, a different set each run). Spend one
// budget instead: each live chunk gets an equal share, never below 1 and never
// above the width it asked for. A chunk that runs alone still gets everything,
// so the sequential CI path is unchanged.
function budgetedParallel(requested: number, poolWidth: number): number {
	const budget = Math.max(1, os.availableParallelism()) * FILE_OVERSUBSCRIBE;
	return Math.max(1, Math.min(requested, Math.floor(budget / poolWidth)));
}

// Bun's 5s default per-test timeout is a unit-test default, and this repo's
// suites are not unit tests: mnemopi builds real SQLite schemas per case, the
// coding-agent suites drive sessions and subprocesses. Those cases already run
// 1-4s on a quiet CI runner, so any scheduling hiccup crosses 5s and reports a
// timeout that says nothing about the code. Timing out is still worth catching,
// so keep a ceiling — just one loose enough to only fire on a real hang. The
// per-chunk watchdog (chunkTimeoutMs) remains the backstop for a wedged process.
// Override with OMP_TEST_TIMEOUT (seconds); per-test `it(name, fn, ms)` still wins.
function testTimeoutMs(): number {
	const raw = Number(Bun.env.OMP_TEST_TIMEOUT?.trim());
	if (Number.isFinite(raw) && raw >= 1) return raw * 1000;
	return 30_000;
}

// Materialize each chunk's argv against the pool width it will actually run at,
// rewriting `parallel` from the requested width to the granted one so later
// reporting reads the truth. A `parallel` request marks the command as a `bun
// test` invocation, so that is also where the shared per-test timeout is
// applied; the Rust task, which has neither, passes through untouched.
function applyChunkBudget(commands: TestCommand[], poolWidth: number): TestCommand[] {
	const timeout = testTimeoutMs();
	return commands.map(testCommand => {
		if (testCommand.parallel === undefined) return testCommand;
		const parallel = budgetedParallel(testCommand.parallel, poolWidth);
		return {
			...testCommand,
			command: [...testCommand.command, `--parallel=${parallel}`, `--timeout=${timeout}`],
			parallel,
		};
	});
}

// ANSI styling for interactive runs only; disabled when stdout is not a TTY or
// NO_COLOR is set, so CI logs and piped/aggregated output stay plain text.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, value: string): string => (useColor ? `\x1b[${code}m${value}\x1b[0m` : value);
const style = {
	green: (s: string) => paint("32", s),
	red: (s: string) => paint("31", s),
	bold: (s: string) => paint("1", s),
	dim: (s: string) => paint("2", s),
	yellow: (s: string) => paint("33", s),
};

// Outcome of one finished chunk. `output` is the chunk's combined stdout+stderr,
// buffered so it can be withheld during a quiet run and replayed only on failure.
// `retries` counts extra attempts spent on bun-crash exits (see BUN_CRASH_EXITS).
// `slowTests` comes from the chunk's junit report (see SLOW_TEST_SECONDS).
interface ChunkOutcome {
	label: string;
	command: string;
	exitCode: number;
	seconds: number;
	output: string;
	retries: number;
	slowTests: SlowTest[];
}

// Human duration in bun's bracket style: `[264ms]` under a second, `[3.3s]`
// above. Used by the progress line and footer so timings read like `bun test`.
function formatDuration(seconds: number): string {
	return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(1)}s`;
}

// One-line live progress entry in `bun test` style: `✓ <label> [time]` for a
// pass, `✗ <label> [time]` for a failure (bold red so the eye lands on it in a
// long scroll). A failure also names the first failing test parsed from the
// captured output — `— file > test (+N more)` — so the exact break is visible
// in the stream without waiting for the end-of-run report. A yellow
// `(N slow >5s)` note counts the chunk's slow tests, listed at the end of the
// run. Emitted in completion order as each chunk finishes.
function formatProgressLine(outcome: ChunkOutcome): string {
	const time = style.dim(`[${formatDuration(outcome.seconds)}]`);
	const slowNote =
		outcome.slowTests.length > 0
			? ` ${style.yellow(`(${outcome.slowTests.length} slow >${SLOW_TEST_SECONDS}s)`)}`
			: "";
	const retryNote = outcome.retries > 0 ? ` ${style.dim(`(retried ×${outcome.retries} after bun crash)`)}` : "";
	const notes = `${slowNote}${retryNote}`;
	if (outcome.exitCode === 0) {
		return `${style.green("✓")} ${outcome.label} ${time}${notes}`;
	}
	const failing = extractFailingTests(outcome.output);
	const first = failing[0]?.name;
	const more = failing.length > 1 ? style.dim(` (+${failing.length - 1} more)`) : "";
	const detail = first ? ` ${style.dim("—")} ${style.red(first)}${more}` : "";
	return `${style.bold(style.red(`✗ ${outcome.label}`))} ${time}${detail}${notes}`;
}

// Closing tally in `bun test` style, but counting test *chunks* (child commands),
// not individual tests — the runner never parses child summaries. A green
// `N chunks passed` line, a `N failed` line (red when non-zero, dim when clean),
// then the total wall time. Printed after the failure report so a run always
// ends on an at-a-glance verdict.
function formatSummaryFooter(passed: number, failed: number, totalSeconds: number): string {
	const failLine = failed > 0 ? style.red(`${failed} failed`) : style.dim("0 failed");
	return [
		"",
		` ${style.green(`${passed} chunks passed`)}`,
		` ${failLine}`,
		style.dim(`Ran ${passed + failed} test command(s) in ${formatDuration(totalSeconds)}.`),
	].join("\n");
}

// End-of-run warning listing every test slower than SLOW_TEST_SECONDS, slowest
// first: `[duration] file:line — describe > test`. Printed by both run paths
// ahead of the failure report / summary footer; "" when nothing was slow. It
// is advice, not a failure, and never touches the exit code.
function formatSlowTests(runs: CommandRun[]): string {
	const slowTests = runs.flatMap(run => run.report?.slowTests ?? []).sort((a, b) => b.seconds - a.seconds);
	if (slowTests.length === 0) return "";
	const lines = ["", style.yellow(`⚠ ${slowTests.length} test(s) slower than ${SLOW_TEST_SECONDS}s:`)];
	for (const test of slowTests) {
		lines.push(
			`  ${style.yellow(`[${formatDuration(test.seconds)}]`)} ${test.location} ${style.dim("—")} ${test.name}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

// A single failing test pulled from a chunk's captured bun output: its
// `file > test` identifier and the verbatim failure block bun printed for it
// (source frame, `error:` line, received/expected) — the detail a developer
// needs to act without re-running.
interface FailingTest {
	name: string;
	detail: string;
}

// Parse the failing tests + their detail blocks out of a chunk's captured bun
// output. Bun emits, per failure, a source code frame and `error:` block
// *followed by* its `(fail) <name> [<time>]` marker, all under the most recent
// `<relative/path>.test.ts:` header. We track the current header, buffer the
// lines since the last marker/header (that's the pending failure's frame), and
// flush them when the `(fail)` line arrives. ANSI is stripped only to classify
// lines; the detail keeps bun's original bytes (incl. color). Returns `[]` when
// the chunk died without per-test markers (e.g. a compile/import crash), so the
// caller can fall back to replaying the raw log.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const FILE_HEADER_RE = /^(\S.*\.test\.[cm]?[jt]sx?):$/;
const FAIL_MARKER_RE = /^\(fail\)\s+(.*?)(?:\s+\[[\d.]+\s*m?s\])?$/;
function extractFailingTests(output: string): FailingTest[] {
	const failing: FailingTest[] = [];
	let currentFile = "";
	let buffer: string[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.replace(ANSI_RE, "").trim();
		const header = FILE_HEADER_RE.exec(line);
		if (header) {
			currentFile = header[1];
			buffer = [];
			continue;
		}
		const fail = FAIL_MARKER_RE.exec(line);
		if (fail) {
			failing.push({
				name: currentFile ? `${currentFile} > ${fail[1]}` : fail[1],
				detail: buffer.join("\n").trim(),
			});
			buffer = [];
			continue;
		}
		buffer.push(raw);
	}
	return failing;
}

// Final report for the chunks that failed. Each chunk lists its failing tests,
// and under each test name bun's own failure block (source frame + `error:` +
// received/expected) is reproduced verbatim — caret alignment and diffs intact —
// so it reads like a direct `bun test` failure. In quiet mode (`replayOutput`)
// the blocks are shown because the run withheld them; in verbose mode they
// already streamed inline, so only the names are listed. When a chunk crashed
// without per-test markers (no parseable failures) the raw log is replayed as a
// fallback in quiet mode.
function formatChunkFailure(failure: ChunkOutcome, replayOutput: boolean): string {
	const lines: string[] = [];
	lines.push(
		"",
		style.bold(style.red(`✗ ${failure.label} (exit ${failure.exitCode})`)),
		style.dim(`$ ${failure.command}`),
	);
	const failing = extractFailingTests(failure.output);
	// Fully attributed only when every failure carries its own bun block;
	// otherwise (no markers, or a marker with no preceding frame — timeouts,
	// crashes) name what we can and replay the raw log so no error is lost.
	const fullyAttributed = failing.length > 0 && failing.every(test => test.detail.length > 0);
	for (const test of failing) {
		lines.push("", `  ${style.red("✗")} ${style.bold(test.name)}`);
		// Flush-left and verbatim so bun's caret/diff alignment is preserved.
		if (replayOutput && fullyAttributed) {
			lines.push(test.detail);
		}
	}
	if (replayOutput && !fullyAttributed && failure.output.trim().length > 0) {
		lines.push("", failure.output.trimEnd());
	}
	return lines.join("\n");
}

// Run every command through a fixed-width worker pool. Each child's stdout and
// stderr are drained concurrently (so a chatty test never deadlocks on a full
// pipe) and buffered. Quiet mode (the default) prints one progress line per
// finished chunk and replays full output only for failures, in a single report
// at the end; `--full` streams every chunk's output inline as it completes. All
// failures are collected and reported together instead of failing fast, so one
// run surfaces every broken chunk and exits non-zero without a runner stack trace.
// Commands are dispatched in the given order; every finished one lands in `runs`.
async function runTestCommandsInParallel(
	commands: TestCommand[],
	concurrency: number,
	junitDir: string,
	runs: CommandRun[],
): Promise<void> {
	const env = buildChildEnv();
	const queue = [...commands];
	const failures: ChunkOutcome[] = [];
	let completed = 0;
	let dispatched = 0;
	const fileWidths = [...new Set(commands.map(c => c.parallel).filter(p => p !== undefined))].sort((a, b) => a - b);
	console.log(
		`Running ${commands.length} test command(s), up to ${concurrency} in parallel ` +
			`(OMP_TEST_CONCURRENCY=<n> to lower); ${os.availableParallelism()} cores, ` +
			`--parallel=${fileWidths.join("/") || "n/a"} per chunk.`,
	);

	// Incremental, cancellable drain into a mutable sink, so a watchdog-killed
	// chunk still reports whatever the child managed to print before it wedged.
	function drainInto(
		stream: ReadableStream<Uint8Array>,
		sink: { text: string },
	): { done: Promise<void>; cancel: () => void } {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		const done = (async () => {
			try {
				for (;;) {
					const { done: ended, value } = await reader.read();
					if (ended) break;
					sink.text += decoder.decode(value, { stream: true });
				}
			} catch {
				// cancelled or broken pipe — keep what was captured
			}
			sink.text += decoder.decode();
		})();
		return { done, cancel: () => void reader.cancel().catch(() => {}) };
	}

	// Wait for `promise` at most `ms`; resolves `true` when it settled in time.
	// Never rejects.
	async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
		const { promise: expired, resolve } = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => resolve(false), ms);
		const settled = await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			expired,
		]);
		clearTimeout(timer);
		return settled;
	}

	// One spawn of a chunk: pipes drained into buffers, watchdog-killed if it
	// wedges, post-exit drain capped so leaked grandchildren holding the pipes
	// can't keep the runner's event loop alive.
	async function runAttempt(
		testCommand: TestCommand,
		junitPath: string,
	): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
		const proc = Bun.spawn(spawnArgv(testCommand, junitPath), {
			cwd: path.join(repoRoot, testCommand.cwd),
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = { text: "" };
		const stderr = { text: "" };
		const stdoutDrain = drainInto(proc.stdout as ReadableStream<Uint8Array>, stdout);
		const stderrDrain = drainInto(proc.stderr as ReadableStream<Uint8Array>, stderr);
		const drains = Promise.all([stdoutDrain.done, stderrDrain.done]);
		// Watchdog: a wedged child (e.g. bun's panic handler deadlocking
		// after a GC crash) would otherwise hang this worker forever.
		let timedOut = false;
		let stuckTree = "";
		const killTimer = setTimeout(async () => {
			timedOut = true;
			try {
				stuckTree = await describeStuckProcessTree(proc.pid);
			} finally {
				proc.kill("SIGKILL");
			}
		}, chunkTimeoutMs());
		const exitCode = await proc.exited;
		clearTimeout(killTimer);
		if (!(await settleWithin(drains, 5000))) {
			stdoutDrain.cancel();
			stderrDrain.cancel();
			await drains;
		}
		return {
			exitCode,
			timedOut,
			output: `${stdout.text}${stderr.text}${timedOut ? `\n${stuckTree}[watchdog] chunk exceeded ${Math.round(chunkTimeoutMs() / 1000)}s; killed with SIGKILL (OMP_TEST_CHUNK_TIMEOUT to change)\n` : ""}`,
		};
	}

	async function worker(): Promise<void> {
		for (;;) {
			const testCommand = queue.shift();
			if (!testCommand) {
				return;
			}
			const renderedCommand = testCommand.command.map(shellQuote).join(" ");
			const junitPath = path.join(junitDir, `${dispatched++}.xml`);
			const startedAt = performance.now();
			let attempt = 1;
			let result = await runAttempt(testCommand, junitPath);
			// Bun-crash retry: a 128+signal exit means the runtime died (GC
			// segfault/abort), not that tests failed — rerun in a fresh heap.
			while (!result.timedOut && BUN_CRASH_EXITS[result.exitCode] && attempt < MAX_CHUNK_ATTEMPTS) {
				attempt += 1;
				process.stdout.write(
					`${style.dim(`↻ ${testCommand.label} — bun crashed (exit ${result.exitCode}); retrying (attempt ${attempt}/${MAX_CHUNK_ATTEMPTS})`)}\n`,
				);
				result = await runAttempt(testCommand, junitPath);
			}
			completed += 1;
			const seconds = (performance.now() - startedAt) / 1000;
			const report = await readJunitReport(junitPath, testCommand.cwd);
			runs.push({ command: testCommand, seconds, report });
			const outcome: ChunkOutcome = {
				label: testCommand.label,
				command: renderedCommand,
				exitCode: result.exitCode,
				seconds,
				output: result.output,
				retries: attempt - 1,
				slowTests: report?.slowTests ?? [],
			};
			if (quiet) {
				let msg = `${formatProgressLine(outcome)}\n`;
				if (result.exitCode !== 0 || result.timedOut) {
					msg += `${formatChunkFailure(outcome, true)}\n`;
				}
				process.stdout.write(msg);
			} else {
				const status = result.exitCode === 0 ? "ok" : `FAILED exit ${result.exitCode}`;
				process.stdout.write(
					`\n==> [${completed}/${commands.length}] ${testCommand.label} (${status}, ${outcome.seconds.toFixed(1)}s)\n$ ${renderedCommand}\n${outcome.output}`,
				);
			}
			if (result.exitCode !== 0 || result.timedOut) {
				failures.push(outcome);
			}
		}
	}

	const runStartedAt = performance.now();
	await Promise.all(Array.from({ length: concurrency }, () => worker()));

	process.stdout.write(formatSlowTests(runs));

	if (quiet) {
		const totalSeconds = (performance.now() - runStartedAt) / 1000;
		process.stdout.write(
			`${formatSummaryFooter(commands.length - failures.length, failures.length, totalSeconds)}\n`,
		);
	} else if (failures.length > 0) {
		process.stdout.write(style.bold(style.red(`\n${failures.length} of ${commands.length} test chunk(s) FAILED\n`)));
	}
	if (failures.length > 0) {
		process.exitCode = 1;
	}
}

// Pool dispatch order: longest expected first, so the slowest commands start
// while the pool is full instead of trailing alone at the end. A chunk's
// estimate is its planned `estimatedSeconds`; a command that lists no test
// files uses its label's recorded wall time. Commands with no estimate go
// first (they may be long), and the sort is stable, so a cold history
// dispatches in planned order.
function dispatchOrder(commands: TestCommand[], history: TimingHistory): TestCommand[] {
	const estimate = (testCommand: TestCommand): number =>
		testCommand.estimatedSeconds ??
		(listsTestFiles(testCommand) ? undefined : history.commands[testCommand.label]) ??
		Number.POSITIVE_INFINITY;
	return commands
		.map(testCommand => ({ testCommand, seconds: estimate(testCommand) }))
		.sort((a, b) => (a.seconds === b.seconds ? 0 : a.seconds > b.seconds ? -1 : 1))
		.map(entry => entry.testCommand);
}

// `OMP_TEST_SHARD=i/n` splits a mode's chunk commands across n CI jobs; job i
// runs every chunk whose index ≡ i-1 (mod n). Round-robin rather than
// contiguous ranges because neighbouring chunks are alike in cost (weighted
// plans list a bucket's chunks heaviest-first; consecutive ones keep similar
// suites together), so slow chunks spread evenly instead of piling into one
// shard. Every chunk lands in exactly one shard; unset/empty runs everything.
function selectShard<T>(commands: T[], spec: string | undefined): T[] {
	const trimmed = spec?.trim();
	if (!trimmed) return commands;
	const match = /^(\d+)\/(\d+)$/.exec(trimmed);
	const index = match ? Number(match[1]) : 0;
	const count = match ? Number(match[2]) : 0;
	if (!match || count < 1 || index < 1 || index > count) {
		throw new Error(`Invalid OMP_TEST_SHARD=${JSON.stringify(trimmed)}; expected i/n with 1 <= i <= n`);
	}
	const selected = commands.filter((_, i) => i % count === index - 1);
	if (selected.length === 0) {
		throw new Error(`OMP_TEST_SHARD=${trimmed} selects no chunks (${commands.length} available)`);
	}
	return selected;
}

if (!(requestedMode in validModes)) {
	throw new Error(`Unknown mode ${shellQuote(requestedMode)}. Expected one of: ${Object.keys(validModes).join(", ")}`);
}

const requestedCommands = selectShard(await commandsForMode(requestedMode as Mode), Bun.env.OMP_TEST_SHARD);
const explicitConcurrency = Boolean(Bun.env.OMP_TEST_CONCURRENCY?.trim());
// CI defaults to one process at a time, but memory-sized workflow buckets
// explicitly opt into bounded process concurrency. Local runs fan out by
// default and may use the same override. Resolved before the dry-run check so
// `--dry-run` prints the argv the real run would use, budget included.
const pooled = requestedCommands.length > 1 && (!isCI() || explicitConcurrency);
// The sequential path is a pool of one, so a lone chunk keeps the whole budget.
const poolWidth = pooled
	? testConcurrency(requestedCommands.length, Bun.env.OMP_TEST_CONCURRENCY, os.availableParallelism())
	: 1;
const testCommands = applyChunkBudget(requestedCommands, poolWidth);
if (isDryRun) {
	for (const testCommand of testCommands) printCommandHeader(testCommand);
} else {
	// Per-command junit reports (see spawnArgv) live only for this run; what they
	// say is folded into the timing history before they are removed.
	const junitDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-test-junit-"));
	const runs: CommandRun[] = [];
	try {
		if (pooled) {
			await runTestCommandsInParallel(
				dispatchOrder(testCommands, await getTimingHistory()),
				poolWidth,
				junitDir,
				runs,
			);
		} else {
			await runTestCommandsSequentially(testCommands, junitDir, runs);
		}
	} finally {
		await recordTimingHistory(runs);
		await fs.rm(junitDir, { recursive: true, force: true });
	}
}
