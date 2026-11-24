/**
 * A failed collab guest resync (the staged transcript rebuild throws) keeps the
 * visible transcript, so every live tool block it orphaned — still pending, or
 * settled into the event controller's displaceable wait/todo trackers — must be
 * sealed in place (animation stopped, row kept), and the trackers emptied.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsp from "node:fs/promises";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext, PendingTool } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

let restoreSpies: (() => void)[] = [];

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	installInMemoryRelay();
	const write = spyOn(Bun, "write").mockResolvedValue(0);
	const rename = spyOn(fsp, "rename").mockResolvedValue(undefined);
	restoreSpies = [() => write.mockRestore(), () => rename.mockRestore()];
});

afterEach(() => {
	for (const restore of restoreSpies) restore();
	uninstallInMemoryRelay();
	resetSettingsForTest();
});

/** A context whose transcript rebuild fails like a broken staged replay. */
function failingResyncContext(): InteractiveModeContext {
	const ctx = createInteractiveModeContext({
		session: {
			switchSession: () => Promise.resolve(true),
			agent: { setModel: () => {}, setThinkingLevel: () => {}, setDisableReasoning: () => {} },
		},
		syncRunningSubagentBadge: () => {},
		resetObserverRegistry: () => {},
		reloadTodos: () => Promise.resolve(),
		renderInitialMessages: () => Promise.reject(new Error("staged rebuild boom")),
		setCollabGuest: () => {},
	});
	Object.defineProperty(ctx, "eventController", { value: new EventController(ctx), configurable: true });
	return ctx;
}

/** Join `ctx` to a room whose host welcomes it, returning the join's rejection. */
async function joinFailingRoom(ctx: InteractiveModeContext, roomId: string): Promise<unknown> {
	const roomKey = generateRoomKey();
	const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
	const hostSocket = new CollabSocket({
		wsUrl: `ws://localhost:8788/r/${roomId}`,
		role: "host",
		key: await importRoomKey(roomKey),
	});
	const hostOpen = Promise.withResolvers<void>();
	hostSocket.onOpen = () => hostOpen.resolve();
	hostSocket.onFrame = frame => {
		if (frame.t !== "hello") return;
		hostSocket.send({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: { type: "session", id: `${roomId}-session`, timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
			state: {
				isStreaming: false,
				queuedMessageCount: 0,
				sessionName: "host session",
				cwd: "/tmp",
				participants: [{ name: "Host", role: "host" }],
			},
			agents: [],
			entryCount: 0,
		});
	};
	hostSocket.connect();
	await hostOpen.promise;
	const guest = new CollabGuestLink(ctx);
	try {
		await guest.join(link);
		return undefined;
	} catch (error) {
		return error;
	} finally {
		hostSocket.close();
		await guest.leave("test cleanup").catch(() => {});
	}
}

/** Start a `wait` whose result settles while its job still runs (a displaceable card). */
async function settleRunningWait(controller: EventController): Promise<void> {
	await controller.handleEvent({
		type: "tool_execution_start",
		toolCallId: "wait-1",
		toolName: "wait",
		args: {},
	} as AgentSessionEvent);
	await controller.handleEvent({
		type: "tool_execution_end",
		toolCallId: "wait-1",
		toolName: "wait",
		isError: false,
		result: {
			content: [{ type: "text", text: "" }],
			details: {
				op: "wait",
				jobs: [{ id: "j0", type: "task", status: "running", label: "job 0", durationMs: 1_000 }],
			},
		},
	} as AgentSessionEvent);
}

describe("collab guest resync rollback", () => {
	it("seals a displaceable wait card in place and empties the controller's trackers", async () => {
		const ctx = failingResyncContext();
		const controller = ctx.eventController;
		await settleRunningWait(controller);
		// The running wait left `pendingTools` for the controller's displaceable tracker.
		expect(ctx.pendingTools.size).toBe(0);
		const blocks = ctx.shell.transcript.blocks();
		const entry = blocks.map(block => ctx.transcriptEntry(block)).find(e => e?.kind === "tool");
		if (entry?.kind !== "tool") throw new Error("expected the wait to present a tool card");
		const seal = spyOn(entry.tool, "seal");

		const error = await joinFailingRoom(ctx, "resync-displaceable-room");
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("staged rebuild boom");

		expect(seal).toHaveBeenCalledTimes(1);
		expect(controller.takeDisplaceableComponents()).toEqual([]);
		expect(ctx.shell.transcript.blocks()).toContain(entry.tool.block);
	});

	it("seals both pending and displaceable blocks, keeping their rows", async () => {
		const ctx = failingResyncContext();
		const pending = ctx.presentToolCall({
			name: "eval",
			args: { language: "py", code: "import time\ntime.sleep(10)" },
			tool: undefined,
			id: "call-1",
			cwd: process.cwd(),
		});
		ctx.pendingTools.set("call-1", pending);
		const displaceable = ctx.presentToolCall({
			name: "eval",
			args: { language: "py", code: "import time\ntime.sleep(20)" },
			tool: undefined,
			id: "call-2",
			cwd: process.cwd(),
		});
		const takeDisplaceable = spyOn(ctx.eventController, "takeDisplaceableComponents").mockReturnValue([
			displaceable,
		] as PendingTool[]);
		const seals = [spyOn(pending, "seal"), spyOn(displaceable, "seal")];

		const error = await joinFailingRoom(ctx, "resync-pending-room");
		expect((error as Error).message).toContain("staged rebuild boom");

		expect(takeDisplaceable).toHaveBeenCalledTimes(1);
		for (const seal of seals) expect(seal).toHaveBeenCalledTimes(1);
		const blocks = ctx.shell.transcript.blocks();
		expect(blocks).toContain(pending.block);
		expect(blocks).toContain(displaceable.block);
	});
});
