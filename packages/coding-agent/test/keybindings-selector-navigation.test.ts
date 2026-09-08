import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionList } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-list";
import type { Extension } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/types";
import { HistorySearchComponent } from "@oh-my-pi/pi-coding-agent/modes/components/history-search";
import { RewindSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/rewind-selector";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import type { SessionMessageEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { setKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

const CTRL_N = "\x0e";
const CTRL_P = "\x10";
const TEST_KEYBINDINGS = KeybindingsManager.inMemory({
	"tui.select.up": "ctrl+p",
	"tui.select.down": "ctrl+n",
});

const tempDirs: TempDir[] = [];

beforeAll(() => {
	initTheme();
});

afterEach(async () => {
	setKeybindings(KeybindingsManager.inMemory());
	HistoryStorage.close();
	await Bun.sleep(0);
	await Promise.all(tempDirs.splice(0).map(tempDir => tempDir.remove().catch(() => {})));
});

function createSession(id: string, title: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 0,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
	};
}

function createMessageNode(id: string, parentId: string | null, content: string): SessionTreeNode {
	const message: AgentMessage = { role: "user", content, timestamp: 1 };
	return {
		entry: {
			type: "message",
			id,
			parentId,
			timestamp: "2024-01-01T00:00:00Z",
			message,
		},
		children: [],
	};
}
function createAgentMessageNode(id: string, parentId: string | null, message: AgentMessage): SessionTreeNode {
	return {
		entry: {
			type: "message",
			id,
			parentId,
			timestamp: "2024-01-01T00:00:00Z",
			message,
		},
		children: [],
	};
}

function createExtension(id: string, displayName: string): Extension {
	return {
		id,
		kind: "tool",
		name: id,
		displayName,
		description: displayName,
		path: `/tmp/${id}.md`,
		source: {
			provider: "test-provider",
			providerName: "Test Provider",
			level: "project",
		},
		state: "active",
		raw: {},
	};
}

async function createHistoryStorage(prompts: string[]): Promise<HistoryStorage> {
	const dir = TempDir.createSync("@omp-history-nav-");
	tempDirs.push(dir);
	HistoryStorage.close();
	const storage = HistoryStorage.open(dir.join("history.db"));
	// add() batches writes behind a 100ms AsyncDrain timer. Drive that timer with
	// fake timers so the flush is instant instead of waiting real wall-clock time.
	vi.useFakeTimers();
	try {
		const writes = prompts.map(prompt => storage.add(prompt));
		vi.advanceTimersByTime(100);
		await Promise.all(writes);
	} finally {
		vi.useRealTimers();
	}
	return storage;
}

describe("selector navigation keybindings", () => {
	it("uses tui.select.down in the session selector", () => {
		setKeybindings(TEST_KEYBINDINGS);
		const selected: string[] = [];
		const selector = new SessionSelectorComponent(
			[createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
			session => selected.push(session.path),
			() => {},
			() => {},
		);

		selector.handleInput(CTRL_N);
		selector.handleInput("\n");

		expect(selected).toEqual(["/tmp/session-b.jsonl"]);
	});

	it("uses tui.select.down in the session tree", () => {
		setKeybindings(TEST_KEYBINDINGS);
		const root = createMessageNode("root", null, "Root");
		const child = createMessageNode("child", "root", "Child");
		root.children.push(child);
		const selected: string[] = [];
		const selector = new TreeSelectorComponent(
			[root],
			"root",
			40,
			id => selected.push(id),
			() => {},
		);
		selector.handleInput(CTRL_N);
		selector.handleInput("\n");

		expect(selected).toEqual(["child"]);
	});
	it("traverses actual turns and jumps to first/last visible tree items", () => {
		const firstUser = createMessageNode("first-user", null, "First question");
		const assistant = createAgentMessageNode("assistant", "first-user", {
			role: "assistant",
			content: [{ type: "text", text: "Working on it" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		});
		const firstToolResult = createAgentMessageNode("first-tool-result", "assistant", {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "first file contents" }],
			isError: false,
			timestamp: 3,
		});
		const secondUser = createMessageNode("second-user", "first-tool-result", "Second question");
		const trailingToolResult = createAgentMessageNode("trailing-tool-result", "second-user", {
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "read",
			content: [{ type: "text", text: "second file contents" }],
			isError: false,
			timestamp: 5,
		});
		firstUser.children.push(assistant);
		assistant.children.push(firstToolResult);
		firstToolResult.children.push(secondUser);
		secondUser.children.push(trailingToolResult);

		const selected: string[] = [];
		const selector = new TreeSelectorComponent(
			[firstUser],
			"trailing-tool-result",
			40,
			id => selected.push(id),
			() => {},
		);

		selector.handleInput("\x1b[1;3A");
		selector.handleInput("\n");
		selector.handleInput("\x1b[1;3A");
		selector.handleInput("\n");
		selector.handleInput("\x1b[1;3A");
		selector.handleInput("\n");
		selector.handleInput("\x1b[1;3B");
		selector.handleInput("\n");
		selector.handleInput("\x1b[F");
		selector.handleInput("\n");
		selector.handleInput("\x1b[H");
		selector.handleInput("\n");

		expect(selected).toEqual([
			"second-user",
			"assistant",
			"first-user",
			"assistant",
			"trailing-tool-result",
			"first-user",
		]);
	});

	it("honors configured row bindings before Alt+Up and Alt+Down turn traversal", () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.up": "alt+up",
				"tui.select.down": "alt+down",
			}),
		);
		const firstUser = createMessageNode("first-user", null, "First question");
		const toolResult = createAgentMessageNode("tool-result", "first-user", {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: 2,
		});
		const secondUser = createMessageNode("second-user", "tool-result", "Second question");
		firstUser.children.push(toolResult);
		toolResult.children.push(secondUser);

		const selected: string[] = [];
		const selector = new TreeSelectorComponent(
			[firstUser],
			"first-user",
			40,
			id => selected.push(id),
			() => {},
		);

		selector.handleInput("\x1b[1;3B");
		selector.handleInput("\n");
		selector.handleInput("\x1b[1;3A");
		selector.handleInput("\n");

		expect(selected).toEqual(["tool-result", "first-user"]);
	});

	it("uses rendered tree order for Home and End across branches", () => {
		const root = createMessageNode("root", null, "Root");
		const activeBranch = createMessageNode("active-branch", "root", "Active branch");
		const inactiveBranch = createMessageNode("inactive-branch", "root", "Inactive branch");
		root.children.push(activeBranch, inactiveBranch);

		const selected: string[] = [];
		const selector = new TreeSelectorComponent(
			[root],
			"active-branch",
			40,
			id => selected.push(id),
			() => {},
		);

		selector.handleInput("\x1b[F");
		selector.handleInput("\n");
		selector.handleInput("\x1b[H");
		selector.handleInput("\n");

		expect(selected).toEqual(["inactive-branch", "root"]);
	});

	it("uses PageUp and PageDown to move by a visible page in the session tree", () => {
		const root = createMessageNode("node-0", null, "Message 0");
		let parent = root;
		for (let index = 1; index <= 25; index++) {
			const child = createMessageNode(`node-${index}`, parent.entry.id, `Message ${index}`);
			parent.children.push(child);
			parent = child;
		}

		const selected: string[] = [];
		const selector = new TreeSelectorComponent(
			[root],
			"node-0",
			40,
			id => selected.push(id),
			() => {},
		);

		selector.handleInput("\x1b[6~");
		selector.handleInput("\n");
		selector.handleInput("\x1b[5~");
		selector.handleInput("\n");

		expect(selected).toEqual(["node-20", "node-0"]);
	});

	it("uses tui.select.up in the esc-esc rewind selector", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		try {
			setKeybindings(TEST_KEYBINDINGS);
			const selected: string[] = [];
			const ids = ["first", "second", "third"];
			const entries: SessionMessageEntry[] = ids.map((id, index) => ({
				type: "message",
				id,
				parentId: index === 0 ? null : ids[index - 1]!,
				timestamp: "2024-01-01T00:00:00Z",
				message: { role: "user", content: `${id} prompt`, timestamp: 1 },
			}));
			const selector = new RewindSelectorComponent(entries, {
				ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
				cwd: "/tmp",
				requestRender: () => {},
				onSelect: id => selected.push(id),
				onCancel: () => {},
			});

			selector.handleInput(CTRL_P);
			selector.handleInput("\n");

			expect(selected).toEqual(["second"]);
		} finally {
			resetSettingsForTest();
		}
	});

	it("uses tui.select.down in the extension list", () => {
		setKeybindings(TEST_KEYBINDINGS);
		const list = new ExtensionList([createExtension("tool-a", "Tool A"), createExtension("tool-b", "Tool B")]);

		list.handleInput(CTRL_N);

		expect(list.getSelectedExtension()?.id).toBe("tool-a");
	});

	it("uses tui.select.down in history search", async () => {
		setKeybindings(TEST_KEYBINDINGS);
		const selected: string[] = [];
		const storage = await createHistoryStorage(["old prompt", "middle prompt", "new prompt"]);
		const selector = new HistorySearchComponent(
			storage,
			prompt => selected.push(prompt),
			() => {},
		);
		selector.handleInput(CTRL_N);
		selector.handleInput("\n");

		expect(selected).toEqual(["middle prompt"]);
	});

	it("supports page and home/end navigation in history search", async () => {
		setKeybindings(KeybindingsManager.inMemory());
		const selected: string[] = [];
		// Added oldest-first; getRecent returns newest-first, so index 0 is "p14", index 14 is "p0".
		const storage = await createHistoryStorage(Array.from({ length: 15 }, (_, i) => `p${i}`));
		const selector = new HistorySearchComponent(
			storage,
			prompt => selected.push(prompt),
			() => {},
		);

		const PAGE_UP = "\x1b[5~";
		const PAGE_DOWN = "\x1b[6~";
		const HOME = "\x1b[H";
		const END = "\x1b[F";

		selector.handleInput(PAGE_DOWN); // index 0 -> 10  (p4)
		selector.handleInput("\n");
		selector.handleInput(END); // -> 14, last  (p0)
		selector.handleInput("\n");
		selector.handleInput(PAGE_UP); // index 14 -> 4  (p10)
		selector.handleInput("\n");
		selector.handleInput(HOME); // -> 0, first  (p14)
		selector.handleInput("\n");

		expect(selected).toEqual(["p4", "p0", "p10", "p14"]);
	});
});
