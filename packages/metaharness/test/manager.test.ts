import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { experimentDetail } from "../src/experiments";
import { ManagerServer, resolveArmLaunch } from "../src/server";
import { RunStore } from "../src/store";

/**
 * Contracts under test:
 *  - discover() backfills historical job dirs into run rows.
 *  - syncRun() mirrors trial outcomes (pass / error / running) and rollups.
 *  - REST API surfaces runs, trials, compact transcripts, and rejects bad launches.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metaharness-test-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeFixtureJob(jobsDir: string, jobName: string): void {
	const jobDir = path.join(jobsDir, jobName);
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "result.json"),
		JSON.stringify({
			n_total_trials: 3,
			stats: { n_running_trials: 1, n_pending_trials: 0 },
		}),
	);
	fs.writeFileSync(
		path.join(jobDir, "config.json"),
		JSON.stringify({
			dataset: "test-dataset@1.0",
			agents: [{ name: "omp", model_name: "anthropic/claude-opus-4-8" }],
		}),
	);
	const mkTrial = (name: string, body: Record<string, unknown> | null) => {
		const dir = path.join(jobDir, name, "agent");
		fs.mkdirSync(dir, { recursive: true });
		if (body) fs.writeFileSync(path.join(jobDir, name, "result.json"), JSON.stringify(body));
	};
	mkTrial("alpha__abc", {
		started_at: "2026-07-12T10:00:00",
		finished_at: "2026-07-12T10:05:00",
		verifier_result: { rewards: { reward: 1 } },
		agent_result: { cost_usd: 0.5, n_input_tokens: 100, n_output_tokens: 10, n_cache_tokens: 80 },
	});
	mkTrial("beta__def", {
		started_at: "2026-07-12T10:00:00",
		finished_at: "2026-07-12T10:02:00",
		exception_info: { exception_type: "AgentTimeoutError" },
		agent_result: { cost_usd: 0.2 },
	});
	mkTrial("gamma__ghi", null); // running: no result.json yet
	// transcript for alpha
	const transcript = [
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				model: "claude-opus-4-8",
				content: [
					{ type: "text", text: "Reading the file first." },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
				],
			},
		}),
		JSON.stringify({
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "file contents" }],
			},
		}),
	].join("\n");
	fs.writeFileSync(path.join(jobDir, "alpha__abc", "agent", "omp.txt"), transcript);
}

describe("RunStore", () => {
	it("discovers historical job dirs and mirrors trial state", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "job-a");
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		expect(store.discover()).toBe(1);
		const run = store.getRun("job-a");
		// No job-level finished_at + fresh dir + a running trial → still running.
		expect(run?.status).toBe("running");
		expect(run?.dataset).toBe("test-dataset@1.0");
		expect(run?.models).toBe("anthropic/claude-opus-4-8");
		expect(run?.nTotal).toBe(3);
		expect(run?.pass).toBe(1);
		expect(run?.error).toBe(1);
		expect(run?.running).toBe(1);
		expect(run?.costUsd).toBeCloseTo(0.7, 5);

		const traces = store.listTraces("job-a");
		expect(traces.map(t => [t.task, t.status])).toEqual([
			["alpha", "pass"],
			["beta", "error"],
			["gamma", "running"],
		]);
		expect(traces[1].detail).toBe("AgentTimeoutError");

		// re-discover is idempotent
		expect(store.discover()).toBe(0);
	});

	it("marks discovered runs complete when harbor recorded a terminal state", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "job-done");
		const jobDir = path.join(jobsDir, "job-done");
		fs.writeFileSync(
			path.join(jobDir, "result.json"),
			JSON.stringify({
				n_total_trials: 2,
				finished_at: "2026-07-12T11:00:00",
				stats: { n_running_trials: 0, n_pending_trials: 0 },
			}),
		);
		fs.rmSync(path.join(jobDir, "gamma__ghi"), { recursive: true, force: true });
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		store.discover();
		expect(store.getRun("job-done")?.status).toBe("complete");
		expect(store.getRun("job-done")?.finishedAt).not.toBeNull();
	});

	it("stores experiment goals and run roles/labels, and orders baselines first", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "exp-treat");
		writeFixtureJob(jobsDir, "exp-base");
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		store.discover();
		store.setExperimentGoal("exp", "does the treatment beat the baseline?");
		expect(store.setRunMeta("exp-base", { role: "baseline", note: "plain model" })).toBe(true);
		expect(store.setRunMeta("exp-treat", { role: "variant", note: "prewalk flash", label: "flash@edit" })).toBe(true);
		expect(store.setRunMeta("exp-missing", { role: "variant" })).toBe(false);

		const detail = experimentDetail(store, "exp");
		expect(detail?.goal).toBe("does the treatment beat the baseline?");
		// ArmSummary.arm resolves to the display label when one is set.
		expect(detail?.arms.map(a => [a.arm, a.run.role, a.run.note, a.run.label])).toEqual([
			["base", "baseline", "plain model", ""],
			["flash@edit", "variant", "prewalk flash", "flash@edit"],
		]);

		// Partial updates keep the omitted fields.
		expect(store.setRunMeta("exp-treat", { note: "prewalk flash v2" })).toBe(true);
		const treat = store.getRun("exp-treat");
		expect(treat?.label).toBe("flash@edit");
		expect(treat?.role).toBe("variant");
		expect(treat?.note).toBe("prewalk flash v2");
	});

	it("releases a dead runner's pid without failing a possibly-live orphan", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "job-b");
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		store.registerLaunch({
			benchmark: "harbor",
			jobName: "job-b",
			dataset: "test-dataset@1.0",
			agent: "omp",
			models: ["m"],
			pid: 999999999, // certainly dead
		});
		const rows = store.syncActive();
		expect(rows).toHaveLength(1);
		// The runner is only a monitor: its death must not fail the run while
		// the job dir is fresh (an orphaned harbor may still be writing trials).
		const row = store.getRun("job-b");
		expect(row?.pid).toBeNull();
		expect(row?.status).toBe("running");

		// Once harbor stamps the terminal marker, the same sweep completes it.
		const jobDir = path.join(jobsDir, "job-b");
		fs.writeFileSync(
			path.join(jobDir, "result.json"),
			JSON.stringify({
				n_total_trials: 3,
				stats: { n_running_trials: 0, n_pending_trials: 0 },
				finished_at: "2026-07-12T11:00:00",
			}),
		);
		store.syncActive();
		const finished = store.getRun("job-b");
		expect(finished?.status).toBe("complete");
		expect(finished?.finishedAt).toBe(Date.parse("2026-07-12T11:00:00"));
	});
});

describe("ManagerServer API", () => {
	it("serves uniform runs, traces, and rejects invalid launches", async () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "job-api");
		const manager = new ManagerServer(jobsDir);
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://localhost:${server.port}`;

		const runs = (await (await fetch(`${base}/api/runs`)).json()) as Array<{ jobName: string; pass: number }>;
		expect(runs.map(r => r.jobName)).toContain("job-api");

		const detailRes = await fetch(`${base}/api/runs/job-api`);
		expect(detailRes.status).toBe(200);
		const detail = (await detailRes.json()) as { run: { pass: number }; traces: Array<{ status: string }> };
		expect(detail.run.pass).toBe(1);
		expect(detail.traces).toHaveLength(3);

		const tr = await fetch(`${base}/api/runs/job-api/traces/alpha__abc?tail=10`);
		expect(tr.status).toBe(200);
		const trace = (await tr.json()) as { entries: Array<{ kind: string; tools?: string[] }> };
		expect(trace.entries.map(e => e.kind)).toEqual(["assistant", "toolResult"]);
		expect(trace.entries[0].tools).toEqual(["read"]);

		const missing = await fetch(`${base}/api/runs/nope`);
		expect(missing.status).toBe(404);

		const badLaunch = await fetch(`${base}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(badLaunch.status).toBe(400);

		const cancelUnknown = (await (await fetch(`${base}/api/runs/nope/cancel`, { method: "POST" })).json()) as {
			cancelled: boolean;
		};
		expect(cancelUnknown.cancelled).toBe(false);

		const deleteUnknown = await fetch(`${base}/api/runs/nope`, { method: "DELETE" });
		expect(deleteUnknown.status).toBe(404);
	});

	it("serves edit and SnapCompact metrics and native traces through one API", async () => {
		const jobsDir = makeJobsDir();
		const manager = new ManagerServer(jobsDir);
		for (const benchmark of ["edit", "snapcompact"] as const) {
			const jobName = `${benchmark}-arm`;
			manager.store.registerLaunch({
				benchmark,
				jobName,
				dataset: benchmark === "edit" ? "typescript-edit" : "squad-dev",
				agent: benchmark,
				models: ["test/model"],
				pid: process.pid,
			});
			manager.store.markExit(jobName, 0);
		}
		const editDir = path.join(jobsDir, "edit-arm");
		fs.writeFileSync(
			path.join(editDir, "result.json"),
			JSON.stringify({
				tasks: [
					{
						id: "rename",
						name: "Rename",
						runs: [{ runIndex: 0, success: true, duration: 10, tokens: { input: 8, output: 2, reasoning: 0 } }],
					},
				],
				summary: {
					totalRuns: 1,
					successfulRuns: 1,
					taskSuccessRate: 1,
					editSuccessRate: 1,
					totalTokens: { input: 8, output: 2 },
				},
			}),
		);
		fs.mkdirSync(path.join(editDir, "result.dump", "rename"), { recursive: true });
		fs.writeFileSync(path.join(editDir, "result.dump", "rename", "run-1.md"), "# conversation\n\nassistant answer");
		const snapDir = path.join(jobsDir, "snapcompact-arm");
		fs.writeFileSync(
			path.join(snapDir, "records.jsonl"),
			`${JSON.stringify({ cond: "text", chunk: 0, pos_rel: 0, q: "question", answer: "answer", golds: ["gold"], em: 0, f1: 0.5 })}\n`,
		);
		fs.writeFileSync(
			path.join(snapDir, "summary.json"),
			JSON.stringify({
				rows: [{ n: 1, f1: 0.5, em: 0, cost_usd: 0.1, tokens_in: 10, tokens_out: 2, cache_w: 0, cache_r: 0 }],
			}),
		);
		manager.store.syncAll();
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://localhost:${server.port}`;

		const edit = (await (await fetch(`${base}/api/runs/edit-arm`)).json()) as {
			run: { benchmark: string; metrics: Record<string, number> };
			traces: Array<{ name: string }>;
		};
		expect(edit.run).toMatchObject({ benchmark: "edit", metrics: { task_success_rate: 1, edit_success_rate: 1 } });
		const editTrace = (await (
			await fetch(`${base}/api/runs/edit-arm/traces/${encodeURIComponent(edit.traces[0].name)}`)
		).json()) as { entries: Array<{ kind: string; text: string }> };
		expect(editTrace.entries).toEqual([{ kind: "conversation", text: "# conversation\n\nassistant answer" }]);

		const snap = (await (await fetch(`${base}/api/runs/snapcompact-arm`)).json()) as {
			run: { benchmark: string; metrics: Record<string, number> };
			traces: Array<{ name: string }>;
		};
		expect(snap.run).toMatchObject({ benchmark: "snapcompact", metrics: { f1: 0.5, exact_match: 0 } });
		const snapTrace = (await (
			await fetch(`${base}/api/runs/snapcompact-arm/traces/${encodeURIComponent(snap.traces[0].name)}`)
		).json()) as { entries: Array<{ kind: string }> };
		expect(snapTrace.entries.map(entry => entry.kind)).toEqual(["question", "answer", "reference"]);
	});
	it("guards resume: unknown, non-harbor, running, and config-less runs are rejected", async () => {
		const jobsDir = makeJobsDir();
		const manager = new ManagerServer(jobsDir);
		manager.store.registerLaunch({
			benchmark: "edit",
			jobName: "edit-x",
			dataset: "typescript-edit",
			agent: "edit",
			models: ["m/x"],
			pid: process.pid,
		});
		manager.store.markExit("edit-x", 1);
		// A live harbor run: pid is this test process, never marked exited.
		manager.store.registerLaunch({
			benchmark: "harbor",
			jobName: "job-live",
			dataset: "terminal-bench@2.0",
			agent: "omp",
			models: ["m/x"],
			pid: process.pid,
		});
		// A failed harbor run whose job dir has no harbor config.json.
		manager.store.registerLaunch({
			benchmark: "harbor",
			jobName: "job-bare",
			dataset: "terminal-bench@2.0",
			agent: "omp",
			models: ["m/x"],
			pid: process.pid,
		});
		manager.store.markExit("job-bare", 1);
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://localhost:${server.port}`;
		const resumeError = async (name: string): Promise<string> => {
			const res = await fetch(`${base}/api/runs/${name}/resume`, { method: "POST" });
			expect(res.status).toBe(400);
			return ((await res.json()) as { error: string }).error;
		};

		expect(await resumeError("nope")).toMatch(/not found/);
		expect(await resumeError("edit-x")).toMatch(/only harbor/);
		expect(await resumeError("job-live")).toMatch(/already running/);
		expect(await resumeError("job-bare")).toMatch(/no harbor config.json/);
	});

	it("experiment CRUD: create is browsable, delete removes rows + job dirs, live arms are protected", async () => {
		const jobsDir = makeJobsDir();
		const manager = new ManagerServer(jobsDir);
		// Two finished arms of experiment `crud` and one live run in a different experiment.
		for (const jobName of ["crud-base", "crud-treat"]) {
			manager.store.registerLaunch({
				benchmark: "harbor",
				jobName,
				dataset: "terminal-bench@2.0",
				agent: "omp",
				models: ["m/x"],
				pid: process.pid,
			});
			manager.store.markExit(jobName, 0);
		}
		manager.store.registerLaunch({
			benchmark: "harbor",
			jobName: "live-run",
			dataset: "terminal-bench@2.0",
			agent: "omp",
			models: ["m/x"],
			pid: process.pid,
		});
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://localhost:${server.port}`;

		// Create: registered id is browsable before any run exists.
		const created = await fetch(`${base}/api/experiments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "fresh", goal: "does X beat Y?" }),
		});
		expect(created.status).toBe(201);
		const list = (await (await fetch(`${base}/api/experiments`)).json()) as Array<{
			id: string;
			goal: string;
			arms: number;
		}>;
		const fresh = list.find(e => e.id === "fresh");
		expect(fresh).toMatchObject({ goal: "does X beat Y?", arms: 0 });
		const freshDetail = (await (await fetch(`${base}/api/experiments/fresh`)).json()) as {
			goal: string;
			arms: unknown[];
		};
		expect(freshDetail).toMatchObject({ goal: "does X beat Y?", arms: [] });

		// Create: dashed / empty ids can never own a run — rejected.
		for (const id of ["bad-id", ""]) {
			const res = await fetch(`${base}/api/experiments`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id }),
			});
			expect(res.status).toBe(400);
		}

		// Browse: list filters.
		const filtered = (await (await fetch(`${base}/api/runs?experiment=crud`)).json()) as Array<{
			jobName: string;
		}>;
		expect(filtered.map(r => r.jobName).sort()).toEqual(["crud-base", "crud-treat"]);
		const running = (await (await fetch(`${base}/api/runs?status=running`)).json()) as Array<{
			jobName: string;
		}>;
		expect(running.map(r => r.jobName)).toEqual(["live-run"]);
		const q = (await (await fetch(`${base}/api/experiments?q=fresh`)).json()) as Array<{ id: string }>;
		expect(q.map(e => e.id)).toEqual(["fresh"]);

		// Delete run: live runs are protected, finished runs vanish from DB and disk.
		const liveDelete = await fetch(`${base}/api/runs/live-run`, { method: "DELETE" });
		expect(liveDelete.status).toBe(400);
		const runDelete = await fetch(`${base}/api/runs/crud-treat`, { method: "DELETE" });
		expect(runDelete.status).toBe(200);
		expect(fs.existsSync(path.join(jobsDir, "crud-treat"))).toBe(false);
		expect(manager.store.getRun("crud-treat")).toBeNull();

		// Delete experiment: remaining arm rows + dirs + goal row all go; 404 after.
		const expDelete = (await (await fetch(`${base}/api/experiments/crud`, { method: "DELETE" })).json()) as {
			deletedRuns: string[];
		};
		expect(expDelete.deletedRuns).toEqual(["crud-base"]);
		expect(fs.existsSync(path.join(jobsDir, "crud-base"))).toBe(false);
		expect((await fetch(`${base}/api/experiments/crud`)).status).toBe(404);
		expect((await fetch(`${base}/api/experiments/unknown`, { method: "DELETE" })).status).toBe(404);

		// Delete experiment with a live arm: refused, nothing removed.
		const liveExpDelete = await fetch(`${base}/api/experiments/live`, { method: "DELETE" });
		expect(liveExpDelete.status).toBe(400);
		expect(manager.store.getRun("live-run")).not.toBeNull();
	});
});

describe("resolveArmLaunch", () => {
	it("inherits dataset + exact task sample + scale from a sibling arm", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		store.registerLaunch({
			benchmark: "harbor",
			jobName: "exp-base",
			dataset: "swe-bench/swe-bench-verified",
			agent: "omp",
			models: ["anthropic/claude-opus-4-8"],
			pid: 4321,
			role: "baseline",
			config: {
				include: ["astropy__astropy-1", "django__django-2", "sympy__sympy-3"],
				tasks: 3,
				concurrency: 4,
				timeoutMultiplier: 2,
			},
		});

		const launch = resolveArmLaunch(store, "exp", {
			arm: "n8",
			model: "google/gemini-3.5-flash",
			role: "variant",
			note: "prewalk@flash",
			prewalk: { into: "google/gemini-3.5-flash" },
		});

		expect(launch.jobName).toBe("exp-n8");
		expect(launch.dataset).toBe("swe-bench/swe-bench-verified");
		expect(launch.include).toEqual(["astropy__astropy-1", "django__django-2", "sympy__sympy-3"]);
		expect(launch.tasks).toBe(3);
		expect(launch.concurrency).toBe(4);
		expect(launch.timeoutMultiplier).toBe(2);
		expect(launch.model).toBe("google/gemini-3.5-flash");
		expect(launch.role).toBe("variant");
		expect(launch.prewalk?.into).toBe("google/gemini-3.5-flash");
	});

	it("prefers the sibling with a recorded include list over newer include-less siblings", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		// Older sibling carries the authoritative sample…
		store.registerLaunch({
			benchmark: "harbor",
			jobName: "exp-base",
			dataset: "swe-bench/swe-bench-verified",
			agent: "omp",
			models: ["anthropic/claude-opus-4-8"],
			pid: 1,
			config: { include: ["swe-bench/astropy__astropy-1", "swe-bench/django__django-2"] },
		});
		// …while a newer arm (e.g. discovered from disk) recorded no include.
		store.registerLaunch({
			benchmark: "harbor",
			jobName: "exp-noinc",
			dataset: "swe-bench/swe-bench-verified",
			agent: "omp",
			models: ["anthropic/claude-opus-4-8"],
			pid: 2,
			config: {},
		});

		const launch = resolveArmLaunch(store, "exp", { arm: "next", model: "anthropic/claude-opus-4-8" });
		expect(launch.include).toEqual(["swe-bench/astropy__astropy-1", "swe-bench/django__django-2"]);
		expect(launch.tasks).toBe(2);
	});

	it("rejects a duplicate arm and an unknown experiment", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		store.registerLaunch({
			benchmark: "harbor",
			jobName: "exp-base",
			dataset: "d",
			agent: "omp",
			models: ["m/x"],
			pid: 1,
			config: { include: ["t1"] },
		});
		expect(() => resolveArmLaunch(store, "exp", { arm: "base", model: "m/y" })).toThrow(/already exists/);
		expect(() => resolveArmLaunch(store, "ghost", { arm: "x", model: "m/y" })).toThrow(/no runs to inherit/);
	});
});
