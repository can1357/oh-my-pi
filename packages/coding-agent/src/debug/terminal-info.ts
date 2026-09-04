/**
 * Terminal state collection for the debug menu.
 *
 * Surfaces the detected terminal, the established subprotocols the renderer
 * negotiated (graphics, desktop notifications, hyperlinks, true color), the
 * scrollback/erase strategy, and the live geometry — the details that decide
 * which escape sequences the renderer emits.
 */
import {
	getCellDimensions,
	ImageProtocol,
	isInsideHerdr,
	isOsc99Supported,
	NotifyProtocol,
	TERMINAL,
	TERMINAL_ID,
} from "@oh-my-pi/pi-tui";

/** Live values the debug view reads off the running TUI, not the static capability table. */
export interface TerminalRuntimeState {
	columns: number;
	rows: number;
	/** Whether DEC 2026 synchronized-output wrappers are currently emitted. */
	synchronizedOutput: boolean;
}

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
	[ImageProtocol.Kitty]: "Kitty graphics",
	[ImageProtocol.Iterm2]: "iTerm2 inline images",
	[ImageProtocol.Sixel]: "Sixel",
};

const NOTIFY_PROTOCOL_NAMES: Record<NotifyProtocol, string> = {
	[NotifyProtocol.Bell]: "BEL (\\a)",
	[NotifyProtocol.Osc99]: "OSC 99 (kitty desktop notifications)",
	[NotifyProtocol.Osc9]: "OSC 9 (iTerm2/WezTerm)",
};

/** Identify the multiplexer wrapping the session, if any (mirrors the renderer's gate). */
function detectMultiplexer(env: NodeJS.ProcessEnv): string | null {
	if (isInsideHerdr(env)) return "herdr";
	if (env.TMUX) return "tmux";
	if (env.STY) return "screen";
	if (env.ZELLIJ) return "zellij";
	if (env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_REMOTE_TRANSPORT) return "cmux";
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.startsWith("tmux")) return "tmux";
	if (term.startsWith("screen")) return "screen";
	return null;
}

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
		imageProtocol: TERMINAL.imageProtocol === null ? "none" : IMAGE_PROTOCOL_NAMES[TERMINAL.imageProtocol],
		notifyProtocol: NOTIFY_PROTOCOL_NAMES[TERMINAL.notifyProtocol],
		osc99Confirmed: isOsc99Supported(),
		hyperlinks: TERMINAL.hyperlinks,
		deccara: TERMINAL.deccara,
		screenToScrollback: TERMINAL.supportsScreenToScrollback,
		synchronizedOutput: runtime.synchronizedOutput,
		multiplexer: detectMultiplexer(env),
		env: {
			TERM: env.TERM,
			TERM_PROGRAM: env.TERM_PROGRAM,
			TERM_PROGRAM_VERSION: env.TERM_PROGRAM_VERSION,
			COLORTERM: env.COLORTERM,
		},
	};
}

const yesNo = (value: boolean): string => (value ? "yes" : "no");

/** Format terminal state for display in the debug menu. */
export function formatTerminalState(info: TerminalStateInfo): string {
	const lines = [
		"Terminal State",
		"━━━━━━━━━━━━━━",
		`Detected:     ${info.detectedId}`,
		`Geometry:     ${info.columns}x${info.rows} cells · cell ${info.cellWidthPx}x${info.cellHeightPx}px`,
		info.multiplexer ? `Multiplexer:  ${info.multiplexer}` : "Multiplexer:  none",
		"",
		"Subprotocols",
		`  Graphics:     ${info.imageProtocol}`,
		`  Notify:       ${info.notifyProtocol}${info.osc99Confirmed ? " · confirmed via DA" : ""}`,
		`  Hyperlinks:   ${yesNo(info.hyperlinks)} (OSC 8)`,
		`  True color:   ${yesNo(info.trueColor)} (24-bit SGR)`,
		`  DECCARA:      ${yesNo(info.deccara)} (rectangular-SGR background fills)`,
		`  Sync output:  ${yesNo(info.synchronizedOutput)} (DEC 2026)`,
		"",
		"Scrollback",
		`  Screen->history clear: ${info.screenToScrollback ? "CSI 22 J" : "CSI 2 J (redraw)"}`,
		"",
		"Detection signals",
		`  TERM:                 ${info.env.TERM ?? "(unset)"}`,
		`  TERM_PROGRAM:         ${info.env.TERM_PROGRAM ?? "(unset)"}`,
		`  TERM_PROGRAM_VERSION: ${info.env.TERM_PROGRAM_VERSION ?? "(unset)"}`,
		`  COLORTERM:            ${info.env.COLORTERM ?? "(unset)"}`,
	];
	return lines.join("\n");
}
