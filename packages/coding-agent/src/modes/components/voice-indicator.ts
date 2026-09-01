import { renderTuiOrb } from "thinking-orbs/tui";
import type { OrbState } from "thinking-orbs/engine";
import type { Component } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

export type VoiceIndicatorState = "recording" | "transcribing";

const ORB_WIDTH = 19;
const ORB_HEIGHT = 7;

function voiceGlyph(glyph: string, intensity: number): string {
	if (glyph === " ") return glyph;
	const color = intensity >= 0.68 ? "accent" : intensity >= 0.4 ? "borderAccent" : intensity >= 0.2 ? "muted" : "dim";
	return theme.fg(color, glyph);
}

/** Center a styled line by its visible terminal width. */
export function centerVoiceLine(line: string, width: number): string {
	const left = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
	const right = Math.max(0, width - left - visibleWidth(line));
	return `${" ".repeat(left)}${line}${" ".repeat(right)}`;
}

/** Project thinking-orbs' shared particle geometry into a stable TUI frame. */
export function renderVoiceOrb(state: OrbState, frame: number, energy = 0, rows = ORB_HEIGHT): readonly string[] {
	const response = Math.sqrt(Math.min(1, Math.max(0, energy)));
	return renderTuiOrb(state, {
		columns: ORB_WIDTH,
		rows,
		time: frame * 0.12,
		speed: 0.55 + response * 0.2,
		threshold: 0.23 - response * 0.07,
		paint: voiceGlyph,
	}).lines;
}

/** Compact non-modal voice presence rendered as a floating TUI overlay. */
export class VoiceIndicatorComponent implements Component {
	#state: VoiceIndicatorState;
	#frame = 0;

	constructor(state: VoiceIndicatorState) {
		this.#state = state;
	}

	setState(state: VoiceIndicatorState): void {
		if (this.#state === state) return;
		this.#state = state;
		this.#frame = 0;
	}

	advance(): void {
		this.#frame++;
	}

	render(width: number): readonly string[] {
		const frameWidth = Math.max(24, width);
		const listening = this.#state === "recording";
		const energy = listening ? 0.52 + Math.sin(this.#frame * 0.11) * 0.18 : 0.3;
		const orb = renderVoiceOrb(listening ? "listening" : "solving", this.#frame, energy).map(line =>
			centerVoiceLine(line, frameWidth),
		);
		const status = listening ? theme.bold("Listening") : theme.bold("Thinking");
		const hint = listening ? "speak naturally" : "turning voice into words";
		return [...orb, centerVoiceLine(status, frameWidth), centerVoiceLine(theme.fg("muted", hint), frameWidth)];
	}
}
