/**
 * Agent side of provider live steering ({@link LiveSteering}).
 *
 * A provider that can put user input into the response it is streaming (OpenAI
 * Responses `response.steer`) pulls queued steering through a
 * {@link LiveSteeringChannel}. The loop records what the provider accepted right
 * after that response, so the transcript matches what the model saw; anything
 * it declined is injected at the next boundary like ordinary steering.
 */
import type { LiveSteerClaim, LiveSteering, UserMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "./types";

/** Steering-queue access for one provider call, supplied by the agent loop. */
export interface LiveSteeringQueue {
	/** Resolves once steering is queued or `signal` aborts; never consumes. */
	wait(signal: AbortSignal): Promise<void>;
	/** Dequeues the next steering batch. */
	take(signal: AbortSignal): Promise<AgentMessage[]>;
	/**
	 * Provider view of `messages` appended to the in-flight call's context, or
	 * `undefined` when that view is not purely user messages.
	 */
	toProvider(messages: AgentMessage[], signal: AbortSignal): Promise<UserMessage[] | undefined>;
	/** `messages` without the input the host took back since it was taken (`AgentLoopConfig.keepQueuedInput`). */
	keep?(messages: AgentMessage[]): AgentMessage[];
	/** The provider is handed `messages`, kept from the batch `taken` returned (`AgentLoopConfig.commitQueuedInput`). */
	commit?(messages: readonly AgentMessage[], taken: readonly AgentMessage[]): void;
	/** The provider handed `messages` back undelivered (`AgentLoopConfig.releaseQueuedInput`). */
	release?(messages: readonly AgentMessage[]): void;
	/** The provider accepted `messages` into its response (`AgentLoopConfig.acceptQueuedInput`). */
	accept?(messages: readonly AgentMessage[]): void;
}

/** One provider call's {@link LiveSteering} source. */
export class LiveSteeringChannel implements LiveSteering {
	/** Steering the provider delivered into the in-flight response, in queue order. */
	readonly accepted: AgentMessage[] = [];
	/** Steering taken from the queue but not delivered; always queued after {@link accepted}. */
	readonly deferred: AgentMessage[] = [];
	readonly #queue: LiveSteeringQueue;

	constructor(queue: LiveSteeringQueue) {
		this.#queue = queue;
	}

	wait(signal: AbortSignal): Promise<void> {
		// Once input is deferred, later input must follow it at the boundary;
		// delivering it live would reorder the user's messages.
		if (this.deferred.length === 0) return this.#queue.wait(signal);
		if (signal.aborted) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		signal.addEventListener("abort", () => resolve(), { once: true });
		return promise;
	}

	async claim(signal: AbortSignal): Promise<LiveSteerClaim | undefined> {
		if (this.deferred.length > 0 || signal.aborted) return undefined;
		let messages: AgentMessage[];
		try {
			messages = await this.#queue.take(signal);
		} catch (error) {
			// The queue restores what it could not hand over.
			logger.debug("Live steering dequeue failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		if (messages.length === 0) return undefined;
		const taken = messages;
		let providerMessages: UserMessage[] | undefined;
		// The host may take input back while it is converted; the provider gets only what is left.
		for (;;) {
			providerMessages = undefined;
			try {
				providerMessages = await this.#queue.toProvider(messages, signal);
			} catch (error) {
				logger.debug("Live steering conversion failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			if (!providerMessages) {
				this.deferred.push(...messages);
				return undefined;
			}
			const kept = this.#queue.keep?.(messages) ?? messages;
			if (kept.length === messages.length) break;
			messages = kept;
			if (messages.length === 0) return undefined;
		}
		const delivered = messages;
		this.#queue.commit?.(delivered, taken);
		let settled = false;
		return {
			messages: providerMessages,
			accept: () => {
				if (settled) return;
				settled = true;
				this.#queue.accept?.(delivered);
				this.accepted.push(...delivered);
			},
			reject: () => {
				if (settled) return;
				settled = true;
				this.#queue.release?.(delivered);
				this.deferred.push(...delivered);
			},
		};
	}
}
