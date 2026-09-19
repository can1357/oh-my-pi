import type { RlmMetrics, RlmRecord, RlmStore } from "../rlm/store";
import { flushContextSnapshot, scheduleContextSnapshot, type ContextFlowEmitterHost } from "./emitter";
import { getContextFlowRegistry } from "./registry";
import { mergeRlmMetricsIntoOffload } from "./snapshot";

export const FLOW_KEYS = {
	ROOT: "omp.root",
	RLM_SPILL: "omp.rlm.spill",
	RLM_SEARCH: "omp.rlm.search",
	RLM_AUTO_GATE: "omp.rlm.auto_gate",
	DECIDER_SHADOW: "omp.shadow.decider",
	RLM_GRANTS: "omp.rlm.grants",
	RLM_WORKER: "omp.rlm.worker",
	RLM_CODEC: "omp.rlm.groq_codec",
} as const;

export type RlmFlowHooks = {
	onSpill?: (record: RlmRecord) => void;
	onSearchBegin?: (handle: string) => void;
	onSearch?: (args: { handle: string; hits: number; durationMs: number }) => void;
};

export function resolveRlmFlowOwner(storeOrRuntime: { flowOwner?: object }): (object & ContextFlowEmitterHost) | undefined {
	return storeOrRuntime.flowOwner as (object & ContextFlowEmitterHost) | undefined;
}

function syncOffload(owner: object, store: RlmStore, packetTokens?: number): void {
	mergeRlmMetricsIntoOffload(getContextFlowRegistry(owner), store.metrics, packetTokens);
}

function emitSnapshot(owner: ContextFlowEmitterHost, store: RlmStore, packetTokens?: number): void {
	syncOffload(owner, store, packetTokens);
	scheduleContextSnapshot(owner, { ...store.metrics, grantedBytes: store.metrics.bytesReintroduced }, owner.getTokenomicsBridge?.());
}

export function bindRlmContextFlow(owner: object & ContextFlowEmitterHost, runtime: RlmRuntime): void {
	runtime.flowOwner = owner;
	runtime.store.flowOwner = owner;
	runtime.store.flowHooks = {
		onSpill: record => contextFlowRlmSpill(owner, record),
		onSearchBegin: handle => contextFlowRlmSearchBegin(owner, handle),
		onSearch: args => contextFlowRlmSearchComplete(owner, args, runtime.store),
	};
}

export function contextFlowRlmSpill(owner: object, record: RlmRecord, store?: RlmStore): void {
	const reg = getContextFlowRegistry(owner);
	reg.recordInstant({
		stage: "context_manager",
		component: FLOW_KEYS.RLM_SPILL,
		role: "spill",
		visibility: "externalized",
		inputBytes: record.bytes,
		decision: `rlm://h/${record.id}`,
		reason: record.source,
		durationMs: 0,
	});
	const metricsStore = store ?? (owner as { rlmStore?: RlmStore }).rlmStore;
	if (metricsStore) emitSnapshot(owner as ContextFlowEmitterHost, metricsStore);
}

export function contextFlowRlmSearchBegin(owner: object, handle: string): void {
	getContextFlowRegistry(owner).beginStage({
		key: FLOW_KEYS.RLM_SEARCH,
		stage: "context_manager",
		component: FLOW_KEYS.RLM_SEARCH,
		role: "search",
		visibility: "externalized",
		decision: handle,
	});
}

export function contextFlowRlmSearchComplete(
	owner: object,
	args: { handle: string; hits: number; durationMs: number },
	store?: RlmStore,
): void {
	const reg = getContextFlowRegistry(owner);
	reg.completeStage(FLOW_KEYS.RLM_SEARCH, {
		decision: `${args.hits} hit${args.hits === 1 ? "" : "s"}`,
		durationMs: args.durationMs,
		reason: args.handle,
	});
	if (store) emitSnapshot(owner as ContextFlowEmitterHost, store);
}

export function contextFlowRlmGrants(
	owner: object,
	args: { grantedBytes: number; grantCount: number; grantedTokens?: number },
	store?: RlmStore,
): void {
	const reg = getContextFlowRegistry(owner);
	reg.recordInstant({
		stage: "context_manager",
		component: FLOW_KEYS.RLM_GRANTS,
		role: "grants",
		visibility: "externalized",
		inputBytes: args.grantedBytes,
		grantCount: args.grantCount,
		inputTokens: args.grantedTokens,
		durationMs: 0,
	});
	reg.updateOffload({
		grantedTokens: args.grantedTokens ?? Math.round(args.grantedBytes / 4),
		active: true,
	});
	if (store) emitSnapshot(owner as ContextFlowEmitterHost, store);
}

export function contextFlowRlmAutoGate(
	owner: object,
	decision: { flowDecision: string; reason: string },
	store?: RlmStore,
): void {
	getContextFlowRegistry(owner).recordInstant({
		stage: "classifier",
		component: FLOW_KEYS.RLM_AUTO_GATE,
		role: "auto_gate",
		visibility: "externalized",
		decision: decision.flowDecision,
		reason: decision.reason,
		durationMs: 0,
	});
	if (store) emitSnapshot(owner as ContextFlowEmitterHost, store);
}

export function contextFlowDeciderShadow(
	owner: object,
	args: {
		prediction?: string;
		confidence?: number;
		latencyMs: number;
		status: "ok" | "error" | "cancelled" | "unavailable" | "unknown" | "warming";
		reason?: string;
		runtime?: { residency?: string; inferenceMs?: number };
	},
	store?: RlmStore,
): void {
	let decision: string;
	if (args.status === "warming") {
		decision = "SHADOW warming";
	} else if (args.status === "cancelled") {
		decision = "SHADOW timeout";
	} else if (args.status === "ok") {
		const pred = args.prediction ?? "—";
		const conf =
			args.confidence !== undefined && Number.isFinite(args.confidence)
				? ` · ${args.confidence.toFixed(2)}`
				: "";
		const ms =
			args.runtime?.inferenceMs !== undefined
				? args.runtime.inferenceMs
				: args.latencyMs;
		const resident = args.runtime?.residency === "warm" ? " · resident" : "";
		decision = `SHADOW ${pred}${conf} · ${Math.round(ms)}ms${resident}`;
	} else {
		decision = `SHADOW ${args.status}`;
	}
	getContextFlowRegistry(owner).recordInstant({
		stage: "classifier",
		component: FLOW_KEYS.DECIDER_SHADOW,
		role: "shadow_router",
		visibility: "shadow",
		wiringStatus: "shadow",
		decision,
		reason: args.reason ?? `decider_2b ${args.status}`,
		durationMs: args.latencyMs,
		status:
			args.status === "ok"
				? "complete"
				: args.status === "cancelled" || args.status === "warming"
					? "skipped"
					: "failed",
		provider: "local",
		model: "decider_2b",
	});
	if (store) emitSnapshot(owner as ContextFlowEmitterHost, store);
}

export function contextFlowRlmWorkerSkipped(
	owner: object,
	component: string,
	reason: string,
	store?: RlmStore,
): void {
	getContextFlowRegistry(owner).skipStage(component, { reason, visibility: "worker" });
	if (store) emitSnapshot(owner as ContextFlowEmitterHost, store);
}

export function contextFlowRlmWorkerBegin(
	owner: object,
	args: { component: string; provider?: string; model?: string; grantedBytes?: number; inputTokens?: number },
): void {
	getContextFlowRegistry(owner).beginStage({
		key: args.component,
		stage: "worker",
		component: args.component,
		role: "worker",
		visibility: "worker",
		provider: args.provider,
		model: args.model,
		inputBytes: args.grantedBytes,
		inputTokens: args.inputTokens,
	});
}

export function contextFlowRlmWorkerComplete(
	owner: object,
	args: {
		component: string;
		provider?: string;
		model?: string;
		inputTokens?: number;
		outputTokens?: number;
		durationMs?: number;
		failed?: boolean;
		decision?: string;
	},
	store?: RlmStore,
	packetTokens?: number,
): void {
	const reg = getContextFlowRegistry(owner);
	const patch = {
		provider: args.provider,
		model: args.model,
		inputTokens: args.inputTokens,
		outputTokens: args.outputTokens,
		durationMs: args.durationMs,
		decision: args.decision,
	};
	if (args.failed) reg.failStage(args.component, patch);
	else reg.completeStage(args.component, patch);
	if (store) emitSnapshot(owner as ContextFlowEmitterHost, store, packetTokens);
}

export function contextFlowEvidenceReintroduced(
	owner: object,
	args: { packetTokens: number; grantedBytes?: number },
	store?: RlmStore,
): void {
	const reg = getContextFlowRegistry(owner);
	reg.updateOffload({
		reintroducedTokens: args.packetTokens,
		grantedTokens: args.grantedBytes ? Math.round(args.grantedBytes / 4) : undefined,
		active: true,
	});
	if (store) {
		syncOffload(owner, store, args.packetTokens);
		flushContextSnapshot(owner as ContextFlowEmitterHost, { ...store.metrics, grantedBytes: store.metrics.bytesReintroduced });
	}
}

export function contextFlowRootBegin(owner: object, provider?: string, model?: string): void {
	getContextFlowRegistry(owner).beginStage({
		key: FLOW_KEYS.ROOT,
		stage: "root_model",
		component: FLOW_KEYS.ROOT,
		role: "root",
		visibility: "root",
		provider,
		model,
	});
}

export function contextFlowRootComplete(
	owner: object,
	args: {
		provider?: string;
		model?: string;
		inputTokens?: number;
		outputTokens?: number;
		cachedTokens?: number;
		durationMs?: number;
		failed?: boolean;
	},
): void {
	const reg = getContextFlowRegistry(owner);
	const patch = {
		provider: args.provider,
		model: args.model,
		inputTokens: args.inputTokens,
		outputTokens: args.outputTokens,
		cachedTokens: args.cachedTokens,
		durationMs: args.durationMs,
	};
	if (args.failed) reg.failStage(FLOW_KEYS.ROOT, patch);
	else reg.completeStage(FLOW_KEYS.ROOT, patch);
}

export function contextFlowTurnFlush(owner: ContextFlowEmitterHost, metrics?: Partial<RlmMetrics>): void {
	if (metrics) flushContextSnapshot(owner, metrics);
}
