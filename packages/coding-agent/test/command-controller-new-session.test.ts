import { beforeAll, describe, expect, it } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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
	};
	setFocused: (id: string | undefined) => void;
}

function makeHarness(): NewSessionHarness {
	let newSession = 0;
	let unfocusSession = 0;
	let resetTranscriptAnchors = 0;
	let resetTranscript = 0;
	let presented = 0;
	let focusedAgentId: string | undefined = "subagent-1";

	const ctx = {
		session: {
			isCompacting: false,
			newSession: async () => {
				newSession++;
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
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		controller: new CommandController(ctx),
		counts: {
			newSession: () => newSession,
			unfocusSession: () => unfocusSession,
			resetTranscriptAnchors: () => resetTranscriptAnchors,
			resetTranscript: () => resetTranscript,
			presented: () => presented,
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
});
