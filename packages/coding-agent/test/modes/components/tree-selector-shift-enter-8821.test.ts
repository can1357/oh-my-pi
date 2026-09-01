import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

// Issue #8821 — a terminal that delivers Shift+Enter as a bare LF (iTerm2
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

function selectorWithOnSelect(
	entries: SessionEntry[],
	records: SelectRecord[],
): { selector: TreeSelectorComponent; onSelect: (id: string, o: { summarize: boolean }) => void } {
	const onSelect = (entryId: string, options: { summarize: boolean }) => {
		records.push({ entryId, options });
	};
	const selector = new TreeSelectorComponent([chain(entries)], entries.at(-1)?.id ?? null, 40, onSelect, () => {});
	return { selector, onSelect };
}

describe("tree selector Shift+Enter fallback (issue #8821)", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("treats a bare LF as Shift+Enter (summarize-and-switch)", () => {
		const records: SelectRecord[] = [];
		const { selector } = selectorWithOnSelect([userEntry, responseEntry], records);
		selector.handleInput("\n");
		expect(records).toEqual([{ entryId: responseEntry.id, options: { summarize: true } }]);
	});

	it("keeps plain CR as plain Enter (plain switch, no summary)", () => {
		const records: SelectRecord[] = [];
		const { selector } = selectorWithOnSelect([userEntry, responseEntry], records);
		selector.handleInput("\r");
		expect(records).toEqual([{ entryId: responseEntry.id, options: { summarize: false } }]);
	});

	it("still recognizes the kitty CSI-u Shift+Enter encoding", () => {
		const records: SelectRecord[] = [];
		const { selector } = selectorWithOnSelect([userEntry, responseEntry], records);
		selector.handleInput("\u001b[13;2u");
		expect(records).toEqual([{ entryId: responseEntry.id, options: { summarize: true } }]);
	});

	it("treats the legacy CSI ~ form as Shift+Enter (summarize-and-switch), matching the composer", () => {
		const records: SelectRecord[] = [];
		const { selector } = selectorWithOnSelect([userEntry, responseEntry], records);
		selector.handleInput("\u001b[13;2~");
		expect(records).toEqual([{ entryId: responseEntry.id, options: { summarize: true } }]);
	});
});
