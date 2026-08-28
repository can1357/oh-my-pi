/**
 * Guardian session integration — the part that actually does something.
 *
 * {@link GuardianDecisionEngine} decides and records; it deliberately performs
 * no retrieval and no injection, which is what keeps it cheap enough to run on
 * every event. This module is the other half: it observes the decision stream
 * via {@link GuardianDecisionEngine.onDecision} and carries out the work the
 * decision implies.
 *
 * ## Why a port instead of the fabric
 *
 * This file depends on a narrow {@link GuardianRetrievalPort} — four methods,
 * two of them optional — rather than on a retrieval implementation. Three
 * reasons, in order of how much they cost when ignored:
 *
 * 1. The guardian is on the hot path of every session. A hard dependency on a
 *    retrieval stack means the guardian cannot be enabled until that stack is
 *    complete, and cannot be tested without standing it up.
 * 2. The lanes behind retrieval are installed independently. A port lets a
 *    deployment with only a vector lane satisfy the same contract as one with
 *    a graph lane, without a build-time union of everything that might exist.
 * 3. It is the difference between a test that constructs a fake object and a
 *    test that needs a database.
 *
 * ## Ordering and backpressure
 *
 * Decisions arrive synchronously from the event bus; the work they imply is
 * asynchronous. Applying them concurrently would let a slow retrieval for turn
 * N land after a fast one for turn N+1, so the context injected into a turn
 * could describe the turn before it. Work is therefore serialised through a
 * single promise chain, and the emitting event is never blocked on it — a
 * guardian that stalls a tool call to go and think is worse than one that
 * misses a turn.
 *
 * ## Failure
 *
 * Retrieval failures are reported, never thrown into the session. With
 * `failOpen` (the default) the turn simply proceeds without memory. With
 * `failOpen: false` any context already staged is dropped as well, so a turn
 * either sees a complete guardian context or none — never a partial one that
 * silently omits the record that mattered.
 */

import { prompt } from "@oh-my-pi/pi-utils";
import type {
	GuardianAction,
	GuardianConfig,
	GuardianDecision,
	GuardianIntervention,
	GuardianMemoryRecord,
	GuardianWorkingState,
} from "./decision-engine";
import { GuardianDecisionEngine } from "./decision-engine";
import type { QueryIntent, SessionEvent, SessionEventBus } from "./event-bus";
import guardianInjectionInfoMd from "./prompts/guardian-injection-info.md" with { type: "text" };
import guardianInjectionWarningMd from "./prompts/guardian-injection-warning.md" with { type: "text" };

/** Where a session sits, for scoping retrieval. */
export interface GuardianScope {
	projectId: string;
	sessionId: string;
	worktreeId?: string;
	branchId?: string;
}

/** A retrieval request derived from a decision. */
export interface GuardianRetrievalQuery {
	scope: GuardianScope;
	/** Free text assembled from the entities that drove the decision. */
	text: string;
	intent: QueryIntent;
	files: string[];
	symbols: string[];
	errors: string[];
	limit: number;
}

/** Records rendered into something a model can read, within a token budget. */
export interface GuardianComposedContext {
	text: string;
	recordIds: string[];
	tokenCount: number;
}

/**
 * The retrieval surface the guardian needs — and nothing else.
 *
 * `createCheckpoint` and `queueMaintenance` are optional because they are
 * housekeeping: a deployment without a checkpoint store is degraded, not
 * broken, and should not be forced to supply a stub that throws.
 */
export interface GuardianRetrievalPort {
	retrieve(query: GuardianRetrievalQuery): Promise<GuardianMemoryRecord[]>;
	getWorkingState(sessionId: string): Promise<GuardianWorkingState | null>;
	composeContext(records: GuardianMemoryRecord[], budgetTokens: number): Promise<GuardianComposedContext>;
	createCheckpoint?(sessionId: string, label: string): Promise<string>;
	queueMaintenance?(sessionId: string, reason: string): Promise<void>;
}

export interface GuardianReport {
	level: "debug" | "warn" | "error";
	message: string;
	interventionId: string;
	action: GuardianAction;
	detail?: Record<string, unknown>;
}

/**
 * Where the integration says what it did.
 *
 * Injected rather than written to the console: this runs inside a TUI that
 * owns the terminal, and a guardian that prints over the transcript is a
 * guardian that gets switched off.
 */
export type GuardianReporter = (report: GuardianReport) => void;

/** Context staged for the next model call. */
export interface GuardianPendingInjection {
	interventionId: string;
	trigger: SessionEvent["type"];
	action: GuardianAction;
	/** True when the decision wanted the agent warned, not merely informed. */
	warning: boolean;
	context: GuardianComposedContext;
}

export interface GuardianIntegrationOptions {
	scope: GuardianScope;
	port: GuardianRetrievalPort;
	reporter?: GuardianReporter;
	/** Token budget handed to `composeContext`. */
	maxInjectionTokens?: number;
	/** Upper bound on records requested per retrieval. */
	maxRecordsPerRetrieval?: number;
	/** When false, a failed retrieval also discards any staged context. */
	failOpen?: boolean;
}

const DEFAULT_MAX_INJECTION_TOKENS = 1200;
const DEFAULT_MAX_RECORDS_PER_RETRIEVAL = 12;

/** Actions that require records to be fetched. */
const RETRIEVING_ACTIONS: ReadonlySet<GuardianAction> = new Set(["RETRIEVE_SILENTLY", "INJECT_CONTEXT", "WARN_AGENT"]);

/** Actions whose records are staged for the next model call. */
const INJECTING_ACTIONS: ReadonlySet<GuardianAction> = new Set(["INJECT_CONTEXT", "WARN_AGENT"]);

/**
 * Build a retrieval query from a decision.
 *
 * Pure and exported so the query can be asserted on directly: what the
 * guardian asks for is as much a part of its behaviour as what it does with
 * the answer.
 */
export function createRetrievalQuery(
	decision: GuardianDecision,
	scope: GuardianScope,
	limit = DEFAULT_MAX_RECORDS_PER_RETRIEVAL,
): GuardianRetrievalQuery {
	const { entities } = decision;
	const text = [...entities.taskNames, ...entities.errors, ...entities.symbols, ...entities.files]
		.map(part => part.trim())
		.filter(part => part.length > 0)
		.join(" ");

	return {
		scope,
		text,
		intent: decision.intent,
		files: [...entities.files],
		symbols: [...entities.symbols],
		errors: [...entities.errors],
		limit,
	};
}

/**
 * Render staged context for a model.
 *
 * A warning is marked as such in the text rather than delivered through a
 * separate channel, because the model reads one stream and an out-of-band
 * warning it never sees is not a warning. The framing lives in static `.md`
 * prompt templates; the composed context is passed in as template data.
 */
export function formatGuardianInjection(pending: GuardianPendingInjection): string {
	const template = pending.warning ? guardianInjectionWarningMd : guardianInjectionInfoMd;
	return prompt.render(template, { context: pending.context.text });
}

/**
 * Carries out what the decision engine decided.
 *
 * Construct, {@link start}, and read {@link takeInjection} immediately before
 * a model call. Nothing happens until `start()` is called, so an integration
 * can be assembled during setup and enabled behind a flag.
 */
export class GuardianSessionIntegration {
	readonly #engine: GuardianDecisionEngine;
	readonly #port: GuardianRetrievalPort;
	readonly #scope: GuardianScope;
	readonly #reporter: GuardianReporter;
	readonly #maxInjectionTokens: number;
	readonly #maxRecordsPerRetrieval: number;
	readonly #failOpen: boolean;

	#unsubscribe: (() => void) | null = null;
	#lifecycleUnsubscribes: Array<() => void> = [];
	#queue: Promise<void> = Promise.resolve();
	#pending: GuardianPendingInjection | null = null;
	#lastRetrievedRecords: GuardianMemoryRecord[] = [];
	#lastError: Error | null = null;

	constructor(engine: GuardianDecisionEngine, options: GuardianIntegrationOptions) {
		this.#engine = engine;
		this.#port = options.port;
		this.#scope = options.scope;
		this.#reporter = options.reporter ?? (() => {});
		this.#maxInjectionTokens = options.maxInjectionTokens ?? DEFAULT_MAX_INJECTION_TOKENS;
		this.#maxRecordsPerRetrieval = options.maxRecordsPerRetrieval ?? DEFAULT_MAX_RECORDS_PER_RETRIEVAL;
		this.#failOpen = options.failOpen ?? true;
	}

	/** Begin acting on decisions. Idempotent. */
	start(): void {
		if (this.#unsubscribe) return;
		this.#unsubscribe = this.#engine.onDecision((intervention, event) => {
			this.#enqueue(intervention, event);
		});
	}

	/** Stop acting on decisions and drop anything staged. Idempotent. */
	stop(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		for (const unsubscribe of this.#lifecycleUnsubscribes) unsubscribe();
		this.#lifecycleUnsubscribes = [];
		this.#pending = null;
	}

	/**
	 * Tie the integration to the session's own lifetime.
	 *
	 * On `session-stop` the integration stops itself, so a session that ends
	 * without an explicit teardown does not leave a listener attached to a bus
	 * that outlives it. On `resume` any context staged for the previous turn is
	 * discarded: it was assembled for a turn that never happened, and injecting
	 * it now would describe a state the session is no longer in.
	 */
	hookSessionLifecycle(eventBus: SessionEventBus): void {
		// Both handlers are declared `async` because the bus calls `.catch()` on
		// whatever a listener returns. Neither has anything to await; the keyword
		// is there to satisfy the contract, not to signal asynchronous work.
		this.#lifecycleUnsubscribes.push(
			eventBus.on("session-stop", async () => {
				this.stop();
			}),
			eventBus.on("resume", async () => {
				this.#pending = null;
			}),
		);
	}

	/**
	 * Take the staged context, if any, and clear it.
	 *
	 * Single-shot on purpose: context is assembled for one turn. Leaving it
	 * available would let the same records be injected into every subsequent
	 * turn until something replaced them, which reads to the model as the
	 * memory layer insisting on a point nobody made.
	 */
	takeInjection(): GuardianPendingInjection | null {
		const pending = this.#pending;
		this.#pending = null;
		return pending;
	}

	/** Inspect the staged context without consuming it. */
	peekInjection(): GuardianPendingInjection | null {
		return this.#pending;
	}

	/** Records fetched for the most recent retrieving decision. */
	getLastRetrievedRecords(): GuardianMemoryRecord[] {
		return [...this.#lastRetrievedRecords];
	}

	/** The most recent failure, or `null` if the last unit of work succeeded. */
	getLastError(): Error | null {
		return this.#lastError;
	}

	/**
	 * Resolves once all work queued so far has settled.
	 *
	 * Exists because decisions are applied off the event that produced them:
	 * without this, a caller has no way to observe the effect of an event it
	 * just emitted, and a test would be reduced to sleeping.
	 */
	whenIdle(): Promise<void> {
		return this.#queue;
	}

	#enqueue(intervention: GuardianIntervention, event: SessionEvent): void {
		this.#queue = this.#queue
			.then(() => this.#apply(intervention, event))
			.catch(error => {
				// The chain must survive: one failed decision cannot be allowed to
				// poison every decision after it.
				this.#fail(intervention, error);
			});
	}

	async #apply(intervention: GuardianIntervention, event: SessionEvent): Promise<void> {
		const { decision } = intervention;
		const action = decision.action;

		if (action === "IGNORE" || action === "CAPTURE_ONLY") return;

		try {
			if (action === "CHECKPOINT_NOW") {
				await this.#checkpoint(intervention, event);
				return;
			}
			if (action === "QUEUE_MAINTENANCE") {
				await this.#maintain(intervention);
				return;
			}
			if (RETRIEVING_ACTIONS.has(action)) {
				await this.#retrieveAndStage(intervention, decision);
			}
			this.#lastError = null;
		} catch (error) {
			this.#fail(intervention, error);
		}
	}

	async #retrieveAndStage(intervention: GuardianIntervention, decision: GuardianDecision): Promise<void> {
		const query = createRetrievalQuery(decision, this.#scope, this.#maxRecordsPerRetrieval);
		const records = await this.#port.retrieve(query);
		this.#lastRetrievedRecords = records;

		intervention.injectedRecordIds = [];

		if (records.length === 0) {
			this.#report("debug", "no records matched", intervention, { queryText: query.text });
			return;
		}

		if (!INJECTING_ACTIONS.has(decision.action)) {
			// A silent retrieval warms the lanes and populates the trace; it
			// deliberately stages nothing, because the whole point of the
			// action is that the turn is not interrupted.
			this.#report("debug", `retrieved ${records.length} record(s) silently`, intervention);
			return;
		}

		const context = await this.#port.composeContext(records, this.#maxInjectionTokens);
		if (context.text.trim().length === 0) {
			this.#report("debug", "composed context was empty", intervention);
			return;
		}

		intervention.injectedRecordIds = [...context.recordIds];
		intervention.tokenCount = context.tokenCount;

		this.#pending = {
			interventionId: intervention.id,
			trigger: intervention.trigger,
			action: decision.action,
			warning: decision.action === "WARN_AGENT",
			context,
		};

		this.#report("debug", `staged ${context.recordIds.length} record(s) for injection`, intervention, {
			tokenCount: context.tokenCount,
		});
	}

	async #checkpoint(intervention: GuardianIntervention, event: SessionEvent): Promise<void> {
		if (!this.#port.createCheckpoint) {
			this.#report("debug", "checkpoint requested but no checkpoint store is installed", intervention);
			return;
		}
		const checkpointId = await this.#port.createCheckpoint(this.#scope.sessionId, event.type);
		this.#report("debug", "created checkpoint", intervention, { checkpointId });
	}

	async #maintain(intervention: GuardianIntervention): Promise<void> {
		if (!this.#port.queueMaintenance) {
			this.#report("debug", "maintenance requested but no maintenance queue is installed", intervention);
			return;
		}
		await this.#port.queueMaintenance(this.#scope.sessionId, intervention.trigger);
		this.#report("debug", "queued maintenance", intervention);
	}

	#fail(intervention: GuardianIntervention, error: unknown): void {
		const wrapped = error instanceof Error ? error : new Error(String(error));
		this.#lastError = wrapped;

		// Fail-closed drops staged context so a turn never sees a guardian
		// context that is missing the record the failure would have supplied.
		if (!this.#failOpen) this.#pending = null;

		this.#report("error", `guardian action failed: ${wrapped.message}`, intervention, {
			failOpen: this.#failOpen,
		});
	}

	#report(
		level: GuardianReport["level"],
		message: string,
		intervention: GuardianIntervention,
		detail?: Record<string, unknown>,
	): void {
		try {
			this.#reporter({
				level,
				message,
				interventionId: intervention.id,
				action: intervention.decision.action,
				detail,
			});
		} catch {
			// A reporter that throws is a reporting problem, not a session
			// problem. Swallowed on purpose, and not re-reported.
		}
	}
}

export interface GuardianRuntime {
	engine: GuardianDecisionEngine;
	integration: GuardianSessionIntegration;
	/** Tears down both the engine's bus subscriptions and the integration's. */
	dispose(): void;
}

/**
 * Build a guardian, wire it to a session bus, and start it.
 *
 * The single entry point a session needs. Returns the engine as well as the
 * integration because the engine owns the decision trace, which the
 * transparency surfaces read directly.
 */
export function initializeGuardian(
	eventBus: SessionEventBus,
	options: GuardianIntegrationOptions,
	config: Partial<GuardianConfig> = {},
): GuardianRuntime {
	const engine = new GuardianDecisionEngine(config, eventBus);
	const integration = new GuardianSessionIntegration(engine, options);
	integration.start();
	integration.hookSessionLifecycle(eventBus);

	return {
		engine,
		integration,
		dispose(): void {
			integration.stop();
			engine.dispose();
		},
	};
}
