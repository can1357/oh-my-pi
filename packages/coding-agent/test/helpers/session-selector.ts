/**
 * The `/resume` session picker on an in-memory terminal: built over plain
 * session rows, its picker focused as the overlay focuses it, keys routed as
 * the terminal backend routes them. Picks and cancels are recorded.
 */
import type { SessionSelectorEntry } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/session-selector";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { SessionSelector, type SessionSelectorProps } from "../../src/ui/overlays/pickers/session-selector";
import { mountOverlay } from "./overlay-terminal";

/** A session row in `/work` (or `cwd`) modified at `modified`. */
export function sessionEntry(
	id: string,
	title: string | undefined,
	modified: string,
	extra: Partial<SessionSelectorEntry> = {},
): SessionSelectorEntry {
	return {
		path: `/work/${id}.jsonl`,
		id,
		cwd: "/work",
		...(title !== undefined ? { title } : {}),
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date(modified),
		size: 2048,
		firstMessage: `first message ${id}`,
		allMessagesText: `first message ${id}`,
		...extra,
	};
}

export interface MountedSessionSelector {
	readonly term: TestTerminal;
	/** Sessions picked (Enter, click), in order. */
	readonly picked: SessionSelectorEntry[];
	/** Times the picker cancelled. */
	cancels(): number;
	/** The plain screen. */
	screen(): string;
	/** Press keys by id (`down`, `enter`, `delete`, `tab`); `text` keys type themselves. */
	press(...ids: string[]): void;
	/** The session Enter resumes now (pressing it). */
	enter(): SessionSelectorEntry | undefined;
}

export function mountSessionSelector(
	props: Partial<SessionSelectorProps> & Pick<SessionSelectorProps, "sessions">,
	size: { columns?: number; rows?: number } = {},
): MountedSessionSelector {
	const picked: SessionSelectorEntry[] = [];
	let cancels = 0;
	const rows = size.rows ?? 40;
	const term = mountOverlay(
		() =>
			SessionSelector({
				onSelect: session => picked.push(session),
				onCancel: () => cancels++,
				terminalRows: rows,
				...props,
			}),
		{ columns: size.columns ?? 120, rows },
	);
	return {
		term,
		picked,
		cancels: () => cancels,
		screen() {
			term.render();
			return term.screen().join("\n");
		},
		press(...ids) {
			for (const id of ids) {
				if ([...id].length === 1) term.type(id);
				else term.press(id);
			}
		},
		enter() {
			const before = picked.length;
			term.press("enter");
			return picked.length > before ? picked.at(-1) : undefined;
		},
	};
}
