import * as AIError from "../error";
import type { AssistantMessage, AssistantMessageEvent } from "../types";

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	queue: T[] = [];
	waiting: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (err: unknown) => void }> = [];
	done = false;
	/** True once finalResultPromise has been resolved or rejected. */
	resultSettled = false;
	#failed = false;
	#error: unknown = undefined;
	finalResultPromise: Promise<R>;
	resolveFinalResult!: (result: R) => void;
	rejectFinalResult!: (err: unknown) => void;
	isComplete: (event: T) => boolean;
	extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		const { promise, resolve, reject } = Promise.withResolvers<R>();
		// Prevent an unhandled rejection when fail() is called but nobody awaits result().
		// Callers who do await result() still receive the rejection normally.
		promise.catch(() => {});
		this.finalResultPromise = promise;
		this.resolveFinalResult = resolve;
		this.rejectFinalResult = reject;
		this.isComplete = isComplete;
		this.extractResult = extractResult;
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resultSettled = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	deliver(event: T): void {
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resultSettled = true;
			this.resolveFinalResult(result);
		} else if (!this.resultSettled) {
			// end() without a terminal value must still settle result() —
			// otherwise complete()/result() awaits hang forever.
			this.resultSettled = true;
			this.rejectFinalResult(
				new AIError.ProviderResponseError("Stream ended without a final result", { kind: "envelope" }),
			);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.resolve({ value: undefined as any, done: true });
		}
	}

	endWaiting(): void {
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.resolve({ value: undefined as any, done: true });
		}
	}

	fail(err: unknown): void {
		if (this.done) return;
		this.done = true;
		this.#failed = true;
		this.#error = err;
		this.resultSettled = true;
		this.rejectFinalResult(err);
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.reject(err);
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.#failed) {
				throw this.#error;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve, reject) =>
					this.waiting.push({ resolve, reject }),
				);
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			event => event.type === "done" || event.type === "error",
			event => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new AIError.ProviderResponseError("Unexpected event type for final result", { kind: "envelope" });
			},
		);
	}

	override push(event: AssistantMessageEvent): void {
		if (this.done) return;

		if (event.type === "error" && event.error.stopReason === "error") {
			AIError.classifyMessage(event.error);
		}

		// Completion resolves the final result and still emits the terminal event.
		if (this.isComplete(event)) {
			this.done = true;
			this.resultSettled = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		this.deliver(event);
	}

	override end(result?: AssistantMessage): void {
		this.done = true;
		if (result !== undefined) {
			if (result.stopReason === "error") {
				AIError.classifyMessage(result);
			}
			this.resultSettled = true;
			this.resolveFinalResult(result);
		} else if (!this.resultSettled) {
			// Mirror the base class: a result-less end() must not leave
			// result() pending forever.
			this.resultSettled = true;
			this.rejectFinalResult(
				new AIError.ProviderResponseError("Stream ended without a final result", { kind: "envelope" }),
			);
		}
		this.endWaiting();
	}
}
