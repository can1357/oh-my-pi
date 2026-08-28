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
	SpeculativeEgress,
	SpeculativeInformationOrigin,
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

function normalizeAuthority(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname !== "/" || url.search) {
			return undefined;
		}
		return url.origin;
	} catch {
		return undefined;
	}
}

function normalizeResources(value: unknown): readonly SpeculativeResourceAccess[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const resources: SpeculativeResourceAccess[] = [];
	const accesses = new Map<string, "read" | "write">();
	for (const item of value) {
		if (!isPlainRecord(item) || !hasExactKeys(item, ["scheme", "path", "access"])) return undefined;
		if (item.scheme !== "file" || typeof item.path !== "string" || !path.isAbsolute(item.path)) return undefined;
		if (item.access !== "read" && item.access !== "write") return undefined;
		if (accesses.has(item.path)) return undefined;
		accesses.set(item.path, item.access);
		resources.push(Object.freeze({ scheme: "file", path: item.path, access: item.access }));
	}
	return Object.freeze(resources);
}

function normalizeEgress(value: unknown): readonly SpeculativeEgress[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const egress: SpeculativeEgress[] = [];
	for (const item of value) {
		if (!isPlainRecord(item) || !hasExactKeys(item, ["authority", "origins"])) return undefined;
		const authority = normalizeAuthority(item.authority);
		if (!authority || seen.has(authority) || !Array.isArray(item.origins)) return undefined;
		const origins: SpeculativeInformationOrigin[] = [];
		for (const origin of item.origins) {
			if (!isPlainRecord(origin) || typeof origin.kind !== "string") return undefined;
			switch (origin.kind) {
				case "provider_literal":
				case "persistent_state":
					if (!hasExactKeys(origin, ["kind"])) return undefined;
					origins.push(Object.freeze({ kind: origin.kind }));
					break;
				case "local_read":
					if (typeof origin.resource !== "string" || !hasExactKeys(origin, ["kind", "resource"])) return undefined;
					origins.push(Object.freeze({ kind: origin.kind, resource: origin.resource }));
					break;
				case "remote_read": {
					const originAuthority = normalizeAuthority(origin.authority);
					if (!originAuthority || !hasExactKeys(origin, ["kind", "authority"])) return undefined;
					origins.push(Object.freeze({ kind: origin.kind, authority: originAuthority }));
					break;
				}
				case "model_completion": {
					const originAuthority = normalizeAuthority(origin.authority);
					if (
						typeof origin.provider !== "string" ||
						origin.provider.length === 0 ||
						!originAuthority ||
						!hasExactKeys(origin, ["kind", "provider", "authority"])
					) {
						return undefined;
					}
					origins.push(
						Object.freeze({ kind: origin.kind, provider: origin.provider, authority: originAuthority }),
					);
					break;
				}
				default:
					return undefined;
			}
		}
		seen.add(authority);
		egress.push(Object.freeze({ authority, origins: Object.freeze(origins) }));
	}
	return Object.freeze(egress);
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

/** Rejects malformed or ambiguous effects and returns a frozen logical identity. */
export function normalizeSpeculationEffect(effect: unknown): ToolSpeculationEffect | undefined {
	if (!isPlainRecord(effect) || typeof effect.kind !== "string") return undefined;
	if (effect.kind === "pure" && hasExactKeys(effect, ["kind"])) return Object.freeze({ kind: "pure" });
	if (effect.kind === "local_read" && hasExactKeys(effect, ["kind", "resources"])) {
		const resources = normalizeResources(effect.resources);
		return resources ? Object.freeze({ kind: "local_read", resources }) : undefined;
	}
	if (effect.kind === "reversible_write" && hasExactKeys(effect, ["kind", "isolation", "resources"])) {
		const resources = normalizeResources(effect.resources);
		return effect.isolation === "pal" && resources
			? Object.freeze({ kind: "reversible_write", isolation: "pal", resources })
			: undefined;
	}
	if (effect.kind === "irreversible_write" && hasExactKeys(effect, ["kind", "reason"])) {
		return typeof effect.reason === "string" && effect.reason.length > 0
			? Object.freeze({ kind: "irreversible_write", reason: effect.reason })
			: undefined;
	}
	if (
		effect.kind === "remote_read" &&
		hasExactKeys(effect, ["kind", "transport", "egress"]) &&
		isPlainRecord(effect.transport)
	) {
		const transport = effect.transport;
		if (!hasExactKeys(transport, ["url", "headers", "credentials", "cache", "redirect"])) return undefined;
		if (typeof transport.url !== "string" || !isPlainRecord(transport.headers)) return undefined;
		let url: URL;
		try {
			url = new URL(transport.url);
		} catch {
			return undefined;
		}
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.hash ||
			url.href !== transport.url ||
			transport.credentials !== "omit" ||
			transport.cache !== "no-store" ||
			transport.redirect !== "error"
		) {
			return undefined;
		}
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(transport.headers)) {
			const normalizedName = name.toLowerCase();
			if (
				typeof value !== "string" ||
				headers[normalizedName] !== undefined ||
				!["accept", "cache-control", "pragma", "user-agent"].includes(normalizedName) ||
				/[\r\n]/.test(name) ||
				/[\r\n]/.test(value)
			) {
				return undefined;
			}
			headers[normalizedName] = value;
		}
		if (headers["cache-control"] !== "no-store" || headers.pragma !== "no-cache") return undefined;
		const egress = normalizeEgress(effect.egress);
		if (!egress) return undefined;
		const normalizedTransport = Object.freeze({
			url: url.href,
			headers: Object.freeze(Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)))),
			credentials: "omit" as const,
			cache: "no-store" as const,
			redirect: "error" as const,
		});
		return Object.freeze({ kind: "remote_read", transport: normalizedTransport, egress });
	}
	if (effect.kind === "model_completion" && hasExactKeys(effect, ["kind", "provider", "model", "baseUrl", "egress"])) {
		const baseUrl = normalizeAuthority(effect.baseUrl);
		const egress = normalizeEgress(effect.egress);
		return typeof effect.provider === "string" &&
			effect.provider.length > 0 &&
			typeof effect.model === "string" &&
			effect.model.length > 0 &&
			baseUrl &&
			egress
			? Object.freeze({ kind: "model_completion", provider: effect.provider, model: effect.model, baseUrl, egress })
			: undefined;
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
	return effect.kind === "local_read" || effect.kind === "reversible_write" ? effect.resources.length : 0;
}

function egressAuthority(effect: ToolSpeculationEffect): string | undefined {
	return effect.kind === "remote_read" || effect.kind === "model_completion" ? effect.egress[0]?.authority : undefined;
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
		if (this.#candidates.size > 0 || this.#streamSessions.size > 0) coordinatorByMessage.set(message, this);
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
			staged: candidate.effect.kind === "reversible_write",
			resourceCount: resourceCount(candidate.effect),
			egressAuthority: egressAuthority(candidate.effect),
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
			effectKind: "irreversible_write",
			dependencyCount: 0,
			outcome: "ineligible",
			reason,
			staged: false,
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
			if (!finalCall || finalCall.name !== candidate.toolCall.name) {
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
		let assessment: ToolSpeculationAssessment;
		try {
			assessment = await candidate.policy.assess({ toolCall, args });
		} catch {
			assessment = { eligible: false, reason: "final speculation assessment failed" };
		}
		const effect = assessment.eligible ? normalizeSpeculationEffect(assessment.effect) : undefined;
		let fingerprint: string | undefined;
		try {
			if (effect) fingerprint = createExecutionFingerprint(toolCall, args, effect);
		} catch {
			fingerprint = undefined;
		}
		if (candidate.tool !== tool || !effect || fingerprint !== candidate.fingerprint) {
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
		if (physicalOutcome.kind === "result" && physicalOutcome.isError) {
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
			const commitDefault = async (): Promise<AgentToolResult<unknown>> => {
				if (candidate.policy.commit) return candidate.policy.commit(context, physicalOutcome);
				if (physicalOutcome.kind === "result") return physicalOutcome.result;
				throw new Error("A staged speculative outcome requires a commit policy");
			};
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
				isError: decision.result.isError === true || (physicalOutcome.kind === "result" && physicalOutcome.isError),
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
		if (!effect || effect.kind === "irreversible_write") {
			this.ineligible(toolCall, "invalid or irreversible speculation effect", source, parentToolCallId);
			return undefined;
		}
		if (tool.concurrency === "exclusive" && effect.kind !== "reversible_write") {
			this.ineligible(toolCall, "exclusive tool is not a reversible write", source, parentToolCallId);
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
			// Provider completions have irreversible spend, while a host can defer
			// any candidate until the finalized call survives validation and the
			// consumer's beforeToolCall hook. Neither class may start while final
			// admission is still open.
			if (
				(candidate.effect.kind === "model_completion" || candidate.deferBeforeToolCall) &&
				!this.#admissionsFinalized
			) {
				continue;
			}
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
		const operationContext = this.#createContext(candidate);
		const executionContext: ToolSpeculationExecutionContext = {
			toolCall: candidate.toolCall,
			args: candidate.executionArgs,
			effect: candidate.effect,
		};
		void (async () => {
			try {
				const executeDefault = () => candidate.policy.execute(executionContext, signal);
				const outcome = this.config.host?.execute
					? await this.config.host.execute(operationContext, executeDefault)
					: await executeDefault();
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
