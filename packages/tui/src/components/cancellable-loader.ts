import { getKeybindings } from "../keybindings";
import { Loader } from "./loader";

/**
 * Loader that can be cancelled with Escape.
 * Extends Loader with an AbortSignal for cancelling async operations.
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.onAbort = () => done(null);
 * doWork(loader.signal).then(done);
 */
export class CancellableLoader extends Loader {
	#abortController = new AbortController();

	/** Called when user presses Escape */
	onAbort?: () => void;

	/** AbortSignal that is aborted when user presses Escape */
	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	/** Whether the loader was aborted */
	get aborted(): boolean {
		return this.#abortController.signal.aborted;
	}
	/** Return loader state including whether cancellation was requested. */
	override debugState(): Record<string, unknown> {
		return {
			...super.debugState(),
			cancelled: this.aborted,
		};
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.#abortController.abort();
			this.onAbort?.();
		}
	}

	override dispose(): void {
		this.stop();
	}
}
