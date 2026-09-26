import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function makeHostContext(manager: SessionManager): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: manager,
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "discard marker",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
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

beforeAll(installInMemoryRelay);
afterAll(uninstallInMemoryRelay);

describe("discarded entry branch replication", () => {
	it("keeps the pre-discard conversation connected on a guest snapshot", async () => {
		const manager = SessionManager.inMemory();
		const priorId = manager.appendMessage({ role: "user", content: "prior", timestamp: Date.now() });
		const discardedId = manager.appendMessage({
			role: "assistant",
			content: [],
			api: "mock",
			provider: "mock",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await manager.discardEntryDurably(discardedId);
		const markerId = manager.getBranch().at(-1)?.id;
		if (!markerId) throw new Error("Expected a durable branch marker");
		const reminderId = manager.appendMessage({ role: "developer", content: "retry", timestamp: Date.now() });

		const host = new CollabHost(makeHostContext(manager));
		let socket: CollabSocket | undefined;
		try {
			await host.start("ws://localhost:8788");
			const parsed = parseCollabLink(host.link);
			if ("error" in parsed) throw new Error(parsed.error);
			const key = await importRoomKey(parsed.key);
			socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
			const frames: CollabFrame[] = [];
			const complete = Promise.withResolvers<void>();
			socket.onFrame = frame => {
				frames.push(frame);
				if (frame.t === "snapshot-chunk" && frame.final) complete.resolve();
			};
			socket.onOpen = () => socket?.send({ t: "hello", proto: COLLAB_PROTO, name: "replication test" });
			socket.connect();
			await complete.promise;

			const guest = SessionManager.inMemory();
			for (const frame of frames) {
				if (frame.t !== "snapshot-chunk") continue;
				for (const entry of frame.entries) guest.ingestReplicatedEntry(entry);
			}
			expect(guest.getBranch().map(entry => entry.id)).toEqual([priorId, markerId, reminderId]);
		} finally {
			socket?.close();
			await host.stop("test done");
		}
	});

	it("resynchronizes guests without exposing a branch archived at local-only metadata", async () => {
		const manager = SessionManager.inMemory();
		const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
		const tierId = manager.appendServiceTierChange(null);
		const hiddenId = manager.appendMessage({ role: "user", content: "hidden", timestamp: Date.now() });
		manager.branch(rootId);
		const activeId = manager.appendMessage({ role: "user", content: "active", timestamp: Date.now() });

		const host = new CollabHost(makeHostContext(manager));
		let socket: CollabSocket | undefined;
		try {
			await host.start("ws://localhost:8788");
			const parsed = parseCollabLink(host.link);
			if ("error" in parsed) throw new Error(parsed.error);
			const key = await importRoomKey(parsed.key);
			socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
			const snapshots: CollabFrame[][] = [];
			let current: CollabFrame[] = [];
			const first = Promise.withResolvers<void>();
			const second = Promise.withResolvers<void>();
			socket.onFrame = frame => {
				if (frame.t === "welcome") current = [];
				if (frame.t !== "snapshot-chunk") return;
				current.push(frame);
				if (!frame.final) return;
				snapshots.push(current);
				if (snapshots.length === 1) first.resolve();
				if (snapshots.length === 2) second.resolve();
			};
			socket.onOpen = () => socket?.send({ t: "hello", proto: COLLAB_PROTO, name: "archive projection test" });
			socket.connect();
			await first.promise;

			await manager.archiveBranch(tierId);
			await second.promise;

			const snapshotIds = snapshots.map(frames =>
				frames.flatMap(frame => (frame.t === "snapshot-chunk" ? frame.entries.map(entry => entry.id) : [])),
			);
			expect(snapshotIds[0]).toEqual([rootId, hiddenId, activeId]);
			expect(snapshotIds[1]).toEqual([rootId, activeId]);
		} finally {
			socket?.close();
			await host.stop("test done");
		}
	});

	it("keeps a guest's archived branch hidden through local-only entries inside it", async () => {
		const manager = SessionManager.inMemory();
		const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
		const archivedId = manager.appendMessage({ role: "user", content: "archived", timestamp: Date.now() });
		manager.appendServiceTierChange(null);
		const behindTierId = manager.appendMessage({ role: "user", content: "behind tier", timestamp: Date.now() });
		manager.branch(rootId);
		const activeId = manager.appendMessage({ role: "user", content: "active", timestamp: Date.now() });

		const host = new CollabHost(makeHostContext(manager));
		let socket: CollabSocket | undefined;
		try {
			await host.start("ws://localhost:8788");
			const parsed = parseCollabLink(host.link);
			if ("error" in parsed) throw new Error(parsed.error);
			const key = await importRoomKey(parsed.key);
			socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
			const guest = SessionManager.inMemory();
			const snapshotDone = Promise.withResolvers<void>();
			const nextSeen = Promise.withResolvers<void>();
			let nextId: string | undefined;
			socket.onFrame = frame => {
				if (frame.t === "snapshot-chunk") {
					for (const entry of frame.entries) guest.ingestReplicatedEntry(entry);
					if (frame.final) snapshotDone.resolve();
				} else if (frame.t === "entry") {
					guest.ingestReplicatedEntry(frame.entry);
					if (frame.entry.id === nextId) nextSeen.resolve();
				}
			};
			socket.onOpen = () => socket?.send({ t: "hello", proto: COLLAB_PROTO, name: "archive traversal test" });
			socket.connect();
			await snapshotDone.promise;

			await manager.archiveBranch(archivedId);
			manager.appendServiceTierChange(null);
			nextId = manager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
			await nextSeen.promise;

			const visible: string[] = [];
			const stack = guest.getTree();
			while (stack.length > 0) {
				const node = stack.pop();
				if (!node) break;
				visible.push(node.entry.id);
				stack.push(...node.children);
			}
			expect(visible).not.toContain(behindTierId);
			const branchIds = guest.getBranch().map(entry => entry.id);
			expect(branchIds.slice(0, 2)).toEqual([rootId, activeId]);
			expect(branchIds.at(-1)).toBe(nextId);
		} finally {
			socket?.close();
			await host.stop("test done");
		}
	});
});
