/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The ctrl+p role-cycle track (`modelCycle` slot): the cycled roles in a row,
 * each in its position's theme color, the active one filled as a chip. It
 * clears itself four seconds after the last cycle.
 *
 * - Natively (role `omp.track`): one `text` per role, the active one roled
 *   `omp.track.active` (the terminal fills it as a chip), the rest
 *   `omp.track.item`; no caps or separators travel.
 * - In a text terminal (`src/ui/styles/dock/track.ts`): a blank row, then one
 *   cell in: plain labels joined by a thin `┆`, the active one a powerline
 *   chip (`◀ slow ▶`) in its color with a contrasting bold label, padded by
 *   two spaces instead of separators.
 */
import { computed, type JSXNode, signal } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../styles/dock";

/** The track shown: role labels and the active one. */
export interface CycleTrack {
	readonly segments: readonly string[];
	readonly active: number;
}

/** How long the track lingers after the last cycle, ms. */
export const CYCLE_TRACK_CLEAR_MS = 4000;

/** What the track shows; `show` on every cycle. */
export class ModelCycleModel {
	readonly track = signal<CycleTrack | undefined>(undefined);
	#timer: NodeJS.Timeout | undefined;

	/** Show the track and (re)arm its clear timer. */
	show(segments: readonly string[], active: number): void {
		this.track.set({ segments, active });
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.clear(), CYCLE_TRACK_CLEAR_MS);
		this.#timer.unref?.();
	}

	clear(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.track.set(undefined);
	}
}

/** Vivid theme colors a track position takes, in preference order. */
const CANDIDATES = [
	"accent",
	"success",
	"warning",
	"error",
	"mdCode",
	"mdLink",
	"syntaxString",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxNumber",
	"syntaxOperator",
	"syntaxVariable",
];

/**
 * Up to `count` theme colors that look distinct under `theme`, in preference
 * order (themes alias many candidates to one hue); never empty.
 */
export function trackPalette(theme: Theme, count: number): string[] {
	const palette: string[] = [];
	const seen = new Set<string>();
	for (const color of CANDIDATES) {
		if (!theme.has(color)) continue;
		const sgr = theme.fgSgr(color);
		if (seen.has(sgr)) continue;
		seen.add(sgr);
		palette.push(color);
		if (palette.length >= count) break;
	}
	return palette.length > 0 ? palette : ["accent"];
}

/** See the module docs. */
export function ModelCycleTrack(props: { readonly model: ModelCycleModel }): JSXNode {
	const model = props.model;
	const palette = computed(() => trackPalette(currentTheme(), model.track()?.segments.length ?? 0));
	return () => {
		const track = model.track();
		if (!track) return undefined;
		const colors = palette();
		return (
			<row role="omp.track" gap="sm" align="center" term={{ track }}>
				{track.segments.map((label, index) => (
					<text
						key={`${index}`}
						spans={[{ t: label, s: colors[index % colors.length]! }]}
						wrap="none"
						role={index === track.active ? "omp.track.active" : "omp.track.item"}
					/>
				))}
			</row>
		);
	};
}
