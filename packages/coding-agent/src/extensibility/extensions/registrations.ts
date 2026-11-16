/**
 * Lifecycle of the registrations an extension load makes outside its own session state.
 */
import { logger } from "@oh-my-pi/pi-utils";

/** A registration an extension load made outside its own session state. */
export interface ExtensionRegistration {
	/** Undo it for good: the load was torn down. Runs at most once. */
	release(): void;
	/** The load was suspended (`true`) or resumed (`false`): stop acting for it, or start again. */
	suspend?(suspended: boolean): void;
}

/**
 * What a load registered outside its session state, and the state that governs it. A runner
 * suspends and resumes the load in place (a live `disabledExtensions` edit), and releases it when
 * the load is torn down: session shutdown, a factory that throws, a startup or deferred bind no
 * session adopts, or a plugin install's validation load.
 */
export class ExtensionRegistrations {
	#entries: ExtensionRegistration[] = [];
	#listeners = new Set<(suspended: boolean) => void>();
	#suspended = false;
	/** The state listeners last heard; lags {@link suspended} while a notification is held back. */
	#heard = false;
	#released = false;

	/** Whether the load is suspended. */
	get suspended(): boolean {
		return this.#suspended;
	}

	/** Whether the load was torn down. */
	get released(): boolean {
		return this.#released;
	}

	/**
	 * Track `registration` until the load is torn down. One added after teardown is released at
	 * once, and one added while the load is suspended starts suspended. Returns the untrack, for a
	 * registration its owner undid itself.
	 */
	add(registration: ExtensionRegistration): () => void {
		if (this.#released) {
			releaseLogged(registration);
			return () => {};
		}
		this.#entries.push(registration);
		if (this.#suspended) registration.suspend?.(true);
		return () => {
			const index = this.#entries.indexOf(registration);
			if (index !== -1) this.#entries.splice(index, 1);
		};
	}

	/**
	 * Suspend or resume every registration, then notify {@link onSuspensionChange} listeners unless
	 * `notify` is false: a runner adopting a load before its session can act for it resumes the
	 * registrations at once and lets the listeners hear it from {@link notifySuspensionChange} later.
	 */
	setSuspended(suspended: boolean, options?: { notify?: boolean }): void {
		if (this.#released || suspended === this.#suspended) return;
		this.#suspended = suspended;
		// A snapshot: a registration's suspend may add or untrack registrations.
		for (const registration of Array.from(this.#entries)) registration.suspend?.(suspended);
		if (options?.notify !== false) this.notifySuspensionChange();
	}

	/** Tell {@link onSuspensionChange} listeners the current state, unless they already heard it. */
	notifySuspensionChange(): void {
		if (this.#released || this.#heard === this.#suspended) return;
		const suspended = this.#suspended;
		this.#heard = suspended;
		// A snapshot: a listener may subscribe or unsubscribe while being told.
		for (const listener of Array.from(this.#listeners)) {
			try {
				listener(suspended);
			} catch (error) {
				logger.warn("Extension suspension listener failed", { error: errorMessage(error) });
			}
		}
	}

	/** Call `listener` whenever the load is suspended or resumed. Returns the unsubscribe. */
	onSuspensionChange(listener: (suspended: boolean) => void): () => void {
		if (this.#released) return () => {};
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Tear the load down: release every registration once, newest first; later ones release at once. */
	release(): void {
		if (this.#released) return;
		this.#released = true;
		this.#listeners.clear();
		for (const registration of this.#entries.splice(0).reverse()) releaseLogged(registration);
	}
}

function releaseLogged(registration: ExtensionRegistration): void {
	try {
		registration.release();
	} catch (error) {
		logger.warn("Extension registration release failed", { error: errorMessage(error) });
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
