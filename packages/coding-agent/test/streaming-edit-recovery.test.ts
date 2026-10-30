import { describe, expect, test } from "bun:test";
import type { Agent, AgentEvent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StreamingEditGuard } from "@oh-my-pi/pi-coding-agent/session/stream-guards";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

interface RecoveryHarnessOptions {
	settings?: Settings;
}

interface RecoveryHarness {
	guard: StreamingEditGuard;
	state: { settings: Settings; promptSequence: number; promptGeneration: number; disposed: boolean };
	aborts: unknown[];
	appended: Record<string, unknown>[];
	persisted: unknown[][];
	notices: { level: string; message: string }[];
	tasks: ((signal: AbortSignal) => Promise<void>)[];
	continueCount: () => number;
}

function streamingEditFailure(opts: { path: string; error: string }): AgentEvent {
	return {
		type: "tool_stream_update",
		toolCallId: "call-edit-1",
		toolName: "edit",
		update: { generation: 1, streaming: false, files: [{ path: opts.path, error: opts.error }] },
	};
}

function createHarness(opts: RecoveryHarnessOptions = {}): RecoveryHarness {
	const state = {
		settings: opts.settings ?? Settings.isolated({ "edit.streamingAbort": true }),
		promptSequence: 0,
		promptGeneration: 0,
		disposed: false,
	};
	const aborts: unknown[] = [];
	const appended: Record<string, unknown>[] = [];
	const persisted: unknown[][] = [];
	const notices: { level: string; message: string }[] = [];
	const tasks: ((signal: AbortSignal) => Promise<void>)[] = [];
	let continueCount = 0;
	const guard = new StreamingEditGuard({
		agent: {
			abort(reason?: unknown) {
				aborts.push(reason);
			},
			appendMessage(message: unknown) {
				appended.push(message as Record<string, unknown>);
			},
			waitForIdle: async () => {},
			continue: async () => {
				continueCount++;
			},
		} as unknown as Agent,
		settings: state.settings,
		sessionManager: {
			appendCustomMessageEntry(...args: unknown[]) {
				persisted.push(args);
			},
		} as unknown as SessionManager,
		model: () => undefined,
		isDisposed: () => state.disposed,
		promptGeneration: () => state.promptGeneration,
		promptSequence: () => state.promptSequence,
		emitNotice(...args: unknown[]) {
			notices.push({ level: String(args[0]), message: String(args[1]) });
		},
		schedulePostPromptTask(task) {
			tasks.push(task);
		},
		discardAssistantTurn() {},
	});
	return { guard, state, aborts, appended, persisted, notices, tasks, continueCount: () => continueCount };
}

async function runRecoveryTask(opts: { harness: RecoveryHarness; index?: number }): Promise<void> {
	const task = opts.harness.tasks[opts.index ?? 0];
	if (!task) throw new Error("expected a scheduled recovery task");
	await task(new AbortController().signal);
}

describe("streaming edit recovery", () => {
	test("re-drives the run with the preview diagnostic", async () => {
		const harness = createHarness();
		harness.guard.maybeAbort(streamingEditFailure({ path: "src/broken.ts", error: "Failed to find expected lines" }));
		expect(harness.aborts.length).toBe(1);
		expect(harness.tasks.length).toBe(1);
		await runRecoveryTask({ harness });

		const message = harness.appended[0];
		if (!message) throw new Error("expected an appended recovery message");
		expect(message.customType).toBe("streaming-edit-recovery");
		expect(message.display).toBe(false);
		expect(message.attribution).toBe("agent");
		const content = String(message.content);
		expect(content).toContain("src/broken.ts");
		expect(content).toContain("Failed to find expected lines");
		expect(content).toContain("Read the target file again");

		const persisted = harness.persisted[0];
		if (!persisted) throw new Error("expected a persisted recovery entry");
		expect(persisted[0]).toBe("streaming-edit-recovery");
		expect(persisted[2]).toBe(false);

		expect(harness.continueCount()).toBe(1);
		const info = harness.notices.find(notice => notice.level === "info");
		expect(info?.message).toContain("attempt 1/2");
	});

	test("skips recovery after the prompt is superseded", async () => {
		const harness = createHarness();
		harness.guard.maybeAbort(streamingEditFailure({ path: "src/broken.ts", error: "bad anchors" }));
		harness.state.promptSequence += 1;
		await runRecoveryTask({ harness });
		expect(harness.appended.length).toBe(0);
		expect(harness.continueCount()).toBe(0);
	});

	test("skips recovery after the session generation changes", async () => {
		const harness = createHarness();
		harness.guard.maybeAbort(streamingEditFailure({ path: "src/broken.ts", error: "bad anchors" }));
		harness.state.promptGeneration += 1;
		await runRecoveryTask({ harness });
		expect(harness.appended.length).toBe(0);
		expect(harness.continueCount()).toBe(0);
	});

	test("stops with a warning after the recovery budget is spent", () => {
		const harness = createHarness();
		for (let attempt = 0; attempt < 3; attempt++) {
			harness.guard.maybeAbort(streamingEditFailure({ path: "src/broken.ts", error: "bad anchors" }));
			harness.guard.reset();
		}
		expect(harness.aborts.length).toBe(3);
		expect(harness.tasks.length).toBe(2);
		const warning = harness.notices.find(notice => notice.level === "warning");
		expect(warning?.message).toContain("stopped auto-recovery");
	});

	test("resets the recovery budget for a new prompt", () => {
		const harness = createHarness();
		for (let attempt = 0; attempt < 3; attempt++) {
			harness.guard.maybeAbort(streamingEditFailure({ path: "src/broken.ts", error: "bad anchors" }));
			harness.guard.reset();
		}
		expect(harness.tasks.length).toBe(2);
		harness.state.promptSequence += 1;
		harness.guard.maybeAbort(streamingEditFailure({ path: "src/broken.ts", error: "bad anchors" }));
		expect(harness.tasks.length).toBe(3);
	});
});
