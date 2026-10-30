/**
 * Connection warm-ups a session starts on its own: the HTTP `HEAD` to the
 * active model's host and the Codex websocket. A paused process opens no
 * provider connection, and a warm-up deferred to the resume would only race
 * the turn it was meant to speed up for the same socket, so while `/pause`
 * holds a session skips them rather than holding them.
 */
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { Api, DispatchHold, Model } from "@oh-my-pi/pi-ai";
import { prewarmModelConnection } from "@oh-my-pi/pi-ai/providers/connection-prewarm";

/**
 * Fire-and-forget HTTP warm-up of `model`'s host, skipped while `/pause` holds.
 * The entry check spares resolving a target for a warm-up that cannot go out;
 * the same check runs again where the `HEAD` would reach the wire, because a
 * `/pause` can land while the transport prepares the request (the
 * `PI_REQ_DEBUG` dump awaits the filesystem).
 */
export function prewarmUnlessPaused(model: Model<Api>): void {
	if (!agentPauseGate.paused) void prewarmModelConnection(model, { skipIf: () => agentPauseGate.paused });
}

/**
 * The Codex websocket prewarm's dispatch hold. It fails the warm-up instead of
 * waiting out a `/pause` engaged after the prewarm began — while it resolved
 * the credential or the attestation — for the reason in the module docs.
 *
 * The probe is what makes that true of the whole window rather than of the
 * moment the hold is asked: the transport reads it in the same synchronous
 * step as the connect, so a pause landing anywhere up to that step skips the
 * warm-up too.
 */
export const codexPrewarmHold: DispatchHold = Object.assign(
	(): void => {
		if (agentPauseGate.paused) throw new Error("Connection prewarm skipped while paused");
	},
	{ isClosed: () => agentPauseGate.paused },
);
