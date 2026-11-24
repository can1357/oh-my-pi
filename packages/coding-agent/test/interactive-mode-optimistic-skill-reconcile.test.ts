/**
 * Reconciliation contract for the optimistic `/skill:` row (issue #11217).
 *
 * A user-invoked `/skill:` submission paints an optimistic transcript row before
 * its awaited preflight (issue #8895). When the canonical `message_start`
 * arrives the row must be swapped in place — never left behind alongside an
 * appended copy — even when the optimistic row already retired into native
 * scrollback during a slow preflight.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isSettled } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { TranscriptBlock } from "../src/ui/shell";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal } from "./helpers/mode-terminal";

function skillMessage(timestamp: number): AgentMessage {
	return {
		role: "custom",
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: "run the skill",
		display: true,
		attribution: "user",
		details: { name: "test-skill", path: "/skills/test-skill/SKILL.md", lineCount: 12 } satisfies SkillPromptDetails,
		timestamp,
	} as AgentMessage;
}

/** The transcript's skill blocks. */
function skillCards(mode: InteractiveMode): TranscriptBlock[] {
	return mode.shell.transcript.blocks().filter(block => {
		const entry = mode.transcriptEntry(block);
		return entry?.kind === "message" && "customType" in entry.message
			? entry.message.customType === SKILL_PROMPT_MESSAGE_TYPE
			: false;
	});
}

describe("InteractiveMode optimistic skill reconcile (#11217)", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-optimistic-skill-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
		// The test drives reconcile directly and never starts the mode; keep the
		// git branch watcher off so it does not leak an fs.watch into sibling files.
		vi.spyOn(vcs, "watch").mockImplementation(() => () => {});
	});

	beforeEach(() => {
		mode.shell.transcript.clear();
		vi.spyOn(mode, "ensureWorkingRow").mockImplementation(() => {});
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("keeps the optimistic row live so a retirement pass cannot commit it before reconcile", () => {
		mode.renderOptimisticSkillMessage(skillMessage(1));
		const [card] = skillCards(mode);
		expect(card).toBeDefined();
		// Unsettled while pending: only settled blocks retire into scrollback, so it stays removable.
		expect(isSettled(card!.node)).toBe(false);

		mode.reconcileOptimisticSkillMessage(skillMessage(2));
		const cards = skillCards(mode);
		expect(cards).toHaveLength(1);
		expect(cards[0]).not.toBe(card);
	});

	it("adopts the optimistic row in place instead of duplicating it when it already retired", () => {
		mode.renderOptimisticSkillMessage(skillMessage(1));
		const [card] = skillCards(mode);
		expect(card).toBeDefined();

		// Residual race: the row reached immutable scrollback before the canonical message_start arrived.
		vi.spyOn(mode.shell.transcript, "retired").mockImplementation(block => block === card);

		const canonical = skillMessage(2);
		mode.reconcileOptimisticSkillMessage(canonical);

		const cards = skillCards(mode);
		expect(cards).toHaveLength(1);
		expect(cards[0]).toBe(card);
		expect(isSettled(card!.node)).toBe(true);
		// The adopted row stands for the canonical message (rewind, presenters and link lookups find it).
		expect(mode.transcriptBlocks.get(canonical)).toBe(card);
	});

	it("appends the canonical card when a transcript rebuild detached the optimistic row", () => {
		mode.renderOptimisticSkillMessage(skillMessage(1));
		expect(skillCards(mode)).toHaveLength(1);

		// A mid-preflight transcript rebuild (e.g. a display-setting toggle) clears the transcript;
		// the UI-only optimistic row is not replayed, so it is detached while still tracked for
		// reconcile. The canonical card must still be appended.
		mode.shell.transcript.clear();

		mode.reconcileOptimisticSkillMessage(skillMessage(2));
		expect(skillCards(mode)).toHaveLength(1);
	});
});
