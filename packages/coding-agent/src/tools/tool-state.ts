/**
 * State a conversation accumulates through its tools, apart from the host
 * capabilities a {@link ToolSession} also carries (cwd, settings, callbacks).
 *
 * Every field is created on first use by its accessor (`getEditStore`,
 * `getConflictHistory`, `getDiagnosticsLedger`, …). A session derived from
 * another — an advisor's, a speculative read's — sets its own `state` so it
 * never shares this with the session it was copied from.
 */
import type { EditStore, SummaryResult } from "@oh-my-pi/pi-natives";
import type { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { DiagnosticsLedger } from "../lsp/diagnostics-ledger";
import type { ConflictHistory } from "./conflict-detect";
import type { ToolSession } from "./index";

export class ToolConversationState {
	/** Native snapshots, clipboard registers, and no-op guard shared by edit calls. */
	editStore?: EditStore;
	/**
	 * Unresolved git merge conflict regions surfaced by `read`. Each entry gets a
	 * stable id N referenced by `write conflict://N` to splice the recorded
	 * region with replacement content.
	 */
	conflictHistory?: ConflictHistory;
	/** Post-edit LSP diagnostics already surfaced to the model for each file. */
	diagnosticsLedger?: DiagnosticsLedger;
	/** Per read selector: hash of the last output and how often it repeated. */
	repeatReads?: Map<string, { hash: bigint; count: number }>;
	/** Memoized tree-sitter summaries; `false` marks a file with nothing to summarize. */
	summaryParses?: LRUCache<string, SummaryResult | false>;
}

/** The session's conversation state, created on first use. */
export function getToolConversationState(session: ToolSession): ToolConversationState {
	session.state ??= new ToolConversationState();
	return session.state;
}
