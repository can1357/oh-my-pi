/**
 * Pluggable Decider-2B client for observe-only shadow predictions.
 *
 * Default path: resident z0int bridge (`decision` / `decision_warm` ops).
 * Tests inject a mock predictor. Never invents Decider-looking answers on failure.
 * RLM does not own a Python child process.
 */
import type { WorkerNeededDecisionRequest, WorkerNeededLabel } from "./worker-needed-features";
import { SHADOW_BACKEND_ID, WORKER_NEEDED_QUESTION } from "./worker-needed-features";
import { getZ0intBridgeTransport } from "./bridge-transport";

export interface ShadowRuntimeDiagnostics {
	residency?: "warm" | "warming" | "failed" | "unloaded" | "absent";
	backendLoaded?: boolean;
	backendLoadMs?: number;
	inferenceMs?: number;
	queueMs?: number;
	ipcMs?: number;
	bridgeGeneration?: number;
	bridgeBuildId?: string;
	bridgeInstanceId?: string;
}

export interface ShadowPrediction {
	status: "ok" | "error" | "cancelled" | "unavailable" | "warming";
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
	runtime?: ShadowRuntimeDiagnostics;
}

export type ShadowPredictor = (
	request: WorkerNeededDecisionRequest,
	options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<ShadowPrediction>;

function asLabel(value: unknown): WorkerNeededLabel | undefined {
	if (value === "native" || value === "worker" || value === "abstain") return value;
	return undefined;
}

function toBridgeDecisionRequest(request: WorkerNeededDecisionRequest): Record<string, unknown> {
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

function parseBridgeDecisionResponse(raw: Record<string, unknown>, ipcMs: number): ShadowPrediction {
	const runtimeRaw = (raw.runtime && typeof raw.runtime === "object" ? raw.runtime : {}) as Record<
		string,
		unknown
	>;
	const runtime: ShadowRuntimeDiagnostics = {
		residency:
			runtimeRaw.residency === "warm" ||
			runtimeRaw.residency === "warming" ||
			runtimeRaw.residency === "failed" ||
			runtimeRaw.residency === "unloaded"
				? runtimeRaw.residency
				: undefined,
		backendLoaded: runtimeRaw.backend_loaded === true,
		backendLoadMs: typeof runtimeRaw.load_ms === "number" ? runtimeRaw.load_ms : undefined,
		inferenceMs: typeof runtimeRaw.inference_ms === "number" ? runtimeRaw.inference_ms : undefined,
		queueMs: typeof runtimeRaw.queue_ms === "number" ? runtimeRaw.queue_ms : undefined,
		ipcMs,
		bridgeGeneration: typeof raw.generation === "number" ? raw.generation : undefined,
		bridgeBuildId: typeof raw.build_id === "string" ? raw.build_id : undefined,
		bridgeInstanceId: typeof raw.instance_id === "string" ? raw.instance_id : undefined,
	};

	const status = typeof raw.status === "string" ? raw.status : raw.ok === true ? "ok" : "error";
	if (status === "warming" || raw.status === "warming") {
		return {
			status: "warming",
			latencyMs: ipcMs,
			backendId: SHADOW_BACKEND_ID,
			errorClass: "Warming",
			reason: typeof raw.error === "string" ? raw.error : "backend_warming",
			runtime: { ...runtime, residency: "warming" },
		};
	}

	if (raw.ok !== true) {
		return {
			status: status === "cancelled" ? "cancelled" : "error",
			latencyMs: ipcMs,
			backendId: typeof raw.backend === "string" ? raw.backend : SHADOW_BACKEND_ID,
			errorClass: "BridgeDecisionError",
			reason: typeof raw.error === "string" ? raw.error : "decision_failed",
			runtime,
		};
	}

	const result = raw.result as
		| {
				answers?: Array<{ value?: unknown; probabilities?: Record<string, number>; confidence?: number }>;
				revision?: string;
				diagnostics?: { device?: string };
		  }
		| undefined;
	const ans = result?.answers?.[0];
	const prediction = asLabel(ans?.value);
	if (!prediction) {
		return {
			status: "error",
			latencyMs: ipcMs,
			backendId: SHADOW_BACKEND_ID,
			errorClass: "MalformedResult",
			reason: "decider returned no choice label",
			runtime,
		};
	}
	const probabilities = ans?.probabilities ?? {};
	const inferenceMs = runtime.inferenceMs ?? 0;
	return {
		status: "ok",
		prediction,
		probabilities,
		confidence: typeof ans?.confidence === "number" ? ans.confidence : probabilities[prediction],
		abstained: prediction === "abstain",
		latencyMs: inferenceMs > 0 ? inferenceMs : ipcMs,
		revision: result?.revision ?? (typeof runtimeRaw.revision === "string" ? runtimeRaw.revision : undefined),
		device: result?.diagnostics?.device ?? (typeof runtimeRaw.device === "string" ? runtimeRaw.device : undefined),
		backendId: typeof raw.backend === "string" ? raw.backend : SHADOW_BACKEND_ID,
		runtime: { ...runtime, residency: "warm", backendLoaded: true },
	};
}

export function createBridgeDeciderPredictor(): ShadowPredictor {
	return async (request, { signal, timeoutMs }) => {
		const started = Date.now();
		const transport = getZ0intBridgeTransport();
		if (!transport) {
			return {
				status: "unavailable",
				latencyMs: Date.now() - started,
				backendId: SHADOW_BACKEND_ID,
				errorClass: "BridgeAbsent",
				reason: "z0int bridge transport not registered (extension not loaded)",
				runtime: { residency: "absent", ipcMs: Date.now() - started },
			};
		}
		if (signal?.aborted) {
			return {
				status: "cancelled",
				latencyMs: 0,
				backendId: SHADOW_BACKEND_ID,
				errorClass: "Aborted",
				reason: "shadow cancelled",
			};
		}

		const onAbort = () => {
			/* request layer times out / rejects; fail-open */
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const ipcStarted = Date.now();
			const raw = await transport.request(
				{
					op: "decision",
					payload: {
						backend: SHADOW_BACKEND_ID,
						capability_id: request.capability,
						request: toBridgeDecisionRequest(request),
					},
				},
				timeoutMs,
			);
			const ipcMs = Date.now() - ipcStarted;
			return parseBridgeDecisionResponse(raw, ipcMs);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const timedOut = /timeout/i.test(msg);
			return {
				status: timedOut ? "cancelled" : "error",
				latencyMs: Date.now() - started,
				backendId: SHADOW_BACKEND_ID,
				errorClass: timedOut ? "Timeout" : err instanceof Error ? err.name : "BridgeError",
				reason: msg.slice(0, 500),
				runtime: { residency: "warm", ipcMs: Date.now() - started },
			};
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	};
}

/** Fire-and-forget Decider prewarm via registered bridge. */
export function requestShadowDeciderWarm(): void {
	const transport = getZ0intBridgeTransport();
	if (!transport) return;
	void (transport.warm?.(SHADOW_BACKEND_ID) ??
		transport.request({ op: "decision_warm", payload: { backend: SHADOW_BACKEND_ID } }, 5_000)).catch(() => {
		/* fail-open */
	});
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
	return activePredictor ?? createBridgeDeciderPredictor();
}

/** @deprecated Use createBridgeDeciderPredictor — per-call Python spawn removed. */
export function createZ0intDeciderPredictor(): ShadowPredictor {
	return createBridgeDeciderPredictor();
}
