export type RouteDecisionDisposition = "dispatched" | "skipped" | "not_reached";

export type RouteSkipReason =
	| "capability_mismatch"
	| "credential_unavailable"
	| "credential_lookup_failed"
	| "quota_cutoff"
	| "provider_cooldown"
	| "circuit_open"
	| "state_incompatible"
	| "concurrency_cap"
	| "domain_policy";

const SKIP_REASONS: Record<RouteSkipReason, true> = {
	capability_mismatch: true,
	credential_unavailable: true,
	credential_lookup_failed: true,
	quota_cutoff: true,
	provider_cooldown: true,
	circuit_open: true,
	state_incompatible: true,
	concurrency_cap: true,
	domain_policy: true,
};

export interface RouteDecisionTrace {
	requestId: string;
	routeId: string;
	generation: number;
	selectedTarget: string;
	disposition: RouteDecisionDisposition;
	reason?: RouteSkipReason;
	recordedAtMs: number;
}

export interface RouteDecisionTraceInput {
	requestId: string;
	routeId: string;
	generation: number;
	selectedTarget: string;
	disposition: RouteDecisionDisposition;
	reason?: RouteSkipReason;
}

const MAX_TRACES = 2000;
const TRACE_TTL_MS = 30 * 60 * 1000;

/**
 * Bounded in-memory decision log. Never stores prompts, bodies, tokens, raw
 * headers, or emails — the recorded shape is the allow-listed fields only.
 */
export class RouteDecisionTraceLog {
	#traces: RouteDecisionTrace[] = [];

	record(input: RouteDecisionTraceInput, nowMs: number = Date.now()): RouteDecisionTrace {
		if (input.disposition === "skipped") {
			if (input.reason === undefined || SKIP_REASONS[input.reason] !== true) {
				throw new Error("skipped route decision requires an allow-listed reason");
			}
		}
		const trace: RouteDecisionTrace = {
			requestId: input.requestId,
			routeId: input.routeId,
			generation: input.generation,
			selectedTarget: input.selectedTarget,
			disposition: input.disposition,
			recordedAtMs: nowMs,
		};
		if (input.reason !== undefined) trace.reason = input.reason;
		this.#evict(nowMs);
		this.#traces.push(trace);
		if (this.#traces.length > MAX_TRACES) {
			this.#traces.splice(0, this.#traces.length - MAX_TRACES);
		}
		return trace;
	}

	list(nowMs: number = Date.now()): readonly RouteDecisionTrace[] {
		this.#evict(nowMs);
		return this.#traces;
	}

	#evict(nowMs: number): void {
		const cutoff = nowMs - TRACE_TTL_MS;
		let keepFrom = 0;
		while (keepFrom < this.#traces.length && this.#traces[keepFrom]!.recordedAtMs <= cutoff) {
			keepFrom += 1;
		}
		if (keepFrom > 0) this.#traces.splice(0, keepFrom);
	}
}

/** Redacted summary safe to pass to {@link logger}. No secrets by construction. */
export function redactedDecisionSummary(trace: RouteDecisionTrace): {
	requestId: string;
	routeId: string;
	generation: number;
	selectedTarget: string;
	disposition: RouteDecisionDisposition;
	reason?: RouteSkipReason;
} {
	const summary: {
		requestId: string;
		routeId: string;
		generation: number;
		selectedTarget: string;
		disposition: RouteDecisionDisposition;
		reason?: RouteSkipReason;
	} = {
		requestId: trace.requestId,
		routeId: trace.routeId,
		generation: trace.generation,
		selectedTarget: trace.selectedTarget,
		disposition: trace.disposition,
	};
	if (trace.reason !== undefined) summary.reason = trace.reason;
	return summary;
}
