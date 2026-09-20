#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
/**
 * Harbor benchmark runner for the local `omp` build.
 *
 * Orchestrates Harbor (`harbor run`) against any Harbor dataset (default
 * terminal-bench-2) using a custom agent (`agent/omp_local.py`) that installs
 * the working tree at /work/pi and routes all model auth through the host pm2
 * auth-gateway (no provider keys ever enter the task containers).
 *
 * It owns the terminal: Harbor's own output is redirected to a log file and this
 * process renders a live dashboard (progress / success% / spend / tokens / ETA)
 * by polling each trial's `result.json`. On completion it writes a markdown report.
 *
 *   metaharness harbor --model anthropic/claude-sonnet-4-6 --tasks 20 --concurrency 4
 *   metaharness harbor --agent oracle --tasks 2        # cheap pipeline smoke
 *   metaharness harbor --help
 */
import type { Server } from "bun";
import { harborRunnerArgs, type LaunchRequest } from "./launch-args";

// ────────────────────────────────────────────────────────────────────── config

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PKG_DIR = path.resolve(import.meta.dir, "..");
const AGENT_DIR = path.join(PKG_DIR, "agent");
const CODING_AGENT_DIR = path.join(REPO_ROOT, "packages", "coding-agent");
const AGENT_IMPORT_PATH = "omp_local:OmpLocal";

/** Container-side mount points for `--install source` (must match omp_local.py defaults). */
const SOURCE_SRC_MOUNT = "/opt/omp/src";
const SOURCE_BIN_MOUNT = "/opt/omp/bin";

/** Host address containers see on Apple Container's vmnet (bridge) network. */
const VMNET_HOST_IP = "192.168.64.1";
const DOCKER_GATEWAY_URL = "http://host.docker.internal:4000";
const VMNET_GATEWAY_URL = `http://${VMNET_HOST_IP}:4000`;
/**
 * Resolver injected into Apple Container runs (OMP_BENCH_CONTAINER_DNS overrides).
 * The vmnet gateway resolver (192.168.64.1:53) is unreachable when VPN/DNS
 * agents on the host intercept port 53, so containers get an explicit one.
 */
const CONTAINER_DNS = process.env.OMP_BENCH_CONTAINER_DNS || "1.1.1.1";

export interface Config {
	models: string[];
	dataset: string;
	tasks: number;
	concurrency: number;
	attempts: number;
	include: string[];
	exclude: string[];
	thinking: string | null;
	/** Extra args forwarded verbatim to the in-container omp CLI invocation (repeatable). */
	agentArgs: string[];

	agent: string;
	install: "source" | "local" | "published";
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
	/** Job name (or job dir path) to resume via `harbor job resume` instead of starting a new run. */
	resume: string | null;
	/** With resume: evict+re-run completed trials that errored with these exception types. */
	filterErrorTypes: string[];
	/** Harbor environment backend running the task containers. */
	envType: "docker" | "apple-container";
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
		agentArgs: [],

		agent: "omp",
		install: "source",
		version: null,
		tarball: null,
		binaryArm64: null,
		binaryX64: null,
		build: true,
		jobsDir: path.join(REPO_ROOT, "runs", "harbor"),
		jobName: null,
		gatewayUrl: DOCKER_GATEWAY_URL,
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
		resume: null,
		filterErrorTypes: [],
		envType: "docker",
		passthrough: [],
		env: {},
	};
}

const HELP = `metaharness runner (local omp)

Usage: metaharness harbor [options] [-- <extra harbor args>]

Commands:
  cleanup                        Force-remove ALL leftover Harbor containers + networks, then exit

Model / agent:
  -m, --model <provider/model>   Model (repeatable). Default anthropic/claude-sonnet-4-6
      --agent <name>             omp (default) | oracle | nop | any harbor agent
      --install <source|local|published> omp install mode (default: source).
                                 source = mount /work/pi read-only + prebuilt linux deps tree; TS changes
                                 apply per-trial with no rebuild. local = pack a tarball. published = npm.
      --version <v>              omp version for published install (default: latest)
      --thinking <level>         off|minimal|low|medium|high|xhigh|max

      --tarball <path>           Reuse a prebuilt omp tarball (implies --install local, --no-build)
      --no-build                 Skip packing; reuse newest tarball in bench dir (--install local)
      --agent-arg <arg>          Extra arg forwarded verbatim to the in-container omp CLI (repeatable)
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

Environment:
      --environment <type>       docker (default) | apple-container (Apple 'container' CLI;
                                 no Docker needed, gateway auto-forwarded via 192.168.64.1)

Output / control:
  -o, --jobs-dir <path>          Default <repo>/runs/harbor
      --job-name <name>          Default <model>-<timestamp>
      --resume <name|path>       Resume that job dir: the original launch flags are recovered
                                 automatically (runner-config.json / manager.json), completed
                                 trials are kept and paid for once, the rest re-run
      --filter-error-type <T>    With --resume: also re-run completed trials whose exception
                                 type is <T> (repeatable; CancelledError is always evicted)
      --dry-run                  Print the harbor command + models.yml and exit
      --cleanup                  Clean up stale and exited Harbor Docker resources safely before starting (docker only)
      --cleanup-force            Force-stop and remove ALL previous Harbor Docker containers and networks (docker only)
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
				if (v !== "source" && v !== "local" && v !== "published") {
					throw new Error("--install must be source|local|published");
				}
				cfg.install = v;
				break;
			}
			case "--version":
				cfg.version = take(arg);
				break;
			case "--thinking":
				cfg.thinking = take(arg);
				break;
			case "--tarball":
				cfg.tarball = path.resolve(take(arg));
				cfg.install = "local";
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
			case "--agent-arg":
				cfg.agentArgs.push(take(arg));
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
			case "--resume":
				cfg.resume = take(arg);
				break;
			case "--filter-error-type":
				cfg.filterErrorTypes.push(take(arg));
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
			case "--environment": {
				const v = take(arg);
				if (v !== "docker" && v !== "apple-container") {
					throw new Error("--environment must be docker|apple-container");
				}
				cfg.envType = v;
				break;
			}
			default:
				throw new Error(`unknown flag: ${arg} (see --help)`);
		}
	}
	if (cfg.models.length === 0) cfg.models = ["anthropic/claude-sonnet-4-6"];
	if (cfg.envType === "apple-container") {
		if (cfg.hostNetwork) throw new Error("--host-network is docker-only (compose overlay)");
		// host.docker.internal doesn't exist on vmnet; containers reach the host at the bridge address.
		if (cfg.gatewayUrl === DOCKER_GATEWAY_URL) cfg.gatewayUrl = VMNET_GATEWAY_URL;
	}
	return cfg;
}

// ─────────────────────────────────────────────────────────────────── resume

/** manager.json launch record written by RunStore.registerLaunch. */
interface ManagerRecord {
	benchmark?: string;
	dataset?: string;
	config?: LaunchRequest;
}

/**
 * Recover the original launch Config for `--resume <job>` — nothing needs
 * re-specifying. Prefers the exact Config snapshot recorded at launch
 * (`_bench/<job>/runner-config.json`), falling back to rebuilding runner argv
 * from the manager.json launch record of API-launched runs. The job dir's own
 * harbor config.json decides the container backend: harbor rejects a resume
 * whose reconstructed config differs from the recorded one.
 */
export function resolveResumeConfig(cli: Config): Config {
	const spec = cli.resume as string;
	const jobsDir = spec.includes(path.sep) ? path.dirname(path.resolve(spec)) : cli.jobsDir;
	const jobName = path.basename(spec);
	const jobDir = path.join(jobsDir, jobName);
	const jobConfig = readJson(path.join(jobDir, "config.json")) as { environment?: { type?: string } } | null;
	if (!jobConfig) throw new Error(`--resume: ${jobDir} has no harbor config.json (not a harbor job dir)`);

	let cfg: Config | null = null;
	const saved = readJson(path.join(jobsDir, "_bench", jobName, "runner-config.json"));
	if (saved && typeof saved === "object") {
		cfg = { ...defaultConfig(), ...(saved as Partial<Config>) };
	} else {
		const manager = readJson(path.join(jobDir, "manager.json")) as ManagerRecord | null;
		if (manager?.config) {
			if (manager.benchmark && manager.benchmark !== "harbor") {
				throw new Error(`--resume supports only harbor runs (${jobName} is ${manager.benchmark})`);
			}
			const dataset = manager.config.dataset ?? manager.dataset ?? "terminal-bench@2.0";
			cfg = parseArgs(harborRunnerArgs(manager.config, { jobsDir, jobName, dataset }));
		}
	}
	if (!cfg) {
		throw new Error(
			`--resume: no recorded launch config for ${jobName} ` +
				`(missing both _bench/${jobName}/runner-config.json and ${jobName}/manager.json)`,
		);
	}
	cfg.jobsDir = jobsDir;
	cfg.jobName = jobName;
	cfg.resume = spec;
	// The recorded backend wins over any reconstruction-time preference
	// (e.g. apple-container auto-detection added after the original run).
	const recorded = jobConfig.environment?.type;
	if ((recorded === "docker" || recorded === "apple-container") && cfg.envType !== recorded) {
		if (recorded === "apple-container" && cfg.gatewayUrl === DOCKER_GATEWAY_URL) cfg.gatewayUrl = VMNET_GATEWAY_URL;
		else if (recorded === "docker" && cfg.gatewayUrl === VMNET_GATEWAY_URL) cfg.gatewayUrl = DOCKER_GATEWAY_URL;
		cfg.envType = recorded;
	}
	// Knobs owned by the resume invocation, not the original launch.
	cfg.filterErrorTypes = cli.filterErrorTypes;
	cfg.passthrough = cli.passthrough;
	cfg.dryRun = cli.dryRun;
	cfg.cleanup = cli.cleanup;
	cfg.cleanupForce = cli.cleanupForce;
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

function agentArgsLabel(cfg: Config): string | null {
	return cfg.agentArgs.length > 0 ? cfg.agentArgs.join(" ") : null;
}

// ───────────────────────────────────────────────────────────── result parsing

export type TrialStatus = "pass" | "fail" | "error" | "running";

export interface Trial {
	name: string;
	status: TrialStatus;
	reward: number | null;
	costUsd: number;
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

/** Running usage totals for one live trial's transcript, plus the parse cursor. */
interface CostProbe {
	/** Bytes of the transcript already consumed. */
	offset: number;
	/** Trailing partial line carried to the next read (bytes, so multi-byte chars survive chunking). */
	remainder: Buffer;
	/** True while discarding an oversized line (resync at the next newline). */
	discarding: boolean;
	costUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
}

/** Incremental parse state per live transcript path. Entries are dropped once the trial finishes. */
const costProbes = new Map<string, CostProbe>();

/** First sight of an already-huge transcript: parse only its tail (undercounts cost, never OOMs). */
const COST_PROBE_FIRST_SCAN_BYTES = 16 * 1024 * 1024;
/** A single line longer than this is bloat/corruption, never a usage event: skip it. */
const COST_PROBE_MAX_LINE_BYTES = 4 * 1024 * 1024;
const COST_PROBE_CHUNK_BYTES = 1024 * 1024;

/** Accumulate assistant `message_end` usage from one complete transcript line. */
function probeLine(line: string, probe: CostProbe): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	try {
		const event = JSON.parse(trimmed);
		if (event?.type !== "message_end") return;
		const message = event.message;
		if (!message || typeof message !== "object" || message.role !== "assistant") return;
		const usage = message.usage;
		if (!usage || typeof usage !== "object") return;
		probe.tokIn += num(usage.input) + num(usage.cacheRead);
		probe.tokOut += num(usage.output);
		probe.tokCache += num(usage.cacheRead);
		const cost = usage.cost;
		if (cost && typeof cost === "object") probe.costUsd += num(cost.total);
	} catch {
		/* Ignore malformed lines from incomplete writes */
	}
}

/**
 * Realtime usage for a still-running trial, read incrementally from its
 * `agent/omp.txt` JSONL. Only bytes appended since the previous call are read
 * and parsed — both this runner's render loop and the manager's 2s sync tick
 * call this for every live trial, and a full-file reread used to block the
 * event loop for seconds (and OOM outright on runaway multi-GB transcripts).
 */
function probeTrialCost(ompLogPath: string): CostProbe | null {
	let size: number;
	try {
		size = fs.statSync(ompLogPath).size;
	} catch {
		return costProbes.get(ompLogPath) ?? null;
	}
	let probe = costProbes.get(ompLogPath);
	if (!probe || size < probe.offset) {
		// New (or truncated/rotated) transcript. Skip a pre-existing giant head.
		probe = {
			offset: Math.max(0, size - COST_PROBE_FIRST_SCAN_BYTES),
			remainder: Buffer.alloc(0),
			discarding: size > COST_PROBE_FIRST_SCAN_BYTES, // resync to the next full line
			costUsd: 0,
			tokIn: 0,
			tokOut: 0,
			tokCache: 0,
		};
		costProbes.set(ompLogPath, probe);
	}
	if (size === probe.offset) return probe;
	let fd: number;
	try {
		fd = fs.openSync(ompLogPath, "r");
	} catch {
		return probe;
	}
	try {
		const chunk = Buffer.allocUnsafe(COST_PROBE_CHUNK_BYTES);
		for (;;) {
			const read = fs.readSync(fd, chunk, 0, chunk.length, probe.offset);
			if (read <= 0) break;
			probe.offset += read;
			const data = Buffer.concat([probe.remainder, chunk.subarray(0, read)]);
			let start = 0;
			for (;;) {
				const nl = data.indexOf(0x0a, start);
				if (nl === -1) break;
				if (probe.discarding) probe.discarding = false;
				else probeLine(data.subarray(start, nl).toString("utf8"), probe);
				start = nl + 1;
			}
			probe.remainder = data.subarray(start);
			if (probe.remainder.length > COST_PROBE_MAX_LINE_BYTES) {
				probe.remainder = Buffer.alloc(0);
				probe.discarding = true;
			}
		}
	} catch {
		/* keep whatever was accumulated; retry next tick */
	} finally {
		fs.closeSync(fd);
	}
	return probe;
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

		// Realtime cost from the live agent omp.txt log, parsed incrementally.
		const probe = probeTrialCost(path.join(dir, "agent", "omp.txt"));
		const costUsd = probe?.costUsd ?? 0;
		const tokIn = probe?.tokIn ?? 0;
		const tokOut = probe?.tokOut ?? 0;
		const tokCache = probe?.tokCache ?? 0;

		return {
			name,
			status: "running",
			reward: null,
			costUsd,
			tokIn,
			tokOut,
			tokCache,
			durationMs: Date.now() - started,
			detail: "",
		};
	}
	// Trial finished: usage now comes from result.json; drop the live-parse state.
	costProbes.delete(path.join(dir, "agent", "omp.txt"));
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
		tokIn = 0,
		tokOut = 0,
		tokCache = 0;
	for (const ctx of ctxs) {
		costUsd += num(ctx.cost_usd);
		tokIn += num(ctx.n_input_tokens);
		tokOut += num(ctx.n_output_tokens);
		tokCache += num(ctx.n_cache_tokens);
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
	return { name, status, reward, costUsd, tokIn, tokOut, tokCache, durationMs, detail };
}

export function readTrials(jobDir: string): Trial[] {
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
export interface JobInfo {
	nTotal: number;
	running: number | null;
	pending: number | null;
	/** Harbor sets this only when the job reached a terminal state. */
	finishedAt: number | null;
}

export function readJobResult(jobDir: string): JobInfo | null {
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
	const finishedRaw = typeof r.finished_at === "string" ? Date.parse(r.finished_at) : NaN;
	const finishedAt = Number.isFinite(finishedRaw) ? finishedRaw : null;
	return nTotal > 0 ? { nTotal, running, pending, finishedAt } : null;
}

// ──────────────────────────────────────────────────────────────────── totals

export interface Totals {
	total: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	running: number;
	pending: number;
	costUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	durationMs: number;
}

export function aggregate(trials: Trial[], job: JobInfo | null, fallbackExpected: number): Totals {
	const t: Totals = {
		total: fallbackExpected,
		done: 0,
		pass: 0,
		fail: 0,
		error: 0,
		running: 0,
		pending: 0,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
		durationMs: 0,
	};
	for (const tr of trials) {
		t.costUsd += tr.costUsd;
		t.tokIn += tr.tokIn;
		t.tokOut += tr.tokOut;
		t.tokCache += tr.tokCache;
		if (tr.status === "running") {
			t.running++;
			continue;
		}
		t.durationMs += tr.durationMs;

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
	const argsLabel = agentArgsLabel(st.cfg);
	const argsTag = argsLabel ? `${dim(" · args ")}${argsLabel}` : "";
	const header = `${bold(st.cfg.dataset)} ${dim("·")} ${cyan(st.cfg.agent)} ${dim("·")} ${st.cfg.models.join(",")}${argsTag} ${dim(`· conc=${st.cfg.concurrency} k=${st.cfg.attempts}`)}`;
	rows.push(header);
	const width = 28;
	rows.push(
		`${bar(tot.total > 0 ? tot.done / tot.total : 0, width)} ${bold(`${tot.done}/${tot.total}`)}  ${dim("elapsed")} ${fmtDur(elapsed)}  ${dim("eta")} ${eta > 0 ? `~${fmtDur(eta)}` : "—"}`,
	);
	rows.push(
		`${green(`pass ${tot.pass}`)} ${dim(`(${successPct.toFixed(0)}%)`)}   ${red(`fail ${tot.fail}`)}   ${yellow(`err ${tot.error}`)}   ${cyan(`run ${tot.running}`)}   ${gray(`pend ${tot.pending}`)}`,
	);
	rows.push(
		`${bold("spend")} ${fmtUsd(tot.costUsd)}   ${dim("in")} ${fmtNum(tot.tokIn)}  ${dim("out")} ${fmtNum(tot.tokOut)}  ${dim("cache")} ${fmtNum(tot.tokCache)}`,
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
			`[harbor] ${tot.done}/${tot.total} pass=${tot.pass}(${successPct.toFixed(0)}%) fail=${tot.fail} err=${tot.error} run=${tot.running} spend=${fmtUsd(tot.costUsd)} elapsed=${fmtDur(elapsed)}\n`,
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
	const argsLabel = agentArgsLabel(st.cfg);
	const baseModelLine = st.cfg.models.join(", ");
	const modelLine = argsLabel ? `${baseModelLine} (${argsLabel})` : baseModelLine;
	lines.push(`# ${st.cfg.dataset} — ${st.cfg.agent} — ${modelLine}`);
	lines.push("");
	lines.push(`- dataset: \`${st.cfg.dataset}\``);
	lines.push(`- tasks: ${st.cfg.tasks} · attempts: ${st.cfg.attempts} · concurrency: ${st.cfg.concurrency}`);
	if (isOmp) {
		lines.push(
			`- install: ${st.cfg.install} · auth: ${st.cfg.gateway ? "host gateway (no keys in container)" : "direct provider keys"}`,
		);
		lines.push(`- tools: web_search=${st.cfg.webSearch ? "on" : "off"}`);
		if (argsLabel) lines.push(`- agent args: ${argsLabel}`);
	}
	lines.push(`- elapsed: ${fmtDur(Date.now() - st.startMs)} · harbor exit: ${exitCode}`);
	lines.push("");
	lines.push(
		`**${tot.pass}/${tot.done} passed (${successPct.toFixed(1)}%)** · fail ${tot.fail} · error ${tot.error} · spend ${fmtUsd(tot.costUsd)}`,
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

// ─────────────────────────────────────────────────────── source mount (--install source)

/** Linux deps tree + mount plan for running omp straight from the mounted repo. */
export interface SourceMount {
	arch: "arm64" | "x64";
	/** Host dir holding the linux `bin/bun` + skeleton `node_modules` trees. */
	depsDir: string;
	/** Repo-relative node_modules dirs to shadow-mount over the darwin ones. */
	nodeModules: string[];
}

/** Bun version pinned by the repo's `packageManager` field. */
function repoBunVersion(): string {
	const raw = readJson(path.join(REPO_ROOT, "package.json"));
	if (raw && typeof raw === "object") {
		const pm = (raw as Record<string, unknown>).packageManager;
		if (typeof pm === "string" && pm.startsWith("bun@")) return pm.slice("bun@".length);
	}
	return "1.4.0";
}

/** Native arch of the docker daemon (what non-emulated task containers run as). */
function dockerServerArch(): "arm64" | "x64" {
	const r = spawnSync("docker", ["version", "--format", "{{.Server.Arch}}"], { encoding: "utf8" });
	const a = (r.stdout ?? "").trim();
	if (a === "arm64" || a === "aarch64") return "arm64";
	if (a === "amd64" || a === "x86_64") return "x64";
	throw new Error(`cannot detect docker server arch (got ${a || "nothing"}); is docker running?`);
}

/** Workspace member dirs (repo-relative), expanded from root package.json `workspaces.packages`. */
function workspacePackageDirs(): string[] {
	const raw = readJson(path.join(REPO_ROOT, "package.json")) as {
		workspaces?: { packages?: string[] };
	} | null;
	const dirs = new Set<string>();
	for (const pattern of raw?.workspaces?.packages ?? []) {
		for (const match of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: REPO_ROOT })) {
			dirs.add(path.dirname(match));
		}
	}
	return [...dirs].sort();
}

/** Manifest files (repo-relative) that fully determine a `bun install` result. */
function sourceManifestFiles(pkgDirs: string[]): string[] {
	const files = ["package.json", "bun.lock"];
	if (fs.existsSync(path.join(REPO_ROOT, "bunfig.toml"))) files.push("bunfig.toml");
	const patchesDir = path.join(REPO_ROOT, "patches");
	if (fs.existsSync(patchesDir)) {
		for (const f of fs.readdirSync(patchesDir).sort()) files.push(path.join("patches", f));
	}
	for (const dir of pkgDirs) files.push(path.join(dir, "package.json"));
	return files;
}

function sourceDepsStamp(manifests: string[], bunVersion: string): string {
	const h = new Bun.CryptoHasher("sha256");
	h.update(`bun@${bunVersion}\0source-deps-v1\0`);
	for (const rel of manifests) {
		h.update(rel);
		h.update("\0");
		h.update(fs.readFileSync(path.join(REPO_ROOT, rel)));
		h.update("\0");
	}
	return h.digest("hex");
}

/**
 * Ensure the cached linux deps tree for source mode: a manifest-only skeleton of the
 * workspace with `bun install --production` run inside `oven/bun:<ver>` (matching the
 * daemon's native arch), plus the image's linux `bun` under `bin/`. Rebuilt only when
 * a manifest/lockfile or the pinned bun version changes; TS edits never invalidate it.
 */
export function prepareSourceDeps(cfg: Config): SourceMount {
	const arch = cfg.envType === "apple-container" ? "arm64" : dockerServerArch();
	const bunVersion = repoBunVersion();
	const depsDir = path.join(cfg.jobsDir, "_bench", "_deps", `linux-${arch}`);
	const pkgDirs = workspacePackageDirs();
	const manifests = sourceManifestFiles(pkgDirs);
	const stamp = sourceDepsStamp(manifests, bunVersion);
	const stampFile = path.join(depsDir, ".stamp");
	let current: string | null = null;
	try {
		current = fs.readFileSync(stampFile, "utf8").trim();
	} catch {
		/* no stamp yet */
	}
	if (current !== stamp) {
		process.stdout.write(dim(`building linux-${arch} deps tree for source mount (one-time per lockfile change)…\n`));
		fs.rmSync(depsDir, { recursive: true, force: true });
		fs.mkdirSync(depsDir, { recursive: true });
		for (const rel of manifests) {
			const dst = path.join(depsDir, rel);
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			fs.copyFileSync(path.join(REPO_ROOT, rel), dst);
		}
		// --ignore-scripts: the skeleton has manifests only, so lifecycle scripts
		// (root `prepare` → gen:tool-views) would fail; patchedDependencies still apply.
		const script =
			'mkdir -p /deps/bin && cp "$(command -v bun)" /deps/bin/bun && cd /deps && bun install --production --omit=optional --ignore-scripts';
		const image = `oven/bun:${bunVersion}`;
		const runArgv =
			cfg.envType === "apple-container"
				? [
						"container",
						"run",
						"--rm",
						"--dns",
						CONTAINER_DNS,
						"-e",
						"HOME=/tmp",
						"-v",
						`${depsDir}:/deps`,
						image,
						"sh",
						"-c",
						script,
					]
				: [
						"docker",
						"run",
						"--rm",
						"--platform",
						`linux/${arch === "x64" ? "amd64" : "arm64"}`,
						"-e",
						"HOME=/tmp",
						"-v",
						`${depsDir}:/deps`,
						image,
						"sh",
						"-c",
						script,
					];
		const r = spawnSync(runArgv[0], runArgv.slice(1), { stdio: ["ignore", "inherit", "inherit"] });
		if (r.status !== 0) {
			fs.rmSync(stampFile, { force: true });
			throw new Error(`source deps install failed (${runArgv[0]} exit ${r.status})`);
		}
		fs.writeFileSync(stampFile, `${stamp}\n`);
	}
	if (!fs.existsSync(path.join(depsDir, "node_modules"))) {
		throw new Error(`source deps tree has no node_modules (${depsDir}); delete it and retry`);
	}
	// Shadow-mount every node_modules visible in the host tree (they hold darwin
	// binaries) with the skeleton's linux one; both sides of each mount must exist.
	const nodeModules = ["node_modules"];
	for (const dir of pkgDirs) {
		const rel = path.join(dir, "node_modules");
		const inHost = fs.existsSync(path.join(REPO_ROOT, rel));
		const inDeps = fs.existsSync(path.join(depsDir, rel));
		if (!inHost && !inDeps) continue;
		if (!inDeps) fs.mkdirSync(path.join(depsDir, rel), { recursive: true });
		if (!inHost) fs.mkdirSync(path.join(REPO_ROOT, rel), { recursive: true });
		nodeModules.push(rel);
	}
	return { arch, depsDir, nodeModules };
}

/**
 * Compose overlay applied to every trial's `main` service: host networking and/or the
 * read-only source + linux-deps mounts. Returns null when nothing needs overlaying.
 */
function writeComposeOverlay(benchDir: string, cfg: Config, source: SourceMount | null): string | null {
	const lines: string[] = [];
	if (cfg.hostNetwork) lines.push('    network_mode: "host"');
	if (source) {
		lines.push("    volumes:");
		lines.push(`      - ${REPO_ROOT}:${SOURCE_SRC_MOUNT}:ro`);
		for (const rel of source.nodeModules) {
			lines.push(`      - ${path.join(source.depsDir, rel)}:${SOURCE_SRC_MOUNT}/${rel}:ro`);
		}
		lines.push(`      - ${path.join(source.depsDir, "bin")}:${SOURCE_BIN_MOUNT}:ro`);
	}
	if (lines.length === 0) return null;
	const file = path.join(benchDir, "omp-compose-overlay.yaml");
	fs.writeFileSync(file, `${["services:", "  main:", ...lines].join("\n")}\n`);
	return file;
}

/**
 * `harbor run --mounts` JSON (compose service-volume format) for non-compose
 * environments (apple-container): source repo + linux deps tree. Apple
 * Container currently mounts binds read-write regardless of `read_only`.
 */
function buildMountsJson(source: SourceMount | null): string | null {
	if (!source) return null;
	const mounts: Array<{ type: "bind"; source: string; target: string; read_only: true }> = [
		{ type: "bind", source: REPO_ROOT, target: SOURCE_SRC_MOUNT, read_only: true },
	];
	for (const rel of source.nodeModules) {
		mounts.push({
			type: "bind",
			source: path.join(source.depsDir, rel),
			target: `${SOURCE_SRC_MOUNT}/${rel}`,
			read_only: true,
		});
	}
	mounts.push({ type: "bind", source: path.join(source.depsDir, "bin"), target: SOURCE_BIN_MOUNT, read_only: true });
	return JSON.stringify(mounts);
}

function deriveProviders(cfg: Config): string[] {
	// Explicit --providers is authoritative: it's the escape hatch for routing
	// only SOME providers through the gateway (e.g. oauth-only openai-codex)
	// while the model's own provider authenticates directly via a forwarded
	// env key. The model-provider + anthropic/openai-codex additions are the
	// DEFAULT for when the flag is absent.
	if (cfg.providers.length > 0) return [...new Set(cfg.providers)];
	const set = new Set<string>();
	for (const m of cfg.models) {
		const slash = m.indexOf("/");
		if (slash > 0) set.add(m.slice(0, slash));
	}
	if (set.size === 0) {
		set.add("anthropic");
		set.add("openai-codex");
	}
	return [...set];
}

function writeModelsYaml(benchDir: string, cfg: Config): string {
	const providers = deriveProviders(cfg);
	const lines = ["# Generated by metaharness — auth via host pm2 gateway.", "providers:"];
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
	const hostUrl = url
		.replace("host.docker.internal", "127.0.0.1")
		.replace(VMNET_HOST_IP, "127.0.0.1")
		.replace(/\/+$/, "");
	const r = spawnSync("curl", ["-s", "--max-time", "4", `${hostUrl}/healthz`], { encoding: "utf8" });
	return r.status === 0 && (r.stdout ?? "").includes('"ok":true');
}

/**
 * HTTP forward from the vmnet host address to the loopback-bound auth gateway.
 * Apple Container has no host.docker.internal: containers reach the host at
 * 192.168.64.1, but the pm2 gateway binds 127.0.0.1 only. The bridge interface
 * only exists while a container is running, so binding retries until it appears.
 */
function startVmnetGatewayForward(cfg: Config): { stop(): void } | null {
	if (cfg.envType !== "apple-container" || !cfg.gateway) return null;
	const url = new URL(cfg.gatewayUrl);
	if (url.hostname !== VMNET_HOST_IP) return null;
	const port = Number(url.port || "80");
	let server: Server<undefined> | null = null;
	let timer: Timer | undefined;
	let stopped = false;
	const bind = (): void => {
		if (stopped) return;
		try {
			server = Bun.serve({
				hostname: VMNET_HOST_IP,
				port,
				idleTimeout: 0,
				fetch(req) {
					const target = new URL(req.url);
					target.hostname = "127.0.0.1";
					return fetch(target, { method: req.method, headers: req.headers, body: req.body, redirect: "manual" });
				},
			});
			process.stdout.write(dim(`gateway forward: ${VMNET_HOST_IP}:${port} → 127.0.0.1:${port}\n`));
		} catch {
			timer = setTimeout(bind, 2000);
		}
	};
	bind();
	return {
		stop(): void {
			stopped = true;
			clearTimeout(timer);
			server?.stop(true);
		},
	};
}

function buildHarborArgs(
	cfg: Config,
	jobName: string,
	modelsYaml: string,
	tarball: string | null,
	composeOverlayPath: string | null,
	mountsJson: string | null,
): string[] {
	const a: string[] = ["run", "-d", cfg.dataset, "-o", cfg.jobsDir, "--job-name", jobName];
	a.push("-n", String(cfg.concurrency), "-k", String(cfg.attempts), "-l", String(cfg.tasks));
	for (const m of cfg.models) a.push("-m", m);
	for (const inc of cfg.include) a.push("-i", inc);
	for (const exc of cfg.exclude) a.push("-x", exc);
	for (const h of cfg.allowHosts) a.push("--allow-agent-host", h);
	if (cfg.timeoutMultiplier !== null) a.push("--timeout-multiplier", String(cfg.timeoutMultiplier));
	if (cfg.yes) a.push("-y");
	if (composeOverlayPath) {
		a.push("--extra-docker-compose", composeOverlayPath);
	}
	if (cfg.envType !== "docker") a.push("-e", cfg.envType);
	if (mountsJson) a.push("--mounts", mountsJson);

	if (cfg.agent === "omp") {
		// Config + secrets travel via env (OMP_BENCH_*); the agent reads os.environ.
		a.push("--agent-import-path", AGENT_IMPORT_PATH);
		void modelsYaml;
		void tarball;
	} else {
		a.push("-a", cfg.agent);
	}
	a.push(...cfg.passthrough);
	return a;
}
/**
 * `harbor job resume` argv for an existing job dir: trial dirs with a
 * result.json are kept (their spend is reused), the rest re-run. Explicit
 * `-f` values REPLACE harbor's CancelledError default, so it is always
 * re-added alongside the caller's filters.
 */
export function buildResumeArgs(cfg: Config, jobDir: string): string[] {
	const a: string[] = ["job", "resume", "-p", jobDir];
	if (cfg.filterErrorTypes.length > 0) {
		for (const t of new Set(["CancelledError", ...cfg.filterErrorTypes])) a.push("-f", t);
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
	source: SourceMount | null = null,
): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	// Drop any stale OMP_BENCH_FORWARD_ENV inherited from the caller's shell before
	// the agent-type early return, so it never leaks (incl. into the dry-run dump).
	delete env.OMP_BENCH_FORWARD_ENV;
	if (cfg.agent !== "omp") return env;
	const prepend = (k: string, v: string): void => {
		env[k] = env[k] ? `${v}:${env[k]}` : v;
	};
	prepend("PYTHONPATH", AGENT_DIR);
	env.OMP_BENCH_INSTALL = cfg.install;
	env.OMP_BENCH_VERSION = cfg.version ?? version;
	if (tarball) env.OMP_BENCH_TARBALL = tarball;
	if (source) {
		env.OMP_BENCH_SOURCE_DIR = SOURCE_SRC_MOUNT;
		env.OMP_BENCH_SOURCE_BUN = `${SOURCE_BIN_MOUNT}/bun`;
		env.OMP_BENCH_SOURCE_ARCH = source.arch;
	}
	if (cfg.binaryArm64) env.OMP_BENCH_BINARY_ARM64 = cfg.binaryArm64;
	if (cfg.binaryX64) env.OMP_BENCH_BINARY_X64 = cfg.binaryX64;
	if (cfg.thinking) env.OMP_BENCH_THINKING = cfg.thinking;
	if (cfg.agentArgs.length > 0) env.OMP_BENCH_AGENT_ARGS = JSON.stringify(cfg.agentArgs);
	if (cfg.webSearch) env.OMP_BENCH_WEB_SEARCH = "1";
	env.OMP_BENCH_GATEWAY = cfg.gateway ? "1" : "0";
	if (cfg.gateway) {
		env.OMP_BENCH_MODELS_YAML = modelsYaml;
		env.OMP_BENCH_GATEWAY_URL = cfg.gatewayUrl;
		env.OMP_BENCH_GATEWAY_TOKEN = cfg.gatewayToken;
		env.OMP_BENCH_GATEWAY_PROVIDERS = deriveProviders(cfg).join(",");
	}
	if (cfg.envType === "apple-container") env.OMP_BENCH_CONTAINER_DNS = CONTAINER_DNS;
	const forward = collectForwardEnv(cfg);
	if (Object.keys(forward).length > 0) env.OMP_BENCH_FORWARD_ENV = JSON.stringify(forward);
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

interface BenchmarkRun {
	exitCode: number;
	jobName: string;
	jobDir: string;
	benchDir: string;
	tarball: string | null;
	elapsedMs: number;
	totals: Totals | null;
	reportPath: string | null;
}

async function runBenchmark(cfg: Config): Promise<BenchmarkRun> {
	if (!which("harbor")) {
		throw new Error("harbor not found on PATH. Install with: uv tool install harbor");
	}
	if (cfg.agent === "omp" && cfg.envType === "docker" && !which("docker")) {
		throw new Error("docker not found on PATH (required to run task containers).");
	}
	if (cfg.envType === "apple-container" && !which("container")) {
		throw new Error(
			"Apple 'container' CLI not found. Install with: brew install container && container system start",
		);
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const modelSlug = (cfg.models[0] ?? "model").replace(/[^a-zA-Z0-9]+/g, "-");
	const jobName = cfg.jobName ?? `${modelSlug}-${stamp}`;
	const jobDir = path.join(cfg.jobsDir, jobName);
	const benchDir = path.join(cfg.jobsDir, "_bench", jobName);
	fs.mkdirSync(benchDir, { recursive: true });
	if (!cfg.resume && !cfg.dryRun) {
		// Snapshot the resolved launch config so a later `--resume <job>` can
		// rebuild the exact same invocation without re-specifying flags.
		fs.writeFileSync(path.join(benchDir, "runner-config.json"), JSON.stringify({ ...cfg, jobName }, null, "\t"));
	}

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

	// source mount (default): repo bind-mounted read-only + cached linux deps tree
	let source: SourceMount | null = null;
	if (cfg.agent === "omp" && cfg.install === "source" && !cfg.binaryArm64 && !cfg.binaryX64) {
		source = prepareSourceDeps(cfg);
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
	const composeOverlayPath = cfg.envType === "docker" ? writeComposeOverlay(benchDir, cfg, source) : null;
	const mountsJson = cfg.envType === "docker" ? null : buildMountsJson(source);

	const harborArgs = cfg.resume
		? buildResumeArgs(cfg, jobDir)
		: buildHarborArgs(cfg, jobName, modelsYaml, tarball, composeOverlayPath, mountsJson);
	const harborEnv = buildHarborEnv(cfg, modelsYaml, tarball, version, source);
	const logPath = path.join(benchDir, "harbor.log");
	if (cfg.dryRun) {
		process.stdout.write(bold("\nharbor command:\n"));
		process.stdout.write(`harbor ${harborArgs.join(" ")}\n\n`);
		if (modelsYaml) {
			process.stdout.write(bold("models.yml:\n"));
			process.stdout.write(`${fs.readFileSync(modelsYaml, "utf8")}\n`);
		}
		process.stdout.write(bold("omp env:\n"));
		for (const key in harborEnv) {
			if (key === "OMP_BENCH_FORWARD_ENV") continue;
			if (key.startsWith("OMP_BENCH_") || key === "PYTHONPATH") process.stdout.write(`  ${key}=${harborEnv[key]}\n`);
		}
		if (harborEnv.OMP_BENCH_FORWARD_ENV) {
			const parsedForwardEnv: unknown = JSON.parse(harborEnv.OMP_BENCH_FORWARD_ENV);
			if (parsedForwardEnv !== null && typeof parsedForwardEnv === "object" && !Array.isArray(parsedForwardEnv)) {
				const keys: string[] = [];
				for (const key in parsedForwardEnv) keys.push(key);
				process.stdout.write(`  OMP_BENCH_FORWARD_ENV=${keys.join(",")} (values hidden)\n`);
			}
		}
		process.stdout.write(`\njob dir: ${jobDir}\nbench dir: ${benchDir}\n`);
		return { exitCode: 0, jobName, jobDir, benchDir, tarball, elapsedMs: 0, totals: null, reportPath: null };
	}

	// Pre-run cleanup of leftover Harbor resources, if requested.
	if ((cfg.cleanup || cfg.cleanupForce) && cfg.envType === "docker" && which("docker")) {
		runDockerCleanup(cfg.cleanupForce);
	}

	const gatewayForward = startVmnetGatewayForward(cfg);
	process.stdout.write(dim(`launching harbor → ${logPath}\n`));
	const logFd = fs.openSync(logPath, "a");
	const proc = Bun.spawn(["harbor", ...harborArgs], {
		env: harborEnv,
		stdout: logFd,
		stderr: logFd,
		stdin: "ignore",
	});

	const expected = cfg.resume
		? (readJobResult(jobDir)?.nTotal ?? Math.max(1, cfg.tasks * cfg.attempts * cfg.models.length))
		: Math.max(1, cfg.tasks * cfg.attempts * cfg.models.length);
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
		gatewayForward?.stop();
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
	const totals = aggregate(trials, readJobResult(jobDir), expected);
	const successPct = totals.done > 0 ? (totals.pass / totals.done) * 100 : 0;
	const elapsedMs = Date.now() - st.startMs;
	const reportPath = writeReport(st, benchDir, exitCode);
	process.stdout.write("\n");
	process.stdout.write(
		`${bold(`${st.cfg.dataset} complete`)} — ${green(`${totals.pass}/${totals.done} passed (${successPct.toFixed(1)}%)`)}\n`,
	);
	process.stdout.write(
		`fail ${totals.fail} · error ${totals.error} · spend ${fmtUsd(totals.costUsd)} · elapsed ${fmtDur(elapsedMs)}\n`,
	);
	process.stdout.write(
		`tokens: in ${fmtNum(totals.tokIn)} · out ${fmtNum(totals.tokOut)} · cache ${fmtNum(totals.tokCache)}\n`,
	);
	process.stdout.write(`${dim("report:")} ${reportPath}\n`);
	process.stdout.write(`${dim("logs:  ")} ${logPath}\n`);
	process.stdout.write(`${dim("trials:")} ${jobDir}\n`);
	if (exitCode !== 0) process.stdout.write(yellow(`harbor exited ${exitCode}; see harbor.log\n`));
	return { exitCode, jobName, jobDir, benchDir, tarball, elapsedMs, totals, reportPath };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === "cleanup") {
		if (!which("docker")) throw new Error("docker not found on PATH (required for cleanup).");
		runDockerCleanup(true);
		return;
	}
	let cfg = parseArgs(argv);
	if (cfg.resume) cfg = resolveResumeConfig(cfg);
	const exitCode = (await runBenchmark(cfg)).exitCode;
	process.exit(exitCode);
}

if (import.meta.main) {
	main().catch((err: unknown) => {
		if (isTTY) process.stdout.write(`${ESC}?25h${ESC}?1049l`);
		process.stderr.write(red(`\nerror: ${err instanceof Error ? err.message : String(err)}\n`));
		process.exit(1);
	});
}
