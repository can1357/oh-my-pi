import type { ContextTrace, RequestInput, StepContext, StepContextMetadata, StepKind, StepRisk, VerifierSignal } from "./types.js";

const STEP_KINDS: StepKind[] = ["plan", "tool_call", "tool_result", "code_edit", "browser", "final", "other"];
const STEP_RISKS: StepRisk[] = ["low", "medium", "high"];
const VERIFIER_SIGNALS: VerifierSignal[] = ["pass", "fail", "uncertain"];

export function stepContextToRequestInput(ctx: StepContext): RequestInput {
	const metadata = stepContextToMetadata(ctx);
	const baseRuntime = ctx.request.runtime;
	const runtime =
		ctx.budgets?.latencyMs !== undefined || ctx.budgets?.costUsd !== undefined
			? {
					...baseRuntime,
					latencyBudgetMs: baseRuntime?.latencyBudgetMs ?? ctx.budgets?.latencyMs,
					costBudgetUsd: baseRuntime?.costBudgetUsd ?? ctx.budgets?.costUsd,
				}
			: baseRuntime;

	return {
		...ctx.request,
		...(runtime === undefined ? {} : { runtime }),
		metadata: {
			...(ctx.request.metadata ?? {}),
			stepContext: metadata,
		},
	};
}

export function stepContextToMetadata(ctx: StepContext): StepContextMetadata {
	const metadata: StepContextMetadata = {};
	assignDefined(metadata, "stepId", ctx.step.id);
	assignDefined(metadata, "stepIndex", ctx.step.index);
	assignDefined(metadata, "stepKind", ctx.step.kind);
	assignDefined(metadata, "agentRole", ctx.step.agentRole);
	assignDefined(metadata, "stepRisk", ctx.step.risk);
	assignDefined(metadata, "irreversible", ctx.step.irreversible);
	assignDefined(metadata, "conversationTurns", ctx.trajectory?.conversationTurns);
	assignDefined(metadata, "recentToolCalls", ctx.trajectory?.recentToolCalls);
	assignDefined(metadata, "recentFailures", ctx.trajectory?.recentFailures);
	assignDefined(metadata, "lastVerifier", ctx.trajectory?.lastVerifier);
	assignDefined(metadata, "escalationCount", ctx.trajectory?.escalationCount);
	assignDefined(metadata, "priorModelSelector", ctx.trajectory?.priorModelSelector);
	assignDefined(metadata, "stablePrefixHash", ctx.cache?.stablePrefixHash);
	assignDefined(metadata, "estimatedCacheHit", ctx.cache?.estimatedCacheHit);
	assignDefined(metadata, "providerAffinity", ctx.cache?.providerAffinity);
	assignDefined(metadata, "remainingTokens", ctx.budgets?.remainingTokens);
	return metadata;
}

export function readStepContextMetadata(metadata: RequestInput["metadata"]): Partial<StepContextMetadata> {
	const source = stepContextSource(metadata);
	if (!source) return {};
	const result: Partial<StepContextMetadata> = {};
	const stepKind = enumValue(source.stepKind, STEP_KINDS);
	if (stepKind !== undefined) result.stepKind = stepKind;
	const stepRisk = enumValue(source.stepRisk, STEP_RISKS);
	if (stepRisk !== undefined) result.stepRisk = stepRisk;
	const lastVerifier = enumValue(source.lastVerifier, VERIFIER_SIGNALS);
	if (lastVerifier !== undefined) result.lastVerifier = lastVerifier;
	assignString(result, "stepId", source.stepId);
	assignString(result, "agentRole", source.agentRole);
	assignString(result, "priorModelSelector", source.priorModelSelector);
	assignString(result, "stablePrefixHash", source.stablePrefixHash);
	assignString(result, "providerAffinity", source.providerAffinity);
	assignNumber(result, "stepIndex", source.stepIndex);
	assignNumber(result, "conversationTurns", source.conversationTurns);
	assignNumber(result, "recentFailures", source.recentFailures);
	assignNumber(result, "escalationCount", source.escalationCount);
	assignNumber(result, "remainingTokens", source.remainingTokens);
	assignBoolean(result, "irreversible", source.irreversible);
	assignBoolean(result, "estimatedCacheHit", source.estimatedCacheHit);
	if (Array.isArray(source.recentToolCalls)) result.recentToolCalls = source.recentToolCalls as StepContextMetadata["recentToolCalls"];
	return result;
}

export function stepContextToContextTrace(metadata: RequestInput["metadata"]): ContextTrace {
	const stepContext = readStepContextMetadata(metadata);
	const trace: ContextTrace = {};
	assignDefined(trace, "conversationTurns", stepContext.conversationTurns);
	assignDefined(trace, "stepKind", stepContext.stepKind);
	assignDefined(trace, "stepRisk", stepContext.stepRisk);
	assignDefined(trace, "stepIndex", stepContext.stepIndex);
	assignDefined(trace, "agentRole", stepContext.agentRole);
	assignDefined(trace, "irreversible", stepContext.irreversible);
	assignDefined(trace, "recentFailures", stepContext.recentFailures);
	assignDefined(trace, "lastVerifier", stepContext.lastVerifier);
	assignDefined(trace, "escalationCount", stepContext.escalationCount);
	assignDefined(trace, "estimatedCacheHit", stepContext.estimatedCacheHit);
	assignDefined(trace, "stablePrefixHash", stepContext.stablePrefixHash);
	assignDefined(trace, "providerAffinity", stepContext.providerAffinity);
	if (stepContext.recentToolCalls !== undefined) trace.recentToolCallCount = stepContext.recentToolCalls.length;
	return trace;
}

function stepContextSource(metadata: RequestInput["metadata"]): Record<string, unknown> | undefined {
	const root = asRecord(metadata);
	return asRecord(root?.stepContext) ?? root;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function enumValue<const Value extends string>(value: unknown, allowed: readonly Value[]): Value | undefined {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as Value) : undefined;
}

function assignString<Key extends keyof StepContextMetadata>(
	result: Partial<StepContextMetadata>,
	key: Key,
	value: unknown,
): void {
	if (typeof value === "string") result[key] = value as StepContextMetadata[Key];
}

function assignNumber<Key extends keyof StepContextMetadata>(
	result: Partial<StepContextMetadata>,
	key: Key,
	value: unknown,
): void {
	if (typeof value === "number" && Number.isFinite(value)) result[key] = Math.max(0, value) as StepContextMetadata[Key];
}

function assignBoolean<Key extends keyof StepContextMetadata>(
	result: Partial<StepContextMetadata>,
	key: Key,
	value: unknown,
): void {
	if (typeof value === "boolean") result[key] = value as StepContextMetadata[Key];
}

function assignDefined<Target extends object, Key extends keyof Target>(
	target: Target,
	key: Key,
	value: Target[Key] | undefined,
): void {
	if (value !== undefined) target[key] = value;
}
