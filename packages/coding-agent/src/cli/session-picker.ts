import { ProcessTerminal, TUI } from "@pk-nerdsaver-ai/pi-tui";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import { SessionSelectorComponent } from "../modes/components/session-selector";
import { HistoryStorage } from "../session/history-storage";
import type { SessionInfo } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";

/**
 * Show the TUI session selector and return the selected session, or null if
 * cancelled. Rendered as a fullscreen overlay on the terminal's alternate
 * screen, so the list scrolls and rows are clickable with the mouse. Tab
 * toggles between current-folder and all-projects scope; the all-projects list
 * is loaded lazily via `SessionManager.listAll`.
 */
export async function selectSession(
	sessions: SessionInfo[],
	options?: { allSessions?: SessionInfo[] },
): Promise<SessionInfo | null> {
	const { promise, resolve } = Promise.withResolvers<SessionInfo | null>();
	const ui = new TUI(new ProcessTerminal());
	let resolved = false;
	const storage = new FileSessionStorage();

	// Rank sessions with prompt-history matches too, recovering prompts the 4KB
	// session-list prefix never sees. Best-effort: a missing/locked history.db
	// must not break the picker.
	let historyMatcher: ((query: string) => string[]) | undefined;
	try {
		const history = HistoryStorage.open();
		historyMatcher = (query: string) => history.matchingSessionIds(query);
	} catch (error) {
		logger.warn("History storage unavailable for session ranking", { error: String(error) });
	}

	const showSelector = () => {
		const selector = new SessionSelectorComponent(
			sessions,
			(session: SessionInfo) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(session);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					process.exit(0);
				}
			},
			{
				onDelete: async (session: SessionInfo) => {
					// Delete handler - SessionList will show confirmation internally
					await storage.deleteSessionWithArtifacts(session.path);
					return true;
				},
				historyMatcher,
				loadAllSessions: () => SessionManager.listAll(storage),
				allSessions: options?.allSessions,
				getTerminalRows: () => ui.terminal.rows,
				fillHeight: true,
			},
		);
		return selector;
	};

	const selector = showSelector();
	selector.setOnRequestRender(() => ui.requestRender());
	// Present as a fullscreen overlay so the picker borrows the terminal's
	// alternate screen buffer (vim/less idiom): the list scrolls and rows are
	// clickable via the mouse tracking the overlay enables for its lifetime.
	// Anchored top-left at full size so a mouse row maps directly to a rendered
	// line (the overlay paints from screen row 0).
	ui.showOverlay(selector, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
	});
	ui.setFocus(selector);
	ui.start();
	return promise;
}
