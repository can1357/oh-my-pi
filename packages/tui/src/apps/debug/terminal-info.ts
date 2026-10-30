/**
 * Terminal state collection for the debug menu.
 *
 * Surfaces the detected terminal, the established subprotocols the renderer
 * negotiated (graphics, desktop notifications, hyperlinks, true color), the
 * scrollback/erase strategy, and the live geometry — the details that decide
 * which escape sequences the renderer emits.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import {
	getCellDimensions,
	ImageProtocol,
	isOsc99Supported,
	NotifyProtocol,
	TERMINAL,
	TERMINAL_ID,
} from "../../terminal-capabilities";
import { classifyTerminalMultiplexer } from "../../terminal-multiplexer";

/** Live values the debug view reads off the running TUI, not the static capability table. */
export interface TerminalRuntimeState {
	columns: number;
	rows: number;
	/** Whether DEC 2026 synchronized-output wrappers are currently emitted. */
	synchronizedOutput: boolean;
}

/** Terminal capabilities, geometry, and detection environment. */
export interface TerminalStateInfo {
	detectedId: string;
	columns: number;
	rows: number;
	cellWidthPx: number;
	cellHeightPx: number;
	trueColor: boolean;
	imageProtocol: string;
	notifyProtocol: string;
	osc99Confirmed: boolean;
	hyperlinks: boolean;
	deccara: boolean;
	screenToScrollback: boolean;
	synchronizedOutput: boolean;
	multiplexer: string | null;
	env: { TERM?: string; TERM_PROGRAM?: string; TERM_PROGRAM_VERSION?: string; COLORTERM?: string };
}

const IMAGE_PROTOCOL_NAMES: Record<ImageProtocol, string> = {
	[ImageProtocol.Kitty]: __ompTranslate("Kitty graphics"),
	[ImageProtocol.Iterm2]: __ompTranslate("iTerm2 inline images"),
	[ImageProtocol.Sixel]: "Sixel",
};

const NOTIFY_PROTOCOL_NAMES: Record<NotifyProtocol, string> = {
	[NotifyProtocol.Bell]: "BEL (\\a)",
	[NotifyProtocol.Osc99]: __ompTranslate("OSC 99 (kitty desktop notifications)"),
	[NotifyProtocol.Osc9]: "OSC 9 (iTerm2/WezTerm)",
};

/** Snapshot the active terminal capabilities and the live runtime geometry. */
export function collectTerminalState(runtime: TerminalRuntimeState): TerminalStateInfo {
	const env = Bun.env;
	const cell = getCellDimensions();
	return {
		detectedId: TERMINAL_ID,
		columns: runtime.columns,
		rows: runtime.rows,
		cellWidthPx: cell.widthPx,
		cellHeightPx: cell.heightPx,
		trueColor: TERMINAL.trueColor,
		imageProtocol:
			TERMINAL.imageProtocol === null ? __ompTranslate("none") : IMAGE_PROTOCOL_NAMES[TERMINAL.imageProtocol],
		notifyProtocol: NOTIFY_PROTOCOL_NAMES[TERMINAL.notifyProtocol],
		osc99Confirmed: isOsc99Supported(),
		hyperlinks: TERMINAL.hyperlinks,
		deccara: TERMINAL.deccara,
		screenToScrollback: TERMINAL.supportsScreenToScrollback,
		synchronizedOutput: runtime.synchronizedOutput,
		multiplexer: classifyTerminalMultiplexer(env),
		env: {
			TERM: env.TERM,
			TERM_PROGRAM: env.TERM_PROGRAM,
			TERM_PROGRAM_VERSION: env.TERM_PROGRAM_VERSION,
			COLORTERM: env.COLORTERM,
		},
	};
}

const yesNo = (value: boolean): string => (value ? __ompTranslate("yes") : __ompTranslate("no"));

/** Format terminal state for display in the debug menu. */
export function formatTerminalState(info: TerminalStateInfo): string {
	const lines = [
		__ompTranslate("Terminal State"),
		"━━━━━━━━━━━━━━",
		__ompTranslate("Detected:     {0}", `${info.detectedId}`),
		__ompTranslate(
			"Geometry:     {0}x{1} cells · cell {2}x{3}px",
			`${info.columns}`,
			`${info.rows}`,
			`${info.cellWidthPx}`,
			`${info.cellHeightPx}`,
		),
		info.multiplexer
			? __ompTranslate("Multiplexer:  {0}", `${info.multiplexer}`)
			: __ompTranslate("Multiplexer:  none"),
		"",
		__ompTranslate("Subprotocols"),
		__ompTranslate("  Graphics:     {0}", `${info.imageProtocol}`),
		__ompTranslate(
			"  Notify:       {0}{1}",
			`${info.notifyProtocol}`,
			`${info.osc99Confirmed ? __ompTranslate(" · confirmed via DA") : ""}`,
		),
		__ompTranslate("  Hyperlinks:   {0} (OSC 8)", `${yesNo(info.hyperlinks)}`),
		__ompTranslate("  True color:   {0} (24-bit SGR)", `${yesNo(info.trueColor)}`),
		__ompTranslate("  DECCARA:      {0} (rectangular-SGR background fills)", `${yesNo(info.deccara)}`),
		__ompTranslate("  Sync output:  {0} (DEC 2026)", `${yesNo(info.synchronizedOutput)}`),
		"",
		__ompTranslate("Scrollback"),
		__ompTranslate(
			"  Screen->history clear: {0}",
			`${info.screenToScrollback ? "CSI 22 J" : __ompTranslate("CSI 2 J (redraw)")}`,
		),
		"",
		__ompTranslate("Detection signals"),
		`  TERM:                 ${info.env.TERM ?? __ompTranslate("(unset)\u0004terminal.setting.unset")}`,
		`  TERM_PROGRAM:         ${info.env.TERM_PROGRAM ?? __ompTranslate("(unset)\u0004terminal.setting.unset")}`,
		`  TERM_PROGRAM_VERSION: ${info.env.TERM_PROGRAM_VERSION ?? __ompTranslate("(unset)\u0004terminal.setting.unset")}`,
		`  COLORTERM:            ${info.env.COLORTERM ?? __ompTranslate("(unset)\u0004terminal.setting.unset")}`,
	];
	return lines.join("\n");
}
