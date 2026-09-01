import type { Component } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

export type VoiceIndicatorState = "recording" | "transcribing";

const ORB_WIDTH = 19;
const ORB_HEIGHT = 5;

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/** Center a styled line by its visible terminal width. */
export function centerVoiceLine(line: string, width: number): string {
	const left = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
	const right = Math.max(0, width - left - visibleWidth(line));
	return `${" ".repeat(left)}${line}${" ".repeat(right)}`;
}

/**
 * Render an audio-reactive terminal orb. The center stays fixed; slow, layered
 * harmonics deform its edge and density so motion reads as organic breathing,
 * not a sprite bouncing between discrete positions.
 */
export function renderVoiceOrb(frame: number, energy: number): readonly string[] {
	const time = frame * 0.075;
	const response = Math.sqrt(clamp01(energy));
	const centerX = (ORB_WIDTH - 1) / 2;
	const centerY = (ORB_HEIGHT - 1) / 2;
	const radiusX = 6.4 + response * 0.9 + Math.sin(time * 0.47) * 0.18;
	const radiusY = 2.05 + response * 0.25 + Math.sin(time * 0.39 + 0.8) * 0.08;
	const lines: string[] = [];

	for (let y = 0; y < ORB_HEIGHT; y++) {
		let line = "";
		for (let x = 0; x < ORB_WIDTH; x++) {
			const dx = (x - centerX) / radiusX;
			const dy = (y - centerY) / radiusY;
			const angle = Math.atan2(dy, dx);
			const distance = Math.sqrt(dx * dx + dy * dy);
			const deformation =
				Math.sin(angle * 3 + time * 0.63) * 0.055 +
				Math.sin(angle * 5 - time * 0.31 + 1.4) * 0.035 +
				Math.sin(angle * 2 + time * 0.19) * response * 0.045;
			const density = clamp01((1 - distance + deformation) * 2.65);
			if (density < 0.08) line += " ";
			else if (density < 0.3) line += theme.fg("dim", "░");
			else if (density < 0.55) line += theme.fg("muted", "▒");
			else if (density < 0.8) line += theme.fg("borderAccent", "▓");
			else line += theme.fg("accent", "█");
		}
		lines.push(line);
	}
	return lines;
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
		const energy = listening
			? 0.52 + Math.sin(this.#frame * 0.11) * 0.18
			: 0.3 + Math.sin(this.#frame * 0.045) * 0.06;
		const orb = renderVoiceOrb(this.#frame, energy).map(line => centerVoiceLine(line, frameWidth));
		const status = listening ? theme.bold("Listening") : theme.bold("Thinking");
		const hint = listening ? "speak naturally" : "turning voice into words";
		return [...orb, centerVoiceLine(status, frameWidth), centerVoiceLine(theme.fg("muted", hint), frameWidth)];
	}
}
