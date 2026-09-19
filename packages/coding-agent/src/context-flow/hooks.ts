import type { Usage } from "@oh-my-pi/pi-ai";
import type { RlmMetrics } from "../rlm/store";
import { getContextFlowRegistry, subscribeContextFlow } from "./registry";
import { contextFlowRootComplete, FLOW_KEYS } from "./rlm-flow";

/** Call at user prompt ingress. */
export function contextFlowBeginTurn(session: object, label?: string): void {
	getContextFlowRegistry(session).beginTurn(label);
}

/** Subscribe to in-memory flow revisions (coalesced). */
export { subscribeContextFlow };

/** Record a completed model invocation on the flow graph. */
export function contextFlowRecordModelCall(
	session: object,
	args: {
		component: string;
		role: "root" | "worker";
		provider?: string;
		model?: string;
		usage?: Usage | null;
		durationMs?: number;
		visibility: "root" | "worker";
		parentId?: string;
		failed?: boolean;
	},
): void {
	const usage = args.usage;
	if (args.component === FLOW_KEYS.ROOT && args.role === "root") {
		contextFlowRootComplete(session, {
			provider: args.provider,
			model: args.model,
			inputTokens: usage?.input,
			outputTokens: usage?.output,
			cachedTokens: usage?.cacheRead,
			durationMs: args.durationMs,
			failed: args.failed,
		});
		return;
	}
	getContextFlowRegistry(session).recordInstant({
		parentId: args.parentId,
		stage: args.role === "root" ? "root_model" : "worker",
		component: args.component,
		role: args.role,
		visibility: args.visibility,
		provider: args.provider,
		model: args.model,
		inputTokens: usage?.input,
		outputTokens: usage?.output,
		durationMs: args.durationMs,
		status: args.failed ? "failed" : "complete",
	});
}

/** RLM store operation counters → flow + offload summary. */
export function contextFlowSyncRlmMetrics(session: object, metrics: Partial<RlmMetrics>, packetTokens?: number): void {
	const reg = getContextFlowRegistry(session);
	reg.updateOffload({
		externalBytes: metrics.bytesSpilled ?? reg.snapshot().offload.externalBytes,
		reintroducedTokens: packetTokens ?? reg.snapshot().offload.reintroducedTokens,
		grantedTokens: metrics.grantsSelected ? metrics.grantsSelected * 1024 : reg.snapshot().offload.grantedTokens,
		active: (metrics.bytesSpilled ?? 0) > 0 || (metrics.searches ?? 0) > 0 || (metrics.queries ?? 0) > 0,
	});
}

/** TypeSafe / local judgment call. */
export function contextFlowRecordJudgment(
	session: object,
	args: { backend: string; inputTokens?: number; outputTokens?: number; decision?: string; durationMs?: number },
): void {
	getContextFlowRegistry(session).recordInstant({
		stage: "classifier",
		component: args.backend,
		role: "judgment",
		visibility: "worker",
		wiringStatus: args.backend.includes("nanojev") ? "present_not_wired" : "conditional",
		inputTokens: args.inputTokens,
		outputTokens: args.outputTokens,
		durationMs: args.durationMs,
		decision: args.decision,
		status: args.backend.includes("nanojev") ? "not_wired" : "complete",
	});
}

/** Seed static not-wired nodes once per session (idempotent). */
export function contextFlowSeedResearchStack(session: object): void {
	const reg = getContextFlowRegistry(session);
	const snap = reg.snapshot();
	if (snap.nodes.some(n => n.component === "NanoJev")) return;
	reg.recordNotWired("NanoJev");
	reg.recordNotWired("OpenJev");
	reg.recordNotWired("z0int");
	reg.recordNotWired("Kerdoios");
	reg.recordNotWired("fly.classifier");
	reg.recordNotWired("mushroom.classifier");
}
