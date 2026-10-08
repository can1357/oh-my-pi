#!/usr/bin/env bun
/**
 * metaharness server: REST + SSE API over the run store, static web
 * dashboard, and a launcher that spawns the CLI runner as a managed child.
 *
 *   bun src/server.ts [--port 4700] [--jobs-dir <path>]
 *
 * API:
 *   GET    /api/experiments[?q=]          → experiment summaries across all benchmarks
 *   POST   /api/experiments               → register an experiment (id + goal) before its first arm
 *   GET    /api/experiments/:id           → experiment detail (arms, task matrix)
 *   PUT    /api/experiments/:id           → update goal + per-run role/note/label
 *   DELETE /api/experiments/:id           → delete all arms (rows + job dirs) and the goal row
 *   POST   /api/experiments/:id/arms      → launch a comparable arm
 *   GET    /api/runs[?experiment=&status=&benchmark=] → RunRow[]
 *   POST   /api/runs                      → launch any benchmark
 *   GET    /api/runs/:name                → { run, traces }
 *   POST   /api/runs/:name/cancel         → cancel a managed run
 *   POST   /api/runs/:name/resume         → resume an incomplete harbor run
 *   DELETE /api/runs/:name                → delete a finished run (row + job dir)
 *   GET    /api/runs/:name/traces/:trace  → normalized trace
 *   GET    /api/events                    → SSE: run-list snapshots on change
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Server, Subprocess } from "bun";
import { BENCHMARK_DEFINITIONS } from "./benchmarks";
import { buildExperiments, experimentDetail, experimentOf } from "./experiments";
import { harborRunnerArgs, type LaunchRequest } from "./launch-args";
import { type LaunchRecord, type RunRole, type RunRow, RunStore } from "./store";

/** PUT /api/experiments/:id body — goal and per-run role/note/label metadata. */
export interface ExperimentMetaUpdate {
	goal?: string;
	runs?: Record<string, { role?: RunRole; note?: string; label?: string }>;
}

/** POST /api/experiments body — pre-registers an experiment id with a goal. */
export interface CreateExperimentRequest {
	/** Dash-free token; runs group into it as `<id>-<arm>` job names. */
	id: string;
	goal?: string;
}

import indexHtml from "./web/index.html";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PKG_DIR = path.resolve(import.meta.dir, "..");
const DEFAULT_JOBS_DIR = path.join(REPO_ROOT, "runs", "harbor");

export type { LaunchRequest } from "./launch-args";

/** POST /api/experiments/:id/arms body — a new comparable arm; sample+config inherited. */
export interface AddArmRequest {
	/** Arm label; becomes the `<id>-<arm>` job name. */
	arm: string;
	model: string;
	prewalk?: LaunchRequest["prewalk"];
	/** Explicit task sample; skips sibling inheritance when provided. */
	include?: string[];
	role?: RunRole;
	note?: string;
	extraArgs?: string[];
}

interface ManagedChild {
	proc: Subprocess;
	jobName: string;
	cancelled: boolean;
}

const enum SseState {
	Open = 0,
	Closed = 1,
}

interface SseClient {
	controller: ReadableStreamDefaultController<Uint8Array>;
	state: SseState;
}

function parseServerArgs(argv: string[]): { port: number; jobsDir: string } {
	let port = 4700;
	let jobsDir = DEFAULT_JOBS_DIR;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--port" && argv[i + 1]) port = Number(argv[++i]);
		else if (argv[i] === "--jobs-dir" && argv[i + 1]) jobsDir = path.resolve(argv[++i]);
	}
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535");
	return { port, jobsDir };
}

/** Job names are single path segments; anything else could escape the jobs dir. */
function assertSafeJobName(jobName: string): void {
	if (!jobName || jobName === "." || jobName === ".." || /[/\\]/.test(jobName)) {
		throw new Error(`invalid job name: ${jobName}`);
	}
}

/** True when `pid` names a live process (signal-0 probe). */
function pidAlive(pid: number | null): boolean {
	if (pid == null) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve the launch request for a new arm added to an existing experiment.
 * Inherits the experiment's benchmark, dataset, and — crucially — the exact
 * task sample from a sibling arm (its recorded `include`, else its observed
 * trial tasks) so the arm is directly comparable. Only per-arm knobs (model,
 * prewalk, role, note, extra args) come from `req`. Throws if the experiment has
 * no runs to inherit from or the arm name is taken.
 */
export function resolveArmLaunch(store: RunStore, experimentId: string, req: AddArmRequest): LaunchRequest {
	if (!req.arm || /[^\w.-]/.test(req.arm)) throw new Error("arm must be a non-empty [A-Za-z0-9_.-] token");
	if (!req.model) throw new Error("model is required");
	const siblings = store.listRuns().filter(r => experimentOf(r.jobName) === experimentId);
	if (siblings.length === 0) throw new Error(`experiment '${experimentId}' has no runs to inherit from`);
	// Template = the sibling whose recorded `include` list is the longest (the
	// fullest expression of the experiment's sample — partial re-run arms
	// record subsets); among include-less siblings, the most observed trials.
	// listRuns is newest-first so ties keep the newest.
	const strings = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	const recordedInclude = (r: RunRow): string[] => strings((r.config as Partial<LaunchRequest>).include);
	const score = (r: RunRow): [number, number] => {
		const recorded = recordedInclude(r).length;
		return recorded > 0 ? [1, recorded] : [0, store.listTraces(r.jobName).length];
	};
	let template = siblings[0];
	let templateScore = score(template);
	for (const r of siblings.slice(1)) {
		const s = score(r);
		if (s[0] > templateScore[0] || (s[0] === templateScore[0] && s[1] > templateScore[1])) {
			[template, templateScore] = [r, s];
		}
	}
	const cfg = template.config as Partial<LaunchRequest>;
	const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
	const numberOr = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
	// Exact task sample: prefer the intended include list, else observed trial
	// tasks. Trial task names are stored bare, while org-prefixed datasets
	// (e.g. "swe-bench/swe-bench-verified") address tasks as "<org>/<task>" —
	// re-derive the prefix for the fallback.
	let include = req.include && req.include.length > 0 ? req.include : strings(cfg.include);
	if (include.length === 0) {
		const org = template.dataset.includes("/") ? `${template.dataset.split("/", 1)[0]}/` : "";
		include = [
			...new Set(
				store
					.listTraces(template.jobName)
					.map(t => t.task)
					.filter(Boolean)
					.map(task => (task.includes("/") ? task : `${org}${task}`)),
			),
		];
	}
	const jobName = `${experimentId}-${req.arm}`;
	if (store.getRun(jobName)) throw new Error(`arm '${req.arm}' already exists in '${experimentId}'`);
	const conditions = strings(cfg.conditions);
	return {
		benchmark: template.benchmark,
		model: req.model,
		dataset: template.dataset,
		include: include.length > 0 ? include : undefined,
		tasks: include.length > 0 ? include.length : numberOr(cfg.tasks),
		concurrency: numberOr(cfg.concurrency),
		timeoutMultiplier: numberOr(cfg.timeoutMultiplier),
		attempts: numberOr(cfg.attempts),
		agent: str(cfg.agent),
		webSearch: cfg.webSearch === true || undefined,
		prebuiltBinaries: cfg.prebuiltBinaries === true || undefined,
		conditions: conditions.length > 0 ? conditions : undefined,
		jobName,
		prewalk: req.prewalk,
		role: req.role,
		note: req.note,
		environment: cfg.environment === "docker" || cfg.environment === "apple-container" ? cfg.environment : undefined,
		extraArgs: req.extraArgs,
	};
}

export class ManagerServer {
	#store: RunStore;
	#children = new Map<string, ManagedChild>();
	#sse = new Set<SseClient>();
	#lastSnapshot = "";
	#syncTimer: Timer | undefined;
	#server: Server<undefined> | null = null;
	#stopped = false;
	readonly jobsDir: string;

	constructor(jobsDir: string, dbPath?: string) {
		this.jobsDir = jobsDir;
		this.#store = new RunStore(jobsDir, dbPath);
	}

	get store(): RunStore {
		return this.#store;
	}

	start(port: number): Server<undefined> {
		this.#store.discover();
		this.#store.syncAll();
		this.#syncTimer = setInterval(() => this.#tick(), 2000);
		this.#server = Bun.serve({
			port,
			idleTimeout: 0,
			// Bun bundles the dashboard (React + TSX) from the HTML import and
			// serves it on the same port as the API — one process, no Vite.
			routes: { "/": indexHtml },
			// Only `hmr`: the `console: true` mirror adds another dev-client
			// stream with the same teardown hazard (see isDevStreamTeardown)
			// for little value.
			development: process.env.NODE_ENV !== "production" && { hmr: true },
			fetch: request => this.#route(request),
		});
		return this.#server;
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		clearInterval(this.#syncTimer);
		for (const client of this.#sse) {
			client.state = SseState.Closed;
			try {
				client.controller.close();
			} catch {}
		}
		this.#sse.clear();
		this.#server?.stop(true);
		this.#store.close();
	}

	#tick(): void {
		this.#store.syncActive();
		const snapshot = JSON.stringify(this.#store.listRuns());
		if (snapshot !== this.#lastSnapshot) {
			this.#lastSnapshot = snapshot;
			this.#broadcast(`data: ${snapshot}\n\n`);
		}
	}

	#broadcast(frame: string): void {
		const bytes = new TextEncoder().encode(frame);
		for (const client of this.#sse) {
			if (client.state === SseState.Closed) continue;
			try {
				client.controller.enqueue(bytes);
			} catch {
				client.state = SseState.Closed;
				this.#sse.delete(client);
			}
		}
	}

	async #route(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const p = url.pathname;
		try {
			if (p === "/api/events") return this.#sseResponse();
			if (p === "/api/benchmarks" && request.method === "GET") {
				return Response.json(BENCHMARK_DEFINITIONS);
			}
			if (p === "/api/experiments" && request.method === "GET") {
				const q = url.searchParams.get("q")?.toLowerCase() ?? "";
				const experiments = buildExperiments(this.#store);
				return Response.json(
					q
						? experiments.filter(e => e.id.toLowerCase().includes(q) || e.goal.toLowerCase().includes(q))
						: experiments,
				);
			}
			if (p === "/api/experiments" && request.method === "POST") {
				const body = (await request.json()) as CreateExperimentRequest;
				return Response.json(this.createExperiment(body), { status: 201 });
			}
			const expMatch = p.match(/^\/api\/experiments\/([^/]+)$/);
			if (expMatch) {
				const id = decodeURIComponent(expMatch[1]);
				if (request.method === "PUT") {
					const body = (await request.json()) as ExperimentMetaUpdate;
					return Response.json(this.updateExperimentMeta(id, body));
				}
				if (request.method === "DELETE") {
					const result = this.deleteExperiment(id);
					if (!result) return Response.json({ error: "experiment not found" }, { status: 404 });
					return Response.json(result);
				}
				const detail = experimentDetail(this.#store, id);
				if (!detail) return Response.json({ error: "experiment not found" }, { status: 404 });
				return Response.json(detail);
			}
			const armMatch = p.match(/^\/api\/experiments\/([^/]+)\/arms$/);
			if (armMatch && request.method === "POST") {
				const id = decodeURIComponent(armMatch[1]);
				const body = (await request.json()) as AddArmRequest;
				return Response.json(this.addArm(id, body), { status: 201 });
			}
			if (p === "/api/runs" && request.method === "GET") {
				const experiment = url.searchParams.get("experiment");
				const status = url.searchParams.get("status");
				const benchmark = url.searchParams.get("benchmark");
				let runs = this.#store.listRuns();
				if (experiment) runs = runs.filter(r => experimentOf(r.jobName) === experiment);
				if (status) runs = runs.filter(r => r.status === status);
				if (benchmark) runs = runs.filter(r => r.benchmark === benchmark);
				return Response.json(runs);
			}
			if (p === "/api/runs" && request.method === "POST") {
				const body = (await request.json()) as LaunchRequest;
				return Response.json(this.launch(body), { status: 201 });
			}
			const resumeMatch = p.match(/^\/api\/runs\/([^/]+)\/resume$/);
			if (resumeMatch && request.method === "POST") {
				const jobName = decodeURIComponent(resumeMatch[1]);
				const body = (await request.json().catch(() => ({}))) as { filterErrorTypes?: string[] };
				return Response.json(this.resume(jobName, body), { status: 201 });
			}
			const cancelMatch = p.match(/^\/api\/runs\/([^/]+)\/cancel$/);
			if (cancelMatch && request.method === "POST") {
				return Response.json(this.cancel(decodeURIComponent(cancelMatch[1])));
			}
			const runMatch = p.match(/^\/api\/runs\/([^/]+)$/);
			if (runMatch) {
				const jobName = decodeURIComponent(runMatch[1]);
				if (request.method === "DELETE") {
					if (!this.deleteRun(jobName)) return Response.json({ error: "run not found" }, { status: 404 });
					return Response.json({ jobName, deleted: true });
				}
				const run = this.#store.syncRun(jobName);
				if (!run) return Response.json({ error: "run not found" }, { status: 404 });
				return Response.json({ run, traces: this.#store.listTraces(jobName) });
			}
			const traceMatch = p.match(/^\/api\/runs\/([^/]+)\/traces\/([^/]+)$/);
			if (traceMatch) {
				const jobName = decodeURIComponent(traceMatch[1]);
				const trace = decodeURIComponent(traceMatch[2]);
				const tail = Number(url.searchParams.get("tail") ?? "120");
				const raw = url.searchParams.get("raw") === "1";
				return this.#trace(jobName, trace, tail, raw);
			}
			return Response.json({ error: "not found" }, { status: 404 });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return Response.json({ error: message }, { status: 400 });
		}
	}

	#sseResponse(): Response {
		let client: SseClient;
		const sse = this.#sse;
		const initial = `data: ${JSON.stringify(this.#store.listRuns())}\n\n`;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				client = { controller, state: SseState.Open };
				sse.add(client);
				controller.enqueue(new TextEncoder().encode(initial));
			},
			cancel() {
				client.state = SseState.Closed;
				sse.delete(client);
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	}

	/** Launch any supported benchmark and register it in the uniform run store. */
	launch(request: LaunchRequest): { jobName: string; pid: number } {
		if (!request.model) throw new Error("model is required");
		const benchmark = request.benchmark ?? "harbor";
		if (benchmark !== "harbor" && benchmark !== "edit" && benchmark !== "snapcompact") {
			throw new Error(`unsupported benchmark: ${benchmark}`);
		}
		const dataset =
			request.dataset ??
			(benchmark === "harbor" ? "terminal-bench@2.0" : benchmark === "edit" ? "typescript-edit" : "squad-dev");
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const modelSlug = request.model.replace(/[^a-zA-Z0-9]+/g, "-");
		const jobName = request.jobName ?? `${modelSlug}-${stamp}`;
		if (this.#children.has(jobName) || this.#store.getRun(jobName)?.status === "running") {
			throw new Error(`run ${jobName} is already running`);
		}
		const jobDir = path.join(this.jobsDir, jobName);
		fs.mkdirSync(jobDir, { recursive: true });

		let argv: string[];
		let cwd: string;
		if (benchmark === "edit") {
			cwd = PKG_DIR;
			argv = ["bun", "adapters/edit/cli.ts", "--model", request.model, "--output", path.join(jobDir, "result.json")];
			if (request.tasks !== undefined) argv.push("--max-tasks", String(request.tasks));
			if (request.include?.length) argv.push("--tasks", request.include.join(","));
			if (request.concurrency !== undefined) argv.push("--task-concurrency", String(request.concurrency));
			if (request.attempts !== undefined) argv.push("--runs", String(request.attempts));
		} else if (benchmark === "snapcompact") {
			cwd = PKG_DIR;
			argv = ["uv", "run", "src/adapters/snapcompact.py", "--model", request.model, "--output-dir", jobDir];
			if (request.tasks !== undefined) argv.push("--limit-paras", String(request.tasks));
			if (request.concurrency !== undefined) argv.push("--workers", String(request.concurrency));
			if (request.conditions?.length) argv.push("--conditions", request.conditions.join(","));
		} else {
			cwd = PKG_DIR;
			argv = ["bun", "src/runner.ts", ...harborRunnerArgs(request, { jobsDir: this.jobsDir, jobName, dataset })];
		}
		if (benchmark !== "harbor") argv.push(...(request.extraArgs ?? []));

		const pid = this.#spawnRunner(argv, cwd, {
			benchmark,
			jobName,
			dataset,
			agent: request.agent ?? "omp",
			models: [request.model],
			prewalk: request.prewalk,
			config: { ...request },
			role: request.role,
			note: request.note,
		});
		if (request.goal) this.#store.setExperimentGoal(experimentOf(jobName), request.goal);
		return { jobName, pid };
	}

	/**
	 * Resume a harbor run in place via the runner's `--resume`: completed
	 * trials (and their spend) are reused, interrupted/pending trials re-run,
	 * and errored trials are evicted for retry. The runner recovers the
	 * original launch flags from the run's recorded config, so nothing needs
	 * re-specifying. `filterErrorTypes` overrides the default retry set
	 * (every exception type recorded in the job's result.json).
	 */
	resume(jobName: string, opts: { filterErrorTypes?: string[] } = {}): { jobName: string; pid: number } {
		const run = this.#store.getRun(jobName);
		if (!run) throw new Error(`run ${jobName} not found`);
		if (run.benchmark !== "harbor")
			throw new Error(`resume supports only harbor runs (${jobName} is ${run.benchmark})`);
		// Trust liveness, not the recorded status: a runner killed while a
		// previous server instance owned it leaves a stale `running` row with a
		// dead (or null) pid and nobody to fire markExit.
		if (this.#runLive(run)) {
			throw new Error(`run ${jobName} is already running`);
		}
		if (run.status === "running") this.#store.markExit(jobName, null, true);
		const jobDir = path.join(this.jobsDir, jobName);
		if (!fs.existsSync(path.join(jobDir, "config.json"))) {
			throw new Error(`${jobName} has no harbor config.json to resume from`);
		}
		const argv = ["bun", "src/runner.ts", "--resume", jobName, "--jobs-dir", this.jobsDir];
		for (const t of opts.filterErrorTypes ?? erroredExceptionTypes(jobDir)) argv.push("--filter-error-type", t);
		let prewalk: LaunchRequest["prewalk"];
		try {
			prewalk = run.prewalk ? (JSON.parse(run.prewalk) as { into?: string }) : undefined;
		} catch {
			prewalk = undefined;
		}
		const pid = this.#spawnRunner(argv, PKG_DIR, {
			benchmark: "harbor",
			jobName,
			dataset: run.dataset,
			agent: run.agent,
			models: run.models ? run.models.split(",") : [],
			prewalk,
			config: run.config,
			role: run.role,
			note: run.note,
		});
		return { jobName, pid };
	}

	/** Spawn a detached runner child, wire its exit back into the store, and register the run. */
	#spawnRunner(argv: string[], cwd: string, record: Omit<LaunchRecord, "pid">): number {
		const jobName = record.jobName;
		const logDir = path.join(this.jobsDir, "_manager", "logs");
		fs.mkdirSync(logDir, { recursive: true });
		const logFile = fs.openSync(path.join(logDir, `${jobName}.log`), "w");
		const proc = Bun.spawn(argv, {
			cwd,
			stdout: logFile,
			stderr: logFile,
			env: { ...process.env },
			// Own process group: a manager restart (Ctrl+C / --hot dev cycle) must
			// not deliver terminal signals to runners — that killed live runs.
			detached: true,
		});
		const child: ManagedChild = { proc, jobName, cancelled: false };
		this.#children.set(jobName, child);
		proc.exited.then(exitCode => {
			try {
				fs.closeSync(logFile);
			} catch {}
			// A retired instance (--hot reload) must not touch the closed store;
			// the successor's pid sweep reconciles this run from disk instead.
			if (this.#stopped) return;
			this.#store.markExit(jobName, exitCode, child.cancelled);
			// Final sync AFTER the terminal state: the ticker only revisits
			// running rows, so the last-2s trial results would otherwise be lost.
			this.#store.syncRun(jobName);
			this.#children.delete(jobName);
			this.#tick();
		});
		this.#store.registerLaunch({ ...record, pid: proc.pid });
		this.#tick();
		return proc.pid;
	}

	/** Liveness check that survives manager restarts: managed child, or a running row with a live pid. */
	#runLive(run: RunRow): boolean {
		return this.#children.has(run.jobName) || (run.status === "running" && pidAlive(run.pid));
	}

	/** Register an experiment id (with an optional goal) so it is browsable before its first arm. */
	createExperiment(req: CreateExperimentRequest): { id: string; goal: string } {
		const id = req.id?.trim() ?? "";
		// Dashes are structurally impossible: `experimentOf` groups job names by
		// the token before the first dash, so a dashed id could never own a run.
		if (!/^[A-Za-z0-9_.]+$/.test(id)) {
			throw new Error("experiment id must be a non-empty token of [A-Za-z0-9_.] (runs group as `<id>-<arm>`)");
		}
		const goal = req.goal ?? this.#store.getExperimentMeta(id)?.goal ?? "";
		this.#store.setExperimentGoal(id, goal);
		return { id, goal };
	}

	/** Apply goal + per-run role/note metadata; used by the UI and for backfill. */
	updateExperimentMeta(id: string, update: ExperimentMetaUpdate): { id: string; updatedRuns: string[] } {
		if (update.goal !== undefined) this.#store.setExperimentGoal(id, update.goal);
		const updatedRuns: string[] = [];
		for (const jobName in update.runs) {
			if (experimentOf(jobName) !== id) continue;
			if (this.#store.setRunMeta(jobName, update.runs[jobName])) updatedRuns.push(jobName);
		}
		this.#tick();
		return { id, updatedRuns };
	}

	/**
	 * Delete an experiment: every arm's DB row, job dir, and manager log, plus
	 * the goal row. Refuses while any arm is live (cancel first — deleting a
	 * job dir under a writing runner would corrupt it). Returns null when the
	 * id names neither runs nor a registered experiment.
	 */
	deleteExperiment(id: string): { id: string; deletedRuns: string[] } | null {
		const runs = this.#store.listRuns().filter(r => experimentOf(r.jobName) === id);
		if (runs.length === 0 && !this.#store.getExperimentMeta(id)) return null;
		const live = runs.filter(r => this.#runLive(r));
		if (live.length > 0) {
			throw new Error(
				`experiment ${id} has running arms (${live.map(r => r.jobName).join(", ")}); cancel them first`,
			);
		}
		for (const run of runs) this.#destroyRun(run.jobName);
		this.#store.deleteExperimentMeta(id);
		this.#tick();
		return { id, deletedRuns: runs.map(r => r.jobName) };
	}

	/**
	 * Permanently delete a run: DB row + trials, job dir, and manager log.
	 * Disk removal is not optional — discover() would resurrect a surviving
	 * job dir as a fresh row on the next restart. Refuses while the run is
	 * live; returns false when the run is unknown.
	 */
	deleteRun(jobName: string): boolean {
		const run = this.#store.getRun(jobName);
		if (!run) return false;
		if (this.#runLive(run)) throw new Error(`run ${jobName} is running; cancel it first`);
		this.#destroyRun(jobName);
		this.#tick();
		return true;
	}

	/** Remove a run's DB rows and on-disk artifacts (job dir + manager log). */
	#destroyRun(jobName: string): void {
		assertSafeJobName(jobName);
		this.#store.deleteRun(jobName);
		fs.rmSync(path.join(this.jobsDir, jobName), { recursive: true, force: true });
		fs.rmSync(path.join(this.jobsDir, "_manager", "logs", `${jobName}.log`), { force: true });
	}

	/** Add a comparable arm to an existing experiment, inheriting its sample + config. */
	addArm(experimentId: string, req: AddArmRequest): { jobName: string; pid: number } {
		return this.launch(resolveArmLaunch(this.#store, experimentId, req));
	}

	/** Cancel a managed run. SIGTERM first so the runner forwards the signal to
	 *  its harbor child (SIGKILL is untrappable — it used to orphan the harbor
	 *  process, which kept running trials into the job dir); escalates to
	 *  SIGKILL after a grace window. */
	cancel(jobName: string): { jobName: string; cancelled: boolean } {
		const child = this.#children.get(jobName);
		if (child) {
			child.cancelled = true;
			child.proc.kill("SIGTERM");
			const escalate = setTimeout(() => {
				try {
					child.proc.kill(9);
				} catch {}
			}, 5000);
			child.proc.exited.then(() => clearTimeout(escalate));
			return { jobName, cancelled: true };
		}
		const run = this.#store.getRun(jobName);
		if (run?.pid != null) {
			const pid = run.pid;
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
			setTimeout(() => {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}, 5000);
			this.#store.markExit(jobName, null, true);
			return { jobName, cancelled: true };
		}
		return { jobName, cancelled: false };
	}

	/** Return a normalized trace regardless of the benchmark's native artifact format. */
	#trace(jobName: string, traceName: string, tail: number, raw: boolean): Response {
		const trace = this.#store.listTraces(jobName).find(item => item.name === traceName);
		if (!trace?.tracePath) return Response.json({ error: "trace not found" }, { status: 404 });
		const jobDir = path.join(this.jobsDir, jobName);
		const n = Number.isSafeInteger(tail) && tail > 0 ? Math.min(tail, 2000) : 120;
		if (trace.tracePath.startsWith("record:")) {
			const lineNumber = Number(trace.tracePath.slice("record:".length));
			const line = fs.readFileSync(path.join(jobDir, "records.jsonl"), "utf8").split("\n")[lineNumber - 1];
			if (!line) return Response.json({ error: "trace not found" }, { status: 404 });
			if (raw) return new Response(line, { headers: { "content-type": "application/json" } });
			const record = JSON.parse(line) as Record<string, unknown>;
			return Response.json({
				jobName,
				trace: traceName,
				entries: [
					{ kind: "question", text: String(record.q ?? "") },
					{ kind: "answer", model: this.#store.getRun(jobName)?.models ?? "", text: String(record.answer ?? "") },
					{ kind: "reference", text: JSON.stringify(record.golds ?? []) },
				],
				totalEvents: 3,
			});
		}
		const file = path.resolve(jobDir, trace.tracePath);
		if (!file.startsWith(`${path.resolve(jobDir)}${path.sep}`) || !fs.existsSync(file)) {
			return Response.json({ error: "trace not found" }, { status: 404 });
		}
		const text = readTextTail(file, TRACE_READ_CAP_BYTES);
		if (!file.endsWith(".txt")) {
			if (raw) return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
			return Response.json({
				jobName,
				trace: traceName,
				entries: [{ kind: "conversation", text }],
				totalEvents: 1,
			});
		}
		const lines = text.split("\n").filter(Boolean);
		if (raw) {
			return new Response(lines.slice(-n).join("\n"), {
				headers: { "content-type": "application/x-ndjson" },
			});
		}
		const entries: Array<Record<string, unknown>> = [];
		for (const line of lines) {
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (event.type === "message_end") {
				const message = event.message as Record<string, unknown> | undefined;
				if (!message) continue;
				const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
				const body = content
					.filter(block => block.type === "text")
					.map(block => String(block.text ?? ""))
					.join("\n");
				if (message.role === "assistant") {
					const tools = content.filter(block => block.type === "toolCall").map(block => String(block.name ?? "?"));
					entries.push({ kind: "assistant", model: message.model ?? "", text: body, tools });
				} else if (message.role === "toolResult") {
					entries.push({
						kind: "toolResult",
						tool: message.toolName ?? "?",
						isError: message.isError === true,
						text: body.length > 1600 ? `${body.slice(0, 1600)}…` : body,
					});
				}
			} else if (event.type === "notice") {
				entries.push({ kind: "notice", text: event.message ?? "" });
			}
		}
		return Response.json({ jobName, trace: traceName, entries: entries.slice(-n), totalEvents: lines.length });
	}
}
/**
 * Exception types recorded in a job's result.json — the errored trials a
 * resume retries by default (reward-0 fails are completed results and stay).
 */
function erroredExceptionTypes(jobDir: string): string[] {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(jobDir, "result.json"), "utf8")) as {
			stats?: { evals?: Record<string, { exception_stats?: Record<string, unknown> }> };
		};
		const types = new Set<string>();
		for (const ev of Object.values(raw.stats?.evals ?? {})) {
			for (const t of Object.keys(ev.exception_stats ?? {})) types.add(t);
		}
		return [...types];
	} catch {
		return [];
	}
}

/** Trace files can be runaway-huge; the viewer only shows a tail anyway. */
const TRACE_READ_CAP_BYTES = 32 * 1024 * 1024;

/** Last `cap` bytes of a file as text, dropping a leading partial line when truncated. */
function readTextTail(file: string, cap: number): string {
	const size = fs.statSync(file).size;
	if (size <= cap) return fs.readFileSync(file, "utf8");
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.allocUnsafe(cap);
		const read = fs.readSync(fd, buf, 0, cap, size - cap);
		const text = buf.subarray(0, read).toString("utf8");
		const nl = text.indexOf("\n");
		return nl === -1 ? text : text.slice(nl + 1);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Bun's dev server (HMR websocket, browser error reports, console mirror)
 * reads client streams that a tab disconnect or `--hot` reload tears down
 * mid-read. The resulting `AbortError: ERR_STREAM_RELEASE_LOCK` surfaces as
 * an unhandled rejection from Bun internals — fatal by default, which would
 * kill the manager and orphan every running benchmark job.
 */
function isDevStreamTeardown(err: unknown): boolean {
	return err instanceof Error && (err as Error & { code?: string }).code === "ERR_STREAM_RELEASE_LOCK";
}

if (import.meta.main) {
	// `bun --hot` re-evaluates this module in-place: retire the previous
	// instance first, or its sync ticker and sqlite connection leak per reload.
	const host = globalThis as typeof globalThis & {
		__metaharnessServer?: ManagerServer;
		__metaharnessHooks?: boolean;
	};
	await host.__metaharnessServer?.stop();
	const { port, jobsDir } = parseServerArgs(process.argv.slice(2));
	const manager = new ManagerServer(jobsDir);
	host.__metaharnessServer = manager;
	const server = manager.start(port);
	process.stdout.write(`metaharness listening on http://localhost:${server.port} (jobs: ${jobsDir})\n`);
	// Process-wide hooks register once; `--hot` re-evals reuse them via `host`.
	if (!host.__metaharnessHooks) {
		host.__metaharnessHooks = true;
		const shutdown = async () => {
			await host.__metaharnessServer?.stop();
			process.exit(0);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
		process.on("unhandledRejection", err => {
			if (isDevStreamTeardown(err)) {
				process.stderr.write("ignored dev-server stream teardown (ERR_STREAM_RELEASE_LOCK)\n");
				return;
			}
			throw err; // preserve fail-fast for real bugs
		});
	}
}
