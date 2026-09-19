import { logger } from "@oh-my-pi/pi-utils";
import {
	SessionSelectorComponent,
	type SessionSelectorEntry,
	type SessionHistoryMatcher,
} from "../overlays/session-selector";
import { runStandaloneTui } from "./standalone-picker";

/** Persistence and history capabilities supplied by the session-owning host. */
export interface SessionPickerHost<T extends SessionSelectorEntry = SessionSelectorEntry> {
	loadPinnedIds?(): Promise<ReadonlySet<string>>;
	loadHistoryMatcher?(): SessionHistoryMatcher;
	deleteSession?(session: T): Promise<boolean>;
	loadAllSessions?(): Promise<T[]>;
}

/** Presentation and capability controls for the standalone session picker. */
export interface SessionPickerOptions<T extends SessionSelectorEntry = SessionSelectorEntry> {
	allSessions?: T[];
	title?: string;
	scopeLabel?: string | false;
	showCwd?: boolean;
	allowDelete?: boolean;
	allowGlobalScope?: boolean;
	historySearch?: boolean;
	pinnedIds?: ReadonlySet<string>;
}

/**
 * Show the TUI session selector and return the selected session, or null if
 * cancelled. The default OMP picker supports deletion, transcript-history
 * search, and an all-projects scope; foreign import pickers disable those
 * source-owned capabilities.
 */
export async function selectSession<T extends SessionSelectorEntry>(
	sessions: T[],
	options: SessionPickerOptions<T> = {},
	host: SessionPickerHost<T> = {},
): Promise<T | null> {
	// Rank sessions with prompt-history matches too, recovering prompts the 4KB
	// session-list prefix never sees. Best-effort: a missing/locked history.db
	// must not break the picker.
	const pinnedIds = options.pinnedIds ?? (await host.loadPinnedIds?.());

	let historyMatcher: ((query: string) => string[]) | undefined;
	if (options.historySearch !== false) {
		try {
			historyMatcher = host.loadHistoryMatcher?.();
		} catch (error) {
			logger.warn("History storage unavailable for session ranking", { error: String(error) });
		}
	}

	return runStandaloneTui<T | null>(
		({ ui, finish }) => {
			const selector = new SessionSelectorComponent(
				sessions,
				(session: T) => finish(session),
				() => finish(null),
				() => {
					ui.stop();
					process.exit(0);
				},
				{
					onDelete: options.allowDelete === false ? undefined : host.deleteSession,
					historyMatcher,
					loadAllSessions: options.allowGlobalScope === false ? undefined : host.loadAllSessions,
					allSessions: options.allSessions,
					getTerminalRows: () => ui.terminal.rows,
					fillHeight: true,
					title: options.title,
					scopeLabel: options.scopeLabel,
					showCwd: options.showCwd,
					pinnedIds,
				},
			);
			selector.setOnRequestRender(() => ui.requestRender());
			return selector;
		},
		// Present as a fullscreen overlay so the picker borrows the terminal's
		// alternate screen buffer (vim/less idiom): the list scrolls and rows are
		// clickable via the mouse tracking the overlay enables for its lifetime.
		// Anchored top-left at full size so a mouse row maps directly to a rendered
		// line (the overlay paints from screen row 0).
		{
			overlay: {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			},
		},
	);
}
