/**
 * The idle recap is journaled in history.db, never in the session file, so a
 * transcript replay (resume, /restart, rebuild) must re-show it from the
 * journal while the conversation has not moved since, and only on the history
 * it describes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { closeSessionIndex, recordSessionRecap } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { RecapNotice } from "@oh-my-pi/pi-tui/chat/recap-notice";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { restoreEnvValue } from "./helpers/settings-test-state";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let root: string;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-recap-replay-"));
	closeSessionIndex();
	setAgentDir(path.join(root, "agent"));
});

afterEach(() => {
	closeSessionIndex();
	restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDir);
	__resetDirsFromEnvForTests();
	removeSyncWithRetries(root);
});

/**
 * A session whose two prompts were appended a minute before two recaps were journaled (the journal stamps rows
 * with SQLite's clock, so only the entries are backdated). Returns it with both prompts' entry ids.
 */
function sessionWithRecaps(): { sessionManager: SessionManager; firstId: string; lastId: string } {
	const sessionManager = SessionManager.inMemory();
	setSystemTime(Date.now() - 60_000);
	let firstId: string;
	let lastId: string;
	try {
		firstId = sessionManager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
		lastId = sessionManager.appendMessage({ role: "user", content: "check the PR", timestamp: Date.now() });
	} finally {
		setSystemTime();
	}
	recordSessionRecap(sessionManager.getSessionId(), root, "first recap");
	recordSessionRecap(sessionManager.getSessionId(), root, "latest recap");
	return { sessionManager, firstId, lastId };
}

/** Replays the session's current branch and returns the text of every recap row drawn. */
function replayRecaps(sessionManager: SessionManager): string[] {
	const ctx = createInteractiveModeContext({ sessionManager });
	new UiHelpers(ctx).renderSessionContext(sessionManager.buildSessionContext({ transcript: true }));
	return ctx.chatContainer.children
		.filter((child): child is RecapNotice => child instanceof RecapNotice)
		.map(notice => Bun.stripANSI(notice.render(200).join("\n")));
}

describe("idle recap across a transcript replay", () => {
	it("re-shows only the newest journaled recap when it follows the conversation", () => {
		const recaps = replayRecaps(sessionWithRecaps().sessionManager);
		expect(recaps).toHaveLength(1);
		expect(recaps[0]).toContain("latest recap");
	});

	it.each([
		["message", (sm: SessionManager) => sm.appendMessage({ role: "user", content: "next", timestamp: Date.now() })],
		["notice", (sm: SessionManager) => sm.appendCustomMessageEntry("async-result", "job finished", true)],
	])("drops the recap once a %s moves the conversation past it", (_kind, append) => {
		const { sessionManager } = sessionWithRecaps();
		append(sessionManager);
		expect(replayRecaps(sessionManager)).toEqual([]);
	});

	it("keeps the recap when a compaction lands after it", () => {
		const { sessionManager, lastId } = sessionWithRecaps();
		sessionManager.appendCompaction("Earlier work.", undefined, lastId, 1_000);
		expect(replayRecaps(sessionManager)).toHaveLength(1);
	});

	it("does not show the recap on a view rewound to an earlier entry", () => {
		const { sessionManager, firstId } = sessionWithRecaps();
		sessionManager.branch(firstId);
		expect(replayRecaps(sessionManager)).toEqual([]);
	});
});
