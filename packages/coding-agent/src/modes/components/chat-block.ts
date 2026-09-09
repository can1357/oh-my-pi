import { Container } from "@oh-my-pi/pi-tui";

/**
 * Capabilities a mounted {@link ChatBlock} may use against its host transcript.
 * Kept minimal so blocks never reach into the full TUI/InteractiveMode surface.
 */
export interface ChatBlockHost {
	/** Schedule a repaint of the transcript. */
	requestRender(): void;
}

/**
 * Lifecycle-aware transcript block — the "return a block, let the host mount it"
 * primitive, modelled on React/Svelte component lifecycles.
 *
 * Producers build and return a `ChatBlock` instead of poking `chatContainer` and
 * `ui.requestRender()` directly. The host (`ctx.present`) appends it and calls
 * {@link mount}, which runs {@link onMount}; effects started there register
 * teardown via {@link onCleanup}. The block repaints through {@link requestRender}
 * — never touching the TUI — and tears down exactly once on {@link finish}
 * (self-complete: stop the animation, keep the final frame in the transcript) or
 * {@link dispose} (host discards it, e.g. a transcript reset).
 *
 * While mounted and unfinished a block reports `isTranscriptBlockFinalized() ===
 * false` so {@link "../components/transcript-container".TranscriptContainer}
 * keeps it in the live, repaintable region on ED3-risk terminals; after
 * `finish()`/`dispose()` it reports `true` and freezes at its final content.
 */
export abstract class ChatBlock extends Container {
	#host: ChatBlockHost | undefined;
	#cleanups: Array<() => void> = [];
	#active = false;
	#disposed = false;

	/**
	 * Run setup after the block is in the transcript: start timers/subscriptions
	 * and register their teardown with {@link onCleanup}. Default: no-op (a block
	 * whose content is fixed at construction needs no mount work).
	 */
	protected onMount(): void {}

	/**
	 * Register a teardown to run on {@link finish}/{@link dispose}, à la a
	 * `useEffect` cleanup. If the block is already disposed the cleanup runs
	 * immediately so callers never leak.
	 */
	protected onCleanup(cleanup: () => void): void {
		if (this.#disposed) {
			cleanup();
			return;
		}
		this.#cleanups.push(cleanup);
	}

	/** Ask the host to repaint. No-op before mount or after dispose. */
	protected requestRender(): void {
		this.#host?.requestRender();
	}

	/** True between {@link mount} and {@link finish}/{@link dispose}. */
	protected get active(): boolean {
		return this.#active;
	}

	/**
	 * Host-only: attach the host and run {@link onMount}. Idempotent — a second
	 * call (e.g. a transcript rebuild that re-presents the same instance) is a
	 * no-op.
	 */
	mount(host: ChatBlockHost): void {
		if (this.#host || this.#disposed) return;
		this.#host = host;
		this.#active = true;
		this.onMount();
	}

	/**
	 * Self-complete: stop ongoing effects and freeze the block at its current
	 * content, leaving it rendered in the transcript. Use when the operation the
	 * block represents finishes (connection resolved, download done).
	 */
	finish(): void {
		if (!this.#active) return;
		this.#active = false;
		this.#runCleanups();
		this.requestRender();
	}

	/**
	 * Host-only teardown: release everything and propagate to children. Called
	 * when the host permanently discards the block (transcript reset). Idempotent.
	 */
	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#active = false;
		this.#runCleanups();
		super.dispose();
		this.#host = undefined;
	}

	/** Live blocks stay repaintable; finished/disposed ones may freeze. */
	isTranscriptBlockFinalized(): boolean {
		return !this.#active;
	}

	#runCleanups(): void {
		const cleanups = this.#cleanups.splice(0);
		for (const cleanup of cleanups) cleanup();
	}
}
