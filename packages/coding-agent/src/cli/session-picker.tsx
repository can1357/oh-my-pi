/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The standalone session picker (`omp --resume`, `--from-<tool>` imports):
 * the `/resume` selector run fullscreen before any session exists.
 */
import * as path from "node:path";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import type { SessionPickerOptions } from "../modes/view-model/apps/session-picker";
import type {
	SessionHistoryMatcher,
	SessionListing,
	SessionSelectorEntry,
} from "../modes/view-model/overlays/session-selector";
import { runStandalone } from "../ui/apps/fullscreen";
import { SessionSelector, sessionSelectorFocus } from "../ui/overlays/pickers/session-selector";

/** What the picker can do to sessions; foreign import pickers leave most out. */
export interface SessionPickerHost<T extends SessionSelectorEntry = SessionSelectorEntry> {
	loadPinnedIds?(): Promise<ReadonlySet<string>>;
	loadHistoryMatcher?(): SessionHistoryMatcher;
	deleteSession?(session: T): Promise<boolean>;
	/** Rename the session and resolve with the title as stored, or null when it did not happen. */
	renameSession?(session: T, title: string): Promise<string | null>;
	setSessionPinned?(session: T, pinned: boolean): Promise<void>;
	loadAllSessions?(): Promise<SessionListing<T>>;
}

/**
 * Show the session selector and resolve with the picked session, or null when
 * cancelled (Ctrl+C exits the process). The default picker deletes, searches
 * prompt history and switches to every project; foreign import pickers turn
 * those source-owned capabilities off.
 */
export async function selectSession<T extends SessionSelectorEntry>(
	sessions: T[],
	options: SessionPickerOptions<T> = {},
	host: SessionPickerHost<T> = {},
): Promise<T | null> {
	const pinnedIds = options.pinnedIds ?? (await host.loadPinnedIds?.());
	// A missing or locked history.db must not break the picker.
	let historyMatcher: SessionHistoryMatcher | undefined;
	if (options.historySearch !== false) {
		try {
			historyMatcher = host.loadHistoryMatcher?.();
		} catch (error) {
			logger.warn("History storage unavailable for session ranking", { error: String(error) });
		}
	}
	const rename = options.onRename ?? host.renameSession;
	const allSessions = options.allSessions;
	const loadAll =
		options.allowGlobalScope === false
			? undefined
			: allSessions
				? async () => allSessions
				: host.loadAllSessions?.bind(host);
	const deleteSession = options.allowDelete === false ? undefined : host.deleteSession?.bind(host);
	let exit = false;
	const picked = await runStandalone<T | null>({ title: options.title ?? "Resume Session" }, screen => {
		const done = Promise.withResolvers<T | null>();
		return {
			view: () => (
				<SessionSelector
					sessions={sessions}
					completeSessions={options.completeSessions}
					historyMatcher={historyMatcher}
					pinnedIds={pinnedIds}
					title={options.title}
					scopeLabel={options.scopeLabel === false ? undefined : options.scopeLabel}
					showCwd={options.showCwd}
					terminalRows={screen.rows}
					fillHeight
					standalone
					projectName={options.scopeLabel === false ? undefined : path.basename(getProjectDir())}
					onSelect={session => done.resolve(session as T)}
					onCancel={() => done.resolve(null)}
					onExit={() => {
						exit = true;
						done.resolve(null);
					}}
					onDelete={deleteSession ? session => deleteSession(session as T) : undefined}
					onRename={
						rename ? async (session, title) => (await rename(session as T, title)) ?? undefined : undefined
					}
					onSetPinned={
						host.setSessionPinned ? (session, pinned) => host.setSessionPinned!(session as T, pinned) : undefined
					}
					loadAllSessions={loadAll}
				/>
			),
			focus: sessionSelectorFocus,
			done: done.promise,
		};
	});
	if (exit) process.exit(0);
	return picked;
}
