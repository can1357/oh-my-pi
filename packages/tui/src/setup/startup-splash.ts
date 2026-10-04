import { type Component, type OverlayFocusOwner } from "../tui";
import { matchesKey } from "../keys";
import { col } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { Memo } from "../native/memo";
import { isNativeRendering } from "../native/state";
import type { SetupUiHost } from "./scenes/types";
import { describeSetupSplash, renderSetupSplash, SETUP_SPLASH_MS, SETUP_TICK_MS } from "./scenes/splash";

/** Timing controls for the standalone startup animation. */
export interface RunStartupSplashOptions {
	readonly durationMs?: number;
	readonly tickMs?: number;
	readonly now?: () => number;
}

class StartupSplashComponent implements Component, OverlayFocusOwner {
	#phaseStartedAt = 0;
	#timer: NodeJS.Timeout | undefined;
	/** Native path: one-shot at the end of the splash; the terminal clocks the motion. */
	#deadline: NodeJS.Timeout | undefined;
	#native = new Memo();
	#done = Promise.withResolvers<void>();
	#disposed = false;
	readonly #durationMs: number;
	readonly #tickMs: number;
	readonly #now: () => number;

	constructor(
		readonly ctx: SetupUiHost,
		options: RunStartupSplashOptions = {},
	) {
		this.#durationMs = options.durationMs ?? SETUP_SPLASH_MS;
		this.#tickMs = options.tickMs ?? SETUP_TICK_MS;
		this.#now = options.now ?? (() => performance.now());
	}

	run(): Promise<void> {
		this.#phaseStartedAt = this.#now();
		this.#startTimer();
		this.ctx.ui.requestRender();
		return this.#done.promise;
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopTimer();
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this;
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			matchesKey(data, "space") ||
			matchesKey(data, "escape")
		) {
			this.#complete();
		}
	}

	render(width: number): readonly string[] {
		const elapsedMs = Math.min(this.#durationMs, Math.max(0, this.#now() - this.#phaseStartedAt));
		return renderSetupSplash(Math.max(1, width), Math.max(1, this.ctx.ui.terminal.rows), elapsedMs);
	}

	describe(): NativeNode {
		const splash = describeSetupSplash();
		return this.#native.get([splash], () => col([splash], { grow: 1, role: "omp.app.startup-splash" }));
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "skip") this.#complete();
	}

	/**
	 * ANSI: repaint every tick. Native: no repaint loop, only a one-shot at
	 * the end of the splash (re-armed if it fires early).
	 */
	#startTimer(): void {
		if (isNativeRendering()) {
			if (this.#timer) {
				clearInterval(this.#timer);
				this.#timer = undefined;
			}
			clearTimeout(this.#deadline);
			const remaining = this.#durationMs - (this.#now() - this.#phaseStartedAt);
			this.#deadline = setTimeout(() => this.#tick(), Math.max(0, remaining));
			return;
		}
		if (this.#timer) return;
		this.#timer = setInterval(() => this.#tick(), this.#tickMs);
	}

	#tick(): void {
		if (this.#disposed) return;
		const elapsed = this.#now() - this.#phaseStartedAt;
		if (elapsed >= this.#durationMs) {
			this.#complete();
		} else if (isNativeRendering() || !this.#timer) {
			// Re-arm the deadline, or switch loops when the native surface opened/closed.
			this.#startTimer();
		} else {
			this.ctx.ui.requestRender();
		}
	}

	#stopTimer(): void {
		clearTimeout(this.#deadline);
		this.#deadline = undefined;
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#complete(): void {
		if (this.#disposed) return;
		this.#stopTimer();
		this.#done.resolve();
	}
}

/** Show the startup animation and restore the previous overlay focus afterward. */
export async function runStartupSplash(ctx: SetupUiHost, options: RunStartupSplashOptions = {}): Promise<void> {
	const component = new StartupSplashComponent(ctx, options);
	const overlay = ctx.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	try {
		ctx.ui.setFocus(component);
		await component.run();
	} finally {
		component.dispose();
		ctx.ui.setFocus(component);
		overlay.hide();
	}
}
