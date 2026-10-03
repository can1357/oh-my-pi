import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	bindHistorySource,
	resolveHistoryScope,
	type HistoryScopeContext,
} from "@oh-my-pi/pi-coding-agent/modes/history-scope";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import type { HistoryScopeKind } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { Editor } from "@oh-my-pi/pi-tui";
import { setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { runGit } from "./helpers/git";

let tempDir: TempDir | null = null;
let originalCwd = "";

/** Press Up on an emptied editor, exactly the gesture issue #4331 reports. */
function recall(editor: Editor): string {
	editor.setText("");
	editor.handleInput("\x1b[A");
	return editor.getText();
}

/**
 * Binds a real editor to real storage the way the interactive mode does: the scope and the
 * key are resolved lazily, so the editor keeps working across session, directory and
 * setting changes without being recreated.
 */
function bindEditor(
	storage: HistoryStorage,
	state: { setting: HistoryScopeKind; context: HistoryScopeContext },
): Editor {
	const editor = new Editor(getEditorTheme());
	const source = bindHistorySource(storage, () => resolveHistoryScope(state.setting, state.context));
	editor.setHistoryStorage(source.storage, source.sourceKey);
	return editor;
}

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	originalCwd = process.cwd();
	HistoryStorage.close();
	tempDir = TempDir.createSync("@omp-history-recall-");
});

afterEach(async () => {
	HistoryStorage.close();
	setProjectDir(originalCwd);
	if (tempDir) {
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

afterAll(() => {
	setProjectDir(originalCwd);
});

describe("scoped prompt recall", () => {
	it("recalls only the active conversation, and only the active project's prompts", async () => {
		const dir = tempDir!;
		const repoA = path.join(dir.path(), "repo-a");
		const repoB = path.join(dir.path(), "repo-b");
		fs.mkdirSync(repoA, { recursive: true });
		fs.mkdirSync(repoB, { recursive: true });
		runGit(repoA, "init", "--quiet");
		runGit(repoB, "init", "--quiet");
		const dbPath = dir.join("history.db");
		const storage = HistoryStorage.open(dbPath);
		let sessionId = "11111111-1111-4111-8111-111111111111";
		storage.setSessionResolver(() => sessionId);
		const state: { setting: HistoryScopeKind; context: HistoryScopeContext } = {
			setting: "session",
			context: { sessionId, cwd: repoA },
		};
		const editor = bindEditor(storage, state);

		setProjectDir(repoA);
		editor.addToHistory("ONLY_SESSION_A");
		setProjectDir(repoB);
		sessionId = "22222222-2222-4222-8222-222222222222";
		state.context = { sessionId, cwd: repoB };
		editor.addToHistory("ONLY_SESSION_B");

		// Before the fix the preload had already mixed both prompts into every editor.
		expect(recall(editor)).toBe("ONLY_SESSION_B");

		state.context = { sessionId: "11111111-1111-4111-8111-111111111111", cwd: repoA };
		expect(recall(editor)).toBe("ONLY_SESSION_A");

		// Crossing a repository boundary must not leak the other project's prompts either.
		state.context = { sessionId, cwd: repoB };
		expect(recall(editor)).toBe("ONLY_SESSION_B");

		// Project scope keeps the two conversations of one directory together.
		state.setting = "cwd";
		expect(recall(editor)).toBe("ONLY_SESSION_B");

		// Global search stays the documented escape hatch.
		state.setting = "global";
		expect(recall(editor)).toBe("ONLY_SESSION_B");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("ONLY_SESSION_A");

		// A prompt filed later, in the project we just left: the project scopes below must recall
		// their own newest prompt rather than this one, so neither a read that ignored the scope nor
		// a submission filed without its `cwd` can pass them.
		setProjectDir(repoA);
		editor.addToHistory("ONLY_SESSION_A_LATER");
		state.setting = "cwd";
		expect(recall(editor)).toBe("ONLY_SESSION_B");
		state.setting = "repo";
		expect(recall(editor)).toBe("ONLY_SESSION_B");

		// A restart reprovisions the storage: hydration itself must be scoped.
		HistoryStorage.close();
		const reopened = HistoryStorage.open(dbPath);
		const restarted = bindEditor(reopened, {
			setting: "session",
			context: { sessionId: "11111111-1111-4111-8111-111111111111", cwd: repoA },
		});
		expect(recall(restarted)).toBe("ONLY_SESSION_A");
	});

	it("drops a prompt detached by a nested repository without a history write", async () => {
		const dir = tempDir!;
		const outer = dir.join("outer");
		const inner = path.join(outer, "inner");
		await fs.promises.mkdir(inner, { recursive: true });
		runGit(outer, "init", "--quiet");
		const storage = HistoryStorage.open(dir.join("history.db"));
		await storage.add("INNER_PROMPT", inner, "s1");
		const editor = bindEditor(storage, { setting: "repo", context: { sessionId: "s1", cwd: outer } });
		runGit(inner, "init", "--quiet");
		expect(storage.getRecent(10, { kind: "repo", value: outer })).toEqual([]);
		expect(recall(editor)).toBe("");
	});

	it("retires and admits prompts when a stored alias retargets without a history write", async () => {
		const dir = tempDir!;
		const one = dir.join("one");
		const two = dir.join("two");
		const link = dir.join("link");
		await fs.promises.mkdir(one);
		await fs.promises.mkdir(two);
		await fs.promises.symlink(one, link, "junction");
		const storage = HistoryStorage.open(dir.join("history.db"));
		await storage.add("VIA_LINK", link, "s1");
		const from = bindEditor(storage, { setting: "cwd", context: { sessionId: "s1", cwd: one } });
		const to = bindEditor(storage, { setting: "cwd", context: { sessionId: "s1", cwd: two } });
		expect(recall(from)).toBe("VIA_LINK");
		expect(recall(to)).toBe("");

		await fs.promises.unlink(link);
		await fs.promises.symlink(two, link, "junction");
		// Keep the active browse pointer: re-seeding must retire its text, not just its list.
		from.handleInput("\x1b[A");
		to.handleInput("\x1b[A");
		expect(from.getText()).toBe("");
		expect(to.getText()).toBe("VIA_LINK");
	});

	it("retires an active repo prompt while preserving canceled paste payloads", async () => {
		const dir = tempDir!;
		const outer = dir.join("outer");
		const inner = path.join(outer, "inner");
		await fs.promises.mkdir(inner, { recursive: true });
		runGit(outer, "init", "--quiet");
		const storage = HistoryStorage.open(dir.join("history.db"));
		await storage.add("RETIRED_PROMPT", inner, "s1");
		const editor = bindEditor(storage, { setting: "repo", context: { sessionId: "s1", cwd: outer } });
		const payload = "canceled paste ".repeat(120).trim();
		editor.handleInput("\x1b[200~" + payload + "\x1b[201~");
		editor.rememberDraft();
		recall(editor);
		expect(editor.getExpandedText()).toBe(payload);
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("RETIRED_PROMPT");
		runGit(inner, "init", "--quiet");
		editor.handleInput("\x1b[A");
		expect(editor.getExpandedText()).toBe(payload);
		editor.handleInput("\x1b[A");
		expect(editor.getExpandedText()).toBe(payload);
		editor.handleInput("\x1b[B");
		expect(editor.getText()).toBe("");
	});

	for (const setting of ["cwd", "repo"] as const) {
		it("advances Up and Down when " + setting + " membership is unchanged", async () => {
			const dir = tempDir!;
			const outer = dir.join("outer");
			const inner = path.join(outer, "inner");
			await fs.promises.mkdir(inner, { recursive: true });
			runGit(outer, "init", "--quiet");
			const storage = HistoryStorage.open(dir.join("history.db"));
			await storage.add("OLDER", setting === "repo" ? inner : outer, "s1");
			await storage.add("NEWER", outer, "s1");
			const editor = bindEditor(storage, { setting, context: { sessionId: "s1", cwd: outer } });
			expect(recall(editor)).toBe("NEWER");
			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("OLDER");
			editor.handleInput("\x1b[B");
			expect(editor.getText()).toBe("NEWER");
			editor.handleInput("\x1b[B");
			expect(editor.getText()).toBe("");
		});
	}

	it("keeps prompts submitted through the bound editor readable in cwd and repo scopes", async () => {
		const dir = tempDir!;
		const repo = path.join(dir.path(), "repo");
		fs.mkdirSync(repo, { recursive: true });
		runGit(repo, "init", "--quiet");
		const storage = HistoryStorage.open(dir.join("history.db"));
		storage.setSessionResolver(() => "session-1");
		const state: { setting: HistoryScopeKind; context: HistoryScopeContext } = {
			setting: "session",
			context: { sessionId: "session-1", cwd: repo },
		};
		const editor = bindEditor(storage, state);

		setProjectDir(repo);
		editor.addToHistory("SUBMITTED_FROM_EDITOR");

		// A newer prompt filed outside the project. A read that ignored the scope would recall this
		// one, and a delegation that dropped `cwd` would have nothing to recall at all.
		await storage.add("SUBMITTED_ELSEWHERE", path.join(dir.path(), "elsewhere"));

		// Flipping the scope re-seeds from storage, so the editor's own list cannot mask either.
		state.setting = "cwd";
		expect(recall(editor)).toBe("SUBMITTED_FROM_EDITOR");

		state.setting = "repo";
		expect(recall(editor)).toBe("SUBMITTED_FROM_EDITOR");
	});
});
