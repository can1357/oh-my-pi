type PendingInput = {
	providerId: string;
	resolve: (value: string) => void;
	reject: (error: Error) => void;
};
type ClaimedInput = {
	promise: Promise<string>;
	clear: (reason?: string) => void;
};

export class OAuthManualInputManager {
	#pending?: PendingInput;

	waitForInput(providerId: string): Promise<string> {
		if (this.#pending) {
			this.clear("Manual OAuth input superseded by a new login");
		}

		const pending = this.#createPending(providerId);
		this.#pending = pending;
		return pending.promise;
	}

	tryWaitForInput(providerId: string): Promise<string> | undefined {
		if (this.#pending) return undefined;
		return this.waitForInput(providerId);
	}

	tryClaimInput(providerId: string): ClaimedInput | undefined {
		if (this.#pending) return undefined;
		const pending = this.#createPending(providerId);
		this.#pending = pending;
		return {
			promise: pending.promise,
			clear: (reason?: string) => {
				if (this.#pending !== pending) return;
				this.clear(reason);
			},
		};
	}

	submit(input: string): boolean {
		if (!this.#pending) return false;
		const { resolve } = this.#pending;
		this.#pending = undefined;
		resolve(input);
		return true;
	}

	clear(reason = "Manual OAuth input cleared"): void {
		if (!this.#pending) return;
		const { reject } = this.#pending;
		this.#pending = undefined;
		reject(new Error(reason));
	}

	hasPending(): boolean {
		return Boolean(this.#pending);
	}

	get pendingProviderId(): string | undefined {
		return this.#pending?.providerId;
	}

	#createPending(providerId: string): PendingInput & { promise: Promise<string> } {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		return { providerId, resolve, reject, promise };
	}
}
