import type { Usage } from "@oh-my-pi/pi-ai";
import type { RlmMetrics } from "../rlm/store";
import { getContextFlowRegistry } from "./registry";

/** Call at user prompt ingress. */
export function contextFlowBeginTurn(session: object, label?: string): void {
	getContextFlowRegistry(session).beginTurn(label);
}

/** Record a model invocation on the flow graph. */
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
	},
): void {
	const usage = args.usage;
	getContextFlowRegistry(session).record({
		parentId: args.parentId,
		stage: args.role === "root" ? "root_model" : "worker",
		component: args.component,
		role: args.role,
		visibility: args.visibility,
		provider: args.provider,
		model: args.model,
		inputTokens: usage?.input,
		outputTokens: usage?.output,
		cachedTokens: usage?.cacheRead,
		durationMs: args.durationMs,
		status: "ok",
	});
}

/** RLM store operation counters → flow + offload summary. */
export function contextFlowSyncRlmMetrics(session: object, metrics: Partial<RlmMetrics>, packetTokens?: number): void {
	const reg = getContextFlowRegistry(session);
	reg.updateOffload({
		externalBytes: metrics.bytesSpilled ?? 0,
		reintroducedTokens: packetTokens ?? 0,
		grantedTokens: metrics.grantsSelected ? metrics.grantsSelected * 1200 : undefined,
		active: (metrics.bytesSpilled ?? 0) > 0 || (metrics.searches ?? 0) > 0,
	});
}

/** TypeSafe / local judgment call. */
export function contextFlowRecordJudgment(
	session: object,
	args: { backend: string; inputTokens?: number; outputTokens?: number; decision?: string; durationMs?: number },
): void {
	getContextFlowRegistry(session).record({
		stage: "classifier",
		component: args.backend,
		role: "judgment",
		visibility: "worker",
		wiringStatus: args.backend.includes("nanojev") ? "present_not_wired" : "conditional",
		inputTokens: args.inputTokens,
		outputTokens: args.outputTokens,
		durationMs: args.durationMs,
		decision: args.decision,
		status: args.backend.includes("nanojev") ? "not_wired" : "ok",
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
