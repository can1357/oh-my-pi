import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	bindHistoryScope,
	historyScopeKey,
	resolveHistoryScope,
	type HistoryScopeContext,
} from "@oh-my-pi/pi-coding-agent/modes/history-scope";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import type { HistoryScopeKind } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { Editor } from "@oh-my-pi/pi-tui";
import { setProjectDir, TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | null = null;
let originalCwd = "";

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
	}
}

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
	editor.setHistoryStorage(
		bindHistoryScope(storage, () => resolveHistoryScope(state.setting, state.context)),
		() => historyScopeKey(resolveHistoryScope(state.setting, state.context)),
	);
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
		git(repoA, "init", "--quiet");
		git(repoB, "init", "--quiet");
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
		expect(recall(editor)).not.toBe("ONLY_SESSION_A");

		// Project scope keeps the two conversations of one directory together.
		state.setting = "cwd";
		expect(recall(editor)).toBe("ONLY_SESSION_B");

		// Global search stays the documented escape hatch.
		state.setting = "global";
		expect(recall(editor)).toBe("ONLY_SESSION_B");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("ONLY_SESSION_A");

		// A restart reprovisions the storage: hydration itself must be scoped.
		HistoryStorage.close();
		const reopened = HistoryStorage.open(dbPath);
		const restarted = bindEditor(reopened, {
			setting: "session",
			context: { sessionId: "11111111-1111-4111-8111-111111111111", cwd: repoA },
		});
		expect(recall(restarted)).toBe("ONLY_SESSION_A");
	});

	it("keeps prompts submitted through the bound editor readable in cwd and repo scopes", async () => {
		const dir = tempDir!;
		const repo = path.join(dir.path(), "repo");
		fs.mkdirSync(repo, { recursive: true });
		git(repo, "init", "--quiet");
		const storage = HistoryStorage.open(dir.join("history.db"));
		storage.setSessionResolver(() => "session-1");
		const state: { setting: HistoryScopeKind; context: HistoryScopeContext } = {
			setting: "cwd",
			context: { sessionId: "session-1", cwd: repo },
		};
		const editor = bindEditor(storage, state);

		setProjectDir(repo);
		editor.addToHistory("SUBMITTED_FROM_EDITOR");

		// A delegation that dropped `cwd` would hide the row from both project scopes.
		expect(recall(editor)).toBe("SUBMITTED_FROM_EDITOR");

		state.setting = "repo";
		expect(recall(editor)).toBe("SUBMITTED_FROM_EDITOR");
	});
});
