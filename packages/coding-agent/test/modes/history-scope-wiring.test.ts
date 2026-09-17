import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { bindHistorySource, resolveHistoryScope } from "@oh-my-pi/pi-coding-agent/modes/history-scope";
import type { HistorySearchComponent } from "@oh-my-pi/pi-tui/overlays/history-search";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { Editor } from "@oh-my-pi/pi-tui";
import { getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

let tempDir: TempDir | null = null;
let originalCwd = "";

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
	HistoryStorage.close();
	setProjectDir(originalCwd);
	if (tempDir) {
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("history scope wiring", () => {
	it("opens Ctrl+R on the configured search scope and cycles from there", () => {
		expect(getProjectDir()).toBe(tempDir!.path());
		const storage = HistoryStorage.open(tempDir!.join("history.db"));
		// The configured `cwd` start must be honoured rather than falling back to `global`.
		const ctx = createInteractiveModeContext({
			settings: Settings.isolated({ "history.searchScope": "cwd" }),
			historyStorage: storage,
			sessionManager: { getSessionId: () => "session-1" },
		});

		new SelectorController(ctx).showHistorySearch();

		const panel = ctx.editorContainer.children[0] as unknown as HistorySearchComponent;
		expect(panel.title).toBe("History (current folder)");
		panel.handleInput("\t");
		expect(panel.title).toBe("History (all projects)");
		panel.handleInput("\t");
		expect(panel.title).toBe("History (this session)");
	});

	it("recalls through the scope named by the history.scope setting, and follows the setting", async () => {
		const settings = Settings.isolated();
		// Same mutation the settings UI performs: the merged value is what the scope resolver reads.
		settings.override("history.scope", "cwd");
		const storage = HistoryStorage.open(tempDir!.join("history.db"));
		const elsewhere = tempDir!.join("other");
		await storage.add("HERE_PROMPT", tempDir!.path(), "session-1");
		// Same conversation, another folder: only the `session` scope reaches it.
		await storage.add("SESSION_PROMPT", elsewhere, "session-1");

		const scope = () =>
			resolveHistoryScope(settings.get("history.scope"), {
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
		settings.override("history.scope", "session");
		editor.setText("");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("SESSION_PROMPT");
	});
});
