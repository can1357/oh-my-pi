import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function makeHostContext(manager: SessionManager): InteractiveModeContext {
	return {
		settings: { get: () => "" },
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
});
