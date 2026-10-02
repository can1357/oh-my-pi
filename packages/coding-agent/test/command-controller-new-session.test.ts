import { beforeAll, describe, expect, it } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

beforeAll(async () => {
	await initTheme(false);
});

interface NewSessionHarness {
	ctx: InteractiveModeContext;
	controller: CommandController;
	counts: {
		newSession: () => number;
		unfocusSession: () => number;
		resetTranscriptAnchors: () => number;
		resetTranscript: () => number;
		presented: () => number;
		clearPendingModelSwitch: () => number;
	};
	setNewSessionThrows: (shouldThrow: boolean) => void;
	setFocused: (id: string | undefined) => void;
}

function makeHarness(): NewSessionHarness {
	let newSession = 0;
	let unfocusSession = 0;
	let resetTranscriptAnchors = 0;
	let resetTranscript = 0;
	let presented = 0;
	let clearPendingModelSwitch = 0;
	let newSessionShouldThrow = false;
	let focusedAgentId: string | undefined = "subagent-1";

	const ctx = {
		session: {
			isCompacting: false,
			newSession: async () => {
				newSession++;
				if (newSessionShouldThrow) {
					// Mirrors AgentSession.newSession throwing AFTER the boundary
					// committed (prompt rebuild, session_switch hook failure).
					throw new Error("post-commit rebuild failure");
				}
				return true;
			},
		},
		sessionManager: {
			getSessionName: () => undefined,
			getCwd: () => "/tmp",
		},
		get focusedAgentId() {
			return focusedAgentId;
		},
		unfocusSession: async () => {
			unfocusSession++;
			focusedAgentId = undefined;
		},
		eventController: {
			resetTranscriptAnchors: () => {
				resetTranscriptAnchors++;
			},
		},
		resetObserverRegistry: () => {},
		statusLine: {
			invalidate: () => {},
			resetActiveTime: () => {},
		},
		updateEditorBorderColor: () => {},
		clearTransientSessionUi: () => {},
		resetTranscript: () => {
			resetTranscript++;
		},
		present: () => {
			presented++;
		},
		reloadTodos: async () => {},
		flushPendingModelSwitch: async () => {},
		clearPendingModelSwitch: () => {
			clearPendingModelSwitch++;
		},
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		controller: new CommandController(ctx),
		counts: {
			newSession: () => newSession,
			unfocusSession: () => unfocusSession,
			resetTranscriptAnchors: () => resetTranscriptAnchors,
			presented: () => presented,
			clearPendingModelSwitch: () => clearPendingModelSwitch,
			resetTranscript: () => resetTranscript,
		},
		setNewSessionThrows: shouldThrow => {
			newSessionShouldThrow = shouldThrow;
		},
		setFocused: id => {
			focusedAgentId = id;
		},
	};
}

describe("CommandController new-session teardown", () => {
	it("returns a focused subagent view to main and purges transcript anchors on /new", async () => {
		const harness = makeHarness();

		await harness.controller.handleClearCommand();

		expect(harness.counts.newSession()).toBe(1);
		expect(harness.counts.unfocusSession()).toBe(1);
		expect(harness.ctx.focusedAgentId).toBeUndefined();
		expect(harness.counts.resetTranscriptAnchors()).toBe(1);
		expect(harness.counts.resetTranscript()).toBe(1);
		expect(harness.counts.presented()).toBe(1);
	});

	it("skips the unfocus round-trip when already on the main session", async () => {
		const harness = makeHarness();
		harness.setFocused(undefined);

		await harness.controller.handleClearCommand();

		expect(harness.counts.newSession()).toBe(1);
		expect(harness.counts.unfocusSession()).toBe(0);
		expect(harness.counts.resetTranscriptAnchors()).toBe(1);
		expect(harness.counts.resetTranscript()).toBe(1);
	});

	it("discards the pending model queue when the boundary commits but newSession then throws", async () => {
		const harness = makeHarness();
		harness.setNewSessionThrows(true);

		// The awaited newSession() rejects — the controller surfaces the error;
		// the queue must still be discarded because the session boundary already
		// committed.
		await expect(harness.controller.handleClearCommand()).rejects.toThrow("post-commit rebuild failure");
		expect(harness.counts.clearPendingModelSwitch()).toBe(1);
	});

	it("does not discard the pending queue when newSession is vetoed", async () => {
		// A cancelled switch keeps the outgoing session alive: the queued
		// restore still belongs to it and must survive for the next boundary.
		const harness = makeHarness();
		const vetoed = harness.ctx as unknown as { session: { newSession: () => Promise<boolean> } };
		vetoed.session.newSession = async () => false;

		await harness.controller.handleClearCommand();

		expect(harness.counts.clearPendingModelSwitch()).toBe(0);
	});
});
