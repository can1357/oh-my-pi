/**
 * Composer next-message predictions for RPC hosts: the `predict_next_message`,
 * `predict_next_message_feedback` and `predict_next_message_cancel` commands
 * plus the `next_message_prediction` frame.
 *
 * Runs the TUI's {@link ComposerPredictionController} unchanged (prompt,
 * parser, deadline, usage, metrics). The host owns the composer: it asks for a
 * prediction only while its draft is empty, cancels it when the user types, and
 * reports what it showed and accepted. Nothing is requested until it asks.
 */
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import {
	ComposerPredictionController,
	type ComposerPredictionOptions,
} from "../controllers/composer-prediction-controller";
import { cfgComposerPredictionAlternatives, cfgComposerPredictions } from "../settings";
import type { RpcNextMessagePredictionFeedbackEvent, RpcNextMessagePredictionFrame } from "./rpc-types";

/** Session events that end any pending or offered prediction: a new run, or a compaction rewriting the history it read. */
const CANCELLING_EVENTS: Partial<Record<AgentSessionEvent["type"], true>> = {
	agent_start: true,
	auto_compaction_start: true,
	manual_compaction_start: true,
};

export class RpcNextMessagePredictor {
	readonly #session: AgentSession;
	readonly #controller: ComposerPredictionController;
	/** The offered prediction not yet retired; it may have gone stale since. */
	#offered: string | undefined;

	constructor(
		session: AgentSession,
		output: (frame: RpcNextMessagePredictionFrame) => void,
		options: Omit<ComposerPredictionOptions, "onUpdate"> = {},
	) {
		this.#session = session;
		this.#controller = new ComposerPredictionController(
			{
				settings: session.settings,
				viewSession: session,
				focusedAgentId: undefined,
				// The host asks only while its own draft is empty.
				editor: { getText: () => "" },
				ui: { requestRender: () => {} },
			},
			{
				...options,
				onUpdate: ({ id, status, choices }) => {
					if (status === "offered") this.#offered = id;
					else if (status === "retired" && this.#offered === id) this.#offered = undefined;
					output(
						choices
							? { type: "next_message_prediction", predictionId: id, status, choices: [...choices] }
							: { type: "next_message_prediction", predictionId: id, status },
					);
				},
			},
		);
		// As the TUI, for settings reloaded or changed while the process runs: predictions turned off end
		// every pending or offered one; alternatives turned off end a pending request (it asked for
		// alternatives) and a multi-choice offer. Both listeners end with the session.
		cfgComposerPredictions.listen(session, enabled => {
			if (!enabled) this.#controller.cancel();
		});
		cfgComposerPredictionAlternatives.listen(session, enabled => {
			if (enabled || this.#controller.activeId === undefined) return;
			if ((this.#controller.choices?.length ?? 0) !== 1) this.#controller.cancel();
		});
	}

	/**
	 * Start a prediction for the conversation as it stands, superseding any earlier one; null when none
	 * started. None starts while a host `bash` command runs: its result lands without a session event.
	 */
	request(): string | null {
		if (this.#session.isBashRunning) {
			this.#controller.cancel();
			return null;
		}
		return this.#controller.request() ?? null;
	}

	/**
	 * Record that the host displayed prediction `predictionId`, or that the user took its alternative
	 * at `rank`. Feedback for a prediction that is no longer offered is ignored.
	 */
	feedback(predictionId: string, event: RpcNextMessagePredictionFeedbackEvent, rank: number | undefined): void {
		if (event === "shown") {
			if (this.#controller.offeredId === predictionId) this.#controller.shown();
			return;
		}
		if (event !== "accepted") throw new Error('event must be "shown" or "accepted"');
		if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 0) {
			throw new Error("accepted feedback requires a non-negative integer rank");
		}
		if (this.#controller.offeredId !== predictionId) return;
		const count = this.#controller.choices?.length ?? 0;
		if (rank >= count) throw new Error(`rank ${rank} is out of range for ${count} alternatives`);
		this.#controller.accepted(rank);
	}

	/** Cancel the pending or offered prediction (only `predictionId`, when given); false when none matches. */
	cancel(predictionId?: string): boolean {
		const active = this.#controller.activeId;
		if (active === undefined || (predictionId !== undefined && predictionId !== active)) return false;
		return this.#controller.cancel();
	}

	/** Retire what a new turn or message made stale, so the host never offers or accepts it. */
	observe(event: AgentSessionEvent): void {
		if (CANCELLING_EVENTS[event.type]) {
			this.#controller.cancel();
			return;
		}
		this.retireStale();
	}

	/**
	 * Retire an offered prediction the conversation moved past, for appends that emit no session event
	 * (a recorded `bash` result). A pending request settles `stale` on its own.
	 */
	retireStale(): void {
		if (this.#offered !== undefined && this.#controller.offeredId !== this.#offered) this.#controller.cancel();
	}

	/** Before the session changes or the process exits: abort and retire everything. */
	close(): void {
		this.#controller.cancel();
	}
}
