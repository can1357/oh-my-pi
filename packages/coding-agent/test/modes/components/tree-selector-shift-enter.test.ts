import { afterAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { mountTreeSelector } from "../../helpers/tree-selector";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

// A terminal that delivers Shift+Enter as a bare LF (iTerm2
// legacy mapping, e.g. Claude Code's /terminal-setup) must not have the key
// reinterpreted as plain Enter inside the /tree selector. The composer already
// treats `\n` as Shift+Enter; the selector must match so summarize-and-switch
// still fires.

function node(entry: SessionEntry): SessionTreeNode {
	return { entry, children: [] };
}

function chain(entries: SessionEntry[]): SessionTreeNode {
	const [head, ...rest] = entries.map(node);
	let tail = head as SessionTreeNode;
	for (const next of rest) {
		tail.children.push(next);
		tail = next;
	}
	return head as SessionTreeNode;
}

const base = (id: string, parentId: string | null) => ({ id, parentId, timestamp: "2026-01-01T00:00:00.000Z" });

const userEntry: SessionEntry = {
	...base("u1", null),
	type: "message",
	message: { role: "user", content: "start", timestamp: 0 } as AgentMessage,
} as SessionEntry;

const responseEntry: SessionEntry = {
	...base("r1", "u1"),
	type: "message",
	message: { role: "assistant", content: "response", timestamp: 1 } as unknown as AgentMessage,
} as SessionEntry;

interface SelectRecord {
	entryId: string;
	options: { summarize: boolean };
}

/** Feed `raw` (one key, as the terminal sends it) to the tree over `entries`; the selections it made. */
function selectionsAfter(entries: SessionEntry[], raw: string): SelectRecord[] {
	const records: SelectRecord[] = [];
	const term = mountTreeSelector(
		{
			roots: [chain(entries)],
			currentLeafId: entries.at(-1)?.id ?? null,
			onSelect: (entryId, options) => records.push({ entryId, options }),
		},
		{ rows: 40 },
	);
	try {
		// Decoded the way the driver decodes it (legacy terminals: no kitty keyboard protocol).
		const key = decodeKey(raw, { kitty: false, backspaceIsCtrl: false });
		if (!key) throw new Error(`undecodable key ${JSON.stringify(raw)}`);
		// The raw bytes ride along: a bare LF and a CR both decode to `enter`.
		term.press(key.id, { text: key.raw });
	} finally {
		term.dispose();
	}
	return records;
}

describe("tree selector Shift+Enter fallback", () => {
	it("treats a bare LF as Shift+Enter (summarize-and-switch)", () => {
		expect(selectionsAfter([userEntry, responseEntry], "\n")).toEqual([
			{ entryId: responseEntry.id, options: { summarize: true } },
		]);
	});

	it("keeps plain CR as plain Enter (plain switch, no summary)", () => {
		expect(selectionsAfter([userEntry, responseEntry], "\r")).toEqual([
			{ entryId: responseEntry.id, options: { summarize: false } },
		]);
	});

	it("still recognizes the kitty CSI-u Shift+Enter encoding", () => {
		expect(selectionsAfter([userEntry, responseEntry], "\u001b[13;2u")).toEqual([
			{ entryId: responseEntry.id, options: { summarize: true } },
		]);
	});

	it("treats the legacy CSI ~ form as Shift+Enter (summarize-and-switch), matching the composer", () => {
		expect(selectionsAfter([userEntry, responseEntry], "\u001b[13;2~")).toEqual([
			{ entryId: responseEntry.id, options: { summarize: true } },
		]);
	});
});
