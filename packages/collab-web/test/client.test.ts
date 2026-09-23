import { afterEach, describe, expect, it, vi } from "bun:test";
import type {
	AgentSnapshot,
	AssistantMessage,
	GuestFrame,
	HostFrame,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentProgressPayload,
	WireMessage,
} from "@oh-my-pi/pi-wire";
import { GuestClient, PAGE_BYTES, TAIL_BYTES } from "../src/lib/client";
import { COLLAB_PROTO, encodeBase64Url } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };

const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};

const AGENTS: AgentSnapshot[] = [
	{
		id: "main",
		displayName: "Main",
		kind: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1,
		lastActivity: 2,
	},
];

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "test/model",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

function messageEntry(id: string, message: WireMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-06-12T00:00:01Z", message };
}

function welcomeFrame(entryCount = 0, readOnly?: boolean): HostFrame {
	return { t: "welcome", proto: COLLAB_PROTO, header: HEADER, state: STATE, agents: AGENTS, entryCount, readOnly };
}

function snapshotChunk(entries: SessionEntry[], final = true): HostFrame {
	return { t: "snapshot-chunk", entries, final };
}

function liveClient(entries: SessionEntry[] = []): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest(welcomeFrame(entries.length));
	if (entries.length > 0) client.applyFrameForTest(snapshotChunk(entries));
	return client;
}

describe("GuestClient frame apply", () => {
	it("throws on an invalid link", () => {
		expect(() => new GuestClient("not a link", "tester")).toThrow();
	});

	it("welcome populates the snapshot and goes live", () => {
		const userEntry = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
		const client = liveClient([userEntry]);
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("live");
		expect(snap.header).toEqual(HEADER);
		expect(snap.entries).toEqual([userEntry]);
		expect(snap.state).toEqual(STATE);
		expect(snap.agents).toEqual(AGENTS);
		expect(snap.working).toBe(false);
		expect(snap.stream).toBeNull();
		expect(snap.activeTools.size).toBe(0);
	});

	it("welcome readOnly flag lands in the snapshot", () => {
		const client = new GuestClient(LINK, "tester");
		expect(client.getSnapshot().readOnly).toBe(false);
		client.applyFrameForTest(welcomeFrame(0, true));
		expect(client.getSnapshot().readOnly).toBe(true);
	});

	it("times out stalled snapshot chunks and resets the clock on progress", () => {
		vi.useFakeTimers();
		try {
			const firstEntry = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
			const client = new GuestClient(LINK, "tester");
			client.applyFrameForTest(welcomeFrame(2));
			expect(client.getSnapshot().phase).toBe("connecting");

			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("connecting");
			client.applyFrameForTest(snapshotChunk([firstEntry], false));
			expect(client.getSnapshot().entries).toEqual([]);
			expect(client.getSnapshot().phase).toBe("connecting");

			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("connecting");
			vi.advanceTimersByTime(1);
			const snap = client.getSnapshot();
			expect(snap.phase).toBe("ended");
			expect(snap.endedReason).toBe("timed out waiting for the host's session snapshot");

			const completeClient = new GuestClient(LINK, "tester");
			completeClient.applyFrameForTest(welcomeFrame(1));
			completeClient.applyFrameForTest(snapshotChunk([firstEntry]));
			vi.advanceTimersByTime(30_000);
			expect(completeClient.getSnapshot().phase).toBe("live");
			expect(completeClient.getSnapshot().entries).toEqual([firstEntry]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the transcript on screen through a resync and swaps it in on the final chunk", () => {
		const e1 = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "again", timestamp: 2 });
		const client = liveClient([e1]);

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		expect(client.getSnapshot().entries).toEqual([e1]);
		expect(client.getSnapshot().loading).toEqual({ received: 1, total: 2 });

		client.applyFrameForTest(snapshotChunk([e2]));
		expect(client.getSnapshot().entries).toEqual([e1, e2]);
		expect(client.getSnapshot().loading).toBeNull();
		expect(client.getSnapshot().phase).toBe("live");
	});

	it("publishes live entries that arrive mid-snapshot after the snapshot, not inside it", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const live = messageEntry("live", { role: "user", content: "live", timestamp: 3 });
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		client.applyFrameForTest({ t: "entry", entry: live });
		expect(client.getSnapshot().entries).toEqual([]);
		expect(client.getSnapshot().loading).toEqual({ received: 1, total: 2 });

		client.applyFrameForTest(snapshotChunk([e2]));
		expect(client.getSnapshot().entries).toEqual([e1, e2, live]);
	});

	it("drops the finished stream ghost when its entry lands mid-snapshot", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const message = assistantMessage("hello");
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message } });
		client.applyFrameForTest({ t: "entry", entry: messageEntry("a1", message) });
		client.applyFrameForTest(snapshotChunk([e2]));

		const snap = client.getSnapshot();
		expect(snap.entries).toEqual([e1, e2, messageEntry("a1", message)]);
		expect(snap.stream).toBeNull();
		expect(snap.streamDone).toBe(false);
	});

	it("completes the snapshot once every promised entry arrived, even without a final chunk", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1, e2], false));
		expect(client.getSnapshot().phase).toBe("live");
		expect(client.getSnapshot().entries).toEqual([e1, e2]);
		expect(client.getSnapshot().loading).toBeNull();
	});

	it("message_update sets the stream ghost (synthesizing a missed start)", () => {
		const client = liveClient();
		const partial = assistantMessage("hel");
		client.applyFrameForTest({ t: "event", event: { type: "message_update", message: partial } });
		const snap = client.getSnapshot();
		expect(snap.stream).toEqual(partial);
		expect(snap.streamDone).toBe(false);
	});

	it("message_end keeps the ghost until the matching entry lands", () => {
		const client = liveClient();
		const message = assistantMessage("hello");
		client.applyFrameForTest({ t: "event", event: { type: "message_update", message } });
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message } });
		let snap = client.getSnapshot();
		expect(snap.streamDone).toBe(true);
		expect(snap.stream).toEqual(message);

		client.applyFrameForTest({ t: "entry", entry: messageEntry("e2", message) });
		snap = client.getSnapshot();
		expect(snap.stream).toBeNull();
		expect(snap.streamDone).toBe(false);
		expect(snap.entries).toHaveLength(1);
	});

	it("tool start/update/end maintains activeTools", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		});
		let tool = client.getSnapshot().activeTools.get("tc1");
		expect(tool?.toolName).toBe("bash");
		expect(tool?.intent).toBe("Listing");

		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_update",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				partialResult: "src",
			},
		});
		tool = client.getSnapshot().activeTools.get("tc1");
		expect(tool?.partialResult).toBe("src");

		client.applyFrameForTest({
			t: "event",
			event: { type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: "src\ntest" },
		});
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("agent_start/agent_end and state reconcile the working flag", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "event", event: { type: "agent_start" } });
		expect(client.getSnapshot().working).toBe(true);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: false } });
		expect(client.getSnapshot().working).toBe(false);
	});
	it("a state frame recovers a stuck-idle guest when agent_start was dropped", () => {
		// The host begins streaming mid-turn, but the matching `agent_start`
		// never arrived (e.g. dropped on a reconnect). Before the fix nothing
		// set `working` true except `agent_start`, so the guest stayed idle.
		const client = liveClient();
		expect(client.getSnapshot().working).toBe(false);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: true } });
		expect(client.getSnapshot().working).toBe(true);
	});

	it("an idle state frame clears a pinned tool card when tool_execution_end was dropped", () => {
		// Host reports idle, but the matching `tool_execution_end` was dropped,
		// leaving a stuck tool card. The authoritative idle signal must clear it.
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		});
		expect(client.getSnapshot().activeTools.size).toBe(1);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: false } });
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("bus progress frames update the progress map", () => {
		const client = liveClient();
		const payload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			task: "do things",
			progress: {
				index: 0,
				id: "Sub1",
				agent: "task",
				status: "running",
				task: "do things",
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				requests: 1,
				tokens: 100,
				cost: 0.01,
				durationMs: 1000,
			},
		};
		client.applyFrameForTest({ t: "bus", channel: "task:subagent:progress", data: payload });
		expect(client.getSnapshot().progress.get("Sub1")).toEqual(payload);
	});

	it("bye ends the session with a reason", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "bye", reason: "host left" });
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("ended");
		expect(snap.endedReason).toBe("host left");
	});

	it("error frames append notices", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "error", message: "boom" });
		const notices = client.getSnapshot().notices;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", message: "boom" });
	});

	it("auto_retry_end failure surfaces an error notice", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: { type: "auto_retry_end", success: false, attempt: 3, finalError: "x" },
		});
		const notices = client.getSnapshot().notices;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", message: "x" });
	});

	it("a pre-welcome error (hello rejection, e.g. protocol mismatch) ends the session with the host's reason", () => {
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest({
			t: "error",
			message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${COLLAB_PROTO - 1}`,
		});
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("ended");
		expect(snap.endedReason).toContain("protocol mismatch");
		expect(snap.endedReason).toContain(`v${COLLAB_PROTO}`);
	});

	it("tracks host UI requests and sends responses", () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: GuestFrame) => {
			sent.push(frame);
		});
		try {
			const client = liveClient();
			const request = {
				reqId: 7,
				kind: "select" as const,
				title: "Continue?",
				options: ["Yes", { label: "No", description: "Stop here" }],
				selectionMarker: "radio" as const,
			};
			client.applyFrameForTest({ t: "ui-request", request });
			expect(client.getSnapshot().uiRequest).toEqual(request);

			client.sendUiResponse(7, "Yes");
			expect(sent).toEqual([{ t: "ui-response", reqId: 7, value: "Yes" }]);
			expect(client.getSnapshot().uiRequest).toBeNull();
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("clears pending host UI requests when the host ends them", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "ui-request",
			request: { reqId: 8, kind: "editor", title: "Other", prefill: "draft" },
		});
		expect(client.getSnapshot().uiRequest?.reqId).toBe(8);
		client.applyFrameForTest({ t: "ui-request-end", reqId: 8 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("queues overlapping host UI requests until the active one resolves", () => {
		const client = liveClient();
		const first = { reqId: 9, kind: "select" as const, title: "First?", options: ["A"] };
		const second = { reqId: 10, kind: "editor" as const, title: "Second?", prefill: "draft" };
		client.applyFrameForTest({ t: "ui-request", request: first });
		client.applyFrameForTest({ t: "ui-request", request: second });
		expect(client.getSnapshot().uiRequest).toEqual(first);

		client.applyFrameForTest({ t: "ui-request-end", reqId: 9 });
		expect(client.getSnapshot().uiRequest).toEqual(second);

		client.applyFrameForTest({ t: "ui-request-end", reqId: 10 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("snapshot reference is stable between frames and replaced per frame", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		expect(client.getSnapshot()).toBe(before);
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		const after = client.getSnapshot();
		expect(after).not.toBe(before);
		expect(after.agents).not.toBe(before.agents);
		// Non-entry frames must not invalidate entry identity: Transcript's
		// memo and useSyncExternalStore skip their O(n) scans per token.
		expect(after.entries).toBe(before.entries);
	});

	it("replaces the entries reference when entry frames arrive", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		client.applyFrameForTest({
			t: "entry",
			entry: {
				type: "message",
				id: "m-new",
				parentId: null,
				timestamp: "2026-06-12T00:00:02Z",
				message: { role: "user", content: "hi", timestamp: 2 },
			},
		});
		const after = client.getSnapshot();
		expect(after.entries).not.toBe(before.entries);
		expect(after.entries).toHaveLength(before.entries.length + 1);
	});
});

describe("GuestClient tail-first sessions", () => {
	const turn = (n: number): SessionEntry =>
		messageEntry(`t${n}`, { role: "user", content: `Turn ${n}`, timestamp: n });

	function tailWelcome(entryCount: number, startId: string | null, hasEarlier: boolean): HostFrame {
		return {
			t: "welcome",
			proto: COLLAB_PROTO,
			header: HEADER,
			state: STATE,
			agents: AGENTS,
			entryCount,
			history: { v: 1, startId, hasEarlier },
		};
	}

	interface Harness {
		client: GuestClient;
		sent: GuestFrame[];
		socket: () => CollabSocket;
	}

	/** A client whose socket never touches the network; tests drive its (re)connects and closes. */
	function harness(): Harness {
		const sent: GuestFrame[] = [];
		let socket: CollabSocket | null = null;
		vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: GuestFrame) => {
			sent.push(frame);
		});
		vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
			socket = this;
		});
		vi.spyOn(CollabSocket.prototype, "close").mockImplementation(() => {});
		const client = new GuestClient(LINK, "tester");
		client.connect();
		return {
			client,
			sent,
			socket: () => {
				if (socket === null) throw new Error("client never connected");
				return socket;
			},
		};
	}

	/** A live tail guest holding `t{first}..t{last}`, with earlier history on the host when `first > 0`. */
	function liveTail(first: number, last: number): Harness {
		const h = harness();
		h.socket().onOpen?.();
		const tail: SessionEntry[] = [];
		for (let n = first; n <= last; n++) tail.push(turn(n));
		h.client.applyFrameForTest(tailWelcome(tail.length, tail[0]?.id ?? null, first > 0));
		h.client.applyFrameForTest(snapshotChunk(tail));
		return h;
	}

	function requests<T extends "fetch-history" | "fetch-value">(
		sent: readonly GuestFrame[],
		t: T,
	): Extract<GuestFrame, { t: T }>[] {
		return sent.filter((frame): frame is Extract<GuestFrame, { t: T }> => frame.t === t);
	}

	const ids = (client: GuestClient) => client.getSnapshot().entries.map(entry => entry.id);

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("joins with a tail and pages back from the welcome's cursor", () => {
		const { client, sent, socket } = harness();
		socket().onOpen?.();
		expect(sent[0]).toMatchObject({ t: "hello", snapshot: { mode: "tail", maxBytes: TAIL_BYTES } });
		client.applyFrameForTest(tailWelcome(2, "t7", true));
		client.applyFrameForTest(snapshotChunk([turn(7), turn(8)]));

		client.fetchHistory();
		client.fetchHistory(); // one page in flight at a time
		expect(requests(sent, "fetch-history")).toMatchObject([{ before: "t7", maxBytes: PAGE_BYTES }]);
	});

	it("never asks an old host (no welcome.history) for history", () => {
		const { client, sent, socket } = harness();
		socket().onOpen?.();
		client.applyFrameForTest(welcomeFrame(1));
		client.applyFrameForTest(snapshotChunk([turn(0)]));
		expect(client.getSnapshot().history).toBeNull();

		client.fetchHistory();
		expect(requests(sent, "fetch-history")).toEqual([]);
	});

	it("prepends a multi-frame page in one commit, dropping rows it repeats", () => {
		const { client, sent } = liveTail(5, 6);
		client.fetchHistory();
		const { reqId } = requests(sent, "fetch-history")[0];
		const published = new Set<readonly SessionEntry[]>();
		client.subscribe(() => published.add(client.getSnapshot().entries));

		client.applyFrameForTest({ t: "history", reqId, entries: [turn(3), turn(4)], final: false });
		client.applyFrameForTest({ t: "entry", entry: turn(7) });
		client.applyFrameForTest({
			t: "history",
			reqId,
			entries: [turn(5)],
			final: true,
			startId: "t3",
			hasEarlier: true,
		});

		expect(ids(client)).toEqual(["t3", "t4", "t5", "t6", "t7"]);
		expect(client.getSnapshot().history).toEqual({ startId: "t3", hasEarlier: true, loading: false, error: null });
		expect(published.size).toBe(2); // the live entry, then the whole page
	});

	it("stops paging when a page adds nothing but claims more history", () => {
		const { client, sent } = liveTail(5, 6);
		client.fetchHistory();
		const { reqId } = requests(sent, "fetch-history")[0];
		client.applyFrameForTest({ t: "history", reqId, entries: [turn(5)], final: true, hasEarlier: true });
		expect(client.getSnapshot().history).toMatchObject({
			loading: false,
			error: "the host sent no earlier messages",
		});
	});

	it("times out a stalled page, re-arming on each frame, and ignores its late reply", () => {
		vi.useFakeTimers();
		const { client, sent } = liveTail(5, 6);
		client.fetchHistory();
		const { reqId } = requests(sent, "fetch-history")[0];

		vi.advanceTimersByTime(29_999);
		client.applyFrameForTest({ t: "history", reqId, entries: [turn(4)], final: false });
		vi.advanceTimersByTime(29_999);
		expect(client.getSnapshot().history?.loading).toBe(true);
		vi.advanceTimersByTime(1);
		expect(client.getSnapshot().history).toMatchObject({
			loading: false,
			error: "timed out loading earlier messages",
		});

		client.applyFrameForTest({
			t: "history",
			reqId,
			entries: [turn(3)],
			final: true,
			startId: "t3",
			hasEarlier: true,
		});
		expect(ids(client)).toEqual(["t5", "t6"]);
	});

	it("re-joins for a fresh tail when the cursor went stale", async () => {
		const { client, sent } = liveTail(5, 6);
		const transcript = client.fetchTranscript("Sub1", 0);
		client.fetchHistory();
		const { reqId } = requests(sent, "fetch-history")[0];
		client.applyFrameForTest({ t: "history", reqId, entries: [], final: true, error: "stale" });
		expect(sent.filter(frame => frame.t === "hello")).toHaveLength(2);
		expect(ids(client)).toEqual(["t5", "t6"]);

		const branch = messageEntry("b1", { role: "user", content: "other branch", timestamp: 9 });
		client.applyFrameForTest(tailWelcome(1, "b1", false));
		// The host's re-hello discarded this guest's queued transcript replies.
		expect(await transcript).toBeNull();
		client.applyFrameForTest(snapshotChunk([branch]));
		expect(client.getSnapshot().entries).toEqual([branch]);
		expect(client.getSnapshot().history).toEqual({ startId: "b1", hasEarlier: false, loading: false, error: null });
	});

	it("keeps the replica live when a stale-cursor rejoin is refused", () => {
		vi.useFakeTimers();
		const { client, sent } = liveTail(5, 6);
		client.fetchHistory();
		const { reqId } = requests(sent, "fetch-history")[0];
		client.applyFrameForTest({ t: "history", reqId, entries: [], final: true, error: "stale" });
		client.applyFrameForTest({ t: "error", message: "Session transition in progress; join again when it completes" });
		vi.advanceTimersByTime(30_000);

		const snap = client.getSnapshot();
		expect(snap.phase).toBe("live");
		expect(ids(client)).toEqual(["t5", "t6"]);
		expect(snap.history).toMatchObject({ loading: false, error: "timed out reloading the latest messages" });
	});

	it("fails a pending page on close, and ignores it once a new welcome lands", () => {
		const { client, sent, socket } = liveTail(3, 5);
		client.fetchHistory();
		const { reqId } = requests(sent, "fetch-history")[0];
		socket().onClose?.("network lost", true);
		expect(client.getSnapshot().history).toMatchObject({ loading: false, error: null });

		socket().onOpen?.();
		client.applyFrameForTest(tailWelcome(3, "t4", true));
		client.applyFrameForTest({
			t: "history",
			reqId,
			entries: [turn(2)],
			final: true,
			startId: "t2",
			hasEarlier: true,
		});
		client.applyFrameForTest(snapshotChunk([turn(4), turn(5), turn(6)]));
		expect(ids(client)).toEqual(["t4", "t5", "t6"]);
		expect(client.getSnapshot().history?.startId).toBe("t4");
	});

	it("survives a host outage whose retry backoff outlasts the welcome timeout", () => {
		// Each retry opens a socket the relay closes at once (no such room).
		vi.useFakeTimers();
		const { client, socket } = liveTail(3, 5);
		socket().onClose?.("room closed", true);
		for (const backoff of [1_000, 20_000, 35_000, 35_000]) {
			vi.advanceTimersByTime(backoff);
			socket().onOpen?.();
			socket().onClose?.("no such room", true);
		}
		vi.advanceTimersByTime(60_000);
		expect(client.getSnapshot().phase).toBe("reconnecting");

		socket().onOpen?.();
		client.applyFrameForTest(tailWelcome(1, "t5", true));
		client.applyFrameForTest(snapshotChunk([turn(5)]));
		expect(client.getSnapshot().phase).toBe("live");
	});

	it("ends a first join that no host welcomes within the timeout, however often the socket reopens", () => {
		vi.useFakeTimers();
		const { client, socket } = harness();
		for (let i = 0; i < 3; i++) {
			vi.advanceTimersByTime(9_000);
			socket().onOpen?.();
			socket().onClose?.("network lost", true);
		}
		vi.advanceTimersByTime(3_000);
		expect(client.getSnapshot()).toMatchObject({
			phase: "ended",
			endedReason: "timed out waiting for the host's welcome",
		});
	});
});
