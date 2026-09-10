#!/usr/bin/env bun
/**
 * Production architecture benchmark.
 *
 * Compares N independent direct-mode session runtimes with N sessions hosted
 * by one real daemon worker. Both shapes use the same isolated HOME, project,
 * profile, arguments, and MCP/LSP-disabled workload; no model request or live
 * daemon state is involved.
 *
 * `--fairness` switches to the multi-session responsiveness benchmark: one
 * real daemon worker hosts N sessions; one session serves a saturating
 * command flood while the others measure command/status round-trip
 * latencies (p50/p95/p99, failures, timeouts). Deterministic regression
 * contracts for the same behavior live in `test/daemon-fairness.test.ts`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Subprocess } from "bun";
import { createDaemonClient, type DaemonClient } from "../src/daemon/client";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../src/subprocess/worker-client";

export interface ProcessSample {
	pid: number;
	ppid: number;
	pssKb: number;
	rssKb: number;
	cpuUserTicks: number;
	cpuSystemTicks: number;
	threads: number;
	fds: number;
}

export interface ProcessTreeMetrics {
	rootPid: number;
	processCount: number;
	childProcessCount: number;
	pssKb: number;
	rssKb: number;
	cpuUserTicks: number;
	cpuSystemTicks: number;
	threads: number;
	fds: number;
	snapshot: ProcessSample[];
}

export interface BenchmarkFixture {
	cwd: string;
	profile: string;
	model: string;
	permissions: string;
	mcpEnabled: boolean;
	lspEnabled: boolean;
	environment: Record<string, string>;
}

export interface FixtureParity {
	equivalent: boolean;
	differences: string[];
}

export interface LatencySummary {
	count: number;
	minMs: number;
	maxMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	rawMs: number[];
}

export interface BenchmarkOptions {
	n: number[];
	trials: number;
	fairness: boolean;
	probes: number;
}

export type BenchmarkMode = "direct" | "daemon";

export type BenchmarkResourceMetrics = Omit<ProcessTreeMetrics, "rootPid" | "snapshot">;

export interface ArchitectureSample {
	mode: BenchmarkMode;
	n: number;
	trial: number;
	startupMs: number;
	steadySessionMs: number;
	resources: BenchmarkResourceMetrics;
}

export interface ArchitectureSummary {
	mode: BenchmarkMode;
	n: number;
	startup: LatencySummary;
	steadySession: LatencySummary;
	resources: BenchmarkResourceMetrics;
}

export interface ArchitectureBenchmarkResult {
	schemaVersion: 1;
	status: "ok";
	phase: "production-runtime";
	options: BenchmarkOptions;
	fixture: BenchmarkFixture;
	platform: PlatformInfo;
	samples: ArchitectureSample[];
	summaries: ArchitectureSummary[];
}

export interface PlatformInfo {
	os: string;
	kernel: string;
	bun: string;
	gitCommit: string | null;
}

const CORE_FIXTURE: BenchmarkFixture = {
	cwd: "<isolated-temp-project>",
	profile: "none",
	model: "configured-no-request",
	permissions: "no-tools",
	mcpEnabled: false,
	lspEnabled: false,
	environment: { HOME: "<isolated-temp-home>" },
};

export function parseSmapsRollup(text: string): { rssKb: number; pssKb: number } {
	const values = new Map<string, number>();
	for (const line of text.split("\n")) {
		const match = /^(Rss|Pss):\s+(\d+)\s+kB\s*$/.exec(line);
		if (match) values.set(match[1], Number(match[2]));
		else if (/^(Rss|Pss):/.test(line) && !values.has(line.startsWith("Rss") ? "Rss" : "Pss")) {
			const key = line.startsWith("Rss") ? "Rss" : "Pss";
			throw new Error(`${key} in smaps_rollup must be an integer kilobyte value`);
		}
	}
	const rssKb = values.get("Rss");
	const pssKb = values.get("Pss");
	if (rssKb === undefined) throw new Error("Rss is missing from smaps_rollup");
	if (pssKb === undefined) throw new Error("Pss is missing from smaps_rollup");
	return { rssKb, pssKb };
}

function integer(value: string, field: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid ${field} in /proc stat`);
	return parsed;
}

export function parseProcStat(text: string): {
	pid: number;
	ppid: number;
	cpuUserTicks: number;
	cpuSystemTicks: number;
	threads: number;
} {
	const close = text.lastIndexOf(")");
	if (close < 0) throw new Error("invalid /proc stat: missing command terminator");
	const head = text.slice(0, close).trim();
	const pidText = head.split(/\s+/, 1)[0];
	const fields = text
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	if (fields.length < 18) throw new Error("invalid /proc stat: missing fields");
	return {
		pid: integer(pidText, "pid"),
		ppid: integer(fields[1], "ppid"),
		cpuUserTicks: integer(fields[11], "utime"),
		cpuSystemTicks: integer(fields[12], "stime"),
		threads: integer(fields[17], "num_threads"),
	};
}

export function aggregateProcessTree(rootPid: number, samples: readonly ProcessSample[]): ProcessTreeMetrics {
	const byPid = new Map(samples.map(sample => [sample.pid, sample]));
	if (!byPid.has(rootPid)) throw new Error(`root process ${rootPid} is absent from process snapshot`);
	const children = new Map<number, number[]>();
	for (const sample of samples) {
		const list = children.get(sample.ppid);
		if (list) list.push(sample.pid);
		else children.set(sample.ppid, [sample.pid]);
	}
	const selected: ProcessSample[] = [];
	const seen = new Set<number>();
	const visit = (pid: number): void => {
		if (seen.has(pid)) return;
		const sample = byPid.get(pid);
		if (!sample) return;
		seen.add(pid);
		selected.push(sample);
		for (const childPid of children.get(pid) ?? []) visit(childPid);
	};
	visit(rootPid);
	return {
		rootPid,
		processCount: selected.length,
		childProcessCount: Math.max(0, selected.length - 1),
		pssKb: selected.reduce((sum, sample) => sum + sample.pssKb, 0),
		rssKb: selected.reduce((sum, sample) => sum + sample.rssKb, 0),
		cpuUserTicks: selected.reduce((sum, sample) => sum + sample.cpuUserTicks, 0),
		cpuSystemTicks: selected.reduce((sum, sample) => sum + sample.cpuSystemTicks, 0),
		threads: selected.reduce((sum, sample) => sum + sample.threads, 0),
		fds: selected.reduce((sum, sample) => sum + sample.fds, 0),
		snapshot: selected.toSorted((a, b) => a.pid - b.pid),
	};
}

async function readProcessSample(pid: number, procRoot: string): Promise<ProcessSample> {
	const base = path.join(procRoot, String(pid));
	const stat = parseProcStat(await Bun.file(path.join(base, "stat")).text());
	const memory = parseSmapsRollup(await Bun.file(path.join(base, "smaps_rollup")).text());
	let fds = 0;
	try {
		fds = (await fs.readdir(path.join(base, "fd"))).length;
	} catch {
		// A process can exit while a snapshot is being collected; its fd count is
		// best-effort while stat/smaps remain the required measurements.
	}
	return { ...stat, ...memory, fds };
}

export async function readLinuxProcessSnapshot(procRoot = "/proc"): Promise<ProcessSample[]> {
	if (process.platform !== "linux") throw new Error("Linux /proc metrics are unavailable on this platform");
	const entries = await fs.readdir(procRoot, { withFileTypes: true });
	const pids = entries
		.filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
		.map(entry => Number(entry.name));
	const samples = await Promise.all(
		pids.map(async pid => {
			try {
				return await readProcessSample(pid, procRoot);
			} catch {
				return null;
			}
		}),
	);
	return samples.filter((sample): sample is ProcessSample => sample !== null);
}

export async function measureLinuxProcessTree(rootPid: number, procRoot = "/proc"): Promise<ProcessTreeMetrics> {
	return aggregateProcessTree(rootPid, await readLinuxProcessSnapshot(procRoot));
}

function fixtureValue(fixture: BenchmarkFixture, key: keyof BenchmarkFixture): string {
	if (key !== "environment") return String(fixture[key]);
	return Object.entries(fixture.environment)
		.toSorted(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}=${value}`)
		.join("\u0000");
}

export function compareFixtureParity(left: BenchmarkFixture, right: BenchmarkFixture): FixtureParity {
	const differences: string[] = [];
	for (const key of ["cwd", "profile", "model", "permissions", "mcpEnabled", "lspEnabled", "environment"] as const) {
		if (fixtureValue(left, key) !== fixtureValue(right, key)) differences.push(key);
	}
	return { equivalent: differences.length === 0, differences };
}

export function assertComparableFixtures(left: BenchmarkFixture, right: BenchmarkFixture): void {
	const parity = compareFixtureParity(left, right);
	if (!parity.equivalent) throw new Error(`incomparable benchmark fixtures: ${parity.differences.join(", ")}`);
}

function percentile(sorted: readonly number[], quantile: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
}

export function summarizeLatencies(samples: readonly number[]): LatencySummary {
	if (samples.length === 0) throw new Error("cannot summarize an empty latency sample");
	if (samples.some(sample => !Number.isFinite(sample) || sample < 0))
		throw new Error("latencies must be finite non-negative numbers");
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		count: samples.length,
		minMs: sorted[0] ?? 0,
		maxMs: sorted[sorted.length - 1] ?? 0,
		p50Ms: percentile(sorted, 0.5),
		p95Ms: percentile(sorted, 0.95),
		p99Ms: percentile(sorted, 0.99),
		rawMs: [...samples],
	};
}

function average(samples: readonly number[]): number {
	if (samples.length === 0) throw new Error("cannot average an empty sample");
	return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
}

export function summarizeArchitectureSamples(samples: readonly ArchitectureSample[]): ArchitectureSummary[] {
	const groups = new Map<string, ArchitectureSample[]>();
	for (const sample of samples) {
		const key = `${sample.mode}:${sample.n}`;
		const group = groups.get(key);
		if (group) group.push(sample);
		else groups.set(key, [sample]);
	}
	return [...groups.values()]
		.map(group => {
			const first = group[0];
			if (!first) throw new Error("benchmark summary group must not be empty");
			const resource = (field: keyof BenchmarkResourceMetrics): number =>
				average(group.map(sample => sample.resources[field]));
			return {
				mode: first.mode,
				n: first.n,
				startup: summarizeLatencies(group.map(sample => sample.startupMs)),
				steadySession: summarizeLatencies(group.map(sample => sample.steadySessionMs)),
				resources: {
					processCount: resource("processCount"),
					childProcessCount: resource("childProcessCount"),
					pssKb: resource("pssKb"),
					rssKb: resource("rssKb"),
					cpuUserTicks: resource("cpuUserTicks"),
					cpuSystemTicks: resource("cpuSystemTicks"),
					threads: resource("threads"),
					fds: resource("fds"),
				},
			};
		})
		.toSorted((left, right) => left.n - right.n || left.mode.localeCompare(right.mode));
}

export interface ColdSteadyTiming {
	cold: LatencySummary;
	steadyState: LatencySummary;
}

/**
 * Measure separate cold and steady-state paths. Drivers own setup/teardown so
 * this primitive never assumes that a process restart is safe or equivalent.
 */
export async function measureColdAndSteadyState(
	coldRun: () => Promise<void>,
	steadyRun: () => Promise<void>,
	trials: number,
): Promise<ColdSteadyTiming> {
	if (!Number.isInteger(trials) || trials < 1) throw new Error("trials must be a positive integer");
	const measure = async (run: () => Promise<void>): Promise<number> => {
		const started = performance.now();
		await run();
		return performance.now() - started;
	};
	const cold: number[] = [];
	const steadyState: number[] = [];
	for (let trial = 0; trial < trials; trial += 1) {
		cold.push(await measure(coldRun));
		steadyState.push(await measure(steadyRun));
	}
	return { cold: summarizeLatencies(cold), steadyState: summarizeLatencies(steadyState) };
}

export function calculateCpuPercent(
	before: Pick<ProcessTreeMetrics, "cpuUserTicks" | "cpuSystemTicks">,
	after: Pick<ProcessTreeMetrics, "cpuUserTicks" | "cpuSystemTicks">,
	elapsedMs: number,
	clockTicksPerSecond = 100,
): number {
	if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) throw new Error("elapsedMs must be positive");
	if (!Number.isFinite(clockTicksPerSecond) || clockTicksPerSecond <= 0)
		throw new Error("clockTicksPerSecond must be positive");
	const cpuTicks = after.cpuUserTicks + after.cpuSystemTicks - before.cpuUserTicks - before.cpuSystemTicks;
	if (cpuTicks < 0) throw new Error("process-tree CPU counters decreased; trial is invalid");
	return (cpuTicks / clockTicksPerSecond / (elapsedMs / 1000)) * 100;
}

function parsePositiveList(raw: string, name: string): number[] {
	const values = raw.split(",").map(value => Number(value.trim()));
	if (values.length === 0 || values.some(value => !Number.isInteger(value) || value < 1))
		throw new Error(`${name} must be a comma-separated list of positive integers`);
	return [...new Set(values)];
}

export function parseBenchmarkArgs(args: readonly string[]): BenchmarkOptions {
	const n = [1, 2, 5, 10];
	let trials = 3;
	let fairness = false;
	let probes = 50;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--n") {
			const value = args[++index];
			if (!value) throw new Error("--n requires a value");
			n.splice(0, n.length, ...parsePositiveList(value, "--n"));
		} else if (arg === "--trials") {
			const value = args[++index];
			const parsedTrials = value === undefined ? Number.NaN : Number(value);
			if (!Number.isInteger(parsedTrials) || parsedTrials < 1)
				throw new Error("--trials must be a positive integer");
			trials = parsedTrials;
		} else if (arg === "--fairness") {
			fairness = true;
		} else if (arg === "--probes") {
			const value = args[++index];
			const parsedProbes = value === undefined ? Number.NaN : Number(value);
			if (!Number.isInteger(parsedProbes) || parsedProbes < 1)
				throw new Error("--probes must be a positive integer");
			probes = parsedProbes;
		} else if (arg !== "--help" && arg !== "-h") {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return { n, trials, fairness, probes };
}

async function platformInfo(): Promise<PlatformInfo> {
	let gitCommit: string | null = null;
	try {
		const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
		gitCommit = (await new Response(proc.stdout).text()).trim() || null;
		await proc.exited;
	} catch {
		gitCommit = null;
	}
	return { os: `${os.platform()} ${os.arch()}`, kernel: os.release(), bun: Bun.version, gitCommit };
}

type DirectProcess = Subprocess<"pipe", "pipe", "pipe">;
type DaemonProcess = Subprocess<"ignore", "ignore", "pipe">;

interface TrialPaths {
	root: string;
	project: string;
	home: string;
	runtime: string;
	driver: string;
}

const DAEMON_WORKER_ARG = "__omp_worker_daemon_server";
const READY_TIMEOUT_MS = 30_000;
const BENCHMARK_ARGV = ["--no-lsp", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-session"];

async function createTrialPaths(n: number, trial: number): Promise<TrialPaths> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-daemon-bench-${n}-${trial}-`));
	const paths = {
		root,
		project: path.join(root, "project"),
		home: path.join(root, "home"),
		runtime: path.join(root, "runtime"),
		driver: path.join(root, "direct-driver.ts"),
	};
	await Promise.all([fs.mkdir(paths.project, { recursive: true }), fs.mkdir(paths.home, { recursive: true })]);
	const runtimeModule = pathToFileURL(path.resolve(import.meta.dir, "../src/daemon/session-runtime.ts")).href;
	const driverSource = [
		`import { createAgentSessionRuntime } from ${JSON.stringify(runtimeModule)};`,
		`const runtime = await createAgentSessionRuntime({`,
		`  cwd: process.env.BENCH_CWD ?? process.cwd(),`,
		`  sessionId: process.env.BENCH_SESSION_ID,`,
		`  overrides: { argv: ${JSON.stringify(BENCHMARK_ARGV)} },`,
		`});`,
		`await Bun.write(Bun.stdout, "READY\\n");`,
		`await new Response(Bun.stdin.stream()).text();`,
		`await runtime.dispose();`,
	].join("\n");
	await Bun.write(paths.driver, `${driverSource}\n`);
	return paths;
}

async function waitForReady(proc: DirectProcess): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timeout = setTimeout(
		() => reject(new Error(`direct runtime readiness exceeded ${READY_TIMEOUT_MS}ms`)),
		READY_TIMEOUT_MS,
	);
	const reader = proc.stdout.getReader();
	void (async () => {
		const decoder = new TextDecoder();
		let buffered = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) throw new Error(`direct runtime exited before readiness (code ${await proc.exited})`);
				buffered += decoder.decode(value, { stream: true });
				if (buffered.includes("READY\n")) {
					resolve();
					return;
				}
			}
		} catch (error) {
			reject(error);
		} finally {
			reader.releaseLock();
		}
	})();
	try {
		await promise;
	} finally {
		clearTimeout(timeout);
	}
}

function spawnDirectSession(paths: TrialPaths, sessionId: string): DirectProcess {
	return Bun.spawn([process.execPath, paths.driver], {
		cwd: paths.project,
		env: workerEnvFromParent({
			HOME: paths.home,
			PI_CODING_AGENT_DIR: path.join(paths.home, ".omp", "agent"),
			BENCH_CWD: paths.project,
			BENCH_SESSION_ID: sessionId,
		}),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function closeDirectSession(proc: DirectProcess): Promise<void> {
	proc.stdin.end();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`direct runtime exited with code ${exitCode}: ${stderr.trim()}`);
	}
}

async function combinedResources(rootPids: readonly number[]): Promise<BenchmarkResourceMetrics> {
	const trees = await Promise.all(rootPids.map(pid => measureLinuxProcessTree(pid)));
	const sum = (field: keyof BenchmarkResourceMetrics): number => trees.reduce((total, tree) => total + tree[field], 0);
	return {
		processCount: sum("processCount"),
		childProcessCount: sum("childProcessCount"),
		pssKb: sum("pssKb"),
		rssKb: sum("rssKb"),
		cpuUserTicks: sum("cpuUserTicks"),
		cpuSystemTicks: sum("cpuSystemTicks"),
		threads: sum("threads"),
		fds: sum("fds"),
	};
}

async function runDirectSample(paths: TrialPaths, n: number, trial: number): Promise<ArchitectureSample> {
	const processes: DirectProcess[] = [];
	try {
		const started = performance.now();
		for (let index = 0; index < n; index += 1) {
			processes.push(spawnDirectSession(paths, `direct-${trial}-${index}`));
		}
		await Promise.all(processes.map(waitForReady));
		const startupMs = performance.now() - started;
		await Bun.sleep(100);
		const resources = await combinedResources(processes.map(proc => proc.pid));
		const steadyStarted = performance.now();
		const steady = spawnDirectSession(paths, `direct-${trial}-steady`);
		processes.push(steady);
		await waitForReady(steady);
		const steadySessionMs = performance.now() - steadyStarted;
		await closeDirectSession(steady);
		processes.pop();
		return { mode: "direct", n, trial, startupMs, steadySessionMs, resources };
	} finally {
		await Promise.all(processes.map(proc => closeDirectSession(proc)));
	}
}

async function connectDaemon(client: DaemonClient, proc: DaemonProcess): Promise<void> {
	const deadline = performance.now() + READY_TIMEOUT_MS;
	let lastError: Error | undefined;
	while (performance.now() < deadline) {
		if (proc.exitCode !== null) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`daemon exited during startup with code ${proc.exitCode}: ${stderr.trim()}`);
		}
		try {
			await client.connect();
			return;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			await Bun.sleep(25);
		}
	}
	throw new Error(`daemon readiness exceeded ${READY_TIMEOUT_MS}ms: ${lastError?.message ?? "unknown error"}`);
}

async function closeDaemonSessions(client: DaemonClient, sessionIds: readonly string[]): Promise<void> {
	for (const sessionId of sessionIds) {
		await client.request({ op: "session_close", sessionId });
	}
}

async function shutdownDaemonSample(
	client: DaemonClient,
	proc: DaemonProcess,
	sessionIds: readonly string[],
): Promise<void> {
	await closeDaemonSessions(client, sessionIds);
	const result = (await client.request("shutdown")) as { shutdown?: boolean; blockers?: string[] };
	client.close();
	if (result.shutdown !== true)
		throw new Error(`daemon shutdown blocked: ${result.blockers?.join(", ") ?? "unknown"}`);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`daemon exited with code ${exitCode}: ${stderr.trim()}`);
	}
}

async function runDaemonSample(paths: TrialPaths, n: number, trial: number): Promise<ArchitectureSample> {
	const spawn = resolveWorkerSpawnCmd(DAEMON_WORKER_ARG);
	const proc: DaemonProcess = Bun.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent({
			HOME: paths.home,
			PI_CODING_AGENT_DIR: path.join(paths.home, ".omp", "agent"),
			OMP_PROFILE: "",
			OMP_DAEMON_PROJECT_DIR: paths.project,
			OMP_DAEMON_RUNTIME_DIR: paths.runtime,
		}),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const client = await createDaemonClient({
		profile: null,
		runtimeDir: paths.runtime,
	});
	const sessionIds = Array.from({ length: n }, (_, index) => `daemon-${trial}-${index}`);
	const created: string[] = [];
	try {
		const started = performance.now();
		await connectDaemon(client, proc);
		for (const sessionId of sessionIds) {
			await client.request({
				op: "session_create",
				sessionId,
				cwd: paths.project,
				overrides: { argv: [...BENCHMARK_ARGV] },
			});
			created.push(sessionId);
		}
		const startupMs = performance.now() - started;
		await Bun.sleep(100);
		const resources = await combinedResources([proc.pid]);
		const steadyId = `daemon-${trial}-steady`;
		const steadyStarted = performance.now();
		await client.request({
			op: "session_create",
			sessionId: steadyId,
			cwd: paths.project,
			overrides: { argv: [...BENCHMARK_ARGV] },
		});
		const steadySessionMs = performance.now() - steadyStarted;
		await client.request({ op: "session_close", sessionId: steadyId });
		return { mode: "daemon", n, trial, startupMs, steadySessionMs, resources };
	} finally {
		await shutdownDaemonSample(client, proc, created);
	}
}

export async function runArchitectureBenchmark(options: BenchmarkOptions): Promise<ArchitectureBenchmarkResult> {
	if (process.platform !== "linux") throw new Error("production architecture benchmark requires Linux /proc");
	const samples: ArchitectureSample[] = [];
	for (const n of options.n) {
		for (let trial = 0; trial < options.trials; trial += 1) {
			const paths = await createTrialPaths(n, trial);
			try {
				if (trial % 2 === 0) {
					samples.push(await runDirectSample(paths, n, trial));
					samples.push(await runDaemonSample(paths, n, trial));
				} else {
					samples.push(await runDaemonSample(paths, n, trial));
					samples.push(await runDirectSample(paths, n, trial));
				}
			} finally {
				await fs.rm(paths.root, { recursive: true, force: true });
			}
		}
	}
	return {
		schemaVersion: 1,
		status: "ok",
		phase: "production-runtime",
		options,
		fixture: { ...CORE_FIXTURE, environment: { ...CORE_FIXTURE.environment } },
		platform: await platformInfo(),
		samples,
		summaries: summarizeArchitectureSamples(samples),
	};
}

export interface FairnessLaneResult {
	sessionId: string;
	latency: LatencySummary;
	failures: number;
}

export interface FairnessBenchmarkResult {
	schemaVersion: 1;
	status: "ok";
	phase: "daemon-fairness";
	options: BenchmarkOptions;
	platform: PlatformInfo;
	sessions: number;
	heavyOps: number;
	heavyFailures: number;
	victimLanes: FairnessLaneResult[];
	statusLane: FairnessLaneResult;
	combinedVictim: LatencySummary;
}

/**
 * Multi-session responsiveness benchmark against ONE real daemon worker.
 *
 * Session 0 runs a saturating `get_state` command flood; every other session
 * measures sequential command round-trips concurrently, and a status lane
 * measures `server_status`+`session_list`. Reported percentiles answer the
 * incident question directly: how long does an independent session's
 * interaction take while a neighbor is hot?
 */
export async function runFairnessBenchmark(options: BenchmarkOptions): Promise<FairnessBenchmarkResult> {
	if (process.platform !== "linux") throw new Error("daemon fairness benchmark requires Linux /proc");
	const sessions = Math.max(2, options.n[options.n.length - 1] ?? 2);
	const paths = await createTrialPaths(sessions, 0);
	const spawn = resolveWorkerSpawnCmd(DAEMON_WORKER_ARG);
	const proc: DaemonProcess = Bun.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent({
			HOME: paths.home,
			PI_CODING_AGENT_DIR: path.join(paths.home, ".omp", "agent"),
			OMP_PROFILE: "",
			OMP_DAEMON_PROJECT_DIR: paths.project,
			OMP_DAEMON_RUNTIME_DIR: paths.runtime,
		}),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const client = await createDaemonClient({ profile: null, runtimeDir: paths.runtime });
	// The registry keys hosted sessions by the runtime's real session id (a
	// SessionManager UUID), not the requested name — use the ids the daemon
	// reports back.
	const sessionIds: string[] = [];
	const created: string[] = [];
	try {
		await connectDaemon(client, proc);
		for (let index = 0; index < sessions; index++) {
			const response = (await client.request({
				op: "session_create",
				sessionId: `fairness-${index}`,
				cwd: paths.project,
				overrides: { argv: [...BENCHMARK_ARGV] },
			})) as { sessionId?: string };
			const sessionId = response.sessionId ?? `fairness-${index}`;
			sessionIds.push(sessionId);
			created.push(sessionId);
			await client.request({
				op: "attach",
				sessionId,
				attachmentId: `att-${sessionId}`,
				mode: "interactive",
			});
		}
		const command = (sessionId: string): Promise<unknown> =>
			client.request({
				op: "session_command",
				sessionId,
				attachmentId: `att-${sessionId}`,
				command: { type: "get_state", commandId: crypto.randomUUID() },
			});

		// Heavy lane: saturating command flood on session 0 until the probes end.
		let heavyOps = 0;
		let heavyFailures = 0;
		let stopHeavy = false;
		const heavy = (async () => {
			while (!stopHeavy) {
				try {
					await command(sessionIds[0]!);
					heavyOps++;
				} catch {
					heavyFailures++;
				}
			}
		})();

		const probeLane = async (sessionId: string): Promise<FairnessLaneResult> => {
			const latencies: number[] = [];
			let failures = 0;
			for (let i = 0; i < options.probes; i++) {
				const started = performance.now();
				try {
					await command(sessionId);
					latencies.push(performance.now() - started);
				} catch {
					failures++;
				}
			}
			return { sessionId, latency: summarizeLatencies(latencies), failures };
		};
		const statusLane = (async (): Promise<FairnessLaneResult> => {
			const latencies: number[] = [];
			let failures = 0;
			for (let i = 0; i < options.probes; i++) {
				const started = performance.now();
				try {
					await client.request("server_status");
					await client.request("session_list");
					latencies.push(performance.now() - started);
				} catch {
					failures++;
				}
			}
			return { sessionId: "<status>", latency: summarizeLatencies(latencies), failures };
		})();
		const victimLanes = await Promise.all(sessionIds.slice(1).map(probeLane));
		const statusResult = await statusLane;
		stopHeavy = true;
		await heavy;

		return {
			schemaVersion: 1,
			status: "ok",
			phase: "daemon-fairness",
			options,
			platform: await platformInfo(),
			sessions,
			heavyOps,
			heavyFailures,
			victimLanes,
			statusLane: statusResult,
			combinedVictim: summarizeLatencies(victimLanes.flatMap(lane => lane.latency.rawMs)),
		};
	} finally {
		try {
			await shutdownDaemonSample(client, proc, created);
		} finally {
			await fs.rm(paths.root, { recursive: true, force: true });
		}
	}
}

async function main(): Promise<number> {
	try {
		const options = parseBenchmarkArgs(process.argv.slice(2));
		const result = options.fairness ? await runFairnessBenchmark(options) : await runArchitectureBenchmark(options);
		const serialized = `${JSON.stringify(result)}\n`;
		const outputPath = process.env.OMP_DAEMON_BENCH_OUTPUT;
		if (outputPath) await Bun.write(path.resolve(outputPath), serialized);
		await Bun.write(Bun.stdout, serialized);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await Bun.write(Bun.stderr, `daemon benchmark failed: ${message}\n`);
		return 1;
	}
}

if (import.meta.main) process.exit(await main());
