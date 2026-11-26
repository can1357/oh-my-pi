/**
 * State of the realtime-call panel: the call phase, the microphone level
 * (held at its peak and decaying per animation frame), the animation frame
 * and the user's streaming transcript.
 */
import { type Accessor, batch, signal } from "@oh-my-pi/pi-tui";
import { flattenLine, stripControl } from "@oh-my-pi/pi-tui/text/sanitize";
import type { TspTone } from "@oh-my-pi/pi-wire";
import type { LivePhase } from "../../../modes/view-model/apps/live-visualizer";

export type { LivePhase };

/** Status glyph per phase (the working phase shows a spinner instead). */
export const PHASE_ICONS: Readonly<Record<LivePhase, string>> = {
	connecting: "○",
	listening: "●",
	working: "○",
	speaking: "»",
	muted: "×",
	error: "!",
};

/** Theme color of the status per phase. */
export const PHASE_COLORS: Readonly<Record<LivePhase, string>> = {
	connecting: "dim",
	listening: "success",
	working: "warning",
	speaking: "accent",
	muted: "dim",
	error: "error",
};

/** Card tone per phase. */
export const PHASE_TONES: Readonly<Record<LivePhase, TspTone>> = {
	connecting: "muted",
	listening: "success",
	working: "warning",
	speaking: "accent",
	muted: "muted",
	error: "error",
};

/** Per-frame decay of the held level. */
const LEVEL_DECAY = 0.84;
/** The mic meter snaps to 1/20 steps so decay ticks don't change the tree every frame. */
const METER_STEPS = 20;

export interface LiveCallModel {
	readonly phase: Accessor<LivePhase>;
	/** The held microphone level (0..1). */
	readonly level: Accessor<number>;
	readonly frame: Accessor<number>;
	/** The transcript as one line. */
	readonly transcript: Accessor<string>;
	setPhase(phase: LivePhase): void;
	/** The microphone volume (0..1; anything else clamps, NaN is silence). */
	setInputLevel(level: number): void;
	/** Advance the animation: the held level decays toward the input level. */
	setFrame(frame: number): void;
	setTranscript(text: string): void;
	clearTranscript(): void;
}

export function createLiveCallModel(): LiveCallModel {
	const phase = signal<LivePhase>("connecting");
	const input = signal(0);
	const level = signal(0);
	const frame = signal(0);
	const transcript = signal("");
	return {
		phase,
		level,
		frame,
		transcript,
		setPhase: next => phase.set(next),
		setInputLevel(value) {
			const next = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
			batch(() => {
				input.set(next);
				if (next > level.peek()) level.set(next);
			});
		},
		setFrame(next) {
			batch(() => {
				frame.set(next);
				level.set(Math.max(input.peek(), level.peek() * LEVEL_DECAY));
			});
		},
		setTranscript: text => transcript.set(flattenLine(stripControl(text.replace(/\s+/g, " ")))),
		clearTranscript: () => transcript.set(""),
	};
}

/** How loud the spectrum draws (0..1): silent while muted, a square-root boost of the held level otherwise. */
export function callEnergy(phase: LivePhase, level: number): number {
	return phase === "muted" ? 0 : Math.min(1, Math.sqrt(level * 5));
}

/** The mic meter's value: the energy in 1/20 steps. */
export function meterValue(energy: number): number {
	return Math.round(energy * METER_STEPS) / METER_STEPS;
}
