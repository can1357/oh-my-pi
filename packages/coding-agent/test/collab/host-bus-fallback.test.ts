import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// Embedders on the previous InteractiveMode constructor signature wire only a
// session `eventBus`; the host must fall back to it so depth-1 subagent
// frames keep reaching collaboration guests.

function makeHostContext(eventBus: EventBus): InteractiveModeContext {
	return {
		settings: { get: () => "" },
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
		eventBus,
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

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab host bus fallback", () => {
	it("broadcasts subagent frames from a session-bus-only embedding", async () => {
		const hostBus = new EventBus();
		const host = new CollabHost(makeHostContext(hostBus));
		await host.start("ws://localhost:8788");

		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const guestKey = await importRoomKey(parsed.key);
		const guestSocket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: guestKey });

		const welcomed = Promise.withResolvers<void>();
		const mirrored: Array<{ id?: string; status?: string }> = [];
		guestSocket.onFrame = frame => {
			if (frame.t === "welcome") welcomed.resolve();
			if (frame.t === "bus" && frame.channel === TASK_SUBAGENT_LIFECYCLE_CHANNEL) {
				mirrored.push(frame.data as { id?: string; status?: string });
			}
		};
		guestSocket.onOpen = () => {
			guestSocket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: "probe-guest",
				writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
			});
		};
		guestSocket.connect();

		try {
			await welcomed.promise;

			// Depth-1 frame on the session bus — the only bus this embedding has.
			hostBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: "FallbackScout",
				agent: "task",
				agentSource: "bundled",
				status: "started",
				parentToolCallId: "call-fallback",
				index: 1,
			});

			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && mirrored.length === 0) {
				await Bun.sleep(5);
			}
			// Give any duplicate emit a tick to land before counting.
			await Bun.sleep(25);

			expect(mirrored.length).toBe(1);
			expect(mirrored[0]?.id).toBe("FallbackScout");
			expect(mirrored[0]?.status).toBe("started");
		} finally {
			guestSocket.close();
			await host.stop("test cleanup").catch(() => {});
		}
	}, 20000);
});
