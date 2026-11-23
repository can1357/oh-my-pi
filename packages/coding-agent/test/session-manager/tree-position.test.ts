import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assistantMsg, userMsg } from "../utilities";

/** Three answered turns: [prompt, reply] ids per turn. */
function threeTurns(session: SessionManager): [string, string][] {
	return [1, 2, 3].map(turn => [
		session.appendMessage(userMsg(`prompt ${turn}`)),
		session.appendMessage(assistantMsg(`reply ${turn}`)),
	]);
}

describe("SessionManager.getTreePosition", () => {
	it("has none at the tip of a single line", () => {
		const session = SessionManager.inMemory();
		threeTurns(session);
		session.appendThinkingLevelChange("high");
		expect(session.getTreePosition()).toBeUndefined();
	});

	it("counts the turns a rewind left past the leaf", () => {
		const session = SessionManager.inMemory();
		const turns = threeTurns(session);
		// Esc Esc on the second prompt moves the leaf to the reply before it.
		session.branch(turns[0]![1]);
		expect(session.getTreePosition()).toEqual({ ahead: 2 });
	});

	it("shows the branch at a fork, from either side, and keeps one object while it holds", () => {
		const session = SessionManager.inMemory();
		const turns = threeTurns(session);
		session.branch(turns[0]![1]);
		session.appendMessage(userMsg("prompt 2, asked again"));
		const fork = session.getTreePosition();
		expect(fork).toEqual({ branch: { index: 2, count: 2 }, ahead: 0 });

		// Entries that do not move between branches leave the same position object
		// (the status line compares it by identity).
		session.appendThinkingLevelChange("low");
		expect(session.getTreePosition()).toBe(fork);

		// Back on the older branch's tip: first of two, nothing ahead.
		session.branch(turns[2]![1]);
		expect(session.getTreePosition()).toEqual({ branch: { index: 1, count: 2 }, ahead: 0 });
		// Rewound on it: the deepest fork above stays named alongside the turns ahead.
		session.branch(turns[1]![1]);
		expect(session.getTreePosition()).toEqual({ branch: { index: 1, count: 2 }, ahead: 1 });
	});

	it("ignores branches without a user turn, such as a dropped failed reply", () => {
		const session = SessionManager.inMemory();
		const prompt = session.appendMessage(userMsg("prompt"));
		session.appendMessage(assistantMsg("failed reply"));
		// Recovery moves the leaf back to the prompt and answers again.
		session.branch(prompt);
		expect(session.getTreePosition()).toBeUndefined();
		session.appendMessage(assistantMsg("retried reply"));
		expect(session.getTreePosition()).toBeUndefined();
	});
});
