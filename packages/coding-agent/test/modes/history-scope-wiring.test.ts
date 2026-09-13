import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { bindHistoryScope, historyScopeKey, resolveHistoryScope } from "@oh-my-pi/pi-coding-agent/modes/history-scope";
import type { HistorySearchComponent } from "@oh-my-pi/pi-coding-agent/modes/components/history-search";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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

	it("recalls through the scope named by the history.scope setting", async () => {
		const settings = Settings.isolated({ "history.scope": "cwd" });
		const storage = HistoryStorage.open(tempDir!.join("history.db"));
		const elsewhere = tempDir!.join("other");
		await storage.add("HERE_PROMPT", tempDir!.path(), "session-1");
		await storage.add("ELSEWHERE_PROMPT", elsewhere, "session-2");

		const scope = () =>
			resolveHistoryScope(settings.get("history.scope"), {
				sessionId: "session-1",
				cwd: getProjectDir(),
			});
		const editor = new Editor(getEditorTheme());
		editor.setHistoryStorage(bindHistoryScope(storage, scope), () => historyScopeKey(scope()));

		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("HERE_PROMPT");
	});
});
