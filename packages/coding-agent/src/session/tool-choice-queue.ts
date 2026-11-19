import type { ToolChoice } from "@oh-my-pi/pi-ai";

// ── Callback types ──────────────────────────────────────────────────────────

export interface ResolveInfo {
	/** The ToolChoice that was served to the LLM. */
	choice: ToolChoice;
}

export interface RejectInfo {
	/** The ToolChoice that was yielded but never (or unsuccessfully) served. */
	choice: ToolChoice;
	reason: "aborted" | "error" | "cleared" | "removed" | "unavailable" | "not_invoked";
}

/** Controls whether rejection replays a yield, drops it, or drops its remaining sequence. */
export type RejectOutcome = "requeue" | "drop" | "drop_sequence";

export interface DirectiveCallbacks {
	/** Fires when the yield completed; onInvoked directives require the requested tool to run first. */
	onResolved?: (info: ResolveInfo) => void;
	/**
	 * Return "requeue" to replay the same value, or "drop_sequence" to discard
	 * its directive including later yields. Default: drop the rejected yield.
	 */
	onRejected?: (info: RejectInfo) => RejectOutcome | undefined;
	/**
	 * Handler invoked when the model actually calls the forced tool. The queue
	 * directive carries the real execution logic; the tool's own execute() is
	 * bypassed. Returns the tool result directly.
	 */
	onInvoked?: (input: unknown) => Promise<unknown> | unknown;
}

// ── Directive ───────────────────────────────────────────────────────────────

export interface ToolChoiceDirective {
	generator: Iterator<ToolChoice>;
	/** Stable label for targeted removal and debugging (e.g. "user-force"). */
	label: string;
	callbacks: DirectiveCallbacks;
	/** Original multi-yield directive retained across one-yield replays. */
	sequenceRoot?: ToolChoiceDirective;
}

export interface PushOptions {
	/** Prepend to head instead of appending to tail. Default: false. */
	now?: boolean;
	label?: string;
	/** Lifecycle callbacks for this directive. */
	onResolved?: DirectiveCallbacks["onResolved"];
	onRejected?: DirectiveCallbacks["onRejected"];
	onInvoked?: DirectiveCallbacks["onInvoked"];
}

// ── Generators ──────────────────────────────────────────────────────────────

export function* onceGen(choice: ToolChoice): Generator<ToolChoice, void, unknown> {
	yield choice;
}

// ── In-flight state ─────────────────────────────────────────────────────────

interface InFlight {
	directive: ToolChoiceDirective;
	yielded: ToolChoice;
	invoked: boolean;
}

/**
 * A non-forcing pending preview invoker. Registered by `queueResolveHandler`
 * (resolve previews) so a `write` to `xd://resolve` or `xd://reject` can
 * dispatch to a staged action WITHOUT this queue forcing `tool_choice`. The agent-loop's
 * SoftToolRequirement lifecycle (remind-then-escalate) owns any forcing.
 */
interface PendingInvoker {
	/** Unique id for this staged preview; never reused (never clobbered by label). */
	id: string;
	/** Source tool that staged the preview (e.g. "ast_edit"), for the reminder. */
	sourceToolName: string;
	onInvoked: (input: unknown) => Promise<unknown> | unknown;
}

// ── Queue ───────────────────────────────────────────────────────────────────

export class ToolChoiceQueue {
	#queue: ToolChoiceDirective[] = [];
	/**
	 * In-flight yield awaiting resolve()/reject(). May outlive the run that
	 * claimed it: a pre-model gate stop ends the run without a `turn_end`, and
	 * the claim is finalized later — by the next admitted turn's `turn_end`,
	 * the abort safety net, or an `unavailable` rejection on redeem.
	 */
	#inFlight: InFlight | undefined;
	/**
	 * Label of the directive whose last yield was resolved this turn.
	 * Consumers (e.g. todo reminder suppression) read via consumeLastServedLabel().
	 */
	#lastResolvedLabel: string | undefined;
	/**
	 * Non-forcing pending preview invokers, stacked by UNIQUE id. The
	 * `xd://resolve` or `xd://reject` dispatch runs the head; the agent-loop's
	 * soft-tool-requirement lifecycle drives resolution without this queue forcing `tool_choice`.
	 */
	#pendingInvokers: PendingInvoker[] = [];

	// ── Push ──────────────────────────────────────────────────────────────

	pushOnce(choice: ToolChoice, options?: PushOptions): void {
		this.push(onceGen(choice), options);
	}

	pushSequence(choices: ToolChoice[], options?: PushOptions): void {
		this.push(choices, options);
	}

	push(generator: Iterable<ToolChoice>, options?: PushOptions): void {
		const directive: ToolChoiceDirective = {
			generator: generator[Symbol.iterator](),
			label: options?.label ?? "anonymous",
			callbacks: {
				onResolved: options?.onResolved,
				onRejected: options?.onRejected,
				onInvoked: options?.onInvoked,
			},
		};
		if (options?.now) {
			this.#queue.unshift(directive);
		} else {
			this.#queue.push(directive);
		}
	}

	// ── Consume ───────────────────────────────────────────────────────────

	/**
	 * Advance the head directive and return its next yield. Records the value
	 * as in-flight until resolve() or reject() is called.
	 */
	nextToolChoice(): ToolChoice | undefined {
		while (this.#queue.length > 0) {
			const head = this.#queue[0]!;
			const result = head.generator.next();
			if (result.done) {
				this.#queue.shift();
				continue;
			}
			this.#inFlight = { directive: head, yielded: result.value, invoked: false };
			return result.value;
		}
		return undefined;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────

	/**
	 * The in-flight yield completed normally. Directives with onInvoked are only
	 * consumed after their requested tool ran; a normal text turn or a different
	 * tool call requeues/rejects the directive instead.
	 */
	resolve(): void {
		const inFlight = this.#inFlight;
		if (!inFlight) return;
		if (inFlight.directive.callbacks.onInvoked && !inFlight.invoked) {
			this.reject("not_invoked");
			return;
		}
		this.#inFlight = undefined;

		this.#lastResolvedLabel = inFlight.directive.label;
		inFlight.directive.callbacks.onResolved?.({ choice: inFlight.yielded });
	}

	/**
	 * The in-flight yield was not served, or the turn aborted/errored.
	 * Fires onRejected to let the caller decide: "requeue" replays the exact
	 * lost value at the head of the queue; anything else drops it.
	 */
	reject(reason: RejectInfo["reason"]): void {
		const inFlight = this.#inFlight;
		this.#inFlight = undefined;
		if (!inFlight) return;

		const outcome = inFlight.directive.callbacks.onRejected?.({
			choice: inFlight.yielded,
			reason,
		});

		if (outcome === "drop_sequence") {
			const root = inFlight.directive.sequenceRoot ?? inFlight.directive;
			this.#queue = this.#queue.filter(directive => directive !== root && directive.sequenceRoot !== root);
			return;
		}

		if (outcome === "requeue") {
			// Re-queue only the lost yield, not the rest of the sequence. Carry forward
			// callbacks so the replayed yield still executes and finalizes correctly,
			// and can requeue itself again if the next turn also aborts or skips it.
			this.#queue.unshift({
				generator: onceGen(inFlight.yielded),
				label: `${inFlight.directive.label}-requeued`,
				sequenceRoot: inFlight.directive.sequenceRoot ?? inFlight.directive,
				callbacks: {
					onResolved: inFlight.directive.callbacks.onResolved,
					onInvoked: inFlight.directive.callbacks.onInvoked,
					onRejected: inFlight.directive.callbacks.onRejected,
				},
			});
		}
	}

	/** True if there is an in-flight yield that hasn't been resolved or rejected. */
	get hasInFlight(): boolean {
		return this.#inFlight !== undefined;
	}

	/** Return the in-flight directive's onInvoked handler and mark it when called. */
	peekInFlightInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		const inFlight = this.#inFlight;
		const onInvoked = inFlight?.directive.callbacks.onInvoked;
		if (!inFlight || !onInvoked) return undefined;
		return (input: unknown): Promise<unknown> | unknown => {
			inFlight.invoked = true;
			return onInvoked(input);
		};
	}

	// ── Non-forcing pending invokers ──────────────────────────────────────
	// Preview producers (queueResolveHandler) register here so a resolve-device
	// write can dispatch to a staged action WITHOUT a forced tool_choice (no
	// messages-cache bust). Stacked by UNIQUE id: a re-register replaces only the same id, so
	// concurrent/sequential previews each survive and resolve independently.

	/** Register (or replace by exact id) a non-forcing pending preview invoker. */
	registerPendingInvoker(
		id: string,
		sourceToolName: string,
		onInvoked: (input: unknown) => Promise<unknown> | unknown,
	): void {
		this.removePendingInvoker(id);
		this.#pendingInvokers.push({ id, sourceToolName, onInvoked });
	}

	/** Drop the pending invoker with this id (e.g. after it resolves). */
	removePendingInvoker(id: string): void {
		this.#pendingInvokers = this.#pendingInvokers.filter(p => p.id !== id);
	}

	/** Drop every pending preview invoker without touching hard tool-choice directives. */
	clearPendingInvokers(): void {
		if (this.#pendingInvokers.length === 0) return;
		this.#pendingInvokers = [];
	}

	/** True when at least one non-forcing pending preview is registered. */
	get hasPendingInvoker(): boolean {
		return this.#pendingInvokers.length > 0;
	}

	/** The head (most-recently registered) pending invoker's handler, for resolve dispatch. */
	peekPendingInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#pendingInvokers.at(-1)?.onInvoked;
	}

	/** The head pending preview's stable id + source tool, for building the agent-level
	 *  SoftToolRequirement (the id drives reminder re-injection when the head changes). */
	peekPendingHead(): { id: string; sourceToolName: string } | undefined {
		const head = this.#pendingInvokers.at(-1);
		return head ? { id: head.id, sourceToolName: head.sourceToolName } : undefined;
	}

	// ── Cleanup ───────────────────────────────────────────────────────────

	/** Remove all directives with the given label. Rejects in-flight if it matches. */
	removeByLabel(label: string): void {
		if (this.#inFlight?.directive.label === label) {
			this.reject("removed");
		}
		this.#queue = this.#queue.filter(d => d.label !== label);
	}

	/** Empty the queue and reject any in-flight yield. */
	clear(): void {
		if (this.#inFlight) {
			this.reject("cleared");
		}
		this.#queue = [];
		this.#pendingInvokers = [];
		this.#lastResolvedLabel = undefined;
	}

	// ── Observation ───────────────────────────────────────────────────────

	/** Return the label of the most recently resolved directive, then clear it. */
	consumeLastServedLabel(): string | undefined {
		const label = this.#lastResolvedLabel;
		this.#lastResolvedLabel = undefined;
		return label;
	}

	/** For tests/debug: labels of currently queued directives in order. */
	inspect(): readonly string[] {
		return this.#queue.map(d => d.label);
	}
}
