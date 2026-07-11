#!/usr/bin/env bun
/**
 * terminal-bench-2 runner for the local `omp` build.
 *
 * Orchestrates Harbor (`harbor run`) against the harbor-framework/terminal-bench-2
 * dataset using a custom agent (`agent/omp_local.py`) that installs the working
 * tree at /work/pi and routes all model auth through the host pm2 auth-gateway
 * (no provider keys ever enter the task containers).
 *
 * It owns the terminal: Harbor's own output is redirected to a log file and this
 * process renders a live dashboard (progress / success% / spend / tokens / ETA)
 * by polling each trial's `result.json`. On completion it writes a markdown report.
 *
 *   bun src/runner.ts --model anthropic/claude-sonnet-4-6 --tasks 20 --concurrency 4
 *   bun src/runner.ts --agent oracle --tasks 2            # cheap pipeline smoke
 *   bun src/runner.ts --help
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ────────────────────────────────────────────────────────────────────── config

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PKG_DIR = path.resolve(import.meta.dir, "..");
const AGENT_DIR = path.join(PKG_DIR, "agent");
const CODING_AGENT_DIR = path.join(REPO_ROOT, "packages", "coding-agent");
const AGENT_IMPORT_PATH = "omp_local:OmpLocal";

export interface Config {
	models: string[];
	dataset: string;
	tasks: number;
	concurrency: number;
	attempts: number;
	include: string[];
	exclude: string[];
	thinking: string | null;
	advisorModel: string | null;
	advisorSync: string;
	agent: string;
	install: "local" | "published";
	version: string | null;
	tarball: string | null;
	binaryArm64: string | null;
	binaryX64: string | null;
	build: boolean;
	jobsDir: string;
	jobName: string | null;
	gatewayUrl: string;
	gatewayToken: string;
	providers: string[];
	gateway: boolean;
	webSearch: boolean;
	allowHosts: string[];
	timeoutMultiplier: number | null;
	yes: boolean;
	dryRun: boolean;
	cleanup: boolean;
	cleanupForce: boolean;
	hostNetwork: boolean;
	passthrough: string[];
	env: Record<string, string>;
}

function defaultConfig(): Config {
	return {
		models: [],
		dataset: "terminal-bench@2.0",
		tasks: 20,
		concurrency: 4,
		attempts: 1,
		include: [],
		exclude: [],
		thinking: null,
		advisorModel: null,
		advisorSync: "1",
		agent: "omp",
		install: "local",
		version: null,
		tarball: null,
		binaryArm64: null,
		binaryX64: null,
		build: true,
		jobsDir: path.join(REPO_ROOT, "runs", "tb2"),
		jobName: null,
		gatewayUrl: "http://host.docker.internal:4000",
		gatewayToken: "no-auth",
		providers: [],
		gateway: true,
		webSearch: false,
		allowHosts: [],
		timeoutMultiplier: null,
		yes: true,
		dryRun: false,
		cleanup: false,
		cleanupForce: false,
		hostNetwork: false,
		passthrough: [],
		env: {},
	};
}

const HELP = `terminal-bench-2 runner (local omp)

Usage: bun src/runner.ts [options] [-- <extra harbor args>]

Commands:
  cleanup                        Force-remove ALL leftover Harbor containers + networks, then exit

Model / agent:
  -m, --model <provider/model>   Model (repeatable). Default anthropic/claude-sonnet-4-6
      --agent <name>             omp (default) | oracle | nop | any harbor agent
      --install <local|published> omp source. local = pack /work/pi (default)
      --version <v>              omp version for published install (default: latest)
      --thinking <level>         off|minimal|low|medium|high|xhigh
      --advisor-model <p/m>      Second model reviewing the primary (spend summed in)
      --advisor-sync <off|1|3|5> Advisor catch-up backlog (default 1 = accurate spend; off = faster)
      --tarball <path>           Reuse a prebuilt omp tarball (implies --no-build)
      --no-build                 Skip packing; reuse newest tarball in bench dir
      --env <KEY[=VALUE]>        Forward env into omp container (repeatable).
                                 KEY alone forwards host value; host PI_* auto-forwarded.

Dataset / scale:
  -l, --tasks <N>                Max tasks (default 20)
  -n, --concurrency <N>          Concurrent trials (default 4)
  -k, --attempts <N>             Attempts per task (default 1)
  -i, --include <glob>           Include task name (repeatable)
  -x, --exclude <glob>           Exclude task name (repeatable)
  -d, --dataset <name@ver>       Default terminal-bench@2.0

Gateway (auth, no keys in container):
      --gateway-url <url>        Default http://host.docker.internal:4000
      --gateway-token <tok>      Default "no-auth" (gateway runs --no-auth)
      --providers <csv>          Providers to route (default: model provider + anthropic,openai-codex)
      --no-gateway               Pass host provider API keys into containers instead
      --web-search               Enable omp web_search (off by default; can't auth via gateway)
      --allow-host <host>        harbor --allow-agent-host (repeatable)

Output / control:
  -o, --jobs-dir <path>          Default <repo>/runs/tb2
      --job-name <name>          Default tb2-<model>-<timestamp>
      --dry-run                  Print the harbor command + models.yml and exit
      --cleanup                  Clean up stale and exited Harbor Docker resources safely before starting
      --cleanup-force            Force-stop and remove ALL previous Harbor Docker containers and networks
      --host-network             Run Docker task containers using host networking (experimental)
  -h, --help                     This help
`;

// ───────────────────────────────────────────────────────────────── arg parsing

export function parseArgs(argv: string[]): Config {
	const cfg = defaultConfig();
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i];
		if (arg === "--") {
			cfg.passthrough.push(...argv.slice(i + 1));
			break;
		}
		let inlineValue: string | null = null;
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		if (eq !== -1) {
			inlineValue = arg.slice(eq + 1);
			arg = arg.slice(0, eq);
		}
		const take = (flag: string): string => {
			if (inlineValue !== null) return inlineValue;
			const v = argv[i + 1];
			if (v === undefined) throw new Error(`missing value for ${flag}`);
			i++;
			return v;
		};
		switch (arg) {
			case "-m":
			case "--model":
				cfg.models.push(take(arg));
				break;
			case "--agent":
				cfg.agent = take(arg);
				break;
			case "--install": {
				const v = take(arg);
				if (v !== "local" && v !== "published") throw new Error("--install must be local|published");
				cfg.install = v;
				break;
			}
			case "--version":
				cfg.version = take(arg);
				break;
			case "--thinking":
				cfg.thinking = take(arg);
				break;
			case "--advisor-model":
				cfg.advisorModel = take(arg);
				break;
			case "--advisor-sync":
				cfg.advisorSync = take(arg);
				break;
			case "--tarball":
				cfg.tarball = path.resolve(take(arg));
				cfg.build = false;
				break;
			case "--binary": {
				const p = path.resolve(take(arg));
				const base = path.basename(p);
				if (/arm64|aarch64/.test(base)) cfg.binaryArm64 = p;
				else if (/x64|x86[_-]?64|amd64/.test(base)) cfg.binaryX64 = p;
				else throw new Error(`--binary: cannot infer arch from ${base} (expect arm64/x64 in filename)`);
				cfg.build = false;
				break;
			}
			case "--no-build":
				cfg.build = false;
				break;
			case "-l":
			case "--tasks":
			case "--n-tasks":
				cfg.tasks = Number(take(arg));
				break;
			case "-n":
			case "--concurrency":
			case "--n-concurrent":
				cfg.concurrency = Number(take(arg));
				break;
			case "-k":
			case "--attempts":
			case "--n-attempts":
				cfg.attempts = Number(take(arg));
				break;
			case "-i":
			case "--include":
				cfg.include.push(take(arg));
				break;
			case "-x":
			case "--exclude":
				cfg.exclude.push(take(arg));
				break;
			case "-d":
			case "--dataset":
				cfg.dataset = take(arg);
				break;
			case "--gateway-url":
				cfg.gatewayUrl = take(arg);
				break;
			case "--gateway-token":
				cfg.gatewayToken = take(arg);
				break;
			case "--providers":
				cfg.providers.push(
					...take(arg)
						.split(",")
						.map(s => s.trim())
						.filter(Boolean),
				);
				break;
			case "--no-gateway":
				cfg.gateway = false;
				break;
			case "--web-search":
				cfg.webSearch = true;
				break;
			case "--allow-host":
				cfg.allowHosts.push(take(arg));
				break;
			case "-o":
			case "--jobs-dir":
				cfg.jobsDir = path.resolve(take(arg));
				break;
			case "--job-name":
				cfg.jobName = take(arg);
				break;
			case "--timeout-multiplier":
				cfg.timeoutMultiplier = Number(take(arg));
				break;
			case "--dry-run":
				cfg.dryRun = true;
				break;
			case "--cleanup":
				cfg.cleanup = true;
				break;
			case "--cleanup-force":
				cfg.cleanupForce = true;
				break;
			case "--host-network":
				cfg.hostNetwork = true;
				break;
			case "-y":
			case "--yes":
				cfg.yes = true;
				break;
			case "-h":
			case "--help":
				process.stdout.write(HELP);
				process.exit(0);
				break;
			case "-e":
			case "--env": {
				const spec = take(arg);
				const eq2 = spec.indexOf("=");
				if (eq2 === -1) {
					const hostVal = process.env[spec];
					if (hostVal !== undefined) cfg.env[spec] = hostVal;
				} else {
					cfg.env[spec.slice(0, eq2)] = spec.slice(eq2 + 1);
				}
				break;
			}
			default:
				throw new Error(`unknown flag: ${arg} (see --help)`);
		}
	}
	if (cfg.models.length === 0) cfg.models = ["anthropic/claude-sonnet-4-6"];
	return cfg;
}

// ──────────────────────────────────────────────────────────────────── helpers

const isTTY = Boolean(process.stdout.isTTY);
const useColor = isTTY && !process.env.NO_COLOR;
const ESC = "\x1b[";
function c(code: string, s: string): string {
	return useColor ? `${ESC}${code}m${s}${ESC}0m` : s;
}
const dim = (s: string): string => c("2", s);
const bold = (s: string): string => c("1", s);
const green = (s: string): string => c("32", s);
const red = (s: string): string => c("31", s);
const yellow = (s: string): string => c("33", s);
const cyan = (s: string): string => c("36", s);
const gray = (s: string): string => c("90", s);

function fmtUsd(n: number): string {
	if (n >= 100) return `$${n.toFixed(0)}`;
	if (n >= 1) return `$${n.toFixed(2)}`;
	return `$${n.toFixed(3)}`;
}
function fmtNum(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return `${n}`;
}
function fmtDur(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	return `${m}:${String(sec).padStart(2, "0")}`;
}
function bar(frac: number, width: number): string {
	const f = Math.max(0, Math.min(1, frac));
	const filled = Math.round(f * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}
function pad(s: string, w: number): string {
	return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

// ───────────────────────────────────────────────────────────── result parsing

type TrialStatus = "pass" | "fail" | "error" | "running";

interface Trial {
	name: string;
	status: TrialStatus;
	reward: number | null;
	costUsd: number;
	advisorCostUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	durationMs: number;
	detail: string;
}

interface AgentCtxLike {
	n_input_tokens?: unknown;
	n_cache_tokens?: unknown;
	n_output_tokens?: unknown;
	cost_usd?: unknown;
	metadata?: unknown;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function resolveReward(rewards: Record<string, number> | null): number | null {
	if (!rewards) return null;
	const vals = Object.values(rewards).filter(v => typeof v === "number");
	if (vals.length === 0) return null;
	if (typeof rewards.reward === "number") return rewards.reward;
	return Math.max(...vals);
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** Parse one trial directory into a Trial, or null if it isn't a trial dir yet. */
function parseTrial(dir: string, name: string): Trial | null {
	const resultPath = path.join(dir, "result.json");
	if (!fs.existsSync(resultPath)) {
		// running: dir exists, no result yet. Use dir mtime as start proxy.
		let started = Date.now();
		try {
			started = fs.statSync(dir).mtimeMs;
		} catch {
			/* ignore */
		}

		// Try to parse realtime cost from the live agent omp.txt log if it exists
		let costUsd = 0;
		let tokIn = 0;
		let tokOut = 0;
		let tokCache = 0;
		const ompLogPath = path.join(dir, "agent", "omp.txt");
		if (fs.existsSync(ompLogPath)) {
			try {
				const content = fs.readFileSync(ompLogPath, "utf8");
				for (const line of content.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const event = JSON.parse(trimmed);
						if (event && event.type === "message_end") {
							const message = event.message;
							if (message && typeof message === "object" && message.role === "assistant") {
								const usage = message.usage;
								if (usage && typeof usage === "object") {
									tokIn += num(usage.input) + num(usage.cacheRead);
									tokOut += num(usage.output);
									tokCache += num(usage.cacheRead);
									const cost = usage.cost;
									if (cost && typeof cost === "object") {
										costUsd += num(cost.total);
									}
								}
							}
						}
					} catch {
						/* Ignore malformed lines from incomplete writes */
					}
				}
			} catch {
				/* ignore */
			}
		}

		return {
			name,
			status: "running",
			reward: null,
			costUsd,
			advisorCostUsd: 0,
			tokIn,
			tokOut,
			tokCache,
			durationMs: Date.now() - started,
			detail: "",
		};
	}
	const raw = readJson(resultPath);
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;

	// token/cost: prefer top-level agent_result, fall back to step_results[].agent_result
	const ctxs: AgentCtxLike[] = [];
	if (r.agent_result && typeof r.agent_result === "object") ctxs.push(r.agent_result as AgentCtxLike);
	if (Array.isArray(r.step_results)) {
		for (const st of r.step_results) {
			if (st && typeof st === "object") {
				const ar = (st as Record<string, unknown>).agent_result;
				if (ar && typeof ar === "object") ctxs.push(ar as AgentCtxLike);
			}
		}
	}
	let costUsd = 0,
		advisorCostUsd = 0,
		tokIn = 0,
		tokOut = 0,
		tokCache = 0;
	for (const ctx of ctxs) {
		costUsd += num(ctx.cost_usd);
		tokIn += num(ctx.n_input_tokens);
		tokOut += num(ctx.n_output_tokens);
		tokCache += num(ctx.n_cache_tokens);
		if (ctx.metadata && typeof ctx.metadata === "object") {
			advisorCostUsd += num((ctx.metadata as Record<string, unknown>).advisor_cost_usd);
		}
	}

	// rewards: top-level verifier_result, else step_results last verifier
	let rewards: Record<string, number> | null = null;
	const collectRewards = (vr: unknown): void => {
		if (vr && typeof vr === "object") {
			const rw = (vr as Record<string, unknown>).rewards;
			if (rw && typeof rw === "object") rewards = rw as Record<string, number>;
		}
	};
	collectRewards(r.verifier_result);
	if (!rewards && Array.isArray(r.step_results)) {
		for (const st of r.step_results) {
			if (st && typeof st === "object") collectRewards((st as Record<string, unknown>).verifier_result);
		}
	}
	const reward = resolveReward(rewards);

	// exception
	const exc =
		r.exception_info && typeof r.exception_info === "object" ? (r.exception_info as Record<string, unknown>) : null;

	// duration
	let durationMs = 0;
	const start = typeof r.started_at === "string" ? Date.parse(r.started_at) : NaN;
	const end = typeof r.finished_at === "string" ? Date.parse(r.finished_at) : NaN;
	if (Number.isFinite(start) && Number.isFinite(end)) durationMs = end - start;

	let status: TrialStatus;
	let detail = "";
	if (exc) {
		status = "error";
		detail = typeof exc.exception_type === "string" ? exc.exception_type : "error";
	} else if (reward !== null && reward >= 1 - 1e-9) {
		status = "pass";
	} else {
		status = "fail";
	}
	return { name, status, reward, costUsd, advisorCostUsd, tokIn, tokOut, tokCache, durationMs, detail };
}

function readTrials(jobDir: string): Trial[] {
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(jobDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const trials: Trial[] = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const t = parseTrial(path.join(jobDir, e.name), e.name);
		if (t) trials.push(t);
	}
	return trials;
}

/** Authoritative job-level totals from <jobDir>/result.json (written incrementally). */
interface JobInfo {
	nTotal: number;
	running: number | null;
	pending: number | null;
}

function readJobResult(jobDir: string): JobInfo | null {
	const raw = readJson(path.join(jobDir, "result.json"));
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const nTotal = typeof r.n_total_trials === "number" ? r.n_total_trials : 0;
	let running: number | null = null;
	let pending: number | null = null;
	if (r.stats && typeof r.stats === "object") {
		const s = r.stats as Record<string, unknown>;
		if (typeof s.n_running_trials === "number") running = s.n_running_trials;
		if (typeof s.n_pending_trials === "number") pending = s.n_pending_trials;
	}
	return nTotal > 0 ? { nTotal, running, pending } : null;
}

// ──────────────────────────────────────────────────────────────────── totals

interface Totals {
	total: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	running: number;
	pending: number;
	costUsd: number;
	advisorCostUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
}

function aggregate(trials: Trial[], job: JobInfo | null, fallbackExpected: number): Totals {
	const t: Totals = {
		total: fallbackExpected,
		done: 0,
		pass: 0,
		fail: 0,
		error: 0,
		running: 0,
		pending: 0,
		costUsd: 0,
		advisorCostUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
	};
	for (const tr of trials) {
		t.costUsd += tr.costUsd;
		t.advisorCostUsd += tr.advisorCostUsd;
		t.tokIn += tr.tokIn;
		t.tokOut += tr.tokOut;
		t.tokCache += tr.tokCache;
		if (tr.status === "running") {
			t.running++;
			continue;
		}
		t.done++;
		if (tr.status === "pass") t.pass++;
		else if (tr.status === "error") t.error++;
		else t.fail++;
	}
	// Prefer harbor's authoritative job-level totals; fall back to disk scan.
	t.total = job ? job.nTotal : Math.max(fallbackExpected, trials.length);
	if (job && job.running !== null) t.running = job.running;
	t.pending = Math.max(0, t.total - t.done - t.running);
	return t;
}

// ──────────────────────────────────────────────────────────────── dashboard IO

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function statusIcon(s: TrialStatus, tick: number): string {
	switch (s) {
		case "pass":
			return green("✓");
		case "fail":
			return red("✗");
		case "error":
			return yellow("!");
		case "running":
			return cyan(SPINNER[tick % SPINNER.length]);
	}
}

function tailFile(file: string, maxLines: number): string[] {
	try {
		const buf = fs.readFileSync(file, "utf8");
		const lines = buf.split("\n").filter(l => l.trim().length > 0);
		return lines.slice(-maxLines);
	} catch {
		return [];
	}
}

interface RenderState {
	cfg: Config;
	jobDir: string;
	logPath: string;
	startMs: number;
	expected: number;
	tick: number;
}

function render(st: RenderState): void {
	const trials = readTrials(st.jobDir);
	const tot = aggregate(trials, readJobResult(st.jobDir), st.expected);
	const elapsed = Date.now() - st.startMs;
	const rate = tot.done > 0 ? elapsed / tot.done : 0;
	const eta = rate > 0 && tot.done < tot.total ? rate * (tot.total - tot.done) : 0;
	const successPct = tot.done > 0 ? (tot.pass / tot.done) * 100 : 0;

	const rows: string[] = [];
	const advisorTag = st.cfg.advisorModel ? `${dim(" + advisor ")}${st.cfg.advisorModel}` : "";
	const header = `${bold("terminal-bench-2")} ${dim("·")} ${cyan(st.cfg.agent)} ${dim("·")} ${st.cfg.models.join(",")}${advisorTag} ${dim(`· conc=${st.cfg.concurrency} k=${st.cfg.attempts}`)}`;
	rows.push(header);
	const width = 28;
	rows.push(
		`${bar(tot.total > 0 ? tot.done / tot.total : 0, width)} ${bold(`${tot.done}/${tot.total}`)}  ${dim("elapsed")} ${fmtDur(elapsed)}  ${dim("eta")} ${eta > 0 ? `~${fmtDur(eta)}` : "—"}`,
	);
	rows.push(
		`${green(`pass ${tot.pass}`)} ${dim(`(${successPct.toFixed(0)}%)`)}   ${red(`fail ${tot.fail}`)}   ${yellow(`err ${tot.error}`)}   ${cyan(`run ${tot.running}`)}   ${gray(`pend ${tot.pending}`)}`,
	);
	const advisorSpend = tot.advisorCostUsd > 0 ? dim(` (advisor ${fmtUsd(tot.advisorCostUsd)})`) : "";
	rows.push(
		`${bold("spend")} ${fmtUsd(tot.costUsd)}${advisorSpend}   ${dim("in")} ${fmtNum(tot.tokIn)}  ${dim("out")} ${fmtNum(tot.tokOut)}  ${dim("cache")} ${fmtNum(tot.tokCache)}`,
	);
	rows.push(dim("─".repeat(54)));

	// table: running first, then errors/fails, then passes; recent first within
	const order: Record<TrialStatus, number> = { running: 0, error: 1, fail: 2, pass: 3 };
	const sorted = [...trials].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
	const maxRows = isTTY ? Math.max(6, (process.stdout.rows ?? 40) - rows.length - 4) : sorted.length;
	for (const tr of sorted.slice(0, maxRows)) {
		const rw = tr.reward !== null ? `r${tr.reward.toFixed(2)}` : tr.status === "running" ? "·" : "—";
		const right = `${pad(rw, 6)} ${pad(fmtUsd(tr.costUsd), 7)} ${pad(fmtDur(tr.durationMs), 7)}`;
		const detail = tr.detail ? ` ${yellow(tr.detail)}` : "";
		rows.push(` ${statusIcon(tr.status, st.tick)} ${pad(tr.name, 28)} ${dim(right)}${detail}`);
	}
	if (sorted.length > maxRows) rows.push(dim(`  … ${sorted.length - maxRows} more`));
	rows.push(dim("─".repeat(54)));
	const lastLog = tailFile(st.logPath, 1)[0] ?? "";
	rows.push(gray(`harbor: ${lastLog.slice(0, 70)}`));

	if (isTTY) {
		// home + clear to end of screen, then write frame
		let out = `${ESC}H${ESC}J`;
		out += rows.join(`${ESC}K\n`);
		process.stdout.write(out);
	} else {
		process.stdout.write(
			`[tb2] ${tot.done}/${tot.total} pass=${tot.pass}(${successPct.toFixed(0)}%) fail=${tot.fail} err=${tot.error} run=${tot.running} spend=${fmtUsd(tot.costUsd)} elapsed=${fmtDur(elapsed)}\n`,
		);
	}
}

// ────────────────────────────────────────────────────────────────────── report

function writeReport(st: RenderState, benchDir: string, exitCode: number): string {
	const trials = readTrials(st.jobDir).sort((a, b) => a.name.localeCompare(b.name));
	const tot = aggregate(trials, readJobResult(st.jobDir), st.expected);
	const successPct = tot.done > 0 ? (tot.pass / tot.done) * 100 : 0;
	const lines: string[] = [];
	const isOmp = st.cfg.agent === "omp";
	const modelLine =
		isOmp && st.cfg.advisorModel
			? `${st.cfg.models.join(", ")} + advisor ${st.cfg.advisorModel}`
			: st.cfg.models.join(", ");
	lines.push(`# terminal-bench-2 — ${st.cfg.agent} — ${modelLine}`);
	lines.push("");
	lines.push(`- dataset: \`${st.cfg.dataset}\``);
	lines.push(`- tasks: ${st.cfg.tasks} · attempts: ${st.cfg.attempts} · concurrency: ${st.cfg.concurrency}`);
	if (isOmp) {
		lines.push(
			`- install: ${st.cfg.install} · auth: ${st.cfg.gateway ? "host gateway (no keys in container)" : "direct provider keys"}`,
		);
		lines.push(`- tools: web_search=${st.cfg.webSearch ? "on" : "off"}`);
		if (st.cfg.advisorModel) lines.push(`- advisor: ${st.cfg.advisorModel}`);
	}
	lines.push(`- elapsed: ${fmtDur(Date.now() - st.startMs)} · harbor exit: ${exitCode}`);
	lines.push("");
	const advisorSpend = tot.advisorCostUsd > 0 ? ` (advisor ${fmtUsd(tot.advisorCostUsd)})` : "";
	lines.push(
		`**${tot.pass}/${tot.done} passed (${successPct.toFixed(1)}%)** · fail ${tot.fail} · error ${tot.error} · spend ${fmtUsd(tot.costUsd)}${advisorSpend}`,
	);
	lines.push(`tokens: in ${fmtNum(tot.tokIn)} · out ${fmtNum(tot.tokOut)} · cache ${fmtNum(tot.tokCache)}`);
	lines.push("");
	lines.push("| task | result | reward | cost | duration | detail |");
	lines.push("|---|---|---|---|---|---|");
	for (const t of trials) {
		const res =
			t.status === "pass"
				? "✅ pass"
				: t.status === "fail"
					? "❌ fail"
					: t.status === "error"
						? "⚠️ error"
						: "⏳ running";
		lines.push(
			`| ${t.name} | ${res} | ${t.reward !== null ? t.reward.toFixed(2) : "—"} | ${fmtUsd(t.costUsd)} | ${fmtDur(t.durationMs)} | ${t.detail} |`,
		);
	}
	lines.push("");
	const reportPath = path.join(benchDir, "report.md");
	fs.writeFileSync(reportPath, lines.join("\n"));
	return reportPath;
}

// ──────────────────────────────────────────────────────────────────── setup

function which(bin: string): string | null {
	const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
	const out = r.stdout?.trim();
	return r.status === 0 && out ? out : null;
}

function readPkgVersion(): string {
	const raw = readJson(path.join(CODING_AGENT_DIR, "package.json"));
	if (raw && typeof raw === "object") {
		const v = (raw as Record<string, unknown>).version;
		if (typeof v === "string") return v;
	}
	return "latest";
}

function buildTarball(benchDir: string): string {
	process.stdout.write(dim("packing local omp (bun pm pack)…\n"));
	const r = spawnSync("bun", ["pm", "pack", "--destination", benchDir], {
		cwd: CODING_AGENT_DIR,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.status !== 0) {
		process.stderr.write((r.stdout ?? "") + (r.stderr ?? ""));
		throw new Error("bun pm pack failed");
	}
	const tgz = fs
		.readdirSync(benchDir)
		.filter(f => f.endsWith(".tgz"))
		.map(f => ({ f, m: fs.statSync(path.join(benchDir, f)).mtimeMs }))
		.sort((a, b) => b.m - a.m)[0];
	if (!tgz) throw new Error("no .tgz produced by bun pm pack");
	return path.join(benchDir, tgz.f);
}

function newestTarball(benchDir: string): string | null {
	try {
		const tgz = fs
			.readdirSync(benchDir)
			.filter(f => f.endsWith(".tgz"))
			.map(f => ({ f, m: fs.statSync(path.join(benchDir, f)).mtimeMs }))
			.sort((a, b) => b.m - a.m)[0];
		return tgz ? path.join(benchDir, tgz.f) : null;
	} catch {
		return null;
	}
}

function deriveProviders(cfg: Config): string[] {
	const set = new Set<string>(cfg.providers);
	for (const m of cfg.models) {
		const slash = m.indexOf("/");
		if (slash > 0) set.add(m.slice(0, slash));
	}
	if (cfg.advisorModel) {
		const slash = cfg.advisorModel.indexOf("/");
		if (slash > 0) set.add(cfg.advisorModel.slice(0, slash));
	}
	if (set.size === 0) {
		set.add("anthropic");
		set.add("openai-codex");
	}
	return [...set];
}

function writeModelsYaml(benchDir: string, cfg: Config): string {
	const providers = deriveProviders(cfg);
	const lines = ["# Generated by terminal-bench runner — auth via host pm2 gateway.", "providers:"];
	for (const p of providers) {
		lines.push(`  ${p}:`);
		lines.push(`    baseUrl: ${cfg.gatewayUrl}`);
		lines.push("    auth: oauth");
		lines.push("    transport: pi-native");
		lines.push(`    apiKey: ${cfg.gatewayToken}`);
	}
	const file = path.join(benchDir, "models.yml");
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function gatewayHealthOk(url: string): boolean {
	const hostUrl = url.replace("host.docker.internal", "127.0.0.1").replace(/\/+$/, "");
	const r = spawnSync("curl", ["-s", "--max-time", "4", `${hostUrl}/healthz`], { encoding: "utf8" });
	return r.status === 0 && (r.stdout ?? "").includes('"ok":true');
}

function buildHarborArgs(
	cfg: Config,
	jobName: string,
	modelsYaml: string,
	tarball: string | null,
	hostNetworkOverlayPath: string | null,
): string[] {
	const a: string[] = ["run", "-d", cfg.dataset, "-o", cfg.jobsDir, "--job-name", jobName];
	a.push("-n", String(cfg.concurrency), "-k", String(cfg.attempts), "-l", String(cfg.tasks));
	for (const m of cfg.models) a.push("-m", m);
	for (const inc of cfg.include) a.push("-i", inc);
	for (const exc of cfg.exclude) a.push("-x", exc);
	for (const h of cfg.allowHosts) a.push("--allow-agent-host", h);
	if (cfg.timeoutMultiplier !== null) a.push("--timeout-multiplier", String(cfg.timeoutMultiplier));
	if (cfg.yes) a.push("-y");
	if (hostNetworkOverlayPath) {
		a.push("--extra-docker-compose", hostNetworkOverlayPath);
	}

	if (cfg.agent === "omp") {
		// Config + secrets travel via env (OMP_TB_*); the agent reads os.environ.
		a.push("--agent-import-path", AGENT_IMPORT_PATH);
		void modelsYaml;
		void tarball;
	} else {
		a.push("-a", cfg.agent);
	}
	a.push(...cfg.passthrough);
	return a;
}

const FORWARD_ENV_DENYLIST = new Set([
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
	"PI_PROFILE",
	"PI_PACKAGE_DIR",
	"PI_SESSION_FILE",
	"PI_ARTIFACTS_DIR",
	"PI_TOOL_BRIDGE_URL",
	"PI_TOOL_BRIDGE_TOKEN",
	"PI_TOOL_BRIDGE_SESSION",
	"PI_EVAL_LOCAL_ROOTS",
]);

/**
 * Env vars injected into the in-container omp run: every host `PI_*` knob (minus
 * container-hostile dir/profile/session keys) plus explicit `--env` entries,
 * which always win and bypass the denylist.
 */
export function collectForwardEnv(cfg: Config): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined || !k.startsWith("PI_") || FORWARD_ENV_DENYLIST.has(k)) continue;
		out[k] = v;
	}
	for (const [k, v] of Object.entries(cfg.env)) out[k] = v;
	return out;
}

export function buildHarborEnv(
	cfg: Config,
	modelsYaml: string,
	tarball: string | null,
	version: string,
): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	// Drop any stale OMP_TB_FORWARD_ENV inherited from the caller's shell before
	// the agent-type early return, so it never leaks (incl. into the dry-run dump).
	delete env.OMP_TB_FORWARD_ENV;
	if (cfg.agent !== "omp") return env;
	const prepend = (k: string, v: string): void => {
		env[k] = env[k] ? `${v}:${env[k]}` : v;
	};
	prepend("PYTHONPATH", AGENT_DIR);
	env.OMP_TB_INSTALL = cfg.install;
	env.OMP_TB_VERSION = cfg.version ?? version;
	if (tarball) env.OMP_TB_TARBALL = tarball;
	if (cfg.binaryArm64) env.OMP_TB_BINARY_ARM64 = cfg.binaryArm64;
	if (cfg.binaryX64) env.OMP_TB_BINARY_X64 = cfg.binaryX64;
	if (cfg.thinking) env.OMP_TB_THINKING = cfg.thinking;
	if (cfg.advisorModel) {
		env.OMP_TB_ADVISOR_MODEL = cfg.advisorModel;
		env.OMP_TB_ADVISOR_SYNC = cfg.advisorSync;
	}
	if (cfg.webSearch) env.OMP_TB_WEB_SEARCH = "1";
	env.OMP_TB_GATEWAY = cfg.gateway ? "1" : "0";
	if (cfg.gateway) {
		env.OMP_TB_MODELS_YAML = modelsYaml;
		env.OMP_TB_GATEWAY_URL = cfg.gatewayUrl;
		env.OMP_TB_GATEWAY_TOKEN = cfg.gatewayToken;
		env.OMP_TB_GATEWAY_PROVIDERS = deriveProviders(cfg).join(",");
	}
	const forward = collectForwardEnv(cfg);
	if (Object.keys(forward).length > 0) env.OMP_TB_FORWARD_ENV = JSON.stringify(forward);
	return env;
}

// ──────────────────────────────────────────────────────────────── docker cleanup

/** Harbor names each trial's compose project `<task>__<7-char-suffix>`. */
const HARBOR_PROJECT_RE = /^[a-z0-9_.-]+__[a-zA-Z0-9]{7}$/;

interface DockerContainer {
	id: string;
	state: string;
	project: string;
	workingDir: string;
}

/** All containers belonging to a Harbor trial (by compose project or task working_dir). */
function listHarborContainers(): DockerContainer[] {
	const res = spawnSync(
		"docker",
		[
			"ps",
			"-a",
			"--format",
			'{{.ID}}\t{{.State}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
		],
		{ encoding: "utf8" },
	);
	if (res.status !== 0 || !res.stdout) return [];
	const out: DockerContainer[] = [];
	for (const line of res.stdout.trim().split("\n")) {
		if (!line.trim()) continue;
		const [id, state, project, workingDir] = line.split("\t");
		if (!id) continue;
		const harbor = HARBOR_PROJECT_RE.test(project ?? "") || (workingDir ?? "").includes(".cache/harbor/tasks");
		if (harbor) out.push({ id, state: state ?? "", project: project ?? "", workingDir: workingDir ?? "" });
	}
	return out;
}

/**
 * Remove leftover Harbor trial Docker resources: containers in a Harbor compose
 * trial project (or staged under `.cache/harbor/tasks`) plus the trial networks
 * crashed runs leave behind. With `force`, running containers are killed too and
 * every idle trial network is dropped; otherwise only exited/created/dead
 * containers and networks with no running container are removed.
 */
function runDockerCleanup(force: boolean): void {
	try {
		process.stdout.write(dim("Running harbor-targeted Docker cleanup...\n"));
		const containers = listHarborContainers();
		const removable = force ? containers : containers.filter(c => ["exited", "created", "dead"].includes(c.state));
		if (removable.length > 0) {
			const ids = removable.map(c => c.id);
			process.stdout.write(
				dim(`${force ? "Force-removing" : "Removing"} ${ids.length} leftover Harbor container(s)...\n`),
			);
			const rm = spawnSync("docker", force ? ["rm", "-f", ...ids] : ["rm", ...ids], { encoding: "utf8" });
			if (rm.status !== 0) {
				process.stdout.write(yellow(`  docker rm failed: ${(rm.stderr ?? "").trim() || `exit ${rm.status}`}\n`));
			}
		}

		// Networks of projects that still have a running container are kept (non-force).
		const activeProjects = new Set<string>();
		if (!force) {
			for (const c of containers) {
				if (c.state === "running" && c.project) activeProjects.add(c.project);
			}
		}

		const netInspect = spawnSync("docker", ["network", "ls", "--format", "{{.ID}}\t{{.Labels}}"], {
			encoding: "utf8",
		});
		if (netInspect.status === 0 && netInspect.stdout) {
			const netIdsToRemove: string[] = [];
			for (const netLine of netInspect.stdout.trim().split("\n")) {
				const [netId, labels] = netLine.split("\t");
				if (!netId) continue;
				const projMatch = (labels ?? "").match(/com\.docker\.compose\.project=([^,]+)/);
				if (!projMatch) continue;
				if (HARBOR_PROJECT_RE.test(projMatch[1]) && !activeProjects.has(projMatch[1])) {
					netIdsToRemove.push(netId);
				}
			}
			if (netIdsToRemove.length > 0) {
				process.stdout.write(dim(`Removing ${netIdsToRemove.length} stale trial Docker network(s)...\n`));
				for (const netId of netIdsToRemove) {
					const rmNet = spawnSync("docker", ["network", "rm", netId], { encoding: "utf8" });
					if (rmNet.status !== 0) {
						process.stdout.write(
							yellow(
								`  docker network rm ${netId} failed: ${(rmNet.stderr ?? "").trim() || `exit ${rmNet.status}`}\n`,
							),
						);
					}
				}
			}
		}
		process.stdout.write("Docker cleanup completed.\n");
	} catch (err: unknown) {
		process.stdout.write(
			`\nwarning: failed to run docker cleanup: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
}

// ──────────────────────────────────────────────────────────────────────── main

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === "cleanup") {
		if (!which("docker")) throw new Error("docker not found on PATH (required for cleanup).");
		runDockerCleanup(true);
		return;
	}
	const cfg = parseArgs(argv);

	if (!which("harbor")) {
		throw new Error("harbor not found on PATH. Install with: uv tool install harbor");
	}
	if (cfg.agent === "omp" && !which("docker")) {
		throw new Error("docker not found on PATH (required to run task containers).");
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const modelSlug = cfg.models[0].replace(/[^a-zA-Z0-9]+/g, "-");
	const jobName = cfg.jobName ?? `tb2-${modelSlug}-${stamp}`;
	const jobDir = path.join(cfg.jobsDir, jobName);
	const benchDir = path.join(cfg.jobsDir, "_bench", jobName);
	fs.mkdirSync(benchDir, { recursive: true });

	const version = readPkgVersion();

	// tarball (local install only)
	let tarball: string | null = cfg.tarball;
	if (cfg.agent === "omp" && cfg.install === "local" && !cfg.binaryArm64 && !cfg.binaryX64) {
		if (tarball) {
			process.stdout.write(dim(`using tarball ${tarball}\n`));
		} else if (cfg.build) {
			tarball = buildTarball(path.join(cfg.jobsDir, "_bench"));
		} else {
			tarball = newestTarball(path.join(cfg.jobsDir, "_bench"));
			if (!tarball) throw new Error("--no-build but no tarball found; pass --tarball or drop --no-build");
		}
	}

	// models.yml (gateway)
	let modelsYaml = "";
	if (cfg.agent === "omp" && cfg.gateway) {
		modelsYaml = writeModelsYaml(benchDir, cfg);
		if (!gatewayHealthOk(cfg.gatewayUrl)) {
			process.stderr.write(
				yellow(
					`warning: gateway ${cfg.gatewayUrl} health check failed (continuing). Is the pm2 'omp-auth-gateway' running?\n`,
				),
			);
		}
	}
	let hostNetworkOverlayPath: string | null = null;
	if (cfg.hostNetwork) {
		hostNetworkOverlayPath = path.join(benchDir, "host-network-overlay.yaml");
		const content = `services:
  main:
    network_mode: "host"
`;
		fs.writeFileSync(hostNetworkOverlayPath, content);
	}

	const harborArgs = buildHarborArgs(cfg, jobName, modelsYaml, tarball, hostNetworkOverlayPath);
	const harborEnv = buildHarborEnv(cfg, modelsYaml, tarball, version);
	const logPath = path.join(benchDir, "harbor.log");
	if (cfg.dryRun) {
		process.stdout.write(bold("\nharbor command:\n"));
		process.stdout.write(`harbor ${harborArgs.join(" ")}\n\n`);
		if (modelsYaml) {
			process.stdout.write(bold("models.yml:\n"));
			process.stdout.write(`${fs.readFileSync(modelsYaml, "utf8")}\n`);
		}
		process.stdout.write(bold("omp env:\n"));
		for (const k in harborEnv) {
			if (k === "OMP_TB_FORWARD_ENV") continue;
			if (k.startsWith("OMP_TB_") || k === "PYTHONPATH") process.stdout.write(`  ${k}=${harborEnv[k]}\n`);
		}
		if (harborEnv.OMP_TB_FORWARD_ENV) {
			const keys = Object.keys(JSON.parse(harborEnv.OMP_TB_FORWARD_ENV) as Record<string, string>);
			process.stdout.write(`  OMP_TB_FORWARD_ENV=${keys.join(",")} (values hidden)\n`);
		}
		process.stdout.write(`\njob dir: ${jobDir}\nbench dir: ${benchDir}\n`);
		return;
	}

	// Pre-run cleanup of leftover Harbor resources, if requested.
	if ((cfg.cleanup || cfg.cleanupForce) && which("docker")) {
		runDockerCleanup(cfg.cleanupForce);
	}

	process.stdout.write(dim(`launching harbor → ${logPath}\n`));
	const logFd = fs.openSync(logPath, "a");
	const proc = Bun.spawn(["harbor", ...harborArgs], {
		env: harborEnv,
		stdout: logFd,
		stderr: logFd,
		stdin: "ignore",
	});

	const expected = Math.max(1, cfg.tasks * cfg.attempts * cfg.models.length);
	const st: RenderState = { cfg, jobDir, logPath, startMs: Date.now(), expected, tick: 0 };

	if (isTTY) process.stdout.write(`${ESC}?1049h${ESC}?25l`); // alt screen, hide cursor
	let exitCode = 0;
	let finished = false;
	proc.exited.then((code: number) => {
		exitCode = code;
		finished = true;
	});

	const onSig = (): void => {
		try {
			proc.kill("SIGINT");
		} catch {
			/* ignore */
		}
	};
	process.on("SIGINT", onSig);
	process.on("SIGTERM", onSig);

	try {
		while (!finished) {
			render(st);
			st.tick++;
			await Bun.sleep(isTTY ? 700 : 10000);
		}
		render(st); // final frame
	} finally {
		if (isTTY) process.stdout.write(`${ESC}?25h${ESC}?1049l`); // restore cursor + screen
		try {
			fs.closeSync(logFd);
		} catch {
			/* ignore */
		}
		process.off("SIGINT", onSig);
		process.off("SIGTERM", onSig);
	}

	// final summary (printed to the normal screen)
	const trials = readTrials(jobDir);
	const tot = aggregate(trials, readJobResult(jobDir), expected);
	const successPct = tot.done > 0 ? (tot.pass / tot.done) * 100 : 0;
	const reportPath = writeReport(st, benchDir, exitCode);
	process.stdout.write("\n");
	process.stdout.write(
		`${bold("terminal-bench-2 complete")} — ${green(`${tot.pass}/${tot.done} passed (${successPct.toFixed(1)}%)`)}\n`,
	);
	process.stdout.write(
		`fail ${tot.fail} · error ${tot.error} · spend ${fmtUsd(tot.costUsd)} · elapsed ${fmtDur(Date.now() - st.startMs)}\n`,
	);
	process.stdout.write(
		`tokens: in ${fmtNum(tot.tokIn)} · out ${fmtNum(tot.tokOut)} · cache ${fmtNum(tot.tokCache)}\n`,
	);
	process.stdout.write(`${dim("report:")} ${reportPath}\n`);
	process.stdout.write(`${dim("logs:  ")} ${logPath}\n`);
	process.stdout.write(`${dim("trials:")} ${jobDir}\n`);
	if (exitCode !== 0) process.stdout.write(yellow(`harbor exited ${exitCode}; see harbor.log\n`));
	process.exit(exitCode);
}

if (import.meta.main) {
	main().catch((err: unknown) => {
		if (isTTY) process.stdout.write(`${ESC}?25h${ESC}?1049l`);
		process.stderr.write(red(`\nerror: ${err instanceof Error ? err.message : String(err)}\n`));
		process.exit(1);
	});
}
