import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager, setKeybindings } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Extension } from "@oh-my-pi/pi-coding-agent/extensibility/inventory/types";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import type { SessionMessageEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ExtensionListModel } from "../src/ui/overlays/panels/extension-list-model";
import { HistorySearch } from "../src/ui/overlays/pickers/history-search";
import { RewindSelector } from "../src/ui/overlays/pickers/rewind-selector";
import { SessionSelector } from "../src/ui/overlays/pickers/session-selector";
import { TreeSelector } from "../src/ui/overlays/pickers/tree-selector";
import { type LayerTerminal, mountLayer } from "./helpers/layer-terminal";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";

const CTRL_N = "\x0e";
const CTRL_P = "\x10";
const TEST_KEYBINDINGS = KeybindingsManager.inMemory({
	"tui.select.up": "ctrl+p",
	"tui.select.down": "ctrl+n",
});

// Branch navigation ships unbound; traversal tests opt into the documented Shift+arrow bindings.
const BRANCH_KEYBINDINGS = KeybindingsManager.inMemory({
	"app.tree.previousBranch": "shift+left",
	"app.tree.nextBranch": "shift+right",
});

const tempDirs: TempDir[] = [];
const mounted: LayerTerminal[] = [];

function mountTree(roots: SessionTreeNode[], currentLeafId: string, onSelect: (id: string) => void): LayerTerminal {
	const selector = mountLayer(
		() =>
			TreeSelector({
				roots,
				currentLeafId,
				terminalHeight: 40,
				onSelect,
				onCancel: () => {},
				router: InternalUrlRouter.builtins(),
			}),
		{ fullscreen: true },
	);
	mounted.push(selector);
	return selector;
}

function mountHistory(storage: HistoryStorage, onSelect: (prompt: string) => void): LayerTerminal {
	const selector = mountLayer(() => HistorySearch({ source: storage, onSelect, onCancel: () => {} }));
	mounted.push(selector);
	return selector;
}

beforeAll(() => {
	// The default registry is TUI-only; the app registry carries the `app.tree.*` branch bindings.
	setKeybindings(KeybindingsManager.inMemory());
});

afterEach(async () => {
	for (const selector of mounted.splice(0)) selector.dispose();
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

function createModelNode(id: string, parentId: string | null): SessionTreeNode {
	return {
		entry: {
			type: "model_change",
			id,
			parentId,
			timestamp: "2024-01-01T00:00:00Z",
			model: "test/model",
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
		const selector = mountLayer(() =>
			SessionSelector({
				sessions: [createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
				onSelect: session => selected.push(session.path),
				onCancel: () => {},
			}),
		);
		mounted.push(selector);

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
		const selector = mountTree([root], "root", id => selected.push(id));
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
		const selector = mountTree([firstUser], "trailing-tool-result", id => selected.push(id));

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
		const selector = mountTree([firstUser], "first-user", id => selected.push(id));

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
		const selector = mountTree([root], "active-branch", id => selected.push(id));

		selector.handleInput("\x1b[F");
		selector.handleInput("\n");
		selector.handleInput("\x1b[H");
		selector.handleInput("\n");

		expect(selected).toEqual(["inactive-branch", "root"]);
	});

	it("uses Shift+Left and Shift+Right to cycle visible branches through filtered heads", () => {
		setKeybindings(BRANCH_KEYBINDINGS);
		const root = createMessageNode("root", null, "Root");
		const activeBranch = createMessageNode("active-branch", "root", "Active branch");
		const filteredBranch = createModelNode("filtered-branch", "root");
		const promotedHead = createModelNode("promoted-head", "root");
		const promotedMessage = createMessageNode("promoted-message", "promoted-head", "Promoted branch");
		promotedHead.children.push(promotedMessage);
		root.children.push(activeBranch, filteredBranch, promotedHead);

		const selected: string[] = [];
		const selector = mountTree([root], "active-branch", id => selected.push(id));

		selector.handleInput("\x1b[1;2C");
		selector.handleInput("\n");
		selector.handleInput("\x1b[1;2D");
		selector.handleInput("\n");

		expect(selected).toEqual(["promoted-message", "active-branch"]);
	});

	it("wraps Shift+Left past a branch head that is itself a fork", () => {
		setKeybindings(BRANCH_KEYBINDINGS);
		const root = createMessageNode("root", null, "Root");
		const forkA = createMessageNode("a", "root", "Branch A");
		const a1 = createMessageNode("a1", "a", "Branch A1");
		const a2 = createMessageNode("a2", "a", "Branch A2");
		const branchB = createMessageNode("b", "root", "Branch B");
		forkA.children.push(a1, a2);
		root.children.push(forkA, branchB);

		const selected: string[] = [];
		const selector = mountTree([root], "a1", id => selected.push(id));
		for (let press = 0; press < 5; press++) {
			selector.handleInput("\x1b[1;2D");
			selector.handleInput("\n");
		}

		expect(selected).toEqual(["a", "b", "a2", "a1", "a"]);
	});

	it("leaves branch navigation unbound by default", () => {
		const root = createMessageNode("root", null, "Root");
		const activeBranch = createMessageNode("active-branch", "root", "Active branch");
		const siblingBranch = createMessageNode("sibling-branch", "root", "Sibling branch");
		root.children.push(activeBranch, siblingBranch);
		const navigate = (keys: string[]) => {
			const selected: string[] = [];
			const selector = mountTree([root], "active-branch", id => selected.push(id));
			for (const key of keys) {
				selector.handleInput(key);
				selector.handleInput("\n");
			}
			return selected;
		};

		// Default registry: Shift+arrows do nothing, so Enter re-selects the starting row.
		expect(navigate(["\x1b[1;2C", "\x1b[1;2D"])).toEqual(["active-branch", "active-branch"]);
	});

	it("follows configured branch navigation bindings", () => {
		const root = createMessageNode("root", null, "Root");
		const activeBranch = createMessageNode("active-branch", "root", "Active branch");
		const siblingBranch = createMessageNode("sibling-branch", "root", "Sibling branch");
		root.children.push(activeBranch, siblingBranch);
		const navigate = (keys: string[]) => {
			const selected: string[] = [];
			const selector = mountTree([root], "active-branch", id => selected.push(id));
			for (const key of keys) {
				selector.handleInput(key);
				selector.handleInput("\n");
			}
			return selected;
		};

		setKeybindings(KeybindingsManager.inMemory({ "app.tree.nextBranch": "ctrl+n" }));
		expect(navigate([CTRL_N])).toEqual(["sibling-branch"]);
	});

	it("recomputes branch targets after the filter changes", () => {
		setKeybindings(BRANCH_KEYBINDINGS);
		const root = createMessageNode("root", null, "Root");
		const activeBranch = createMessageNode("active-branch", "root", "Active branch");
		const modelBranch = createModelNode("model-branch", "root");
		root.children.push(activeBranch, modelBranch);

		const selected: string[] = [];
		const selector = mountTree([root], "active-branch", id => selected.push(id));

		selector.handleInput("\x1b[1;2C");
		selector.handleInput("\n");
		// Alt+A reveals the model-change branch hidden by the default filter.
		selector.handleInput("\x1ba");
		selector.handleInput("\x1b[1;2C");
		selector.handleInput("\n");

		expect(selected).toEqual(["active-branch", "model-branch"]);
	});

	it("continues branch navigation across nested fork depths", () => {
		setKeybindings(BRANCH_KEYBINDINGS);
		const root = createMessageNode("root", null, "Root");
		const outerActive = createMessageNode("outer-active", "root", "Outer active branch");
		const outerSibling = createMessageNode("outer-sibling", "root", "Outer sibling branch");
		const innerActive = createMessageNode("inner-active", "outer-active", "Inner active branch");
		const innerLeaf = createMessageNode("inner-leaf", "inner-active", "Inner active leaf");
		const innerSibling = createMessageNode("inner-sibling", "outer-active", "Inner sibling branch");
		innerActive.children.push(innerLeaf);
		outerActive.children.push(innerActive, innerSibling);
		root.children.push(outerActive, outerSibling);

		const selected: string[] = [];
		const selector = mountTree([root], "inner-leaf", id => selected.push(id));

		selector.handleInput("\x1b[1;2C");
		selector.handleInput("\n");
		selector.handleInput("\x1b[1;2C");
		selector.handleInput("\n");
		selector.handleInput("\x1b[1;2D");
		selector.handleInput("\n");

		expect(selected).toEqual(["inner-sibling", "outer-sibling", "inner-sibling"]);
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
		const selector = mountTree([root], "node-0", id => selected.push(id));

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
			const selector = mountLayer(
				() =>
					RewindSelector({
						entries,
						onSelect: id => selected.push(id),
						onCancel: () => {},
						router: InternalUrlRouter.builtins(),
					}),
				{ fullscreen: true },
			);
			mounted.push(selector);

			selector.handleInput(CTRL_P);
			selector.handleInput("\n");

			expect(selected).toEqual(["second"]);
		} finally {
			resetSettingsForTest();
		}
	});

	it("uses tui.select.down in the extension list", () => {
		setKeybindings(TEST_KEYBINDINGS);
		const list = new ExtensionListModel([createExtension("tool-a", "Tool A"), createExtension("tool-b", "Tool B")]);

		list.key("ctrl+n", undefined);

		expect(list.selectedExtension()?.id).toBe("tool-a");
	});

	it("appends bare j/k to the extension search filter instead of navigating", () => {
		setKeybindings(TEST_KEYBINDINGS);
		const list = new ExtensionListModel([
			createExtension("jira", "Jira"),
			createExtension("json", "JSON"),
			createExtension("apple", "Apple"),
		]);

		for (const ch of "jira") list.key(ch, ch);

		expect(list.search.text).toBe("jira");
	});

	it("uses tui.select.down in history search", async () => {
		setKeybindings(TEST_KEYBINDINGS);
		const selected: string[] = [];
		const storage = await createHistoryStorage(["old prompt", "middle prompt", "new prompt"]);
		const selector = mountHistory(storage, prompt => selected.push(prompt));
		selector.handleInput(CTRL_N);
		selector.handleInput("\n");

		expect(selected).toEqual(["middle prompt"]);
	});

	it("supports page and home/end navigation in history search", async () => {
		setKeybindings(KeybindingsManager.inMemory());
		const selected: string[] = [];
		// Added oldest-first; getRecent returns newest-first, so index 0 is "p14", index 14 is "p0".
		const storage = await createHistoryStorage(Array.from({ length: 15 }, (_, i) => `p${i}`));
		const selector = mountHistory(storage, prompt => selected.push(prompt));

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
