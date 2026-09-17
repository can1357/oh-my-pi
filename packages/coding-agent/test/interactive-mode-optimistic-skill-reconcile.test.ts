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
import { SkillMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/skill-message";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const WIDTH = 80;

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

function skillCards(mode: InteractiveMode): SkillMessageComponent[] {
	return mode.chatContainer.children.filter((child): child is SkillMessageComponent => {
		return child instanceof SkillMessageComponent;
	});
}

/** Force every settled block to commit into immutable scrollback. */
function retireToScrollback(mode: InteractiveMode): void {
	const batch = mode.chatContainer.peekFlushBatch(WIDTH);
	if (batch) mode.chatContainer.acknowledgeFinalizedBatch(batch.id);
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
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		// The test drives reconcile directly and never starts the mode; keep the
		// git branch watcher off so it does not leak an fs.watch into sibling files.
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	beforeEach(() => {
		mode.chatContainer.clear();
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	});

	afterAll(async () => {
		// No mode.stop(): the mode was never started, and stop() persists the
		// composer status through the native VCS status line — unrelated to the
		// reconcile contract under test.
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("keeps the optimistic row live so a retirement pass cannot commit it before reconcile", () => {
		mode.renderOptimisticSkillMessage(skillMessage(1));
		const [card] = skillCards(mode);
		expect(card).toBeInstanceOf(SkillMessageComponent);
		// Unfinalized while pending: the transcript keeps it removable.
		expect(card!.isTranscriptBlockFinalized()).toBe(false);

		// A retirement pass at submit time offers nothing (nothing settled), so
		// the row stays removable and reconcile can swap it out cleanly.
		retireToScrollback(mode);
		expect(mode.chatContainer.canRemoveBlock(card!)).toBe(true);

		mode.reconcileOptimisticSkillMessage(skillMessage(2));
		expect(skillCards(mode)).toHaveLength(1);
	});

	it("adopts the optimistic row in place instead of duplicating it when it already retired", () => {
		mode.renderOptimisticSkillMessage(skillMessage(1));
		const [card] = skillCards(mode);
		expect(card).toBeInstanceOf(SkillMessageComponent);

		// Residual race: the row finalized and retired into immutable scrollback
		// before the canonical message_start arrived.
		card!.markTranscriptBlockFinalized();
		retireToScrollback(mode);
		expect(mode.chatContainer.canRemoveBlock(card!)).toBe(false);

		mode.reconcileOptimisticSkillMessage(skillMessage(2));

		const cards = skillCards(mode);
		expect(cards).toHaveLength(1);
		expect(cards[0]).toBe(card);
	});

	it("appends the canonical card when a transcript rebuild detached the optimistic row", () => {
		mode.renderOptimisticSkillMessage(skillMessage(1));
		expect(skillCards(mode)).toHaveLength(1);

		// A mid-preflight transcript rebuild (e.g. a display-setting toggle) clears
		// the container; the UI-only optimistic row is not replayed, so it is
		// detached while still tracked for reconcile. canRemoveBlock reports false
		// for the absent component, but the canonical card must still be appended.
		mode.chatContainer.clear();

		mode.reconcileOptimisticSkillMessage(skillMessage(2));
		expect(skillCards(mode)).toHaveLength(1);
	});
});
