import { type SessionListing, type SessionSelectorEntry } from "../overlays/session-selector";

/** Presentation and capability controls for the standalone session picker. */
export interface SessionPickerOptions<T extends SessionSelectorEntry = SessionSelectorEntry> {
	/** Complete listing replacing the preliminary `sessions` once it settles. */
	completeSessions?: Promise<T[]>;
	allSessions?: SessionListing<T>;
	title?: string;
	scopeLabel?: string | false;
	showCwd?: boolean;
	allowDelete?: boolean;
	/** Rename the selected session; resolve with the title as stored, or null when it did not happen. */
	onRename?: (session: T, title: string) => Promise<string | null>;
	allowGlobalScope?: boolean;
	historySearch?: boolean;
	pinnedIds?: ReadonlySet<string>;
}
