import type { ContextBreakdown } from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { OmpTokenomicsBridge } from "../rlm/tokenomics-bridge";
import type { RlmMetrics } from "../rlm/store";
import type { ContextFlowEconomics, ContextFlowSnapshot } from "./types";
import type { ContextFlowRegistry } from "./registry";
import { RESEARCH_STACK_WIRING } from "./wiring";

export function buildContextFlowEconomics(bridge?: OmpTokenomicsBridge): ContextFlowEconomics {
	const summary = bridge?.summary();
	return {
		rootTokens: summary?.root_tokens ?? 0,
		workerTokens: summary?.worker_tokens ?? 0,
		subagentTokens: summary?.subagent_tokens ?? 0,
		cachedTokens: summary?.cached_tokens ?? 0,
		unattributedTokens: summary?.unattributed_tokens ?? 0,
		totalIncrementalTokens: summary?.total_tokens ?? 0,
		costUsd: summary?.cost_usd ?? 0,
		reconciliationDelta: summary?.reconciliation_delta,
		coverage: summary?.accounting_coverage,
		tokenomicsEnabled: bridge?.enabled ?? false,
	};
}

export function mergeRlmMetricsIntoOffload(
	registry: ContextFlowRegistry,
	metrics?: Partial<RlmMetrics>,
	reintroducedTokens?: number,
): void {
	if (!metrics) return;
	const externalBytes = metrics.bytesSpilled ?? 0;
	const granted = metrics.bytesReintroduced ?? 0;
	registry.updateOffload({
		externalBytes,
		reintroducedTokens: reintroducedTokens ?? Math.max(0, Math.round(granted / 4)),
		grantedTokens: metrics.grantsSelected ? metrics.grantsSelected * 1024 : undefined,
		active: externalBytes > 0 || (metrics.queries ?? 0) > 0 || (metrics.searches ?? 0) > 0,
	});
}

export function buildContextFlowSnapshot(args: {
	registry: ContextFlowRegistry;
	breakdown: ContextBreakdown;
	bridge?: OmpTokenomicsBridge;
	rlmMetrics?: Partial<RlmMetrics>;
}): ContextFlowSnapshot {
	const snap = args.registry.snapshot();
	mergeRlmMetricsIntoOffload(args.registry, args.rlmMetrics);
	const offload = args.registry.snapshot().offload;
	return {
		turn: snap.turn,
		updatedAt: Date.now(),
		nodes: snap.nodes,
		offload,
		economics: buildContextFlowEconomics(args.bridge),
		wiring: RESEARCH_STACK_WIRING,
	};
}
