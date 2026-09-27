/**
 * Extension-originated `sendMessage`/`sendUserMessage` calls start an async
 * session send the action itself never exposes a promise for. Every mode's
 * action wiring (runtime-init.ts, acp-agent.ts, extension-ui-controller.ts,
 * task/executor.ts) dispatches through {@link ExtensionSendQueue.dispatch} and
 * tracks the settled task, so startup and `/reload-plugins` can hold sends
 * until discovery has rebuilt the prompt and then settle them via
 * {@link ExtensionSendQueue.drain}.
 */
export class ExtensionSendQueue {
	/** Settled sends leave on their own, so a long-lived session does not retain one promise per send. */
	#pending = new Set<Promise<unknown>>();
	#holdDepth = 0;
	#hold: PromiseWithResolvers<void> | undefined;
	#holdFailed = false;

	/**
	 * Runs `task` with every {@link dispatch} deferred until it settles.
	 * Startup wraps `session_start` plus the startup `resources_discover` round,
	 * and `/reload-plugins` wraps its discovery round, so a handler-triggered
	 * turn never runs against the pre-discovery skill snapshot. When `task`
	 * succeeds the deferred sends dispatch in call order; when it throws they
	 * are rejected instead of starting turns on a session whose startup or
	 * reload failed. Holds nest; the outermost one decides.
	 */
	async withHeld<T>(task: () => Promise<T>): Promise<T> {
		if (this.#holdDepth++ === 0) {
			this.#hold = Promise.withResolvers<void>();
			// A discarded hold with no deferred sends must not surface as unhandled.
			this.#hold.promise.catch(() => {});
			this.#holdFailed = false;
		}
		try {
			return await task();
		} catch (error) {
			this.#holdFailed = true;
			throw error;
		} finally {
			if (--this.#holdDepth === 0) {
				const hold = this.#hold;
				this.#hold = undefined;
				if (this.#holdFailed) {
					hold?.reject(new Error("Extension send discarded: extension discovery did not complete"));
				} else {
					hold?.resolve();
				}
			}
		}
	}

	/** Starts `send` now, or once the active {@link withHeld} task settles. */
	dispatch<T>(send: () => Promise<T>): Promise<T> {
		const hold = this.#hold;
		return hold ? hold.promise.then(send) : send();
	}

	/** Tracks a send (already error-handled by the caller) so {@link drain} can settle it. */
	track(task: Promise<unknown>): void {
		this.#pending.add(task);
		const forget = (): void => {
			this.#pending.delete(task);
		};
		task.then(forget, forget);
	}

	/** Settles every tracked send, including sends started while draining. */
	async drain(): Promise<void> {
		while (this.#pending.size > 0) {
			await Promise.all(this.#pending);
		}
	}
}
