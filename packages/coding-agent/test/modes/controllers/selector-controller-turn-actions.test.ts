import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext, ShowStatusOptions } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(() => {
	initTheme();
});

function entry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message } as SessionEntry;
}

const prompt = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp }) as AgentMessage;
const answer = (timestamp: number) =>
	({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp }) as unknown as AgentMessage;

/** u1 (t=10) → a1 (t=11) → u2 (t=20) → a2 (t=21), the leaf at a2; each rewind lands where omp's navigateTree would. */
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
	const navigateTree = vi.fn(async (id: string) => ({ cancelled: false, editorText: prompts[id] }));
	const ctx = {
		sessionManager: {
			getBranch: () => branch,
			getEntry: (id: string) => branch.find(e => e.id === id),
			getLeafId: () => "a2",
		},
		session: { navigateTree },
		editor: {
			getText: () => editor.text,
			get pendingImages() {
				return [];
			},
			setDraft: (text: string) => {
				editor.text = text;
			},
			submit: () => {
				editor.submitted.push(editor.text);
				editor.text = "";
			},
		},
		ui: { requestRender: vi.fn() },
		truncateTranscriptFromMessage: () => false,
		renderInitialMessages: vi.fn(async () => {}),
		reloadTodos: vi.fn(async () => {}),
		showStatus: (message: string, options?: ShowStatusOptions) => {
			statuses.push([message, options]);
			if (message === "Rewind undone") undone.resolve();
		},
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { controller: new SelectorController(ctx), navigateTree, editor, statuses, undone: undone.promise };
}

describe("SelectorController turn actions", () => {
	it("retries an answer's turn: rewinds past its prompt and sends that prompt again", async () => {
		const h = harness();

		await h.controller.runTurnAction("retry", { role: "assistant", at: 21 });

		expect(h.navigateTree).toHaveBeenCalledWith("u2", { summarize: false });
		expect(h.editor.submitted).toEqual(["second prompt"]);
		expect(h.statuses.map(([message]) => message)).toEqual(["Retrying the turn"]);
	});

	it("keeps an unsent draft: retry refuses instead of sending over it", async () => {
		const h = harness("half-typed");

		await h.controller.runTurnAction("retry", { role: "user", at: 10 });

		expect(h.navigateTree).not.toHaveBeenCalled();
		expect(h.editor).toMatchObject({ text: "half-typed", submitted: [] });
	});

	it("edits a prompt into the editor, and the toast's Undo restores the turns and the draft", async () => {
		const h = harness("half-typed");

		await h.controller.runTurnAction("edit", { role: "user", at: 10 });

		expect(h.navigateTree).toHaveBeenCalledWith("u1", { summarize: false });
		expect(h.editor).toMatchObject({ text: "first prompt", submitted: [] });
		const [message, options] = h.statuses.at(-1)!;
		expect(message).toBe("Rewound 2 turns");
		expect(options?.action).toMatchObject({ act: "undo", label: "Undo" });

		options!.action!.run();
		await h.undone;
		expect(h.navigateTree).toHaveBeenLastCalledWith("a2", { summarize: false });
		expect(h.editor.text).toBe("half-typed");
	});
});
