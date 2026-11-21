/**
 * The resume session picker (`omp --resume` with no argument), shared by the
 * startup path and the `omp agents` view's `/resume` command.
 */
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { type SessionPickerOptions, selectSession } from "@oh-my-pi/pi-tui/apps/session-picker";
import { HistoryStorage } from "./history-storage";
import type { SessionInfo } from "./session-listing";
import { SessionManager } from "./session-manager";
import { loadPinnedSessionIds, setSessionPinned } from "./session-pins";
import { FileSessionStorage } from "./session-storage";

export type SessionPicker = (
	sessions: SessionInfo[],
	options?: SessionPickerOptions<SessionInfo>,
) => Promise<SessionInfo | null>;

/** The `omp --resume` picker with this omp's history, pins, rename and delete wired in. */
export function createSessionPicker(init?: { foreign?: boolean }): SessionPicker {
	return (sessions, options) => {
		const storage = new FileSessionStorage();
		// The picker runs before interactive mode loads the user's keymap, and its pin keys are remappable.
		KeybindingsManager.create();
		return selectSession(sessions, options, {
			loadPinnedIds: loadPinnedSessionIds,
			loadHistoryMatcher: () => {
				const history = HistoryStorage.open();
				return query => history.matchingSessionIds(query);
			},
			deleteSession: async session => {
				await storage.deleteSessionWithArtifacts(session.path);
				return true;
			},
			// Foreign import pickers list source-owned sessions, so rename and
			// pins are native pickers only.
			...(init?.foreign
				? {}
				: {
						renameSession: (session: SessionInfo, title: string) =>
							SessionManager.renameSessionTitle(session.path, title, { cwd: session.cwd }),
						setSessionPinned: (session: SessionInfo, pinned: boolean) => setSessionPinned(session.id, pinned),
					}),
			loadAllSessions: () => SessionManager.listAllForPicker(storage),
		});
	};
}
