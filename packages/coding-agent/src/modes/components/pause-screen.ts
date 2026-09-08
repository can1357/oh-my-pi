/**
 * Fullscreen `/pause` screen.
 *
 * `/pause` engages the process-global {@link agentPauseGate}, freezing every
 * agent loop in the process (main agent, in-process subagents, advisor) at its
 * next safe boundary — nothing is aborted, so a later resume continues exactly
 * where each loop parked. While engaged, this component owns the alternate
 * screen (the `runStartupSplash` idiom) and paints a large pause glyph with a
 * live hold timer; esc / enter / space / ctrl+c releases the gate.
 *
 * Use case: freeze a busy session, hand-edit the repo, resume, then explain
 * the change via a normal steering message.
 */
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	matchesKey,
	type OverlayFocusOwner,
	type OverlayHandle,
	type OverlayOptions,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatDuration } from "../../slash-commands/helpers/format";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";

/**
 * Slice of `InteractiveModeContext` the pause screen drives. Narrow so tests
 * can exercise the full engage → hold → release lifecycle without a real TUI.
 */
export interface PauseScreenHost {
	ui: {
		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
		setFocus(component: Component): void;
		requestRender(): void;
		readonly terminal: { readonly rows: number };
	};
	showStatus(message: string, options?: { dim?: boolean }): void;
	readonly sessionName?: string;
}

/** Refresh cadence for the live "paused for" clock. */
const TICK_MS = 1_000;

/** Pause-bar glyph geometry (rows × columns of full blocks per bar). */
const BAR_ROWS = 7;
const BAR_WIDTH = 5;
const BAR_GAP = 4;

/** Below either bound the full scene cannot breathe; drop to the compact card. */
const MIN_FULL_WIDTH = 64;
const MIN_FULL_HEIGHT = 18;

const TITLE = "P A U S E D";
const BODY_LINES = [
	"Main agent, subagents, and advisor hold at their next step.",
	"In-flight calls finish; nothing new starts until you resume.",
] as const;
const RESUME_HINT = "esc · enter · space — resume";

function centerLine(line: string, width: number): string {
	const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
	return pad > 0 ? " ".repeat(pad) + line : line;
}

/** Live hold clock, seconds-precise: `0:07`, `12:34`, `1:02:03`. */
function formatClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Paint the pause scene as exactly `height` rows, vertically centered.
 * Exported for tests.
 */
export function renderPauseScreen(width: number, height: number, elapsedMs: number, sessionName?: string): string[] {
	const compact = width < MIN_FULL_WIDTH || height < MIN_FULL_HEIGHT;
	const content: string[] = [];

	if (compact) {
		if (sessionName) {
			content.push(centerLine(theme.bold(sessionName), width));
			content.push("");
		}
		content.push(centerLine(theme.bold(theme.fg("accent", `▌▌ ${TITLE}`)), width));
		content.push("");
		content.push(centerLine(theme.fg("dim", `paused for ${formatClock(elapsedMs)}`), width));
		content.push(centerLine(theme.fg("dim", "esc to resume"), width));
	} else {
		if (sessionName) {
			content.push(centerLine(theme.bold(sessionName), width));
			content.push("");
			content.push("");
		}
		const bar = "█".repeat(BAR_WIDTH);
		const glyphRow = `${bar}${" ".repeat(BAR_GAP)}${bar}`;
		for (let i = 0; i < BAR_ROWS; i++) {
			content.push(centerLine(theme.fg("accent", glyphRow), width));
		}
		content.push("");
		content.push(centerLine(theme.bold(theme.fg("accent", TITLE)), width));
		content.push("");
		for (const line of BODY_LINES) {
			content.push(centerLine(theme.fg("muted", line), width));
		}
		content.push("");
		content.push(centerLine(theme.fg("dim", `paused for ${formatClock(elapsedMs)}`), width));
		content.push("");
		content.push(centerLine(theme.fg("dim", RESUME_HINT), width));
	}

	const topPad = Math.max(0, Math.floor((height - content.length) / 2));
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const lines: string[] = new Array(topPad).fill("");
	lines.push(...content);
	while (lines.length < height) lines.push("");
	return lines.slice(0, Math.max(1, height));
}

/** Fullscreen overlay component; resolves {@link run} when a resume key lands. */
export class PauseScreenComponent implements Component, OverlayFocusOwner {
	#timer: NodeJS.Timeout | undefined;
	#done = Promise.withResolvers<void>();
	#disposed = false;
	#startedAt = Date.now();

	constructor(readonly host: PauseScreenHost) {}

	/** Start the clock; resolves once the user asks to resume. */
	run(): Promise<void> {
		this.#startedAt = agentPauseGate.pausedAt ?? Date.now();
		this.#timer ??= setInterval(() => {
			if (!this.#disposed) this.host.ui.requestRender();
		}, TICK_MS);
		this.host.ui.requestRender();
		return this.#done.promise;
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this;
	}

	handleInput(data: string): void {
		// Every dismissal path resumes — including ctrl+c, which must never
		// double as "abort agents" while the whole point of the screen is that
		// nothing gets lost.
		if (
			matchesAppInterrupt(data) ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			matchesKey(data, "space") ||
			matchesKey(data, "ctrl+c")
		) {
			if (!this.#disposed) this.#done.resolve();
		}
	}

	render(width: number): readonly string[] {
		const elapsed = Date.now() - this.#startedAt;
		return renderPauseScreen(
			Math.max(1, width),
			Math.max(1, this.host.ui.terminal.rows),
			elapsed,
			this.host.sessionName,
		);
	}
}

/**
 * Engage the global pause gate and hold the fullscreen pause screen until the
 * user resumes. No-op when the gate is already engaged. Always releases the
 * gate on the way out (including teardown throws) — a leaked pause would
 * freeze every agent in the process with no UI left to release it.
 */
export async function runPauseScreen(host: PauseScreenHost): Promise<void> {
	if (!agentPauseGate.pause()) return;
	const component = new PauseScreenComponent(host);
	const overlay = host.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	try {
		host.ui.setFocus(component);
		await component.run();
	} finally {
		component.dispose();
		host.ui.setFocus(component);
		overlay.hide();
		const heldMs = agentPauseGate.resume();
		if (heldMs !== undefined) {
			host.showStatus(`Resumed after ${formatDuration(heldMs)} — agents are running again.`);
		}
	}
}
