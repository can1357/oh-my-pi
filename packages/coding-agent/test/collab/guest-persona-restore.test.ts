/**
 * Regression: leaving a collab session must clear the replica persona
 * override mirrored from the host (`AgentSession#setReplicaPersonaName`).
 *
 * Oracle: `#applyHostState()` sets a sticky override whenever the host
 * reports `activePersonaName`, and `AgentSession.activePersonaName` prefers
 * that override over the local persona (see agent-session.ts). Without
 * clearing it on teardown, the guest's restored local session — resumed or
 * freshly created — would keep showing the host's (possibly now-stale)
 * persona name in the status line and in the next persisted `agent` stamp,
 * corrupting resume inference for a session that was never actually using
 * that persona.
 *
 * The clear only fires once the replica has actually activated (joined and
 * received its first snapshot) — a guest that never got that far never set
 * the override in the first place. The test drives a real join through the
 * in-memory relay so `#replicaActivated` is genuinely true before `leave()`.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, type CollabFrame, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function makeState(): Extract<CollabFrame, { t: "welcome" }>["state"] {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

function makeContext(setReplicaPersonaName: (name: string | null | undefined) => void) {
	const ctx = {
		collabGuest: undefined,
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			setReplicaPersonaName,
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: () => Promise.resolve(), takeDisplaceableComponents: () => [] },
		syncRunningSubagentBadge: () => {},
	} as unknown as InteractiveModeContext;
	return ctx;
}

beforeEach(() => {
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
});

describe("CollabGuestLink — persona restore on leave", () => {
	it("clears the replica persona override before restoring the local session", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const setReplicaPersonaName = vi.fn();

		const roomId = "persona-restore-room-1";
		const roomKey = generateRoomKey();
		const cryptoKey = await importRoomKey(roomKey);
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
		const hostOpen = Promise.withResolvers<void>();
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t === "hello") {
				hostSocket.send({
					t: "welcome",
					proto: COLLAB_PROTO,
					header: { type: "session", id: "remote-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
					state: makeState(),
					agents: [],
					entryCount: 0,
				} as CollabFrame);
			}
		};
		hostSocket.connect();
		await hostOpen.promise;

		const ctx = makeContext(setReplicaPersonaName);
		const guest = new CollabGuestLink(ctx);

		try {
			await guest.join(link);
			await guest.leave("test cleanup");

			expect(setReplicaPersonaName).toHaveBeenCalledWith(undefined);
		} finally {
			hostSocket.close();
			writeSpy.mockRestore();
		}
	});
});
