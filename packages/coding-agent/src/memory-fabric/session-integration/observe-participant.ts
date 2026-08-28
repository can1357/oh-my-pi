/**
 * Memory Fabric — observe-mode session participant (rollout rung 1).
 *
 * Bridges the session lifecycle to the measure-only observe controller. On
 * every `before_model` event it runs the context hygiene gate in observe mode
 * against the session's active context, records what enforce WOULD have done,
 * and then contributes **nothing**: `prepareContext` always resolves to `null`.
 *
 * Design notes, each of which is a deliberate departure worth stating:
 *
 *   - Only `prepareContext` is implemented. Every hook on `ParticipantLike` is
 *     optional and `CompositeSessionParticipant` skips absent ones, so defining
 *     no-op `onSessionStart`/`beforeToolCall`/… would add pointless entries to
 *     a `Promise.all` on every event for a component that is inert by default.
 *   - `lastReport` retains the REPORT only — ids and metrics, no content. The
 *     full `ObservationResult` (which holds every classified item, and hence a
 *     second copy of the context) is passed transiently to `onObserve` and then
 *     dropped, so an inert observer never pins a copy of the context for the
 *     lifetime of the session.
 *   - `stage` is exposed so callers and tests can assert structurally that this
 *     participant sits on a rung that may not alter context
 *     (`stageMayAlterContext(participant.stage) === false`).
 *
 * Disabled by default: constructing with `enabled: false` (the default) makes
 * every hook a no-op that does not even run the gate.
 */

import type { ContextItem } from "../context-hygiene/types";
import {
	noopObservationSink,
	type ObservationReport,
	type ObservationResult,
	type ObservationSink,
	type ObserveOptions,
	observeContextHygiene,
} from "../rollout/observe";
import { OBSERVE_STAGE, type RolloutStage } from "../rollout/types";
import type { BeforeModelEvent, MemoryContextPacket, SessionMemoryParticipant } from "./types";

/**
 * Projects a `before_model` event into the context items the gate should
 * measure. The default treats the session's active context text as one item;
 * callers with structured context should supply their own projector.
 */
export type ContextObserver = (event: BeforeModelEvent) => ContextItem[];

export interface ObserveModeParticipantOptions {
	/** Master switch. Default `false` — the participant is inert. */
	enabled?: boolean;
	/** Projects the lifecycle event into gate input (default: active context text). */
	observer?: ContextObserver;
	/** Sink for observation reports (default: discard). */
	sink?: ObservationSink;
	/** Injectable clock, forwarded to the observe controller. */
	now?: () => Date;
	/**
	 * Optional callback receiving the FULL observation result (report + gate)
	 * for the duration of the call only. Nothing here is retained by the
	 * participant. Must not throw; if it does, the error is swallowed.
	 */
	onObserve?: (result: ObservationResult) => void;
}

/** Default projector: the active context text as a single item, if non-empty. */
export function defaultContextObserver(event: BeforeModelEvent): ContextItem[] {
	const raw = event.activeContextText;
	if (typeof raw !== "string" || raw.trim().length === 0) return [];
	return [{ id: "session:active-context", content: raw, source: "session" }];
}

/**
 * A session participant that measures context hygiene without ever altering
 * context. Safe to install unconditionally: `prepareContext` returns `null`
 * on every path, including every failure path.
 */
export class ObserveModeSessionParticipant implements SessionMemoryParticipant {
	readonly participantName = "acf-observe";
	/** The rollout rung this participant implements. Never alters context. */
	readonly stage: RolloutStage = OBSERVE_STAGE;

	readonly #enabled: boolean;
	readonly #observer: ContextObserver;
	readonly #sink: ObservationSink;
	readonly #now: (() => Date) | undefined;
	readonly #onObserve: ((result: ObservationResult) => void) | undefined;

	#lastReport: ObservationReport | null = null;
	#observationCount = 0;

	constructor(options: ObserveModeParticipantOptions = {}) {
		this.#enabled = options.enabled ?? false;
		this.#observer = options.observer ?? defaultContextObserver;
		this.#sink = options.sink ?? noopObservationSink;
		this.#now = options.now;
		this.#onObserve = options.onObserve;
	}

	/** Whether this participant will actually run the gate. */
	get enabled(): boolean {
		return this.#enabled;
	}

	/** Metrics-only view of the most recent observation (no context content). */
	get lastReport(): ObservationReport | null {
		return this.#lastReport;
	}

	/** How many observations have been recorded by this participant. */
	get observationCount(): number {
		return this.#observationCount;
	}

	/**
	 * Measure-only. ALWAYS resolves to `null` so the composite participant
	 * contributes nothing to the prompt from this rung.
	 */
	async prepareContext(event: BeforeModelEvent): Promise<MemoryContextPacket | null> {
		if (!this.#enabled) return null;
		try {
			const items = this.#observer(event);
			if (items.length === 0) return null;

			const options: ObserveOptions = { sink: this.#sink };
			if (this.#now) options.now = this.#now;

			const result = observeContextHygiene(items, [], options);
			this.#lastReport = result.report;
			this.#observationCount++;

			if (this.#onObserve) {
				try {
					this.#onObserve(result);
				} catch {
					// Observation callbacks must never break the session.
				}
			}
		} catch {
			// Fail open: observation is best-effort and never blocks the model call.
		}
		return null;
	}

	/** Drop retained metrics (e.g. between transcripts). */
	reset(): void {
		this.#lastReport = null;
		this.#observationCount = 0;
	}
}

/** Convenience factory mirroring the other session participants. */
export function createObserveModeParticipant(
	options: ObserveModeParticipantOptions = {},
): ObserveModeSessionParticipant {
	return new ObserveModeSessionParticipant(options);
}
