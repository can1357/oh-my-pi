import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentViewSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { emptyMirrorState, RemoteAgentSession } from "@oh-my-pi/pi-coding-agent/thread/remote-agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgHistoryScope } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { bindHistorySource, resolveHistoryScope } from "@oh-my-pi/pi-coding-agent/modes/history-scope";
import type { HistorySearchComponent } from "@oh-my-pi/pi-tui/overlays/history-search";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { Editor } from "@oh-my-pi/pi-tui";
import { getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { beginSettingsTest, restoreSettingsTestState } from "../helpers/settings-test-state";

let tempDir: TempDir | null = null;
let originalCwd = "";

const cleanups: Array<() => void | Promise<void>> = [];
beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	originalCwd = process.cwd();
	HistoryStorage.close();
	tempDir = TempDir.createSync("@omp-history-wiring-");
	// Outside any repository, so the ring is session/cwd/global and the sequence is deterministic.
	setProjectDir(tempDir.path());
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	HistoryStorage.close();
	setProjectDir(originalCwd);
	if (tempDir) {
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("history scope wiring", () => {
	it("reads the selected scope, not the whole table, in the Ctrl+R panel", async () => {
		const other = tempDir!.join("other-project");
		await fs.mkdir(other, { recursive: true });
		const storage = HistoryStorage.open(tempDir!.join("history.db"));
		await storage.add("PROMPT_OF_THIS_PROJECT", tempDir!.path(), "session-1");
		await storage.add("PROMPT_OF_ANOTHER_SESSION", tempDir!.path(), "session-2");
		await storage.add("PROMPT_OF_ANOTHER_PROJECT", other, "session-2");

		const ctx = createInteractiveModeContext({
			settings: Settings.isolated({ "history.searchScope": "cwd" }),
			historyStorage: storage,
			sessionManager: { getSessionId: () => "session-1" },
		});
		new SelectorController(ctx).showHistorySearch();
		const panel = ctx.editorContainer.children[0] as unknown as HistorySearchComponent;
		const shown = () => Bun.stripANSI(panel.render(100).join("\n"));

		// Folder scope includes both local conversations, but not the other folder.
		expect(shown()).toContain("PROMPT_OF_THIS_PROJECT");
		expect(shown()).toContain("PROMPT_OF_ANOTHER_SESSION");
		expect(shown()).not.toContain("PROMPT_OF_ANOTHER_PROJECT");

		panel.handleInput("\t");
		expect(shown()).toContain("PROMPT_OF_THIS_PROJECT");
		expect(shown()).toContain("PROMPT_OF_ANOTHER_SESSION");
		expect(shown()).toContain("PROMPT_OF_ANOTHER_PROJECT");

		// Session scope must now exclude even the other conversation in this folder.
		panel.handleInput("\t");
		expect(shown()).toContain("PROMPT_OF_THIS_PROJECT");
		expect(shown()).not.toContain("PROMPT_OF_ANOTHER_SESSION");
		expect(shown()).not.toContain("PROMPT_OF_ANOTHER_PROJECT");

		// All three prompts match the query; search must still enforce the session boundary.
		for (const char of "PROMPT_OF_") panel.handleInput(char);
		expect(shown()).toContain("PROMPT_OF_THIS_PROJECT");
		expect(shown()).not.toContain("PROMPT_OF_ANOTHER_SESSION");
		expect(shown()).not.toContain("PROMPT_OF_ANOTHER_PROJECT");
	});

	it("recalls through the scope named by the history.scope setting, and follows the setting", async () => {
		const settings = Settings.isolated();
		// Same mutation the settings UI performs: the merged value is what the scope resolver reads.
		cfgHistoryScope.override(settings, "cwd");
		const storage = HistoryStorage.open(tempDir!.join("history.db"));
		const elsewhere = tempDir!.join("other");
		await storage.add("HERE_PROMPT", tempDir!.path(), "session-1");
		// Same conversation, another folder: only the `session` scope reaches it.
		await storage.add("SESSION_PROMPT", elsewhere, "session-1");

		const scope = () =>
			resolveHistoryScope(cfgHistoryScope.get(settings), {
				sessionId: "session-1",
				cwd: getProjectDir(),
			});
		const editor = new Editor(getEditorTheme());
		// The production composition: one binding feeds both the reads and the key the editor
		// re-seeds on, so the setting cannot move one without the other.
		const source = bindHistorySource(storage, scope);
		editor.setHistoryStorage(source.storage, source.sourceKey);

		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("HERE_PROMPT");

		// Switching the setting must move the editor to the newly named data set rather than
		// keep serving the previous one.
		cfgHistoryScope.override(settings, "session");
		editor.setText("");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("SESSION_PROMPT");
	});
});

/**
 * Real interactive history wiring and controllers, without an LLM or agent-hub startup.
 * The getter seam changes only which already-created session the view exposes.
 */
async function focusedHistory() {
	const state = beginSettingsTest();
	await Settings.init({ inMemory: true, cwd: tempDir!.path() });
	await fs.mkdir(tempDir!.join("moved"));
	const auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth);
	const model = registry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected test model in registry");
	const makeSession = () =>
		new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir!.path()),
			settings: Settings.isolated({ "history.scope": "session", "history.searchScope": "session" }),
			modelRegistry: registry,
		});
	const main = makeSession();
	const a = new RemoteAgentSession({
		key: "focused-history-a",
		home: "w1",
		agentId: "A",
		host: undefined,
		state: {
			...emptyMirrorState(),
			sessionId: SessionManager.inMemory(tempDir!.path()).getSessionId(),
			cwd: tempDir!.path(),
			model,
		},
		messages: [],
		modelRegistry: registry,
	});
	const b = makeSession();
	// The provider identity differs from the facade's mirrored persistent conversation id.
	Object.defineProperty(a, "sessionId", { value: "remote-provider-a", configurable: true });
	const storage = HistoryStorage.open(tempDir!.join("history.db"));
	await storage.add("MAIN_ONLY", getProjectDir(), main.sessionManager.getSessionId());
	await storage.add("A_ONLY", getProjectDir(), a.sessionManager.getSessionId());
	await storage.add("B_ONLY", getProjectDir(), b.sessionManager.getSessionId());
	const mode = new InteractiveMode(
		main,
		"test",
		undefined,
		undefined,
		undefined,
		undefined,
		new Composer({ terminal: new VirtualTerminal(100, 24) }),
	);
	let focused: AgentViewSession | undefined;
	Object.defineProperty(mode, "viewSession", { configurable: true, get: () => focused ?? main });
	Object.defineProperty(mode, "focusedAgentId", {
		configurable: true,
		get: () => (focused === a ? "A" : focused === b ? "B" : undefined),
	});
	const inputs = new InputController(mode);
	inputs.setupEditorSubmitHandler();
	const selectors = new SelectorController(mode);
	cleanups.push(async () => {
		mode.stop();
		await Promise.all([main.dispose(), b.dispose()]);
		auth.close();
		restoreSettingsTestState(state);
	});
	return {
		mode,
		main,
		a,
		b,
		storage,
		focus(target?: AgentViewSession) {
			focused = target;
		},
		search() {
			selectors.showHistorySearch();
			return mode.editorContainer.children[0] as unknown as HistorySearchComponent;
		},
	};
}

describe("focused conversation history", () => {
	it("isolates persistent writes, active Up selections and each new search, while sharing cancelled drafts", async () => {
		const h = await focusedHistory();
		const editor = h.mode.editor;
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("MAIN_ONLY");
		h.focus(h.a);
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("A_ONLY");
		const first = h.search();
		const shown = () => Bun.stripANSI(first.render(100).join("\n"));
		expect(shown()).toContain("A_ONLY");
		expect(shown()).not.toContain("MAIN_ONLY");
		expect(shown()).not.toContain("B_ONLY");
		h.focus(h.b);
		// An already-open panel deliberately keeps the conversation captured at opening.
		expect(shown()).toContain("A_ONLY");
		expect(shown()).not.toContain("B_ONLY");
		first.handleInput("\x1b");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("B_ONLY");
		const second = h.search();
		const rows = Bun.stripANSI(second.render(100).join("\n"));
		expect(rows).toContain("B_ONLY");
		expect(rows).not.toContain("A_ONLY");
		expect(rows).not.toContain("MAIN_ONLY");
		second.handleInput("\x1b");

		h.focus(h.a);
		vi.spyOn(h.a, "prompt").mockResolvedValue(true);
		await editor.onSubmit?.("A_SUBMIT");
		expect(
			h.storage.getRecent(20, { kind: "session", value: h.a.sessionManager.getSessionId() }).map(row => row.prompt),
		).toEqual(["A_SUBMIT", "A_ONLY"]);
		expect(
			h.storage
				.getRecent(20, { kind: "session", value: h.main.sessionManager.getSessionId() })
				.map(row => row.prompt),
		).toEqual(["MAIN_ONLY"]);
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("A_SUBMIT");
		h.focus(h.b);
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("B_ONLY");

		editor.setText("UNSENT_SHARED_DRAFT");
		editor.clearDraftForRecall();
		h.focus(h.a);
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("UNSENT_SHARED_DRAFT");
		expect(h.storage.search("UNSENT_SHARED_DRAFT", 20)).toEqual([]);
	});

	it("keeps a delayed main dispatch owned by main when focus moves to A", async () => {
		const h = await focusedHistory();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const prompt = vi.spyOn(h.main, "prompt").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return true;
		});
		const submittedCwd = getProjectDir();
		const pending = h.mode.editor.onSubmit?.("LATE_MAIN");
		await entered.promise;
		h.focus(h.a);
		h.mode.editor.handleInput("\x1b[A");
		expect(h.mode.editor.getText()).toBe("A_ONLY");
		setProjectDir(tempDir!.join("moved"));
		release.resolve();
		await pending;
		expect(prompt).toHaveBeenCalledWith("LATE_MAIN", { streamingBehavior: "steer", images: undefined });
		const row = h.storage.getRecent(20).find(entry => entry.prompt === "LATE_MAIN");
		expect(row).toMatchObject({ sessionId: h.main.sessionManager.getSessionId(), cwd: submittedCwd });
		h.mode.editor.handleInput("\x1b[A");
		expect(h.mode.editor.getText()).toBe("A_ONLY");
		const panel = h.search();
		const rows = Bun.stripANSI(panel.render(100).join("\n"));
		expect(rows).toContain("A_ONLY");
		expect(rows).not.toContain("LATE_MAIN");
		panel.handleInput("\x1b");
		h.focus();
		h.mode.editor.handleInput("\x1b[A");
		expect(h.mode.editor.getText()).toBe("LATE_MAIN");
	});

	it("persists a delayed viewer command once for A without exposing it in B", async () => {
		const h = await focusedHistory();
		h.focus(h.a);
		h.mode.editor.handleInput("\x1b[A");
		expect(h.mode.editor.getText()).toBe("A_ONLY");
		vi.spyOn(h.mode, "handleUsageCommand").mockImplementation(async () => {
			h.focus(h.b);
		});
		await h.mode.editor.onSubmit?.("/usage");
		expect(h.storage.getRecent(20).find(row => row.prompt === "/usage")).toMatchObject({
			sessionId: h.a.sessionManager.getSessionId(),
			cwd: getProjectDir(),
			useCount: 1,
		});
		h.mode.editor.handleInput("\x1b[A");
		expect(h.mode.editor.getText()).toBe("B_ONLY");
		const panel = h.search();
		expect(Bun.stripANSI(panel.render(100).join("\n"))).not.toContain("/usage");
		panel.handleInput("\x1b");
		h.focus(h.a);
		h.mode.editor.handleInput("\x1b[A");
		expect(h.mode.editor.getText()).toBe("/usage");
	});

	it("keeps a focused A submission owned by A across the pre-admission await and a switch to B", async () => {
		const h = await focusedHistory();
		const aPrompt = vi.spyOn(h.a, "prompt").mockResolvedValue(true);
		const bPrompt = vi.spyOn(h.b, "prompt").mockResolvedValue(true);
		h.focus(h.a);
		h.mode.editor.handleInput("\x1b[A");
		expect(h.mode.editor.getText()).toBe("A_ONLY");
		const submittedCwd = getProjectDir();
		// The side-file gate awaits before clearDraft records history. Switch in that gap,
		// without clearing the old selection or changing the already-captured prompt target.
		const pending = h.mode.editor.onSubmit?.("LATE_A");
		h.focus(h.b);
		setProjectDir(tempDir!.join("moved"));
		h.mode.editor.handleInput("\x1b[A");
		expect(h.mode.editor.getText()).toBe("B_ONLY");
		await pending;
		expect(aPrompt).toHaveBeenCalledWith("LATE_A", { streamingBehavior: "steer", images: undefined });
		expect(bPrompt).not.toHaveBeenCalled();
		expect(h.storage.getRecent(20).find(entry => entry.prompt === "LATE_A")).toMatchObject({
			sessionId: h.a.sessionManager.getSessionId(),
			cwd: submittedCwd,
		});
		h.mode.editor.handleInput("\x1b[A");
		expect(h.mode.editor.getText()).toBe("B_ONLY");
		const panel = h.search();
		const rows = Bun.stripANSI(panel.render(100).join("\n"));
		expect(rows).toContain("B_ONLY");
		expect(rows).not.toContain("LATE_A");
		panel.handleInput("\x1b");
		h.focus(h.a);
		h.mode.editor.handleInput("\x1b[A");
		expect(h.mode.editor.getText()).toBe("LATE_A");
	});
});
