/**
 * Tree navigation onto a `/skill:` node (issue #5374 and its follow-up).
 *
 * A user-invoked skill prompt is persisted as a `custom_message` entry
 * (customType `skill-prompt`, attribution `user`). It is a user turn: selecting
 * it rewinds PAST it (leaf on its parent) and restores the draft the user typed —
 * never the expanded skill body. An agent/autoload injection is not a user turn:
 * the leaf lands ON it so the skill stays on the active branch.
 */
import { describe, expect, it } from "bun:test";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { assistantMsg, createTestSession, userMsg } from "./utilities";

const BODY = "<skill>huge expanded skill body</skill>";

describe("AgentSession tree navigation onto skill prompts", () => {
	it("rewinds past a user-invoked skill prompt and restores the typed draft, not the body", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			// u1 -> skill prompt -> a1 -> a2
			const u1 = sessionManager.appendMessage(userMsg("hello"));
			const skillId = sessionManager.appendCustomMessageEntry(
				SKILL_PROMPT_MESSAGE_TYPE,
				BODY,
				true,
				{
					name: "some-skill",
					path: "/skills/some-skill/SKILL.md",
					args: "fix it\nplease",
					prompt: "/skill:some-skill fix it\nplease",
					lineCount: 1,
				},
				"user",
			);
			sessionManager.appendMessage(assistantMsg("first reply"));
			sessionManager.appendMessage(assistantMsg("second reply"));

			const result = await session.navigateTree(skillId);

			expect(result.cancelled).toBe(false);
			expect(sessionManager.getLeafId()).toBe(u1);
			expect(sessionManager.getBranch().some(e => e.id === skillId)).toBe(false);
			expect(result.editorText).toBe("/skill:some-skill fix it\nplease");
			expect(result.editorText).not.toContain(BODY);
		} finally {
			await ctx.cleanup();
		}
	});

	it("rebuilds the draft from name and args for prompts recorded before the raw draft was stored", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("hello"));
			const skillId = sessionManager.appendCustomMessageEntry(
				SKILL_PROMPT_MESSAGE_TYPE,
				BODY,
				true,
				{ name: "some-skill", path: "/skills/some-skill/SKILL.md", args: "fix it", lineCount: 1 },
				"user",
			);
			sessionManager.appendMessage(assistantMsg("reply"));

			const result = await session.navigateTree(skillId);
			expect(result.editorText).toBe("/skill:some-skill fix it");
		} finally {
			await ctx.cleanup();
		}
	});

	it("lands the leaf on an agent-attributed skill injection and keeps it on the active branch", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("hello"));
			const skillId = sessionManager.appendCustomMessageEntry(
				SKILL_PROMPT_MESSAGE_TYPE,
				BODY,
				true,
				{ name: "some-skill", path: "/skills/some-skill/SKILL.md", lineCount: 1 },
				"agent",
			);
			sessionManager.appendMessage(assistantMsg("first reply"));
			sessionManager.appendMessage(assistantMsg("second reply"));

			const result = await session.navigateTree(skillId);

			expect(result.cancelled).toBe(false);
			expect(sessionManager.getLeafId()).toBe(skillId);
			expect(sessionManager.getBranch().some(e => e.id === skillId)).toBe(true);
			expect(result.editorText).toBeUndefined();
		} finally {
			await ctx.cleanup();
		}
	});
});
