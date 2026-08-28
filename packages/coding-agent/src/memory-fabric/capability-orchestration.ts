/**
 * Capability Orchestration Core — registry, matching, and pure planning.
 *
 * Foundation of the capability track. Provides:
 *   - `CapabilityDescriptor` vocabulary shared by the whole capability suite.
 *   - `CapabilityCache`: an in-memory registry with lexical matching.
 *   - `CapabilityPlanner`: builds execution plans and evaluates per-step
 *     approval decisions — it NEVER executes anything. Execution belongs to
 *     the real agent runtime behind its own approval flow.
 *
 * Discipline:
 *   - Pure and deterministic: plan ids come from an injectable factory
 *     (monotonic counter fallback), never from Date.now()/Math.random().
 *   - Decision-only: `evaluatePlan` returns approval decisions; callers
 *     execute approved steps through their own paths.
 *   - Fail-open matching: `resolveCapabilitiesFailOpen` falls back rather
 *     than throwing.
 */

export type CapabilityKind = "tool" | "subagent" | "skill" | "sidecar";

export type RolloutMode = "off" | "suggest" | "active" | "autonomous";

export interface CapabilityDescriptor {
	id: string;
	kind: CapabilityKind;
	name: string;
	description: string;
	inputSchema?: Record<string, unknown>;
	tags: string[];
	version: number;
	enabled: boolean;
	requiresApproval?: boolean;
	metadata?: Record<string, unknown>;
}

export interface CapabilityMatch {
	descriptor: CapabilityDescriptor;
	/** Fraction of query terms found in the descriptor text, rounded to 2 dp. */
	matchScore: number;
	reason: string;
}

export interface ExecutionPlanStep {
	stepIndex: number;
	capabilityId: string;
	actionName: string;
	args: Record<string, unknown>;
	approvalRequired: boolean;
}

export interface ExecutionPlan {
	planId: string;
	intent: string;
	steps: ExecutionPlanStep[];
	rolloutMode: RolloutMode;
}

export interface StepApprovalDecision {
	stepIndex: number;
	capabilityId: string;
	approved: boolean;
	reason: string;
}

export interface TelemetryEvent {
	timestamp: string;
	type: string;
	details: Record<string, unknown>;
}

/**
 * In-memory capability registry with lexical matching.
 * Pure data structure — registration and lookup only, no IO.
 */
export class CapabilityCache {
	#descriptors = new Map<string, CapabilityDescriptor>();
	#cacheVersion = 1;

	/**
	 * Register or update a capability. Re-registering an existing id bumps its
	 * stored version by one; a fresh registration keeps the declared version
	 * (or 1 when the declared version is not a positive number).
	 */
	registerCapability(descriptor: CapabilityDescriptor): void {
		const existing = this.#descriptors.get(descriptor.id);
		const declared = Number.isFinite(descriptor.version) && descriptor.version > 0 ? descriptor.version : 1;
		const newVersion = existing ? existing.version + 1 : declared;

		this.#descriptors.set(descriptor.id, { ...descriptor, version: newVersion });
		this.#cacheVersion++;
	}

	/** Enabled descriptor by id, or null when missing or disabled. */
	getCapability(id: string): CapabilityDescriptor | null {
		const desc = this.#descriptors.get(id);
		return desc?.enabled ? desc : null;
	}

	/**
	 * Lexical match over name + description + tags.
	 *
	 * Candidates are ranked by their RAW term-hit ratio (rounding happens only
	 * in the reported matchScore, so display rounding can never reorder or tie
	 * candidates that genuinely differ).
	 */
	matchCapabilities(query: string, options: { kind?: CapabilityKind; limit?: number } = {}): CapabilityMatch[] {
		const limit = options.limit ?? 5;
		const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
		const scored: Array<{ match: CapabilityMatch; rawScore: number }> = [];

		for (const desc of this.#descriptors.values()) {
			if (!desc.enabled) continue;
			if (options.kind && desc.kind !== options.kind) continue;

			const searchText = `${desc.name} ${desc.description} ${desc.tags.join(" ")}`.toLowerCase();
			let hits = 0;
			for (const term of queryTerms) {
				if (searchText.includes(term)) hits++;
			}

			const rawScore = queryTerms.length > 0 ? hits / queryTerms.length : 0.5;
			if (queryTerms.length === 0 || rawScore > 0) {
				scored.push({
					rawScore,
					match: {
						descriptor: desc,
						matchScore: Number(rawScore.toFixed(2)),
						reason: `Matched ${hits} query term(s)`,
					},
				});
			}
		}

		return scored
			.sort((a, b) => b.rawScore - a.rawScore)
			.slice(0, limit)
			.map(s => s.match);
	}

	/** Match, falling back to the supplied list on zero hits or internal error. */
	resolveCapabilitiesFailOpen(query: string, fallback: CapabilityDescriptor[]): CapabilityDescriptor[] {
		try {
			const matches = this.matchCapabilities(query);
			return matches.length > 0 ? matches.map(m => m.descriptor) : fallback;
		} catch {
			return fallback;
		}
	}

	/** Remove one capability (by id) or clear the whole registry. */
	invalidate(id?: string): void {
		if (id) {
			this.#descriptors.delete(id);
		} else {
			this.#descriptors.clear();
		}
		this.#cacheVersion++;
	}

	getCacheVersion(): number {
		return this.#cacheVersion;
	}

	/** All enabled descriptors, optionally filtered by kind. */
	listCapabilities(kind?: CapabilityKind): CapabilityDescriptor[] {
		const list: CapabilityDescriptor[] = [];
		for (const desc of this.#descriptors.values()) {
			if (desc.enabled && (!kind || desc.kind === kind)) list.push(desc);
		}
		return list;
	}
}

export interface CapabilityPlannerOptions {
	rolloutMode?: RolloutMode;
	/** Deterministic plan-id factory. Default: monotonic `plan-1`, `plan-2`, … */
	planIdFactory?: () => string;
	/** Injected clock for telemetry timestamps. Default: constructor-time epoch. */
	nowIso?: () => string;
}

/**
 * Pure capability planner: builds plans from lexical matches and evaluates
 * per-step approval decisions. It never invokes a capability.
 */
export class CapabilityPlanner {
	readonly #cache: CapabilityCache;
	#rolloutMode: RolloutMode;
	readonly #planIdFactory: () => string;
	readonly #nowIso: () => string;
	readonly #telemetryEvents: TelemetryEvent[] = [];
	#planCounter = 0;

	constructor(cache: CapabilityCache, options: CapabilityPlannerOptions = {}) {
		this.#cache = cache;
		this.#rolloutMode = options.rolloutMode ?? "active";
		this.#planIdFactory = options.planIdFactory ?? (() => `plan-${++this.#planCounter}`);
		this.#nowIso = options.nowIso ?? (() => "1970-01-01T00:00:00.000Z");
	}

	setRolloutMode(mode: RolloutMode): void {
		this.#rolloutMode = mode;
	}

	getRolloutMode(): RolloutMode {
		return this.#rolloutMode;
	}

	/** Create an execution plan for a task intent. Empty when rollout is off. */
	createExecutionPlan(intent: string): ExecutionPlan {
		if (this.#rolloutMode === "off") {
			return { planId: this.#planIdFactory(), intent, steps: [], rolloutMode: "off" };
		}

		const matches = this.#cache.matchCapabilities(intent);
		const steps: ExecutionPlanStep[] = matches.map((m, idx) => ({
			stepIndex: idx + 1,
			capabilityId: m.descriptor.id,
			actionName: m.descriptor.name,
			args: {},
			approvalRequired: m.descriptor.requiresApproval === true,
		}));

		this.#logTelemetry("plan_created", { intent, stepCount: steps.length });

		return { planId: this.#planIdFactory(), intent, steps, rolloutMode: this.#rolloutMode };
	}

	/**
	 * Safety-policy approval check for one step.
	 * A step that requires approval is only auto-approved in autonomous mode.
	 */
	approveExecution(step: ExecutionPlanStep): { approved: boolean; reason: string } {
		if (this.#rolloutMode === "off") {
			return { approved: false, reason: "Orchestration rollout mode is OFF" };
		}
		if (step.approvalRequired && this.#rolloutMode !== "autonomous") {
			return { approved: false, reason: "Step requires explicit user approval" };
		}
		return { approved: true, reason: "Approved under safety policy" };
	}

	/**
	 * Evaluate approval decisions for every step of a plan. Pure — nothing is
	 * executed. In `off`/`suggest` modes every step is reported unapproved.
	 */
	evaluatePlan(plan: ExecutionPlan): StepApprovalDecision[] {
		if (this.#rolloutMode === "off" || this.#rolloutMode === "suggest") {
			return plan.steps.map(step => ({
				stepIndex: step.stepIndex,
				capabilityId: step.capabilityId,
				approved: false,
				reason: `Execution paused in rollout mode: ${this.#rolloutMode}`,
			}));
		}
		return plan.steps.map(step => {
			const verdict = this.approveExecution(step);
			return {
				stepIndex: step.stepIndex,
				capabilityId: step.capabilityId,
				approved: verdict.approved,
				reason: verdict.reason,
			};
		});
	}

	#logTelemetry(type: string, details: Record<string, unknown>): void {
		this.#telemetryEvents.push({ timestamp: this.#nowIso(), type, details });
	}

	/** Defensive copy of the telemetry buffer. */
	getTelemetry(): TelemetryEvent[] {
		return [...this.#telemetryEvents];
	}
}
