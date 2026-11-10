import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsp from "node:fs/promises";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
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
} from "@oh-my-pi/pi-tui/overlays/running-subagent-badge";
import { liveTaskAgent } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
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

function makeGuestContext(): InteractiveModeContext {
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
		statusContainer: { clear: () => {} },
		pendingShellContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setRunningSubagents: (agentIds: readonly string[]) => {
				statusLineCount = agentIds.length;
			},
			get subagentCount() {
				return statusLineCount;
			},
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
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
		scheduleLiveTaskCardRefresh: () => {},
		setCollabGuest: (guest: InteractiveModeContext["collabGuest"]) => {
			Object.assign(ctx, { collabGuest: guest });
		},
	} as unknown as InteractiveModeContext;
	return ctx;
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

		const ctx = makeGuestContext();
		const guest = new CollabGuestLink(ctx);

		try {
			await guest.join(link);
			expect(ctx.collabGuest).toBe(guest);
			expect(ctx.statusLine.subagentCount).toBe(1);

			nextWelcomeAgents = makeAgents(["remote-one", "remote-two"]);
			const secondSnapshot = Promise.withResolvers<void>();
			const originalSync = ctx.syncRunningSubagentBadge.bind(ctx);
			ctx.syncRunningSubagentBadge = () => {
				originalSync();
				if (ctx.statusLine.subagentCount === 2) secondSnapshot.resolve();
			};
			sendWelcome(nextWelcomeAgents);
			await secondSnapshot.promise;
			expect(ctx.statusLine.subagentCount).toBe(2);

			await guest.leave("test cleanup");
			expect(ctx.collabGuest).toBeUndefined();
			expect(ctx.statusLine.subagentCount).toBe(0);
		} finally {
			hostSocket.close();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
		}
	});
});

function makeHostContext(): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(),
		session: {
			isStreaming: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "host session",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: new EventBus(),
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

/**
 * Frames cross real WebCrypto sealing, which resolves on the event loop rather than
 * a clock fake timers control, so poll until `predicate` holds, bounded by wall time.
 */
async function settle(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
}

describe("collab guest task-card liveness", () => {
	it("mirrors the host's accepted result so a running tail never draws as a live run", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const hostRegistry = AgentRegistry.global();
		// A streaming session keeps the ref `running` after its result is accepted.
		hostRegistry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as unknown as AgentSessionHandle,
		});
		const host = new CollabHost(makeHostContext());
		await host.start("ws://localhost:8788");
		const guest = new CollabGuestLink(makeGuestContext());
		const mirrored = () => guest.agentRegistry.get("Worker");

		try {
			await guest.join(host.link);
			expect(liveTaskAgent(mirrored(), undefined, undefined)).toEqual({ progress: undefined });

			expect(hostRegistry.markResultAccepted("Worker")).toBe(true);
			await settle(() => mirrored()?.lifecycle?.acceptedAt !== undefined);
			expect(mirrored()?.status).toBe("running");
			expect(mirrored()?.lifecycle?.acceptedAt).toBe(hostRegistry.get("Worker")?.lifecycle?.acceptedAt);
			expect(liveTaskAgent(mirrored(), undefined, undefined)).toBeUndefined();

			// A new run inside one debounce window reaches the guest as `running` → `running`.
			hostRegistry.setStatus("Worker", "idle");
			hostRegistry.setStatus("Worker", "running");
			await settle(() => mirrored()?.lifecycle?.acceptedAt === undefined);
			expect(liveTaskAgent(mirrored(), undefined, undefined)).toEqual({ progress: undefined });
		} finally {
			await guest.leave("test cleanup").catch(() => {});
			await host.stop("test cleanup").catch(() => {});
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	}, 20000);

	it("replaces a killed agent's mirrored ref when the host revives the same id", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const hostRegistry = AgentRegistry.global();
		const streaming = { isStreaming: true } as unknown as AgentSessionHandle;
		hostRegistry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: streaming,
		});
		const host = new CollabHost(makeHostContext());
		await host.start("ws://localhost:8788");
		const guest = new CollabGuestLink(makeGuestContext());
		const mirrored = () => guest.agentRegistry.get("Worker");

		try {
			await guest.join(host.link);
			expect(mirrored()?.status).toBe("running");
			expect(liveTaskAgent(mirrored(), undefined, undefined)).toEqual({ progress: undefined });

			// An explicit kill detaches the session before publishing the terminal row.
			const killed = hostRegistry.get("Worker");
			if (!killed) throw new Error("Expected the running ref");
			expect(hostRegistry.detachSession("Worker", killed)).toBe(true);
			expect(hostRegistry.setStatus("Worker", "aborted", killed)).toBe(true);
			await settle(() => mirrored()?.status === "aborted");
			expect(liveTaskAgent(mirrored(), undefined, undefined)).toBeUndefined();

			// Revival reopens the id as a new generation (as `ensureLive` does for a killed ref).
			const revived = hostRegistry.reopen("Worker", killed);
			if (!revived) throw new Error("Expected the host to reopen the killed ref");
			expect(hostRegistry.attachSession("Worker", streaming, null, revived)).toBe(true);
			expect(hostRegistry.setStatus("Worker", "running", revived)).toBe(true);
			await settle(() => mirrored()?.status === "running");

			// The mirrored tombstone could never adopt the live status; the guest
			// mirrors the host's replacement generation instead.
			expect(mirrored()).not.toBe(killed);
			expect(liveTaskAgent(mirrored(), undefined, undefined)).toEqual({ progress: undefined });
		} finally {
			await guest.leave("test cleanup").catch(() => {});
			await host.stop("test cleanup").catch(() => {});
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	}, 20000);

	it("repaints the settled card when a snapshot changes only the mirrored acceptance", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const hostRegistry = AgentRegistry.global();
		hostRegistry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as unknown as AgentSessionHandle,
		});
		const host = new CollabHost(makeHostContext());
		await host.start("ws://localhost:8788");
		const ctx = makeGuestContext();
		const guest = new CollabGuestLink(ctx);
		const mirrored = () => guest.agentRegistry.get("Worker");
		let frames = 0;
		let cardRefreshes = 0;
		ctx.syncRunningSubagentBadge = () => {
			frames++;
		};
		ctx.scheduleLiveTaskCardRefresh = () => {
			cardRefreshes++;
		};

		try {
			await guest.join(host.link);
			expect(frames).toBe(1);
			expect(cardRefreshes).toBe(0);

			// The run hands over its result while its session still streams: status stays `running`.
			expect(hostRegistry.markResultAccepted("Worker")).toBe(true);
			await settle(() => mirrored()?.lifecycle?.acceptedAt !== undefined);
			expect(mirrored()?.status).toBe("running");
			expect(cardRefreshes).toBe(1);
			expect(liveTaskAgent(mirrored(), undefined, undefined)).toBeUndefined();

			// A new run inside the host's debounce window reaches the guest `running` → `running`.
			const framesBeforeNewRun = frames;
			hostRegistry.setStatus("Worker", "idle");
			hostRegistry.setStatus("Worker", "running");
			await settle(() => mirrored()?.lifecycle?.acceptedAt === undefined);
			expect(frames).toBe(framesBeforeNewRun + 1);
			expect(cardRefreshes).toBe(2);
			expect(liveTaskAgent(mirrored(), undefined, undefined)).toEqual({ progress: undefined });

			// A snapshot the card cannot draw differently must not repaint it.
			const framesBeforeNoop = frames;
			hostRegistry.setHistory("Worker", {});
			await settle(() => frames > framesBeforeNoop);
			expect(cardRefreshes).toBe(2);
		} finally {
			await guest.leave("test cleanup").catch(() => {});
			await host.stop("test cleanup").catch(() => {});
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	}, 20000);
});
