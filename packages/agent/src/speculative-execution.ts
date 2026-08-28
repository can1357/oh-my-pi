import * as path from "node:path";
import { type AssistantMessage, validateToolArguments } from "@oh-my-pi/pi-ai";
import type {
	AgentContext,
	AgentLoopConfig,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	SpeculativeAuthorization,
	SpeculativeChildDefinition,
	SpeculativeChildHandle,
	SpeculativeCommitContext,
	SpeculativeOperationContext,
	SpeculativePhysicalOutcome,
	SpeculativeResourceAccess,
	SpeculativeToolExecutionConfig,
	SpeculativeToolTelemetry,
	ToolSpeculationAssessment,
	ToolSpeculationEffect,
	ToolSpeculationExecutionContext,
	ToolSpeculationPolicy,
	ToolSpeculationStreamSession,
} from "./types";

export type SpeculativeRawOutcome = {
	result: AgentToolResult<unknown>;
	isError: boolean;
};

export type CoerceToolResult = (raw: unknown) => { result: AgentToolResult<unknown>; malformed: boolean };

type FinalizedPolicy = NonNullable<ToolSpeculationPolicy["finalized"]>;

type CandidateState = "queued" | "running" | "completed" | "failed" | "discarded";

type SpeculativeToolCandidate = {
	candidateId: string;
	parentToolCallId?: string;
	source: "direct" | "eval_shadow";
	dependencies: readonly string[];
	dependents: Set<string>;
	toolCall: AgentToolCall;
	tool: AgentTool;
	policy: FinalizedPolicy;
	executionArgs: Record<string, unknown>;
	effect: ToolSpeculationEffect;
	fingerprint: string;
	deferBeforeToolCall: boolean;
	virtualDurationMs?: number;
	virtualStartedAt?: number;
	virtualFinishedAt?: number;
	startedAt?: number;
	finishedAt?: number;
	dispatchReachedAt?: number;
	controller: AbortController;
	outcome: Promise<SpeculativePhysicalOutcome>;
	resolveOutcome: (outcome: SpeculativePhysicalOutcome) => void;
	rejectOutcome: (error: unknown) => void;
	state: CandidateState;
	claimed: boolean;
	reported: boolean;
};

type CoordinatorEnvironment = {
	context: AgentContext;
	loopConfig: AgentLoopConfig;
	signal?: AbortSignal;
};

const coordinatorByMessage = new WeakMap<AssistantMessage, SpeculativeOperationCoordinator>();
const DEFAULT_MAX_IN_FLIGHT = 2;
const emptyDependencies: readonly string[] = Object.freeze([]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function normalizeResources(value: unknown): readonly SpeculativeResourceAccess[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const resources: SpeculativeResourceAccess[] = [];
	const accesses = new Set<string>();
	for (const item of value) {
		if (!isPlainRecord(item) || !hasExactKeys(item, ["scheme", "path", "access"])) return undefined;
		if (item.scheme !== "file" || typeof item.path !== "string" || !path.isAbsolute(item.path)) return undefined;
		if (item.access !== "read" || accesses.has(item.path)) return undefined;
		accesses.add(item.path);
		resources.push(Object.freeze({ scheme: "file", path: item.path, access: "read" }));
	}
	return Object.freeze(resources);
}

/** JSON canonicalization shared by assessment and final reconciliation. */
export function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Non-finite numbers are not JSON values");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) throw new Error("Circular values are not JSON values");
		ancestors.add(value);
		try {
			return `[${value.map(entry => canonicalJson(entry, ancestors)).join(",")}]`;
		} finally {
			ancestors.delete(value);
		}
	}
	if (!isPlainRecord(value)) throw new Error("Non-JSON value");
	if (ancestors.has(value)) throw new Error("Circular values are not JSON values");
	ancestors.add(value);
	try {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`)
			.join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}

export function createExecutionFingerprint(
	toolCall: AgentToolCall,
	executionArgs: Readonly<Record<string, unknown>>,
	effect: ToolSpeculationEffect,
): string {
	return canonicalJson({ name: toolCall.name, args: executionArgs, effect });
}

async function candidateMatchesFingerprint(
	candidate: SpeculativeToolCandidate,
	toolCall: AgentToolCall,
	args: Readonly<Record<string, unknown>>,
): Promise<boolean> {
	let assessment: ToolSpeculationAssessment;
	try {
		assessment = await candidate.policy.assess({ toolCall, args });
	} catch {
		return false;
	}
	const effect = assessment.eligible ? normalizeSpeculationEffect(assessment.effect) : undefined;
	if (!effect) return false;
	try {
		return createExecutionFingerprint(toolCall, args, effect) === candidate.fingerprint;
	} catch {
		return false;
	}
}

/** Rejects malformed or ambiguous effects and returns a frozen logical identity. */
export function normalizeSpeculationEffect(effect: unknown): ToolSpeculationEffect | undefined {
	if (!isPlainRecord(effect) || typeof effect.kind !== "string") return undefined;
	if (effect.kind === "pure" && hasExactKeys(effect, ["kind"])) return Object.freeze({ kind: "pure" });
	if (effect.kind === "local_read" && hasExactKeys(effect, ["kind", "resources"])) {
		const resources = normalizeResources(effect.resources);
		return resources ? Object.freeze({ kind: "local_read", resources }) : undefined;
	}
	return undefined;
}

function emitTelemetry(config: SpeculativeToolExecutionConfig, event: SpeculativeToolTelemetry): void {
	try {
		config.onTelemetry?.(event);
	} catch {
		// Observability must not alter execution.
	}
}

function resourceCount(effect: ToolSpeculationEffect): number {
	return effect.kind === "local_read" ? effect.resources.length : 0;
}

class TrackedStreamSession implements ToolSpeculationStreamSession {
	#closed = false;
	#finalized = false;

	constructor(readonly inner: ToolSpeculationStreamSession) {}

	get contextIndependent(): boolean | undefined {
		return this.inner.contextIndependent;
	}

	update(toolCall: AgentToolCall, partialJson?: string): void | Promise<void> {
		if (!this.#closed) return this.inner.update(toolCall, partialJson);
	}

	async finalize(context: Parameters<ToolSpeculationStreamSession["finalize"]>[0]): Promise<void> {
		if (this.#closed || this.#finalized) return;
		await this.inner.finalize(context);
		this.#finalized = true;
	}

	async commit(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.inner.commit();
	}

	async discard(reason: string): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.inner.discard(reason);
	}
}

/** One streamed assistant response's invisible speculative-operation lifecycle. */
export class SpeculativeOperationCoordinator {
	#candidates = new Map<string, SpeculativeToolCandidate>();
	#streamSessions = new Map<string, TrackedStreamSession>();
	#admission: Promise<void> = Promise.resolve();
	#directBarrier = false;
	#closed = false;
	#admissionsFinalized = false;
	#running = 0;

	constructor(
		readonly config: SpeculativeToolExecutionConfig,
		readonly environment?: CoordinatorEnvironment,
	) {}

	get maxInFlight(): number {
		const configured = this.config.maxInFlight;
		return configured !== undefined && Number.isFinite(configured)
			? Math.max(1, Math.floor(configured))
			: DEFAULT_MAX_IN_FLIGHT;
	}

	get size(): number {
		return this.#candidates.size;
	}

	register(_contentIndex: number): void {}
	registerStreamSession(toolCallId: string, session: ToolSpeculationStreamSession): boolean {
		if (this.#closed || this.#streamSessions.has(toolCallId)) return false;
		this.#streamSessions.set(toolCallId, new TrackedStreamSession(session));
		return true;
	}

	streamSession(toolCallId: string): ToolSpeculationStreamSession | undefined {
		return this.#streamSessions.get(toolCallId);
	}

	takeStreamSession(toolCallId: string): ToolSpeculationStreamSession | undefined {
		const session = this.#streamSessions.get(toolCallId);
		if (session) this.#streamSessions.delete(toolCallId);
		return session;
	}

	async discardStreamSession(toolCallId: string, reason: string): Promise<void> {
		const session = this.#streamSessions.get(toolCallId);
		if (!session) return;
		this.#streamSessions.delete(toolCallId);
		try {
			await session.discard(reason);
		} catch {
			// Stream-session cleanup cannot alter ordinary dispatch.
		}
	}

	async finalizeAdmissions(): Promise<void> {
		await this.#admission;
		this.#admissionsFinalized = true;
		await this.#discardInvalidGraph();
		this.#drain();
	}

	attach(message: AssistantMessage): void {
		if (this.#closed) return;
		if (this.#streamSessions.size > 0) {
			coordinatorByMessage.set(message, this);
			return;
		}
		for (const candidate of this.#candidates.values()) {
			if (candidate.state === "discarded") continue;
			coordinatorByMessage.set(message, this);
			return;
		}
	}

	static take(message: AssistantMessage): SpeculativeOperationCoordinator | undefined {
		const coordinator = coordinatorByMessage.get(message);
		coordinatorByMessage.delete(message);
		return coordinator;
	}

	static discardForMessage(
		message: AssistantMessage,
		reason: string,
		outcome: "discarded" | "aborted" = "discarded",
	): void {
		const coordinator = SpeculativeOperationCoordinator.take(message);
		void coordinator?.close(reason, outcome);
	}

	#createContext(candidate: SpeculativeToolCandidate): SpeculativeOperationContext {
		return {
			candidateId: candidate.candidateId,
			source: candidate.source,
			dependencies: candidate.dependencies,
			tool: candidate.tool,
			toolCall: candidate.toolCall,
			args: candidate.executionArgs,
			effect: candidate.effect,
		};
	}

	#report(
		candidate: SpeculativeToolCandidate,
		outcome: Exclude<SpeculativeToolTelemetry["outcome"], "ineligible">,
		reason?: string,
	): void {
		if (candidate.reported) return;
		candidate.reported = true;
		const executionDurationMs =
			candidate.finishedAt === undefined || candidate.startedAt === undefined
				? undefined
				: candidate.finishedAt - candidate.startedAt;
		emitTelemetry(this.config, {
			source: candidate.source,
			candidateId: candidate.candidateId,
			parentToolCallId: candidate.parentToolCallId,
			toolName: candidate.tool.name,
			effectKind: candidate.effect.kind,
			candidateStartedAt: candidate.startedAt,
			candidateFinishedAt: candidate.finishedAt,
			dispatchReachedAt: candidate.dispatchReachedAt,
			dependencyCount: candidate.dependencies.length,
			outcome,
			reason,
			executionDurationMs,
			overlapMs:
				outcome === "committed" &&
				executionDurationMs !== undefined &&
				candidate.dispatchReachedAt !== undefined &&
				candidate.startedAt !== undefined
					? Math.min(executionDurationMs, Math.max(0, candidate.dispatchReachedAt - candidate.startedAt))
					: undefined,
			resourceCount: resourceCount(candidate.effect),
		});
	}

	ineligible(
		toolCall: AgentToolCall,
		reason: string,
		source: "direct" | "eval_shadow" = "direct",
		parentToolCallId?: string,
	): false {
		emitTelemetry(this.config, {
			source,
			candidateId: toolCall.id,
			parentToolCallId,
			toolName: toolCall.name,
			dependencyCount: 0,
			outcome: "ineligible",
			reason,
			resourceCount: 0,
		});
		return false;
	}

	async #discardCandidate(
		candidate: SpeculativeToolCandidate,
		outcome: "discarded" | "fingerprint_mismatch" | "aborted",
		reason: string,
		descendants = true,
	): Promise<void> {
		if (candidate.state === "discarded" || candidate.claimed) return;
		candidate.state = "discarded";
		candidate.controller.abort();
		candidate.rejectOutcome(new Error(reason));
		const context = this.#createContext(candidate);
		try {
			await candidate.policy.discard?.({ ...context, reason });
			await this.config.host?.discard?.({ ...context, reason });
		} catch {
			// A discard hook cannot change the architectural call.
		}
		this.#report(candidate, outcome, reason);
		if (descendants) {
			await Promise.all(
				[...candidate.dependents]
					.map(id => this.#candidates.get(id))
					.filter((value): value is SpeculativeToolCandidate => value !== undefined)
					.map(value => this.#discardCandidate(value, outcome, `dependency ${candidate.candidateId}: ${reason}`)),
			);
		}
		this.#candidates.delete(candidate.candidateId);
	}

	async close(reason: string, outcome: "discarded" | "aborted" = "discarded"): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#admission;
		await Promise.all([
			...[...this.#streamSessions.values()].map(async session => {
				try {
					await session.discard(reason);
				} catch {
					// Stream-session cleanup cannot alter ordinary dispatch.
				}
			}),
			...[...this.#candidates.values()].map(candidate => this.#discardCandidate(candidate, outcome, reason)),
		]);
		this.#streamSessions.clear();
		this.#candidates.clear();
	}

	async discardAll(reason: string, outcome: "discarded" | "aborted" = "discarded"): Promise<void> {
		await this.close(reason, outcome);
	}

	async reconcileFinalCalls(calls: ReadonlyMap<string, AgentToolCall>): Promise<void> {
		await this.#admission;
		for (const candidate of this.#candidates.values()) {
			if (candidate.source !== "direct") continue;
			const finalCall = calls.get(candidate.candidateId);
			if (
				!finalCall ||
				finalCall.name !== candidate.toolCall.name ||
				!(await candidateMatchesFingerprint(
					candidate,
					finalCall,
					finalCall.arguments as Readonly<Record<string, unknown>>,
				))
			) {
				await this.#discardCandidate(candidate, "fingerprint_mismatch", "final tool call changed");
			}
		}
		for (const toolCallId of this.#streamSessions.keys()) {
			if (!calls.has(toolCallId)) await this.discardStreamSession(toolCallId, "final outer tool call changed");
		}
	}

	async #commitCandidate(
		candidate: SpeculativeToolCandidate,
		tool: AgentTool | undefined,
		toolCall: AgentToolCall,
		args: Readonly<Record<string, unknown>>,
	): Promise<SpeculativeRawOutcome | undefined> {
		if (candidate.claimed || candidate.state === "discarded") return undefined;
		candidate.dispatchReachedAt = Date.now();
		const fingerprintMatches = await candidateMatchesFingerprint(candidate, toolCall, args);
		if (candidate.tool !== tool || !fingerprintMatches) {
			await this.#discardCandidate(candidate, "fingerprint_mismatch", "final speculation fingerprint changed");
			return undefined;
		}
		candidate.claimed = true;
		let physicalOutcome: SpeculativePhysicalOutcome;
		try {
			physicalOutcome = await candidate.outcome;
		} catch {
			candidate.claimed = false;
			await this.#discardCandidate(candidate, "discarded", "speculative execution failed");
			return undefined;
		}
		if (physicalOutcome.isError) {
			candidate.claimed = false;
			await this.#discardCandidate(candidate, "discarded", "speculative execution returned an error");
			return undefined;
		}
		const context: SpeculativeCommitContext = { ...this.#createContext(candidate), physicalOutcome };
		try {
			if (this.config.host?.validate && !(await this.config.host.validate(context))) {
				candidate.claimed = false;
				await this.#discardCandidate(candidate, "discarded", "host validation vetoed speculative result");
				return undefined;
			}
			const commitDefault = async (): Promise<AgentToolResult<unknown>> =>
				candidate.policy.commit ? candidate.policy.commit(context, physicalOutcome) : physicalOutcome.result;
			const decision = this.config.host?.commit
				? await this.config.host.commit(context, commitDefault)
				: { kind: "committed" as const, result: await commitDefault() };
			if (decision.kind === "fallback") {
				candidate.claimed = false;
				await this.#discardCandidate(candidate, "discarded", decision.reason);
				return undefined;
			}
			if (decision.kind === "failed") throw decision.error;
			this.#report(candidate, "committed");
			return {
				result: decision.result,
				isError: decision.result.isError === true || physicalOutcome.isError,
			};
		} catch (error) {
			this.#report(candidate, "commit_conflict", error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	async claim(
		tool: AgentTool | undefined,
		toolCall: AgentToolCall,
		args: Record<string, unknown>,
	): Promise<SpeculativeRawOutcome | undefined> {
		const candidate = this.#candidates.get(toolCall.id);
		if (candidate?.source !== "direct") return undefined;
		return this.#commitCandidate(candidate, tool, toolCall, args);
	}

	admitFinalized(
		context: AgentContext,
		toolCall: AgentToolCall,
		loopConfig: AgentLoopConfig,
		signal: AbortSignal | undefined,
	): void {
		this.#admission = this.#admission.then(async () => {
			if (this.#directBarrier) {
				this.ineligible(toolCall, "preceding speculation barrier");
				return;
			}
			const tool = context.tools?.find(value => value.name === toolCall.name);
			if (!tool) {
				this.#directBarrier = true;
				this.ineligible(toolCall, "tool is not speculation-safe");
				return;
			}
			const candidate = await this.#prepareCandidate(
				{
					candidateId: toolCall.id,
					dependencies: emptyDependencies,
					toolCall,
					tool,
					source: "direct",
				},
				{ context, loopConfig, signal },
			);
			if (!candidate) {
				this.#directBarrier = true;
				return;
			}
			this.#insertCandidate(candidate);
		});
	}

	async admit(definition: SpeculativeChildDefinition): Promise<SpeculativeChildHandle | undefined> {
		const environment = this.environment;
		if (!environment) {
			this.ineligible(
				definition.toolCall,
				"speculation coordinator has no admission environment",
				definition.source,
				definition.parentToolCallId,
			);
			return undefined;
		}
		let handle: SpeculativeChildHandle | undefined;
		this.#admission = this.#admission.then(async () => {
			const candidate = await this.#prepareCandidate(definition, environment);
			if (!candidate) return;
			this.#insertCandidate(candidate);
			handle = {
				candidateId: candidate.candidateId,
				fingerprint: candidate.fingerprint,
				effect: candidate.effect,
				outcome: candidate.outcome,
				commit: async actualArgs =>
					(await this.#commitCandidate(candidate, candidate.tool, candidate.toolCall, actualArgs))?.result,
				discard: reason => this.#discardCandidate(candidate, "discarded", reason),
			};
		});
		await this.#admission;
		return handle;
	}

	async #prepareCandidate(
		definition: Omit<SpeculativeChildDefinition, "parentToolCallId" | "source"> & {
			parentToolCallId?: string;
			source: "direct" | "eval_shadow";
		},
		environment: CoordinatorEnvironment,
	): Promise<SpeculativeToolCandidate | undefined> {
		const { toolCall, source, parentToolCallId } = definition;
		if (this.#closed) {
			this.ineligible(toolCall, "speculation coordinator is closed", source, parentToolCallId);
			return undefined;
		}
		if (this.#candidates.has(definition.candidateId)) {
			this.ineligible(toolCall, "duplicate speculation candidate ID", source, parentToolCallId);
			return undefined;
		}
		if (
			definition.dependencies.includes(definition.candidateId) ||
			new Set(definition.dependencies).size !== definition.dependencies.length
		) {
			this.ineligible(toolCall, "invalid speculation dependencies", source, parentToolCallId);
			return undefined;
		}
		if (environment.loopConfig.transformAssistantMessage) {
			this.ineligible(
				toolCall,
				"assistant message transformation prevents speculative execution",
				source,
				parentToolCallId,
			);
			return undefined;
		}
		const tool = definition.tool;
		const policy = tool.speculation?.finalized;
		if (!policy || typeof tool.concurrency === "function") {
			this.ineligible(toolCall, "tool is not speculation-safe", source, parentToolCallId);
			return undefined;
		}
		let validatedArgs: Record<string, unknown>;
		try {
			validatedArgs = validateToolArguments(tool, toolCall);
		} catch {
			if (!tool.lenientArgValidation) {
				this.ineligible(toolCall, "tool arguments are not valid", source, parentToolCallId);
				return undefined;
			}
			validatedArgs = { ...(toolCall.arguments as Record<string, unknown>) };
			delete validatedArgs.__parseError;
			delete validatedArgs.__rawJson;
		}
		let executionArgs: Record<string, unknown>;
		try {
			executionArgs = environment.loopConfig.transformToolCallArguments
				? environment.loopConfig.transformToolCallArguments(validatedArgs, toolCall.name)
				: validatedArgs;
		} catch {
			this.ineligible(toolCall, "tool argument transform failed", source, parentToolCallId);
			return undefined;
		}
		let assessment: ToolSpeculationAssessment;
		try {
			assessment = await policy.assess({ toolCall, args: executionArgs });
		} catch {
			this.ineligible(toolCall, "speculation assessment failed", source, parentToolCallId);
			return undefined;
		}
		if (!assessment.eligible) {
			this.ineligible(toolCall, assessment.reason, source, parentToolCallId);
			return undefined;
		}
		const effect = normalizeSpeculationEffect(assessment.effect);
		if (!effect) {
			this.ineligible(toolCall, "invalid speculation effect", source, parentToolCallId);
			return undefined;
		}
		if (tool.concurrency === "exclusive") {
			this.ineligible(toolCall, "exclusive tool is not speculation-safe", source, parentToolCallId);
			return undefined;
		}
		if (effect.kind !== "pure" && !this.config.host) {
			this.ineligible(toolCall, "effect requires host authorization", source, parentToolCallId);
			return undefined;
		}
		let fingerprint: string;
		try {
			fingerprint = createExecutionFingerprint(toolCall, executionArgs, effect);
		} catch {
			this.ineligible(toolCall, "speculation arguments are not canonical", source, parentToolCallId);
			return undefined;
		}
		const controller = new AbortController();
		const { promise, resolve, reject } = Promise.withResolvers<SpeculativePhysicalOutcome>();
		void promise.catch(() => undefined);
		const candidate: SpeculativeToolCandidate = {
			candidateId: definition.candidateId,
			parentToolCallId,
			source,
			dependencies: Object.freeze([...definition.dependencies]),
			dependents: new Set(),
			toolCall,
			tool,
			policy,
			executionArgs,
			effect,
			fingerprint,
			deferBeforeToolCall: false,
			virtualDurationMs: definition.virtualDurationMs,
			controller,
			outcome: promise,
			resolveOutcome: resolve,
			rejectOutcome: reject,
			state: "queued",
			claimed: false,
			reported: false,
		};
		const operationContext = this.#createContext(candidate);
		let authorization: SpeculativeAuthorization = { allowed: true };
		if (this.config.host) {
			try {
				authorization = await this.config.host.authorize(operationContext);
			} catch {
				this.ineligible(toolCall, "host speculation authorization failed", source, parentToolCallId);
				return undefined;
			}
		}
		if (!authorization.allowed) {
			this.ineligible(toolCall, authorization.reason, source, parentToolCallId);
			return undefined;
		}
		candidate.deferBeforeToolCall =
			authorization.deferBeforeToolCall === true && environment.loopConfig.beforeToolCall !== undefined;
		return candidate;
	}

	#insertCandidate(candidate: SpeculativeToolCandidate): void {
		this.#candidates.set(candidate.candidateId, candidate);
		for (const dependency of candidate.dependencies) {
			this.#candidates.get(dependency)?.dependents.add(candidate.candidateId);
		}
		for (const existing of this.#candidates.values()) {
			if (existing.dependencies.includes(candidate.candidateId)) candidate.dependents.add(existing.candidateId);
		}
		this.#drain();
	}

	async #discardInvalidGraph(): Promise<void> {
		const invalid = new Set<string>();
		for (const candidate of this.#candidates.values()) {
			if (candidate.dependencies.some(dependency => !this.#candidates.has(dependency)))
				invalid.add(candidate.candidateId);
		}
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (id: string): boolean => {
			if (visiting.has(id)) return true;
			if (visited.has(id)) return false;
			visiting.add(id);
			const candidate = this.#candidates.get(id);
			const cyclic = candidate?.dependencies.some(visit) ?? false;
			visiting.delete(id);
			visited.add(id);
			if (cyclic) invalid.add(id);
			return cyclic;
		};
		for (const id of this.#candidates.keys()) visit(id);
		await Promise.all(
			[...invalid]
				.map(id => this.#candidates.get(id))
				.filter((value): value is SpeculativeToolCandidate => value !== undefined)
				.map(candidate => this.#discardCandidate(candidate, "discarded", "invalid speculation dependency graph")),
		);
	}

	#drain(): void {
		if (this.#closed) return;
		for (const candidate of this.#candidates.values()) {
			if (this.#running >= this.maxInFlight) return;
			if (candidate.state !== "queued") continue;
			// A host may defer a local read until the finalized call survives
			// validation and the consumer's beforeToolCall hook.
			if (candidate.deferBeforeToolCall && !this.#admissionsFinalized) continue;
			const dependencies = candidate.dependencies.map(id => this.#candidates.get(id));
			if (dependencies.some(value => value === undefined)) {
				if (this.#admissionsFinalized) {
					void this.#discardCandidate(candidate, "discarded", "unknown speculation dependency");
				}
				continue;
			}
			const failedDependency = dependencies.find(value => value?.state === "failed" || value?.state === "discarded");
			if (failedDependency) {
				void this.#discardCandidate(
					candidate,
					"discarded",
					`dependency ${failedDependency.candidateId} did not settle successfully`,
				);
				continue;
			}
			if (!dependencies.every(value => value?.state === "completed")) continue;
			this.#startCandidate(candidate, dependencies as SpeculativeToolCandidate[]);
		}
	}

	#startCandidate(candidate: SpeculativeToolCandidate, dependencies: SpeculativeToolCandidate[]): void {
		candidate.state = "running";
		candidate.startedAt = Date.now();
		candidate.virtualStartedAt = dependencies.reduce(
			(maximum, dependency) => Math.max(maximum, dependency.virtualFinishedAt ?? 0),
			0,
		);
		this.#running++;
		const environmentSignal = this.environment?.signal;
		const signal = environmentSignal
			? AbortSignal.any([environmentSignal, candidate.controller.signal])
			: candidate.controller.signal;
		const executionContext: ToolSpeculationExecutionContext = {
			toolCall: candidate.toolCall,
			args: candidate.executionArgs,
			effect: candidate.effect,
		};
		void (async () => {
			try {
				const outcome = await candidate.policy.execute(executionContext, signal);
				if (candidate.state === "discarded") return;
				candidate.finishedAt = Date.now();
				const duration =
					candidate.virtualDurationMs ??
					Math.max(0, candidate.finishedAt - (candidate.startedAt ?? candidate.finishedAt));
				candidate.virtualFinishedAt = (candidate.virtualStartedAt ?? 0) + duration;
				candidate.state = outcome.kind === "result" && outcome.isError ? "failed" : "completed";
				candidate.resolveOutcome(outcome);
				if (candidate.state === "failed") {
					await Promise.all(
						[...candidate.dependents]
							.map(id => this.#candidates.get(id))
							.filter((value): value is SpeculativeToolCandidate => value !== undefined)
							.map(value =>
								this.#discardCandidate(value, "discarded", `dependency ${candidate.candidateId} failed`),
							),
					);
				}
			} catch (error) {
				if (candidate.state !== "discarded") {
					candidate.finishedAt = Date.now();
					candidate.state = "failed";
					candidate.rejectOutcome(error);
					await Promise.all(
						[...candidate.dependents]
							.map(id => this.#candidates.get(id))
							.filter((value): value is SpeculativeToolCandidate => value !== undefined)
							.map(value =>
								this.#discardCandidate(value, "discarded", `dependency ${candidate.candidateId} failed`),
							),
					);
				}
			} finally {
				this.#running--;
				this.#drain();
			}
		})();
	}
}
