#!/usr/bin/env bun
/**
 * Resident Decider dogfood via z0int.bridge.worker (one process, many decisions).
 *
 * bun evals/rlm/shadow-resident-dogfood.ts
 *
 * Env:
 *   OMP_Z0INT_PYTHON=/home/kvn/tmp/openjev/.venv/bin/python
 *   Z0INT_ROOT=/home/kvn/tmp/openjev
 *   Z0INT_DECIDER_DEVICE=cuda
 *   OMP_SHADOW_RESIDENT_N=8
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildWorkerNeededDecisionRequest,
	buildWorkerNeededFeatureState,
	createBridgeDeciderPredictor,
	registerZ0intBridgeTransport,
	SHADOW_BACKEND_ID,
} from "../../src/rlm/shadow";
import { createTokenomicsBridge } from "../../src/rlm/tokenomics-bridge";
import { classifyGrantComplexity } from "../../src/rlm/worker-mode-policy";

type Jsonish = Record<string, unknown>;

const Z0_ROOT = process.env.Z0INT_ROOT || "/home/kvn/tmp/openjev";
const Z0_PY = process.env.OMP_Z0INT_PYTHON || join(Z0_ROOT, ".venv/bin/python");
const N = Math.max(1, Number(process.env.OMP_SHADOW_RESIDENT_N || 8));

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
	return sorted[idx]!;
}

async function startBridgeWorker(): Promise<{
	child: ChildProcess;
	request: (body: Jsonish, timeoutMs?: number) => Promise<Jsonish>;
	stop: () => Promise<void>;
	generation: number;
	buildId: string;
	instanceId: string;
}> {
	const child = spawn(Z0_PY, ["-u", "-m", "z0int.bridge.worker", "--generation", "1"], {
		cwd: Z0_ROOT,
		env: {
			...process.env,
			Z0INT_ROOT: Z0_ROOT,
			PYTHONPATH: join(Z0_ROOT, "src") + (process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ""),
			Z0INT_BRIDGE_GENERATION: "1",
			Z0INT_DECIDER_DEVICE: process.env.Z0INT_DECIDER_DEVICE || "cuda",
			Z0INT_DECIDER_USE_GRAPHS: process.env.Z0INT_DECIDER_USE_GRAPHS || "0",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pending = new Map<
		string,
		{ resolve: (v: Jsonish) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	const lines = createInterface({ input: child.stdout! });
	lines.on("line", line => {
		let msg: Jsonish;
		try {
			msg = JSON.parse(line) as Jsonish;
		} catch {
			return;
		}
		const id = typeof msg.id === "string" ? msg.id : "";
		const p = id ? pending.get(id) : undefined;
		if (!p) return;
		pending.delete(id);
		clearTimeout(p.timer);
		p.resolve(msg);
	});
	child.stderr?.on("data", chunk => {
		const s = String(chunk);
		if (process.env.OMP_SHADOW_DEBUG) process.stderr.write(s);
	});

	const request = (body: Jsonish, timeoutMs = 45_000) =>
		new Promise<Jsonish>((resolve, reject) => {
			const id = randomUUID();
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`timeout op=${body.op}`));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			child.stdin!.write(JSON.stringify({ id, bridge_generation: 1, ...body }) + "\n");
		});

	const hello = await request({ op: "hello" }, 20_000);
	if (hello.ok !== true) throw new Error(`hello failed: ${JSON.stringify(hello)}`);
	const check = await request({ op: "self_check" }, 20_000);
	if (check.ok !== true) throw new Error(`self_check failed: ${JSON.stringify(check)}`);

	return {
		child,
		request,
		generation: typeof hello.generation === "number" ? hello.generation : 1,
		buildId: String(hello.build_id || ""),
		instanceId: String(hello.instance_id || ""),
		stop: async () => {
			try {
				await request({ op: "drain" }, 3000);
			} catch {
				/* */
			}
			try {
				await request({ op: "shutdown" }, 3000);
			} catch {
				/* */
			}
			try {
				child.kill("SIGTERM");
			} catch {
				/* */
			}
		},
	};
}

const CASES = [
	{
		id: "native_sufficient",
		grantedBytes: 8192,
		grantCount: 1,
		patternCount: 1,
		patterns: ["root_cause"],
		question: "exact root_cause token",
	},
	{
		id: "worker_required",
		grantedBytes: 512,
		grantCount: 3,
		patternCount: 2,
		patterns: ["max_connections", "pool_limit"],
		question: "reconcile conflicting pool limits",
	},
	{
		id: "dense_log",
		grantedBytes: 4200,
		grantCount: 2,
		patternCount: 2,
		patterns: ["ERROR", "timeout"],
		question: "diagnose checkout timeout cascade",
	},
	{
		id: "unknown_boundary",
		grantedBytes: 2048,
		grantCount: 1,
		patternCount: 1,
		patterns: ["maybe"],
		question: "ambiguous worker boundary",
	},
];

async function waitReady(request: (body: Jsonish, timeoutMs?: number) => Promise<Jsonish>, timeoutMs = 180_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const st = await request({ op: "status" }, 5_000);
		const backends = (st.decision_backends || {}) as Record<string, { state?: string; load_ms?: number }>;
		const slot = backends[SHADOW_BACKEND_ID];
		if (slot?.state === "ready") return { loadMs: slot.load_ms ?? null, waitMs: Date.now() - t0 };
		if (slot?.state === "failed") throw new Error(`warm failed: ${JSON.stringify(slot)}`);
		await Bun.sleep(500);
	}
	throw new Error("warm timeout");
}

async function main(): Promise<void> {
	const outDir = join(import.meta.dir, "results");
	mkdirSync(outDir, { recursive: true });

	const bridgeStart = performance.now();
	const worker = await startBridgeWorker();
	const bridgeStartupMs = performance.now() - bridgeStart;

	registerZ0intBridgeTransport({
		kind: "z0int-bridge",
		generation: worker.generation,
		buildId: worker.buildId,
		instanceId: worker.instanceId,
		request: worker.request,
		warm: backend => worker.request({ op: "decision_warm", payload: { backend } }, 5_000),
	});

	const warmKick = performance.now();
	await worker.request({ op: "decision_warm", payload: { backend: SHADOW_BACKEND_ID } }, 5_000);
	// status must remain observational during warm
	const midStatus = await worker.request({ op: "status" }, 5_000);
	const ready = await waitReady(worker.request);
	const warmWallMs = performance.now() - warmKick;

	const predictor = createBridgeDeciderPredictor();
	const tokenomics = createTokenomicsBridge({
		sessionId: `shadow-resident-${Date.now()}`,
		dir: outDir,
		enabled: true,
		contextPolicy: "rlm-search-grants",
		experimentId: "omp-shadow-rlm-worker-needed-v1",
	});

	const inference: number[] = [];
	const ipc: number[] = [];
	const queue: number[] = [];
	const total: number[] = [];
	let timeouts = 0;
	let failures = 0;
	let warming = 0;
	let oks = 0;

	for (let i = 0; i < N; i++) {
		const c = CASES[i % CASES.length]!;
		const policyInput = {
			grantedBytes: c.grantedBytes,
			grantCount: c.grantCount,
			patternCount: c.patternCount,
			patterns: c.patterns,
			question: c.question,
		};
		const { complexity } = classifyGrantComplexity(policyInput);
		const state = buildWorkerNeededFeatureState({ policyInput, complexity });
		const request = buildWorkerNeededDecisionRequest(state);
		const t0 = performance.now();
		const pred = await predictor(request, { timeoutMs: 2_000 });
		const wall = performance.now() - t0;
		total.push(wall);
		if (pred.runtime?.inferenceMs !== undefined) inference.push(pred.runtime.inferenceMs);
		if (pred.runtime?.ipcMs !== undefined) ipc.push(pred.runtime.ipcMs);
		if (pred.runtime?.queueMs !== undefined) queue.push(pred.runtime.queueMs);
		if (pred.status === "ok") oks += 1;
		else if (pred.status === "cancelled") timeouts += 1;
		else if (pred.status === "warming") warming += 1;
		else failures += 1;

		await tokenomics.emitShadowWorkerNeeded({
			pairId: `dogfood-${i}`,
			taskSnapshotId: c.id,
			armId: SHADOW_BACKEND_ID,
			treatmentHash: "resident-dogfood",
			status: pred.status === "ok" ? "ok" : pred.status === "cancelled" ? "cancelled" : "unknown",
			prediction: pred.prediction,
			probabilities: pred.probabilities,
			confidence: pred.confidence,
			abstained: pred.abstained,
			latencyMs: pred.latencyMs,
			revision: pred.revision,
			actualPolicy: "native",
			featureSchema: request.schema,
			grantedBytes: state.granted_bytes,
			complexityClass: state.complexity_class,
			errorClass: pred.errorClass,
			reason: pred.reason,
			runtime: pred.runtime,
		});

		console.log(
			JSON.stringify({
				i,
				id: c.id,
				status: pred.status,
				pred: pred.prediction,
				inferenceMs: pred.runtime?.inferenceMs,
				queueMs: pred.runtime?.queueMs,
				ipcMs: pred.runtime?.ipcMs,
				wallMs: Number(wall.toFixed(2)),
			}),
		);
	}

	const sort = (xs: number[]) => [...xs].sort((a, b) => a - b);
	const summary = {
		schema: "omp.shadow.worker_needed.resident_dogfood.v1",
		n: N,
		oks,
		timeouts,
		failures,
		warming,
		bridge_startup_ms: Number(bridgeStartupMs.toFixed(1)),
		decision_warm_kick_to_ready_ms: Number(warmWallMs.toFixed(1)),
		backend_load_ms: ready.loadMs,
		mid_status_during_warm: (midStatus.decision_backends as Record<string, { state?: string }>)?.[
			SHADOW_BACKEND_ID
		]?.state,
		warm_inference_ms_p50: percentile(sort(inference), 0.5),
		warm_inference_ms_p95: percentile(sort(inference), 0.95),
		ipc_ms_p50: percentile(sort(ipc), 0.5),
		ipc_ms_p95: percentile(sort(ipc), 0.95),
		queue_ms_p50: percentile(sort(queue), 0.5),
		queue_ms_p95: percentile(sort(queue), 0.95),
		total_shadow_ms_p50: percentile(sort(total), 0.5),
		total_shadow_ms_p95: percentile(sort(total), 0.95),
		critical_path_overhead_ms: 0,
		note: "Production launchShadowWorkerNeeded is fire-and-forget; this harness awaits for measurement.",
		bridge_generation: worker.generation,
		bridge_build_id: worker.buildId,
		trace_id: tokenomics.traceId,
		events: tokenomics.events.length,
	};
	const path = join(outDir, "shadow-resident-dogfood.json");
	writeFileSync(path, JSON.stringify(summary, null, 2) + "\n");
	console.log(JSON.stringify(summary, null, 2));
	console.log(`wrote ${path}`);
	await worker.stop();
	registerZ0intBridgeTransport(null);
}

await main();
