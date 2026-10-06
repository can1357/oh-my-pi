import { afterEach, expect, it, vi } from "bun:test";
import * as utils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { generateRoomKey, importRoomKey } from "../../src/collab/crypto";
import { CollabGuestLink } from "../../src/collab/guest";
import { COLLAB_PROTO, type CollabFrame, formatCollabLink } from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";
import type { InteractiveModeContext } from "../../src/modes/types";
import { EventBus } from "../../src/utils/event-bus";
import { installInMemoryRelay, uninstallInMemoryRelay } from "../collab/helpers/in-memory-relay";

afterEach(() => {
	uninstallInMemoryRelay();
	vi.restoreAllMocks();
});

it("keeps messages buffered after failed collab restoration, including repeated leave attempts", async () => {
	const temp = TempDir.createSync("@messaging-env-collab-");
	vi.spyOn(utils, "getConfigRootDir").mockReturnValue(temp.path());
	installInMemoryRelay();
	const key = generateRoomKey();
	const roomId = crypto.randomUUID();
	const host = new CollabSocket({
		wsUrl: `ws://localhost:8788/r/${roomId}`,
		role: "host",
		key: await importRoomKey(key),
	});
	const opened = Promise.withResolvers<void>();
	host.onOpen = () => opened.resolve();
	host.onFrame = frame => {
		if (frame.t !== "hello") return;
		host.send({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: { type: "session", id: "remote", timestamp: "2026-10-05T00:00:00Z", cwd: temp.path() },
			state: { isStreaming: false, queuedMessageCount: 0, cwd: temp.path(), participants: [] },
			agents: [],
			entryCount: 0,
		} as CollabFrame);
	};
	const restoreEntered = Promise.withResolvers<void>();
	const restoreGate = Promise.withResolvers<void>();
	let blocked = false;
	const deliveries: string[] = [];
	const pending: string[] = [];
	const resume = vi.fn(() => {
		blocked = false;
		deliveries.push(...pending.splice(0));
	});
	const suspend = vi.fn(() => {
		blocked = true;
		return resume;
	});
	const deliver = (body: string): void => {
		(blocked ? pending : deliveries).push(body);
	};
	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: Settings.isolated(),
		sessionManager: { getSessionFile: () => null, getSessionName: () => "local", getCwd: () => temp.path() },
		session: {
			messages: [],
			messaging: { suspendReceiving: suspend },
			switchSession: async () => {
				deliver("during adoption");
			},
			newSession: async () => {
				restoreEntered.resolve();
				await restoreGate.promise;
				throw new Error("restoration failed");
			},
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {}, disposeChildren: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: async () => {},
		reloadTodos: async () => {},
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: async () => {}, takeDisplaceableComponents: () => [] },
		syncRunningSubagentBadge: () => {},
		eventBus: new EventBus(),
	} as unknown as InteractiveModeContext;
	const guest = new CollabGuestLink(ctx);
	try {
		host.connect();
		await opened.promise;
		await guest.join(formatCollabLink("ws://localhost:8788", roomId, key));
		expect(suspend).toHaveBeenCalledTimes(1);
		expect(deliveries).toEqual([]);
		const leaving = guest.leave("test teardown");
		await restoreEntered.promise;
		deliver("during restoration");
		expect(resume).not.toHaveBeenCalled();
		restoreGate.resolve();
		await expect(leaving).rejects.toThrow("restoration failed");
		expect(resume).not.toHaveBeenCalled();
		expect(deliveries).toEqual([]);
		expect(ctx.collabGuest).toBe(guest);
		vi.spyOn(ctx.session, "newSession").mockResolvedValue(true);
		await expect(guest.leave("retry restoration")).rejects.toThrow("restoration failed");
		expect(resume).not.toHaveBeenCalled();
		expect(ctx.collabGuest).toBe(guest);
		expect(deliveries).toEqual([]);
	} finally {
		restoreGate.resolve();
		await guest.leave("cleanup").catch(() => {});
		host.close();
		temp.removeSync();
	}
});
