/**
 * Mid-run steering for Cursor Agent runs.
 *
 * Cursor runs a whole turn, its local tool calls included, inside one response,
 * so the agent loop reaches no step boundary to inject queued user input or
 * background-job completions until the run ends. After each answered exec
 * frame, {@link CursorSteerInjector} claims what the caller's
 * {@link LiveSteering} source holds and sends it into the run as a
 * `conversation_action` user message. The input counts as delivered only once
 * the server reports it appended (`user_message_appended`); whatever is still
 * unconfirmed when the run ends goes back to the caller for its next request.
 * A run that fails with input unconfirmed turns injection off for its Cursor
 * endpoint for the rest of the process.
 *
 * @example
 * ```ts ignore
 * const steer = new CursorSteerInjector(options.liveSteering, baseUrl, sendUserMessage);
 * await steer.afterExec(); // after an exec frame is answered
 * steer.onAppended(update.userMessage); // on `user_message_appended`
 * await steer.finish(false); // before the response ends
 * ```
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { LiveSteerClaim, LiveSteering } from "../../types";

/** Writes one user message into the run and returns its message id; throws when the run takes no more input. */
export type CursorSteerSend = (text: string) => string;

/** Cursor endpoints where a run failed with injected input unconfirmed. */
const disabledEndpoints = new Set<string>();

/** Feeds caller steering into one Cursor run, one unconfirmed message at a time. */
export class CursorSteerInjector {
	readonly #source: LiveSteering;
	readonly #endpoint: string;
	readonly #send: CursorSteerSend;
	readonly #stop = new AbortController();
	#pending: { claim: LiveSteerClaim; messageId: string; text: string } | undefined;
	#claiming: Promise<void> | undefined;
	/** Input reached the run: the server's records of the turn hold a message the request did not send. */
	delivered = false;

	constructor(source: LiveSteering, endpoint: string, send: CursorSteerSend) {
		this.#source = source;
		this.#endpoint = endpoint;
		this.#send = send;
	}

	/** False once a run on `endpoint` failed with injected input unconfirmed. */
	static available(endpoint: string): boolean {
		return !disabledEndpoints.has(endpoint);
	}

	/** Claims queued input and sends it into the run, unless a sent message still awaits confirmation. */
	afterExec(): Promise<void> {
		if (disabledEndpoints.has(this.#endpoint) || this.#stop.signal.aborted || this.#pending || this.#claiming) {
			return Promise.resolve();
		}
		this.#claiming = this.#inject().finally(() => {
			this.#claiming = undefined;
		});
		return this.#claiming;
	}

	/** Confirms the pending input when the server reports it appended to the run. */
	onAppended(message: { messageId?: string; text?: string } | undefined): void {
		const pending = this.#pending;
		if (!pending || !message) return;
		if (message.messageId !== pending.messageId && message.text?.trim() !== pending.text) return;
		this.#pending = undefined;
		this.delivered = true;
		pending.claim.acceptAnswered?.();
	}

	/** Stops injecting; unconfirmed input goes back to the caller. Await before the response ends. */
	async finish(failed: boolean): Promise<void> {
		this.#stop.abort();
		await this.#claiming;
		const pending = this.#pending;
		this.#pending = undefined;
		if (!pending) return;
		pending.claim.reject();
		if (failed && !disabledEndpoints.has(this.#endpoint)) {
			disabledEndpoints.add(this.#endpoint);
			logger.warn("Cursor live steering disabled: a run failed with steered input unconfirmed", {
				endpoint: this.#endpoint,
				messageId: pending.messageId,
			});
		}
	}

	async #inject(): Promise<void> {
		const claim = await this.#source.claim(this.#stop.signal, { asides: true });
		if (!claim) return;
		// Images never reach a claim: live steering defers image-bearing input to the boundary.
		const text = claim.messages
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n"),
			)
			.map(part => part.trim())
			.filter(part => part.length > 0)
			.join("\n\n");
		if (this.#stop.signal.aborted || !claim.acceptAnswered || !text) {
			claim.reject();
			return;
		}
		try {
			this.#pending = { claim, messageId: this.#send(text), text };
		} catch (error) {
			claim.reject();
			logger.debug("Cursor steering send failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
