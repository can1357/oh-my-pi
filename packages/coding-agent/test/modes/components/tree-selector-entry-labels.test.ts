import { afterAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { mountTreeSelector } from "../../helpers/tree-selector";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

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

// One of every entry type the tree used to render as an empty string.
const bookkeeping: SessionEntry[] = [
	{ ...base("title", "u1"), type: "title_change", title: "fork cleanup", source: "user" },
	{ ...base("pin", "title"), type: "credential_pin", provider: "anthropic", hash: "abc123" },
	{ ...base("mode", "pin"), type: "mode_change", mode: "plan" },
	{ ...base("tier", "mode"), type: "service_tier_change", serviceTier: { claude: "priority" } },
	{ ...base("tier-off", "tier"), type: "service_tier_change", serviceTier: null },
	{ ...base("ttsr", "tier-off"), type: "ttsr_injection", injectedRules: ["prefer-bun"] },
	{ ...base("reset", "ttsr"), type: "reset_boundary" },
	{
		...base("init", "reset"),
		type: "session_init",
		systemPrompt: "sys",
		task: "task",
		tools: ["bash"],
	},
	{
		...base("usage", "init"),
		type: "model_usage",
		purpose: "auto\nthinking",
		role: "smol\trole",
		api: "anthropic-messages",
		provider: "\x1b[31manthropic\x1b[0m",
		model: "claude\nhaiku",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	},
] as SessionEntry[];

/** The tree over `entries` (one chain), the last entry current, run through `keys`; its plain screen. */
function visibleRows(entries: SessionEntry[], ...keys: string[]): string {
	const term: TestTerminal = mountTreeSelector(
		{ roots: [chain(entries)], currentLeafId: entries.at(-1)?.id ?? null },
		{ columns: 100, rows: 40 },
	);
	try {
		for (const key of keys) {
			if (key.startsWith("alt+")) term.press(key);
			else term.type(key);
		}
		return term.screen().join("\n");
	} finally {
		term.dispose();
	}
}

describe("tree selector entry labels", () => {
	it("labels each bookkeeping entry with what it recorded", () => {
		const rows = visibleRows([userEntry, ...bookkeeping], "alt+a");
		expect(rows).toContain("[title: fork cleanup]");
		expect(rows).toContain("[credential pin: anthropic]");
		expect(rows).toContain("[mode: plan]");
		expect(rows).toContain("[service tier: claude:priority]");
		// A cleared tier is a real transition, so it says so rather than "null".
		expect(rows).toContain("[service tier: (default)]");
		expect(rows).toContain("[model usage: auto thinking smol role anthropic/claude haiku]");
		expect(rows).not.toContain("\x1b[31m");
	});

	it("falls back to the entry type for kinds with nothing to spell out", () => {
		const rows = visibleRows([userEntry, ...bookkeeping], "alt+a");
		expect(rows).toContain("[ttsr injection]");
		expect(rows).toContain("[reset boundary]");
		expect(rows).toContain("[session init]");
	});

	it("searches bookkeeping entries by their rendered content", () => {
		for (const [query, expected] of [
			["fork", "[title: fork cleanup]"],
			["anthropic", "[credential pin: anthropic]"],
			["priority", "[service tier: claude:priority]"],
		]) {
			expect(visibleRows([userEntry, ...bookkeeping], "alt+a", query)).toContain(expected);
		}
	});

	it("hides bookkeeping entries in the default view", () => {
		const rows = visibleRows([userEntry, ...bookkeeping]);
		expect(rows).toContain("user: start");
		for (const label of [
			"[title:",
			"[credential pin:",
			"[mode:",
			"[service tier:",
			"[ttsr",
			"[reset",
			"[session init",
		]) {
			expect(rows).not.toContain(label);
		}
	});
});
