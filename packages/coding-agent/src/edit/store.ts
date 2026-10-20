/**
 * Session-scoped native edit state: full-file snapshots that mint hashline
 * tags (recorded by `read`/`search`/`write`), `CUT`/`PUT` clipboard
 * registers, and the byte-identical no-op loop guard. One store per
 * {@link ToolSession}; every {@link EditSession} the edit tool opens shares it.
 */
import { EditStore } from "@oh-my-pi/pi-natives";

/** Owner of the lazily created per-session store. */
export interface EditStoreOwner {
	editStore?: EditStore;
}

/** The session's store, created on first use. */
export function getEditStore(session: EditStoreOwner): EditStore {
	session.editStore ??= new EditStore();
	return session.editStore;
}

const SEEN_ROW_PREFIX = /^[ *]?(\d+)(?:-(\d+))?:/;

/**
 * Seen-line entry that no edit can anchor (lines are 1-based). A display whose
 * every row was column-cut records this: the display happened, but it showed no
 * source line whole, so every anchor on it is unseen. An empty seen set says
 * the same to the guard — only a snapshot with no seen-line record at all
 * (`None`) means unrestricted provenance.
 */
const NO_FULL_LINE = 0;

/** Record numbered output without treating column-cut rows as complete source lines. */
export function recordFullySeenRows(
	store: EditStore,
	path: string,
	tag: string,
	body: string,
	cutLines?: ReadonlySet<number>,
): void {
	if (!cutLines?.size) {
		store.recordSeenLinesFromBody(path, tag, body);
		return;
	}
	store.recordSeenLines(path, tag, [NO_FULL_LINE]);
	const completeRows = body
		.split("\n")
		.filter(row => {
			const prefix = SEEN_ROW_PREFIX.exec(row);
			return !prefix || (!cutLines.has(Number(prefix[1])) && (!prefix[2] || !cutLines.has(Number(prefix[2]))));
		})
		.join("\n");
	store.recordSeenLinesFromBody(path, tag, completeRows);
}
