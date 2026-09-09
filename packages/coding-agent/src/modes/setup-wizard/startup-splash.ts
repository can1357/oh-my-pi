import { type Component, matchesKey, type OverlayFocusOwner } from "@oh-my-pi/pi-tui";
import type { InteractiveModeContext } from "../types";
import { renderSetupSplash, SETUP_SPLASH_MS, SETUP_TICK_MS } from "./scenes/splash";

export interface RunStartupSplashOptions {
	readonly durationMs?: number;
	readonly tickMs?: number;
	readonly now?: () => number;
}

class StartupSplashComponent implements Component, OverlayFocusOwner {
	#phaseStartedAt = 0;
	#timer: NodeJS.Timeout | undefined;
	#done = Promise.withResolvers<void>();
	#disposed = false;
	readonly #durationMs: number;
	readonly #tickMs: number;
	readonly #now: () => number;

	constructor(
		readonly ctx: InteractiveModeContext,
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

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			if (this.#disposed) return;
			const elapsed = this.#now() - this.#phaseStartedAt;
			if (elapsed >= this.#durationMs) {
				this.#complete();
				return;
			}
			this.ctx.ui.requestRender();
		}, this.#tickMs);
	}

	#stopTimer(): void {
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

export async function runStartupSplash(
	ctx: InteractiveModeContext,
	options: RunStartupSplashOptions = {},
): Promise<void> {
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
