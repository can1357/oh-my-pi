/**
 * OMP → Tokenomics emission bridge.
 *
 * Tokenomics owns measurement semantics (aggregate, outcome tiers, schema).
 * OMP owns *when* events happen. This module only maps OMP usage/counters
 * into Tokenomics events and appends durable JSONL (OTLP optional later).
 *
 * Does NOT invent root counters or reimplement summarizeTrace logic.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	JsonlSink,
	makeEvent,
	MemorySink,
	MultiSink,
	Recorder,
	summarizeTrace,
	treatmentHash,
	type ContextEconomics,
	type ExecutionRole,
	type Experiment,
	type Outcome,
	type TokenomicsEvent,
	type TraceSummary,
	type TokenUsage,
} from "@agent-tokenomics/core";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { RlmMetrics } from "./store";
import type { EvidenceQualityLabel } from "./accounting";

export type ContextPolicy = "native" | "rlm-fixed-grant" | "rlm-search-grants" | "rlm-search-grants-groq";

export interface TokenomicsBridgeOptions {
	sessionId: string;
	/** Default ~/.omp/tokenomics */
	dir?: string;
	/** Disable file sink (tests). */
	memoryOnly?: boolean;
	contextPolicy?: ContextPolicy;
	experimentId?: string;
	taskSnapshotId?: string;
	taskId?: string;
	/** Override arm A/B/C */
	armId?: string;
	harness?: string;
	/** When false, no-op recorder (stock path can leave unset). */
	enabled?: boolean;
}

export interface ModelCallEmit {
	role: ExecutionRole;
	name?: string;
	provider?: string;
	model?: string;
	usage?: Usage | null;
	/** Prefer provider-reported; never invent from chars when usage present. */
	status?: "ok" | "error" | "cancelled" | "unknown";
	durationMs?: number;
	ttftMs?: number;
	costUsd?: number;
	/** If true, skip emission when usage missing (default true for provider path). */
	requireUsage?: boolean;
	attributes?: Record<string, string | number | boolean | undefined>;
}

function sessionTraceId(sessionId: string): string {
	return createHash("sha256").update(`omp-session:${sessionId}`).digest("hex").slice(0, 32);
}

function mapUsage(usage: Usage | null | undefined, attribution: TokenUsage["attribution"]): TokenUsage | undefined {
	if (!usage) return undefined;
	const costTotal = usage.cost?.total;
	const mapped: TokenUsage = {
		input_tokens: usage.input,
		output_tokens: usage.output,
		cached_input_tokens: usage.cacheRead,
		cache_write_input_tokens: usage.cacheWrite,
		reasoning_tokens: usage.reasoningTokens,
		reported_total_tokens: usage.totalTokens,
		attribution: attribution ?? "incremental",
		source: "provider",
	};
	return mapped;
}

function armForPolicy(policy: ContextPolicy): string {
	if (policy === "native") return "A";
	if (policy === "rlm-fixed-grant") return "B";
	if (policy === "rlm-search-grants-groq") return "D";
	return "C";
}

function evidenceToOutcome(label?: EvidenceQualityLabel): Outcome | undefined {
	if (!label) return undefined;
	// Manual/fixture only — never auto-gold from turn_end.
	if (label === "SUPPORTED") {
		return {
			verified_success: true,
			verification_source: "manual",
			note: label,
		};
	}
	if (label === "MISSED_EVIDENCE" || label === "UNSUPPORTED" || label === "WRONG_CITATION") {
		return {
			execution_completed: true,
			verified_success: false,
			verification_source: "manual",
			note: label,
			user_correction: label === "WRONG_CITATION" ? true : undefined,
		};
	}
	return undefined;
}

/**
 * Session-scoped Tokenomics emitter. One trace_id per OMP session.
 */
export class OmpTokenomicsBridge {
	readonly enabled: boolean;
	readonly traceId: string;
	readonly sessionId: string;
	readonly contextPolicy: ContextPolicy;
	readonly experiment: Experiment;
	readonly jsonlPath?: string;
	readonly #memory = new MemorySink();
	readonly #recorder: Recorder | null;
	#closed = false;

	constructor(options: TokenomicsBridgeOptions) {
		this.enabled = options.enabled !== false;
		this.sessionId = options.sessionId;
		this.traceId = sessionTraceId(options.sessionId);
		this.contextPolicy = options.contextPolicy ?? "native";
		const arm = options.armId ?? armForPolicy(this.contextPolicy);
		this.experiment = {
			experiment_id: options.experimentId ?? "omp-daily-drive",
			task_snapshot_id: options.taskSnapshotId,
			arm_id: arm,
			treatment_hash: treatmentHash({ context_policy: this.contextPolicy }),
			selection_policy: "operator",
		};

		if (!this.enabled) {
			this.#recorder = null;
			return;
		}

		const sinks: ConstructorParameters<typeof MultiSink>[0] = [this.#memory];
		if (!options.memoryOnly) {
			const dir = options.dir ?? join(process.env.HOME ?? "/tmp", ".omp", "tokenomics");
			const day = new Date().toISOString().slice(0, 10);
			this.jsonlPath = join(dir, `events-${day}.jsonl`);
			sinks.push(new JsonlSink(this.jsonlPath));
		}
		this.#recorder = new Recorder(new MultiSink(sinks));
	}

	/** In-memory events for tests / status. */
	get events(): readonly TokenomicsEvent[] {
		return this.#memory.events;
	}

	async #record(event: TokenomicsEvent): Promise<TokenomicsEvent | null> {
		if (!this.#recorder || this.#closed) return null;
		try {
			return await this.#recorder.record(event);
		} catch {
			// fail-open: never break agent turns for telemetry
			return null;
		}
	}

	baseFields(extra?: { taskId?: string }) {
		return {
			trace_id: this.traceId,
			session_id: this.sessionId,
			task_id: extra?.taskId,
			harness: "omp",
			service: "omp-coding-agent",
			experiment: { ...this.experiment },
		} as const;
	}

	/** Phase 1: one incremental event per actual model invocation. */
	async emitModelCall(call: ModelCallEmit): Promise<TokenomicsEvent | null> {
		if (!this.enabled) return null;
		const requireUsage = call.requireUsage !== false;
		const usage = mapUsage(call.usage, "incremental");
		if (requireUsage && !usage) return null;

		const started =
			call.durationMs !== undefined ? Date.now() / 1000 - call.durationMs / 1000 : undefined;
		const ended = Date.now() / 1000;

		return this.#record(
			makeEvent({
				...this.baseFields(),
				kind: "llm",
				name: call.name ?? (call.role === "rlm_worker" ? "omp.rlm_worker" : `omp.${call.role}`),
				role: call.role,
				status: call.status ?? "ok",
				model: {
					provider: call.provider,
					name: call.model,
					role: call.role,
				},
				usage,
				economics:
					call.costUsd !== undefined || call.usage?.cost?.total !== undefined
						? { cost_usd: call.costUsd ?? call.usage?.cost?.total }
						: undefined,
				latency: {
					duration_ms: call.durationMs,
					time_to_first_chunk_ms: call.ttftMs,
				},
				started_at: started,
				ended_at: ended,
				attributes: {
					"tokenomics.context.policy": this.contextPolicy,
					...(call.attributes ?? {}),
				},
			}),
		);
	}

	/**
	 * Phase 2: RLM context economics snapshot (store counters).
	 * Does not move counters into Tokenomics — only copies a point-in-time view.
	 */
	async emitContextSnapshot(metrics: Partial<RlmMetrics> & {
		grantedBytes?: number;
		policy?: string;
	}): Promise<TokenomicsEvent | null> {
		if (!this.enabled) return null;
		const ctx: ContextEconomics = {
			policy: metrics.policy ?? this.contextPolicy,
			spill_count: metrics.spills,
			spilled_bytes: metrics.bytesSpilled,
			retrieval_calls: metrics.searches,
			granted_bytes: metrics.grantedBytes ?? metrics.bytesReintroduced,
			reintroduced_bytes: metrics.bytesReintroduced,
			worker_calls_avoided: metrics.workerCallsAvoided,
		};
		return this.#record(
			makeEvent({
				...this.baseFields(),
				kind: "context",
				name: "omp.rlm.context",
				role: "rlm_worker",
				status: "ok",
				context: ctx,
				attributes: {
					"tokenomics.context.policy": ctx.policy ?? this.contextPolicy,
					"omp.rlm.queries": metrics.queries ?? 0,
					"omp.rlm.subcalls": metrics.subcalls ?? 0,
					"omp.rlm.grants_selected": metrics.grantsSelected ?? 0,
					"omp.rlm.peeks": metrics.peeks ?? 0,
					"omp.rlm.worker_calls": metrics.workerCalls ?? 0,
				},
			}),
		);
	}

	/**
	 * Phase 3: session/provider aggregate for reconciliation only.
	 * Tokenomics summarizeTrace does NOT add this into total_tokens.
	 */
	async emitSessionAggregate(usage: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: number;
	}): Promise<TokenomicsEvent | null> {
		if (!this.enabled) return null;
		return this.#record(
			makeEvent({
				...this.baseFields(),
				kind: "llm",
				name: "omp.session.aggregate",
				role: "other",
				status: "ok",
				usage: {
					input_tokens: usage.input,
					output_tokens: usage.output,
					cached_input_tokens: usage.cacheRead,
					cache_write_input_tokens: usage.cacheWrite,
					reported_total_tokens: usage.totalTokens,
					attribution: "aggregate",
					source: "provider",
				},
				economics: usage.cost !== undefined ? { cost_usd: usage.cost } : undefined,
			}),
		);
	}

	/**
	 * Phase 6: verified outcomes only with a real verifier source.
	 * turn_end / tool ok → execution tier at most, never gold.
	 */
	async emitOutcome(input: {
		kind?: "verification" | "other";
		name?: string;
		executionCompleted?: boolean;
		evidenceQuality?: EvidenceQualityLabel;
		outcome?: Outcome;
	}): Promise<TokenomicsEvent | null> {
		if (!this.enabled) return null;
		let outcome = input.outcome ?? evidenceToOutcome(input.evidenceQuality);
		if (!outcome && input.executionCompleted) {
			outcome = {
				execution_completed: true,
				source: "omp_turn_end",
			};
		}
		if (!outcome) return null;
		return this.#record(
			makeEvent({
				...this.baseFields(),
				kind: input.kind ?? (outcome.verification_source ? "verification" : "other"),
				name: input.name ?? (outcome.verification_source ? "omp.verifier" : "omp.execution"),
				role: outcome.verification_source ? "verifier" : "other",
				status: outcome.verified_success === false ? "error" : "ok",
				outcome,
			}),
		);
	}

	/**
	 * Observe-only Decider shadow for rlm.worker_needed.
	 * Attaches to the session trace; never credits tokens_saved / latency_saved.
	 */
	async emitShadowWorkerNeeded(input: {
		pairId: string;
		taskSnapshotId: string;
		armId: string;
		treatmentHash: string;
		status: "ok" | "error" | "cancelled" | "unknown";
		prediction?: string;
		probabilities?: Record<string, number>;
		confidence?: number;
		abstained?: boolean;
		latencyMs?: number;
		revision?: string;
		actualPolicy: string;
		featureSchema: string;
		grantedBytes: number;
		complexityClass: string;
		errorClass?: string;
		reason?: string;
		runtime?: {
			residency?: string;
			backendLoaded?: boolean;
			backendLoadMs?: number;
			inferenceMs?: number;
			queueMs?: number;
			ipcMs?: number;
			bridgeGeneration?: number;
			bridgeBuildId?: string;
			bridgeInstanceId?: string;
		};
	}): Promise<TokenomicsEvent | null> {
		if (!this.enabled) return null;
		const runtime = input.runtime;
		const experiment = {
			experiment_id: "omp-shadow-rlm-worker-needed-v1",
			pair_id: input.pairId,
			task_snapshot_id: input.taskSnapshotId,
			arm_id: input.armId,
			treatment_hash: input.treatmentHash,
			selection_policy: "shadow",
			replay_grade: "live_shadow",
		};
		const decision = await this.#record(
			makeEvent({
				...this.baseFields(),
				kind: "decision",
				name: "omp.shadow.rlm.worker_needed",
				capability_id: "rlm.worker_needed",
				role: "router",
				status: input.status,
				model: {
					provider: "local",
					name: input.armId,
					revision: input.revision,
					role: "router",
				},
				latency: input.latencyMs !== undefined ? { duration_ms: input.latencyMs } : undefined,
				experiment,
				// Shadow compute is real cost later; never claim savings while observe-only.
				economics: {
					estimated_tokens_avoided: 0,
					measured_tokens_avoided: 0,
				},
				attributes: {
					"decision.shadow": true,
					"decision.prediction": input.prediction ?? "",
					"decision.confidence": input.confidence ?? -1,
					"decision.abstained": Boolean(input.abstained),
					"omp.actual_policy": input.actualPolicy,
					"omp.feature_schema": input.featureSchema,
					"omp.granted_bytes": input.grantedBytes,
					"omp.complexity_class": input.complexityClass,
					"tokenomics.context.policy": this.contextPolicy,
					"shadow.backend": input.armId,
					"shadow.runtime": runtime?.residency === "warm" ? "resident" : (runtime?.residency ?? "unknown"),
					"shadow.backend_loaded": Boolean(runtime?.backendLoaded),
					...(runtime?.bridgeGeneration !== undefined
						? { "shadow.bridge_generation": runtime.bridgeGeneration }
						: {}),
					...(runtime?.bridgeBuildId ? { "shadow.bridge_build_id": runtime.bridgeBuildId } : {}),
					...(runtime?.backendLoadMs !== undefined ? { "shadow.backend_load_ms": runtime.backendLoadMs } : {}),
					...(runtime?.inferenceMs !== undefined ? { "shadow.inference_ms": runtime.inferenceMs } : {}),
					...(runtime?.queueMs !== undefined ? { "shadow.queue_ms": runtime.queueMs } : {}),
					...(runtime?.ipcMs !== undefined ? { "shadow.ipc_ms": runtime.ipcMs } : {}),
					...(input.errorClass ? { "benchmark.error_class": input.errorClass } : {}),
				},
				extra: {
					"decision.probabilities": input.probabilities ?? {},
					"benchmark.reason": input.reason,
					source: "live_shadow",
					"shadow.bridge_instance_id": runtime?.bridgeInstanceId,
				},
			}),
		);

		// Actual OMP policy action (not gold).
		await this.#record(
			makeEvent({
				...this.baseFields(),
				kind: "decision",
				name: "omp.policy.rlm.worker_needed",
				capability_id: "rlm.worker_needed",
				role: "router",
				status: "ok",
				experiment: {
					...experiment,
					selection_policy: "operator",
					arm_id: "omp_auto_policy",
				},
				attributes: {
					"decision.shadow": false,
					"omp.actual_policy": input.actualPolicy,
					"omp.feature_schema": input.featureSchema,
				},
				extra: { source: "live_policy" },
			}),
		);

		// Gold unknown until counterfactual / verifier joins later.
		await this.#record(
			makeEvent({
				...this.baseFields(),
				kind: "verification",
				name: "omp.shadow.rlm.worker_needed.gold",
				capability_id: "rlm.worker_needed",
				role: "verifier",
				status: "unknown",
				experiment,
				outcome: {
					source: "omp_shadow",
					verification_source: "pending_counterfactual",
					note: "gold unknown — do not train on this row",
				},
				attributes: {
					"decision.gold_status": "unknown",
					"decision.shadow": true,
				},
				extra: { source: "live_shadow" },
			}),
		);

		return decision;
	}

	/**
	 * Append gold verification to an existing shadow pair (same session trace).
	 */
	async emitShadowWorkerNeededGold(input: {
		pairId: string;
		taskSnapshotId?: string;
		armId?: string;
		treatmentHash?: string;
		gold: string;
		correct?: boolean;
		verificationSource: string;
		dangerousFalse?: boolean;
		/** Override experiment id (paired replay uses rlm-worker-needed-replay-v1). */
		experimentId?: string;
		/** Opaque private replay snapshot id — never grant bodies. */
		replaySnapshotId?: string;
	}): Promise<TokenomicsEvent | null> {
		if (!this.enabled) return null;
		const goldKnown = input.gold !== "UNKNOWN";
		return this.#record(
			makeEvent({
				...this.baseFields(),
				kind: "verification",
				name: "omp.shadow.rlm.worker_needed.gold",
				capability_id: "rlm.worker_needed",
				role: "verifier",
				status: goldKnown ? "ok" : "unknown",
				experiment: {
					experiment_id: input.experimentId ?? "omp-shadow-rlm-worker-needed-v1",
					pair_id: input.pairId,
					task_snapshot_id: input.taskSnapshotId,
					arm_id: input.armId ?? "decider_2b",
					treatment_hash: input.treatmentHash,
					selection_policy: input.experimentId ? "counterfactual_replay" : "shadow",
					replay_grade: "counterfactual",
				},
				outcome: {
					verified_success: goldKnown ? input.correct : undefined,
					verifier_ok: goldKnown ? input.correct : undefined,
					verification_source: input.verificationSource,
					source: "omp_counterfactual",
				},
				attributes: {
					"decision.gold": input.gold,
					"decision.gold_status": goldKnown ? "known" : "unknown",
					"decision.correct": Boolean(input.correct) && goldKnown,
					"decision.dangerous_false": Boolean(input.dangerousFalse),
					...(input.replaySnapshotId ? { "replay.snapshot_id": input.replaySnapshotId } : {}),
				},
			}),
		);
	}

	/** Summarize in-memory events via Tokenomics (no OMP reimplementation). */
	summary(): TraceSummary | null {
		if (!this.#memory.events.length) return null;
		try {
			return summarizeTrace([...this.#memory.events]);
		} catch {
			return null;
		}
	}

	formatStatusLine(): string {
		const s = this.summary();
		if (!s) return "tokenomics: no events";
		const parts = [
			`trace=${s.trace_id.slice(0, 8)}`,
			`policy=${this.contextPolicy}`,
			`root=${s.root_tokens}`,
			`rlm=${s.worker_tokens}`,
			`sub=${s.subagent_tokens}`,
			`total=${s.total_tokens}`,
			`cost=${s.cost_usd.toFixed(4)}`,
			`tier=${s.outcome_tier}`,
			`events=${s.event_count}`,
		];
		if (s.aggregate_reported_tokens !== undefined) {
			parts.push(`agg=${s.aggregate_reported_tokens}`);
			parts.push(`Δ=${s.reconciliation_delta ?? 0}`);
		}
		if (this.jsonlPath) parts.push(`jsonl=${this.jsonlPath}`);
		return parts.join(" ");
	}

	/**
	 * End-of-task flush: context snapshot + aggregate + optional verifier + summary line.
	 */
	async flushTask(args: {
		metrics?: Partial<RlmMetrics> & { grantedBytes?: number };
		sessionRaw?: {
			input: number;
			output: number;
			cacheRead?: number;
			cacheWrite?: number;
			totalTokens?: number;
			cost?: number;
		};
		evidenceQuality?: EvidenceQualityLabel;
		executionCompleted?: boolean;
	}): Promise<{ summary: TraceSummary | null; line: string; events: number }> {
		if (args.metrics) {
			await this.emitContextSnapshot({
				...args.metrics,
				policy: this.contextPolicy,
			});
		}
		if (args.sessionRaw) {
			await this.emitSessionAggregate(args.sessionRaw);
		}
		if (args.evidenceQuality) {
			await this.emitOutcome({ evidenceQuality: args.evidenceQuality });
		} else if (args.executionCompleted) {
			await this.emitOutcome({ executionCompleted: true });
		}
		return {
			summary: this.summary(),
			line: this.formatStatusLine(),
			events: this.#memory.events.length,
		};
	}
}

/** Derive treatment from session settings. */
export function deriveContextPolicy(settings?: {
	get?: (path: string) => unknown;
}): ContextPolicy {
	const engine = settings?.get?.("context.engine");
	const rlmOn = settings?.get?.("rlm.enabled") === true || engine === "rlm";
	if (!rlmOn) return "native";
	// Default experimental preference: search-driven grants (arm C).
	// Fixed-grant arm is selected only when OMP_RLM_POLICY=fixed.
	const env = process.env.OMP_RLM_POLICY?.trim().toLowerCase();
	if (env === "fixed" || env === "rlm-fixed-grant" || env === "b") return "rlm-fixed-grant";
	const workerMode = settings?.get?.("rlm.workerMode");
	if (workerMode === "evidence-packet") return "rlm-search-grants-groq";
	if (workerMode === "auto") return "rlm-search-grants";
	return "rlm-search-grants";
}

/** Lazy attach helper for AgentSession. */
export function createTokenomicsBridge(options: TokenomicsBridgeOptions): OmpTokenomicsBridge {
	const envOff = process.env.OMP_TOKENOMICS === "0" || process.env.OMP_TOKENOMICS === "false";
	return new OmpTokenomicsBridge({
		...options,
		enabled: options.enabled !== false && !envOff,
	});
}
