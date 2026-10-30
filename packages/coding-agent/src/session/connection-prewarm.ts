/**
 * Connection warm-ups a session starts on its own: the HTTP `HEAD` to the
 * active model's host and the Codex websocket. A paused process opens no
 * provider connection, and a warm-up deferred to the resume would only race
 * the turn it was meant to speed up for the same socket, so while `/pause`
 * holds a session skips them rather than holding them.
 */
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { prewarmModelConnection } from "@oh-my-pi/pi-ai/providers/connection-prewarm";

/** Fire-and-forget HTTP warm-up of `model`'s host, skipped while `/pause` holds. */
export function prewarmUnlessPaused(model: Model<Api>): void {
	if (!agentPauseGate.paused) void prewarmModelConnection(model);
}

/**
 * The Codex websocket prewarm's dispatch hold. It fails the warm-up instead of
 * waiting out a `/pause` engaged after the prewarm began — while it resolved
 * the credential or the attestation — for the reason in the module docs.
 */
export function codexPrewarmHold(): void {
	if (agentPauseGate.paused) throw new Error("Connection prewarm skipped while paused");
}
