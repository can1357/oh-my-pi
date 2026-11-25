import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext, ShowStatusOptions } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { initTheme } from "../../../src/ui/theme/service";

beforeAll(() => {
	initTheme();
});

function entry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message } as SessionEntry;
}

const prompt = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp }) as AgentMessage;
const answer = (timestamp: number) =>
	({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp }) as unknown as AgentMessage;

const SOURCE_FILE = "/sessions/source.jsonl";

/** u1 (t=10) → a1 (t=11) → u2 (t=20) → a2 (t=21), the leaf at a2 of a session persisted at {@link SOURCE_FILE}. */
function harness(draft = "") {
	const branch = [
		entry("u1", null, prompt("first prompt", 10)),
		entry("a1", "u1", answer(11)),
		entry("u2", "a1", prompt("second prompt", 20)),
		entry("a2", "u2", answer(21)),
	];
	const prompts: Record<string, string> = { u1: "first prompt", u2: "second prompt" };
	const editor = { text: draft, submitted: [] as string[] };
	const statuses: [string, ShowStatusOptions | undefined][] = [];
	const undone = Promise.withResolvers<void>();
	const branchSession = vi.fn(async (id: string, _options?: { requireIdle?: boolean }) => ({
		cancelled: false,
		selectedText: prompts[id] ?? "",
		selectedImages: [],
	}));
	const ctx = {
		sessionManager: {
			getBranch: () => branch,
			getEntry: (id: string) => branch.find(e => e.id === id),
			getLeafId: () => "a2",
			isSessionOnDisk: () => true,
			getSessionFile: () => SOURCE_FILE,
		},
		session: { branch: branchSession, isBusyForSnapshot: false, abortForRewind: async () => {} },
		eventController: { resetTranscriptAnchors: () => {} },
		statusLine: { refresh: () => {} },
		prepareSessionSwitch: async () => {},
		cancelGoalContinuation: () => {},
		cancelPendingSubmission: () => false,
		updatePendingMessagesDisplay: () => {},
		clearTransientSessionUi: () => {},
		composer: {
			text: () => editor.text,
			pendingImages: [],
			setDraft: (text: string) => {
				editor.text = text;
			},
			submit: () => {
				editor.submitted.push(editor.text);
				editor.text = "";
			},
		},
		truncateTranscriptFromMessage: () => false,
		renderInitialMessages: vi.fn(async () => {}),
		reloadTodos: vi.fn(async () => {}),
		showStatus: (message: string, options?: ShowStatusOptions) => {
			statuses.push([message, options]);
			if (message === "Rewind undone") undone.resolve();
		},
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new SelectorController(ctx);
	const resume = vi.spyOn(controller, "handleResumeSession").mockResolvedValue(true);
	return { controller, branchSession, resume, editor, statuses, undone: undone.promise };
}

describe("SelectorController turn actions", () => {
	it("retries an answer's turn: branches before its prompt and sends that prompt again", async () => {
		const h = harness();

		await h.controller.runTurnAction("retry", { role: "assistant", at: 21 });

		expect(h.branchSession).toHaveBeenCalledWith("u2", { requireIdle: true });
		expect(h.editor.submitted).toEqual(["second prompt"]);
		expect(h.statuses.map(([message]) => message)).toEqual(["Retrying the turn"]);
	});

	it("keeps an unsent draft: retry refuses instead of sending over it", async () => {
		const h = harness("half-typed");

		await h.controller.runTurnAction("retry", { role: "user", at: 10 });

		expect(h.branchSession).not.toHaveBeenCalled();
		expect(h.editor).toMatchObject({ text: "half-typed", submitted: [] });
	});

	it("edits a prompt into the editor in a new session, and the toast's Undo resumes the old one with the draft", async () => {
		const h = harness("half-typed");

		await h.controller.runTurnAction("edit", { role: "user", at: 10 });

		expect(h.branchSession).toHaveBeenCalledWith("u1", { requireIdle: true });
		expect(h.editor).toMatchObject({ text: "first prompt", submitted: [] });
		const [message, options] = h.statuses.at(-1)!;
		expect(message).toBe("Rewound 2 turns in a new session");
		expect(options?.action).toMatchObject({ act: "undo", label: "Undo" });

		options!.action!.run();
		await h.undone;
		expect(h.resume).toHaveBeenCalledWith(SOURCE_FILE);
		expect(h.editor.text).toBe("half-typed");
	});
});
