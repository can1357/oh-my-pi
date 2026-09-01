import {
	type Component,
	type KeyId,
	matchesKey,
	replaceTabs,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { renderVoiceOrb } from "../modes/components/voice-indicator";
import { type ThemeColor, theme } from "../modes/theme/theme";

/** Distinct states of a realtime call connection. */
export type LivePhase = "connecting" | "listening" | "working" | "speaking" | "muted" | "error";
/** Configuration callbacks for user interactions in the visualizer. */
export interface LiveVisualizerOptions {
	onStop(): void;
	onToggleMute(): void;
	/** Configured `app.live.toggle` chords that also end the call (Ctrl+L by default). */
	stopKeys?: readonly KeyId[];
}

function normalizeTranscript(text: string): string {
	return replaceTabs(sanitizeText(text)).replace(/\s+/g, " ").trim();
}

function truncateFromStart(text: string, width: number): string {
	if (width <= 0) return "";
	const textWidth = visibleWidth(text);
	if (textWidth <= width) return text;
	if (width === 1) return "…";
	return `…${sliceWithWidth(text, textWidth - width + 1, width - 1, true).text}`;
}

/** A compact, fixed-height terminal component for displaying a realtime call. */
export class LiveVisualizer implements Component {
	readonly wantsKeyRelease = false;

	readonly #options: LiveVisualizerOptions;

	#phase: LivePhase = "connecting";
	#inputLevel = 0;
	#displayLevel = 0;
	#frame = 0;
	#userTranscript = "";

	#cache:
		| {
				width: number;
				phase: LivePhase;
				displayLevel: number;
				frame: number;
				userTranscript: string;
				lines: readonly string[];
		  }
		| undefined;

	constructor(options: LiveVisualizerOptions) {
		this.#options = options;
	}

	/** Updates the current call phase. */
	setPhase(phase: LivePhase): void {
		if (this.#phase !== phase) {
			this.#phase = phase;
			this.invalidate();
		}
	}

	/** Updates the microphone volume level (0..1). */
	setInputLevel(level: number): void {
		const next = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
		if (this.#inputLevel === next) return;
		this.#inputLevel = next;
		this.invalidate();
	}

	/** Advances the organic animation and eases audio energy toward silence. */
	setFrame(frame: number): void {
		const target = this.#inputLevel;
		const rate = target > this.#displayLevel ? 0.22 : 0.08;
		const nextLevel = this.#displayLevel + (target - this.#displayLevel) * rate;
		if (this.#frame !== frame || this.#displayLevel !== nextLevel) {
			this.#frame = frame;
			this.#displayLevel = nextLevel;
			this.invalidate();
		}
	}

	/** Updates the user's streaming voice transcript. */
	setTranscript(text: string): void {
		const normalized = normalizeTranscript(text);
		if (this.#userTranscript === normalized) return;
		this.#userTranscript = normalized;
		this.invalidate();
	}

	/** Clears the user's voice transcript row. */
	clearTranscript(): void {
		if (!this.#userTranscript) return;
		this.#userTranscript = "";
		this.invalidate();
	}

	/** Processes user keypresses. */
	handleInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c") ||
			this.#options.stopKeys?.some(key => matchesKey(data, key))
		) {
			this.#options.onStop();
		} else if (matchesKey(data, "space")) {
			this.#options.onToggleMute();
		}
	}

	/** Clears the render cache. */
	invalidate(): void {
		this.#cache = undefined;
	}

	/** Renders the thinking orb in the original compact live-mode panel. */
	render(width: number): readonly string[] {
		if (
			this.#cache &&
			this.#cache.width === width &&
			this.#cache.phase === this.#phase &&
			this.#cache.displayLevel === this.#displayLevel &&
			this.#cache.frame === this.#frame &&
			this.#cache.userTranscript === this.#userTranscript
		) {
			return this.#cache.lines;
		}

		const lines = this.#renderLines(width);
		this.#cache = {
			width,
			phase: this.#phase,
			displayLevel: this.#displayLevel,
			frame: this.#frame,
			userTranscript: this.#userTranscript,
			lines,
		};
		return lines;
	}

	#renderLines(maxWidth: number): readonly string[] {
		const width = Math.max(2, maxWidth);
		const innerWidth = width - 2;
		const border = (content: string): string =>
			theme.fg("border", "│") + content + (width > 1 ? theme.fg("border", "│") : "");
		const top = theme.fg("border", `┌${"─".repeat(innerWidth)}${width > 1 ? "┐" : ""}`);
		const orbState =
			this.#phase === "connecting"
				? "connecting"
				: this.#phase === "listening"
					? "listening"
					: this.#phase === "working"
						? "solving"
						: this.#phase === "speaking"
							? "composing"
							: this.#phase === "muted"
								? "breathing"
								: "shaping";
		const energy =
			this.#phase === "muted" || this.#phase === "error"
				? 0
				: this.#phase === "speaking"
					? Math.max(0.68, this.#displayLevel)
					: this.#displayLevel;
		const orbRows = renderVoiceOrb(orbState, this.#frame, energy).map(line => {
			const content = ` ${line}`;
			return border(content + " ".repeat(Math.max(0, innerWidth - visibleWidth(content))));
		});
		const transcript = this.#renderTranscript(this.#userTranscript, innerWidth, border);
		return [top, ...orbRows, transcript, this.#renderFooter(width, innerWidth)];
	}

	#renderTranscript(transcript: string, innerWidth: number, border: (content: string) => string): string {
		const content = truncateFromStart(transcript, innerWidth);
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
		return border(theme.fg("accent", content) + padding);
	}

	#renderFooter(width: number, innerWidth: number): string {
		const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		const staticIcons: Record<LivePhase, string> = {
			connecting: "○",
			listening: "●",
			working: "○",
			speaking: "»",
			muted: "×",
			error: "!",
		};
		const icon = this.#phase === "working" ? spinners[this.#frame % spinners.length] : staticIcons[this.#phase];
		const phaseColors: Record<LivePhase, ThemeColor> = {
			connecting: "dim",
			listening: "success",
			working: "warning",
			speaking: "accent",
			muted: "dim",
			error: "error",
		};
		const status = `${icon} ${this.#phase}`;
		const fullLabel = ` ${status} · space mute · esc end `;
		const shortLabel = ` ${status} `;
		const label =
			innerWidth >= visibleWidth(fullLabel) + 1
				? fullLabel
				: innerWidth >= visibleWidth(shortLabel) + 1
					? shortLabel
					: "";
		if (!label) {
			return theme.fg("border", `└${"─".repeat(innerWidth)}${width > 1 ? "┘" : ""}`);
		}
		const remaining = Math.max(0, innerWidth - visibleWidth(label) - 1);
		return (
			theme.fg("border", "└─") +
			theme.fg(phaseColors[this.#phase], truncateToWidth(label, innerWidth - 1)) +
			theme.fg("border", `${"─".repeat(remaining)}${width > 1 ? "┘" : ""}`)
		);
	}
}
