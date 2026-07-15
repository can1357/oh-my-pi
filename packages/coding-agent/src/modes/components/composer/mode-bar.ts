/**
 * Work-mode selector rendered above the composer.
 *
 * Reuses the TUI `TabBar` for layout: per-tab hit zones, short-label collapse
 * on narrow widths, and last-resort wrapping — so the bar never forces
 * horizontal overflow. Selection state is derived from the host on every
 * render (single source of truth: plan-mode/ask-mode session state), so the
 * bar can never go stale or hold duplicate mode state.
 */
import { type Component, TabBar, visibleWidth } from "@pk-nerdsaver-ai/pi-tui";
import { theme } from "../../../modes/theme/theme";
import { COMPOSER_WORK_MODES, type ComposerWorkMode } from "./work-modes";

export interface ComposerModeBarContext {
	/** Whether the intent composer layout is active at all. */
	isEnabled(): boolean;
	/** Currently selected work mode, derived from session state. */
	getSelectedMode(): ComposerWorkMode;
	/** Modes that map to available runtime behavior right now. */
	isModeAvailable(mode: ComposerWorkMode): boolean;
	/** Human-readable key hint for cycling modes (e.g. "alt+shift+m"), if bound. */
	getCycleKeyHint(): string | undefined;
}

export class ComposerModeBar implements Component {
	#tabBar: TabBar;

	constructor(private readonly ctx: ComposerModeBarContext) {
		this.#tabBar = new TabBar(
			"",
			[],
			{
				label: text => theme.fg("muted", text),
				// The selected mode carries a non-color signal (the ◆ marker and
				// bold weight) in addition to the accent color.
				activeTab: text => theme.fg("accent", theme.bold(`◆${text}`)),
				inactiveTab: text => theme.fg("muted", text),
				hint: text => theme.fg("dim", text),
			},
			0,
		);
		this.#tabBar.showHint = false;
	}

	invalidate(): void {}

	/** Resolve a pointer position to a mode id (for future mouse routing). */
	modeAt(line: number, col: number): ComposerWorkMode | undefined {
		const tab = this.#tabBar.tabAt(line, col - 1);
		return tab ? (tab.id as ComposerWorkMode) : undefined;
	}

	render(width: number): readonly string[] {
		if (!this.ctx.isEnabled()) return [];

		const modes = COMPOSER_WORK_MODES.filter(mode => this.ctx.isModeAvailable(mode.id));
		if (modes.length === 0) return [];

		this.#tabBar.setTabs(
			modes.map(mode => ({ id: mode.id, label: mode.label, short: mode.short })),
			this.ctx.getSelectedMode(),
		);

		const barWidth = Math.max(1, width - 1);
		const lines = this.#tabBar.render(barWidth).map(line => ` ${line}`);

		// Right-align the cycle-key hint on the first line when there is room.
		const hintKey = this.ctx.getCycleKeyHint();
		if (hintKey && lines.length === 1) {
			const hint = theme.fg("dim", `${hintKey} mode`);
			const hintWidth = hintKey.length + 5;
			const firstWidth = visibleWidth(lines[0]!);
			const gap = width - firstWidth - hintWidth;
			if (gap >= 2) {
				lines[0] = lines[0] + " ".repeat(gap) + hint;
			}
		}

		return lines;
	}

	/** Number of external rows this bar occupies at the current width. */
	rowCount(width: number): number {
		return this.render(width).length;
	}
}
