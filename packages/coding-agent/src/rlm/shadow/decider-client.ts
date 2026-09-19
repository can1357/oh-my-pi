/**
 * Pluggable Decider-2B client for observe-only shadow predictions.
 *
 * Default adapter shells out to `z0int backends eval` (fail-open).
 * Tests inject a mock predictor — never invents Decider-looking answers on failure.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerNeededDecisionRequest, WorkerNeededLabel } from "./worker-needed-features";
import { SHADOW_BACKEND_ID, WORKER_NEEDED_QUESTION } from "./worker-needed-features";

export interface ShadowPrediction {
	status: "ok" | "error" | "cancelled" | "unavailable";
	prediction?: WorkerNeededLabel;
	probabilities?: Record<string, number>;
	confidence?: number;
	abstained?: boolean;
	latencyMs: number;
	revision?: string;
	device?: string;
	errorClass?: string;
	reason?: string;
	backendId: string;
}

export type ShadowPredictor = (
	request: WorkerNeededDecisionRequest,
	options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<ShadowPrediction>;

function asLabel(value: unknown): WorkerNeededLabel | undefined {
	if (value === "native" || value === "worker" || value === "abstain") return value;
	return undefined;
}

function parseZ0intEvalPayload(raw: unknown, latencyMs: number): ShadowPrediction {
	const obj = raw as {
		answers?: Array<{ value?: unknown; probabilities?: Record<string, number>; confidence?: number }>;
		diagnostics?: { revision?: string; device?: string };
	};
	const ans = obj.answers?.[0];
	const prediction = asLabel(ans?.value);
	if (!prediction) {
		return {
			status: "error",
			latencyMs,
			backendId: SHADOW_BACKEND_ID,
			errorClass: "MalformedResult",
			reason: "decider returned no choice label",
		};
	}
	const probabilities = ans?.probabilities ?? {};
	return {
		status: "ok",
		prediction,
		probabilities,
		confidence: typeof ans?.confidence === "number" ? ans.confidence : probabilities[prediction],
		abstained: prediction === "abstain",
		latencyMs,
		revision: obj.diagnostics?.revision,
		device: obj.diagnostics?.device,
		backendId: SHADOW_BACKEND_ID,
	};
}

function toZ0intRequest(request: WorkerNeededDecisionRequest): Record<string, unknown> {
	return {
		state: request.state,
		questions: [
			{
				id: WORKER_NEEDED_QUESTION.id,
				type: "choice",
				instructions: WORKER_NEEDED_QUESTION.instructions,
				options: WORKER_NEEDED_QUESTION.options.map(o => ({ id: o.id, description: o.description })),
			},
		],
	};
}

export function createZ0intDeciderPredictor(options?: {
	bin?: string;
	pythonPath?: string;
	pythonBin?: string;
}): ShadowPredictor {
	const pythonBin = options?.pythonBin ?? process.env.OMP_Z0INT_PYTHON ?? "python3";
	return async (request, { signal, timeoutMs }) => {
		const started = Date.now();
		let dir: string | undefined;
		try {
			dir = await mkdtemp(join(tmpdir(), "omp-shadow-decider-"));
			const inputPath = join(dir, "request.json");
			const scriptPath = join(dir, "eval_decider.py");
			await writeFile(inputPath, JSON.stringify(toZ0intRequest(request)), "utf8");
			// Direct DeciderBackend import — z0int CLI registry may not list decider_2b yet.
			await writeFile(
				scriptPath,
				[
					"import json, sys",
					"from pathlib import Path",
					"from z0int.backends.base import request_from_mapping, result_to_dict",
					"from z0int.backends.decider import DeciderBackend",
					"req = request_from_mapping(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))",
					"backend = DeciderBackend.for_manifest_id('decider_2b')",
					"print(json.dumps(result_to_dict(backend.evaluate(req)), default=str))",
				].join("\n") + "\n",
				"utf8",
			);

			const args = [scriptPath, inputPath];
			const child = spawn(pythonBin, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					...(options?.pythonPath ? { PYTHONPATH: options.pythonPath } : {}),
					Z0INT_DECIDER_DEVICE: process.env.Z0INT_DECIDER_DEVICE ?? "cuda",
				},
			});

			let stdout = "";
			let stderr = "";
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
			});

			const result = await new Promise<ShadowPrediction>(resolve => {
				let settled = false;
				const finish = (pred: ShadowPrediction) => {
					if (settled) return;
					settled = true;
					resolve(pred);
				};

				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					finish({
						status: "cancelled",
						latencyMs: Date.now() - started,
						backendId: SHADOW_BACKEND_ID,
						errorClass: "Timeout",
						reason: `shadow decider exceeded ${timeoutMs}ms`,
					});
				}, timeoutMs);

				const onAbort = () => {
					child.kill("SIGKILL");
					finish({
						status: "cancelled",
						latencyMs: Date.now() - started,
						backendId: SHADOW_BACKEND_ID,
						errorClass: "Aborted",
						reason: "shadow cancelled",
					});
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("error", err => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					const msg = err.message || String(err);
					finish({
						status: msg.includes("ENOENT") ? "unavailable" : "error",
						latencyMs: Date.now() - started,
						backendId: SHADOW_BACKEND_ID,
						errorClass: err.name || "SpawnError",
						reason: msg.slice(0, 500),
					});
				});

				child.on("close", code => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					const latencyMs = Date.now() - started;
					if (settled) return;
					if (code !== 0) {
						finish({
							status: "error",
							latencyMs,
							backendId: SHADOW_BACKEND_ID,
							errorClass: "ExitNonZero",
							reason: (stderr || stdout || `exit ${code}`).slice(0, 500),
						});
						return;
					}
					try {
						const json = JSON.parse(stdout);
						finish(parseZ0intEvalPayload(json, latencyMs));
					} catch (err) {
						finish({
							status: "error",
							latencyMs,
							backendId: SHADOW_BACKEND_ID,
							errorClass: "ParseError",
							reason: err instanceof Error ? err.message : String(err),
						});
					}
				});
			});
			return result;
		} catch (err) {
			return {
				status: "error",
				latencyMs: Date.now() - started,
				backendId: SHADOW_BACKEND_ID,
				errorClass: err instanceof Error ? err.name : "Error",
				reason: err instanceof Error ? err.message : String(err),
			};
		} finally {
			if (dir) {
				void rm(dir, { recursive: true, force: true });
			}
		}
	};
}

/** Deterministic test predictor — NOT for production claims. */
export function createMockShadowPredictor(
	fn: (request: WorkerNeededDecisionRequest) => Omit<ShadowPrediction, "backendId" | "latencyMs"> & {
		latencyMs?: number;
	},
): ShadowPredictor {
	return async (request, { signal, timeoutMs }) => {
		const started = Date.now();
		if (signal?.aborted) {
			return {
				status: "cancelled",
				latencyMs: 0,
				backendId: SHADOW_BACKEND_ID,
				errorClass: "Aborted",
				reason: "shadow cancelled",
			};
		}
		const out = fn(request);
		if ((out.latencyMs ?? 0) > timeoutMs) {
			return {
				status: "cancelled",
				latencyMs: Date.now() - started,
				backendId: SHADOW_BACKEND_ID,
				errorClass: "Timeout",
				reason: `mock exceeded ${timeoutMs}ms`,
			};
		}
		return {
			backendId: SHADOW_BACKEND_ID,
			latencyMs: out.latencyMs ?? Date.now() - started,
			...out,
		};
	};
}

let activePredictor: ShadowPredictor | null = null;

export function setShadowPredictorForTest(predictor: ShadowPredictor | null): void {
	activePredictor = predictor;
}

export function getShadowPredictor(): ShadowPredictor {
	if (activePredictor) return activePredictor;
	const pythonPath =
		process.env.OMP_Z0INT_PYTHONPATH ??
		process.env.PYTHONPATH ??
		(process.env.HOME ? `${process.env.HOME}/tmp/openjev/src` : undefined);
	const pythonBin = process.env.OMP_Z0INT_PYTHON;
	return createZ0intDeciderPredictor({
		pythonPath,
		pythonBin: pythonBin || undefined,
	});
}
