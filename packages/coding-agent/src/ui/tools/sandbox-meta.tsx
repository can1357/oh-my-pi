/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A run the OS sandbox contained, as the bash and eval presenters show it:
 * the `sandboxed` head badge and one warning note per sandbox finding after
 * the run boxes. The terminal looks read both back (`src/ui/styles/tools/sandbox.ts`).
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { SANDBOX_BADGE_TEXT, sandboxBadgeTitle, sandboxNotes } from "../../tools/details/sandbox";
import type { SandboxResultMeta } from "../../sandbox/types";
import type { ToolHead } from "./contract";

/** Role of a sandbox warning note in a tool body. */
export const SANDBOX_NOTE_ROLE = "omp.tool.sandbox.note";

type ToolBadge = NonNullable<ToolHead["badges"]>[number];

/** The `sandboxed` head badge; its title names backend, mode and network. */
export function sandboxBadge(meta: SandboxResultMeta): ToolBadge {
	return { text: SANDBOX_BADGE_TEXT, tone: "info", title: sandboxBadgeTitle(meta) };
}

/** The warning notes of a contained run (none when `meta` is absent), keyed `sandbox-<i>`; `failed`: the call failed (time-attributed hosts count then). */
export function sandboxNoteNodes(meta: SandboxResultMeta | undefined, failed: boolean): JSXNode[] {
	return sandboxNotes(meta, failed).map((note, index) => (
		<text key={`sandbox-${index}`} role={SANDBOX_NOTE_ROLE} spans={[{ t: note, s: "warning" }]} wrap="word" />
	));
}
