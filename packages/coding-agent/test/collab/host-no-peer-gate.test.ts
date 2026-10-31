/**
 * Contract: an auto-started collab host mirrors nothing while no guest is
 * joined (events, entries and state refreshes are all skipped). A joining
 * guest's live traffic is held off while its welcome streams — the entries it
 * missed follow its last chunk, with fresh state — and reaches it from then on.
 * The state dedupe baseline restarts when that catch-up ends, so a change made
 * while the room was empty is not mistaken for one guests already have.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface Fixture {
	ctx: InteractiveModeContext;
	isStreaming: boolean;
	emit: (event: { type: string; [key: string]: unknown }) => void;
	append: (entry: SessionEntry) => void;
}

function makeFixture(): Fixture {
	const sessionId = `sess-${crypto.randomUUID()}`;
	const fixture = {
		isStreaming: false,
		emit: () => {},
		append: () => {},
	} as unknown as Fixture;
	const sessionManager: { onEntryAppended?: (entry: SessionEntry) => void; [key: string]: unknown } = {
		getSessionId: () => sessionId,
		getCwd: () => "/tmp/collab-no-peer-test",
		snapshotForReplication: () => ({
			header: { type: "session", id: sessionId, timestamp: "2026-07-20T00:00:00Z", cwd: "/tmp/collab-no-peer-test" },
			entries: [],
		}),
		onEntryAppended: undefined,
	};
	fixture.append = entry => sessionManager.onEntryAppended?.(entry);
	fixture.ctx = {
		settings: Settings.isolated(),
		sessionManager,
		session: {
			isSessionTransitioning: false,
			get isStreaming() {
				return fixture.isStreaming;
			},
			queuedMessageCount: 0,
			sessionName: "no-peer-test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: (cb: Fixture["emit"]) => {
				fixture.emit = cb;
				return () => {};
			},
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
	return fixture;
}

const textEntry = (id: string): SessionEntry =>
	({
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "2026-07-20T00:00:00Z",
		customType: "note",
		content: id,
		display: true,
	}) as unknown as SessionEntry;

let host: CollabHost | undefined;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
	host = undefined;
});

afterEach(async () => {
	vi.useRealTimers();
	if (host) await host.stop("test cleanup").catch(() => {});
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

async function startHost(fixture: Fixture): Promise<CollabSocket> {
	const originalConnect = CollabSocket.prototype.connect;
	let transport: CollabSocket | undefined;
	const capture = spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
		transport = this;
		return originalConnect.call(this);
	});
	host = new CollabHost(fixture.ctx);
	try {
		await host.start("ws://localhost:8788");
	} finally {
		capture.mockRestore();
	}
	if (!transport) throw new Error("host transport missing");
	return transport;
}

function frameType(frame: CollabFrame | string): string | undefined {
	// Pre-serialized broadcasts lead with their frame tag.
	return typeof frame === "string" ? /^\{"t":"([a-z-]+)"/.exec(frame)?.[1] : frame.t;
}

describe("collab host with no joined guest", () => {
	it("mirrors nothing until a guest joins, catches it up after its welcome, then mirrors live", async () => {
		const fixture = makeFixture();
		const transport = await startHost(fixture);
		const send = spyOn(transport, "send").mockImplementation(() => {});
		let train: Iterable<CollabFrame | string> | undefined;
		spyOn(transport, "sendBatch").mockImplementation(frames => {
			train = frames;
		});

		fixture.emit({ type: "agent_start" });
		fixture.append(textEntry("before-join"));
		expect(send.mock.calls).toEqual([]);

		transport.onFrame!({ t: "hello", proto: COLLAB_PROTO, name: "guest" }, 1);
		// Its welcome is still streaming: nothing queues behind it.
		fixture.emit({ type: "agent_start" });
		fixture.append(textEntry("during-welcome"));
		expect(send.mock.calls).toEqual([]);

		// The transport drains the train: the skipped entry follows the last chunk, then fresh state.
		if (!train) throw new Error("no welcome train queued");
		expect([...train].map(frameType)).toEqual(["welcome", "snapshot-chunk", "entry", "state", "agents"]);

		fixture.emit({ type: "agent_start" });
		fixture.append(textEntry("after-welcome"));
		const types = send.mock.calls.map(([frame]) => frameType(frame));
		expect(types).toContain("event");
		expect(types).toContain("entry");
	});

	it("re-sends a state that matches the last one sent before the room emptied", async () => {
		const fixture = makeFixture();
		const transport = await startHost(fixture);
		const send = spyOn(transport, "send").mockImplementation(() => {});
		const trains: Iterable<CollabFrame | string>[] = [];
		spyOn(transport, "sendBatch").mockImplementation(frames => {
			trains.push(frames);
		});
		vi.useFakeTimers();
		const stateFrames = () => send.mock.calls.filter(([frame]) => frameType(frame) === "state");
		const join = (peer: number) => {
			transport.onFrame!({ t: "hello", proto: COLLAB_PROTO, name: "first" }, peer);
			const train = trains.at(-1);
			if (!train) throw new Error("no welcome train queued");
			// Drained by the transport; its catch-up state is the guest's own, not a broadcast.
			for (const _ of train);
		};

		join(1);
		fixture.isStreaming = true;
		fixture.emit({ type: "agent_start" });
		vi.advanceTimersByTime(500);
		expect(stateFrames()).toHaveLength(1);

		// The room empties and the session goes idle while nobody is watching.
		transport.onControl!({ t: "peer-left", peer: 1 });
		fixture.isStreaming = false;
		fixture.emit({ type: "agent_end" });
		vi.advanceTimersByTime(500);
		expect(stateFrames()).toHaveLength(1);

		// The same guest rejoins; its welcome carries the idle state, and going busy
		// again before the join's state refresh fires must still reach it.
		join(2);
		fixture.isStreaming = true;
		fixture.emit({ type: "agent_start" });
		vi.advanceTimersByTime(500);
		expect(stateFrames()).toHaveLength(2);
	});
});
