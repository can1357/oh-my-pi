/**
 * Regression: `/tree` navigation onto a `/skill:` injection node (issue #5374).
 *
 * A user-invoked skill injection is persisted as a `custom_message` entry
 * (customType `skill-prompt`). Selecting it in the tree must leave the leaf ON
 * the injection node so the skill stays on the active branch — not on its
 * parent with the expanded skill body dumped into the editor.
 */
import { describe, expect, it } from "bun:test";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { assistantMsg, createTestSession, userMsg } from "./utilities";

describe("AgentSession tree navigation onto skill injection", () => {
	it("lands the leaf on the skill injection node and keeps it on the active branch", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			// u1 -> skill injection -> a1 -> a2
			sessionManager.appendMessage(userMsg("hello"));
			const skillId = sessionManager.appendCustomMessageEntry(
				SKILL_PROMPT_MESSAGE_TYPE,
				"<skill>huge expanded skill body</skill>",
				true,
				{ name: "some-skill", path: "/skills/some-skill/SKILL.md", lineCount: 1 },
				"user",
			);
			sessionManager.appendMessage(assistantMsg("first reply"));
			sessionManager.appendMessage(assistantMsg("second reply"));

			const result = await session.navigateTree(skillId);

			expect(result.cancelled).toBe(false);
			// Leaf must be the skill node itself, not its parent.
			expect(sessionManager.getLeafId()).toBe(skillId);
			// The skill injection must remain on the active branch.
			expect(sessionManager.getBranch().some(e => e.id === skillId)).toBe(true);
			// The expanded skill body must NOT be dumped into the editor.
			expect(result.editorText).toBeUndefined();
		} finally {
			await ctx.cleanup();
		}
	});
});
