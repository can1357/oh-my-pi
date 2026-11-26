/**
 * `/debug` → "View: terminal state": the detected terminal, what the driver
 * negotiated with it (graphics, notifications, hyperlinks, color depth,
 * synchronized output), the scrollback strategy, the live geometry and the
 * environment the detection read.
 */
import { DEFAULT_CELL } from "@oh-my-pi/pi-tui/driver/images/fit";
import type { ProcessTerminalDriver } from "@oh-my-pi/pi-tui/driver/index";

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
	richNotifications: boolean;
	hyperlinks: boolean;
	synchronizedOutput: boolean;
	multiplexer: string | null;
	env: { TERM?: string; TERM_PROGRAM?: string; TERM_PROGRAM_VERSION?: string; COLORTERM?: string };
}

const IMAGE_PROTOCOL_NAMES = { kitty: "Kitty graphics", iterm: "iTerm2 inline images", sixel: "Sixel" } as const;
const NOTIFY_PROTOCOL_NAMES = {
	bell: "BEL (\\a)",
	osc99: "OSC 99 (kitty desktop notifications)",
	osc9: "OSC 9 (iTerm2/WezTerm)",
} as const;

/** Snapshot what `driver` knows about the terminal. */
export function collectTerminalState(
	driver: Pick<ProcessTerminalDriver, "columns" | "rows" | "capabilities" | "identity">,
): TerminalStateInfo {
	const env = Bun.env;
	const caps = driver.capabilities;
	const identity = driver.identity;
	const cell = caps.cell ?? DEFAULT_CELL;
	return {
		detectedId: identity.id,
		columns: driver.columns,
		rows: driver.rows,
		cellWidthPx: cell.w,
		cellHeightPx: cell.h,
		trueColor: caps.truecolor,
		imageProtocol: caps.images === null ? "none" : IMAGE_PROTOCOL_NAMES[caps.images],
		notifyProtocol: NOTIFY_PROTOCOL_NAMES[identity.notify],
		richNotifications: identity.richNotifications,
		hyperlinks: caps.hyperlinks,
		synchronizedOutput: caps.synchronizedOutput,
		multiplexer: identity.multiplexer,
		env: {
			TERM: env.TERM,
			TERM_PROGRAM: env.TERM_PROGRAM,
			TERM_PROGRAM_VERSION: env.TERM_PROGRAM_VERSION,
			COLORTERM: env.COLORTERM,
		},
	};
}

const yesNo = (value: boolean): string => (value ? "yes" : "no");

/**
 * Format terminal state for display in the debug menu. The row renderer fills
 * backgrounds with padded cells and redraws after a clear, so DECCARA and the
 * screen-to-history clear (`CSI 22 J`) are reported as unused.
 */
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
		`  Notify:       ${info.notifyProtocol}${info.richNotifications ? " · confirmed via DA" : ""}`,
		`  Hyperlinks:   ${yesNo(info.hyperlinks)} (OSC 8)`,
		`  True color:   ${yesNo(info.trueColor)} (24-bit SGR)`,
		"  DECCARA:      no (rectangular-SGR background fills)",
		`  Sync output:  ${yesNo(info.synchronizedOutput)} (DEC 2026)`,
		"",
		"Scrollback",
		"  Screen->history clear: CSI 2 J (redraw)",
		"",
		"Detection signals",
		`  TERM:                 ${info.env.TERM ?? "(unset)"}`,
		`  TERM_PROGRAM:         ${info.env.TERM_PROGRAM ?? "(unset)"}`,
		`  TERM_PROGRAM_VERSION: ${info.env.TERM_PROGRAM_VERSION ?? "(unset)"}`,
		`  COLORTERM:            ${info.env.COLORTERM ?? "(unset)"}`,
	];
	return lines.join("\n");
}
