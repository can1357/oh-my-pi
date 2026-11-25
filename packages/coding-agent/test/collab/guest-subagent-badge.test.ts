import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsp from "node:fs/promises";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	formatCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	getRunningSubagentBadgeAgentIds,
	getRunningSubagentBadgeRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/running-subagent-badge";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// In-memory transport: shared FakeWebSocket + InMemoryRelay harness (see
// ./helpers/in-memory-relay), mirroring the relay's forwarding contract.

function makeState(): Extract<CollabFrame, { t: "welcome" }>["state"] {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

function makeAgents(ids: string[]): AgentSnapshot[] {
	return ids.map((id, index) => ({
		id,
		displayName: `Remote ${index + 1}`,
		kind: "sub",
		parentId: "Main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1000 + index,
		lastActivity: 2000 + index,
	}));
}

function makeGuestContext(): { ctx: InteractiveModeContext; subagentCount: () => number } {
	let statusLineCount = 0;
	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: Settings.isolated(),
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		clearTransientSessionUi: () => {},
		clearWorking: () => false,
		ensureWorkingRow: () => {},
		updatePendingMessagesDisplay: () => {},
		compactionQueuedMessages: [],
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		statusLine: {
			setRunningSubagents: (agentIds: readonly string[]) => {
				statusLineCount = agentIds.length;
				return true;
			},
			setCollabStatus: () => {},
			resetActiveTime: () => {},
			refresh: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: {
			dispatchSessionEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		syncRunningSubagentBadge: () => {
			const registry = getRunningSubagentBadgeRegistry(ctx.collabGuest, AgentRegistry.global());
			const agentIds = getRunningSubagentBadgeAgentIds(registry);
			ctx.statusLine.setRunningSubagents(agentIds);
		},
		setCollabGuest: (guest: InteractiveModeContext["collabGuest"]) => {
			Object.assign(ctx, { collabGuest: guest });
		},
	} as unknown as InteractiveModeContext;
	return { ctx, subagentCount: () => statusLineCount };
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab guest running-subagents badge", () => {
	it("uses the guest mirror registry and refreshes on join, resnapshot, and leave", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const roomId = "badge-room-1";
		const roomKey = generateRoomKey();
		const cryptoKey = await importRoomKey(roomKey);
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
		const hostOpen = Promise.withResolvers<void>();
		let nextWelcomeAgents = makeAgents(["remote-one"]);
		const sendWelcome = (agents: AgentSnapshot[]) => {
			hostSocket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
				state: makeState(),
				agents,
				entryCount: 0,
			});
		};
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t === "hello") sendWelcome(nextWelcomeAgents);
		};
		hostSocket.connect();
		await hostOpen.promise;

		const { ctx, subagentCount } = makeGuestContext();
		const guest = new CollabGuestLink(ctx);

		try {
			await guest.join(link);
			expect(ctx.collabGuest).toBe(guest);
			expect(subagentCount()).toBe(1);

			nextWelcomeAgents = makeAgents(["remote-one", "remote-two"]);
			const secondSnapshot = Promise.withResolvers<void>();
			const originalSync = ctx.syncRunningSubagentBadge.bind(ctx);
			ctx.syncRunningSubagentBadge = () => {
				originalSync();
				if (subagentCount() === 2) secondSnapshot.resolve();
			};
			sendWelcome(nextWelcomeAgents);
			await secondSnapshot.promise;
			expect(subagentCount()).toBe(2);

			await guest.leave("test cleanup");
			expect(ctx.collabGuest).toBeUndefined();
			expect(subagentCount()).toBe(0);
		} finally {
			hostSocket.close();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
		}
	});
});
