/**
 * End-to-end contract: a host started with both link variants marks view-link
 * guests read-only in `welcome` and refuses their mutating frames, while
 * full-link guests keep prompt/abort/agent-cmd capability. Runs over an
 * in-process relay + fake WebSocket transport (no real sockets, no handshake
 * or polling latency) that speaks the documented relay forwarding contract,
 * with real AES-GCM sealing — only the TUI context and the network transport
 * are stubbed. One host/relay boots once and is reused; guest frames ride the
 * in-memory transport, so the suite stays fast and time-independent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// In-memory transport: FakeWebSocket + InMemoryRelay (see ./helpers/in-memory-relay)
// replace the real Bun.serve relay and loopback WebSocket with a zero-latency
// microtask transport. Real CollabSocket / CollabHost run unchanged on top, so
// sealing, enveloping, the hello→welcome handshake, and read-only enforcement
// are all exercised.

interface HostHarness {
	ctx: InteractiveModeContext;
	prompts: { from?: string }[];
	aborts: { count: number };
	/** Resolves on the next promptCustomMessage call — no polling. */
	nextPrompt(): Promise<{ from?: string }>;
}

/** Minimal InteractiveModeContext double: only the members CollabHost touches. */
function makeHostContext(): HostHarness {
	const prompts: { from?: string }[] = [];
	const aborts = { count: 0 };
	const promptWaiters: ((details: { from?: string }) => void)[] = [];
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: (message: { details?: { from?: string } }) => {
				const details = message.details ?? {};
				prompts.push(details);
				for (const waiter of promptWaiters.splice(0)) waiter(details);
				return Promise.resolve();
			},
			abort: () => {
				aborts.count++;
				return Promise.resolve();
			},
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
	const nextPrompt = (): Promise<{ from?: string }> => {
		const { promise, resolve } = Promise.withResolvers<{ from?: string }>();
		promptWaiters.push(resolve);
		return promise;
	};
	return { ctx, prompts, aborts, nextPrompt };
}

interface TestGuest {
	socket: CollabSocket;
	nextFrame(): Promise<CollabFrame>;
}

/**
 * Frames the test harness skips: the host's debounced broadcasts (state,
 * agents, entry, event, bus) and the per-peer snapshot-chunk train that
 * follows every welcome. They interleave nondeterministically with the
 * directed welcome/error frames these tests actually assert on.
 */
const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

/**
 * Raw guest speaking the wire protocol directly. `writeToken` overrides the link's token (e.g. forged).
 * Broadcast frames interleave nondeterministically with directed replies (the post-hello state
 * broadcast races the first prompt's error reply), so `nextFrame` drops them and yields only the
 * welcome/error frames these tests assert on.
 */
async function joinAsGuest(link: string, name: string, writeTokenOverride?: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken =
		writeTokenOverride ?? (parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined);
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	return { socket, nextFrame };
}

// ── Shared host/relay, booted once ──────────────────────────────────────────
// Booting the relay + host and connecting the host socket is the only heavy
// step; it is identical across all three tests (none mutate host config), so it
// runs once. Per-test guest state is reset in afterEach.

const guestCleanups: (() => void)[] = [];
let harness: HostHarness;
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	harness = makeHostContext();
	host = new CollabHost(harness.ctx);
	// Port is irrelevant: the fake transport routes by the `role` query param.
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	harness.prompts.length = 0;
	harness.aborts.count = 0;
});

afterAll(async () => {
	// Restore the real transport first so the global is clean even if stop() throws;
	// the host's socket holds its own FakeWebSocket/relay refs, so teardown still works.
	uninstallInMemoryRelay();
	await host.stop("test done");
});

describe("collab read-only links", () => {
	it("retains host UI through a writer disconnect and replays it only to writable guests", async () => {
		const abort = new AbortController();
		const pending = host.requestGuestUi(
			{ kind: "select", title: "Retained before join?", options: ["Yes"] },
			abort.signal,
		);
		if (!pending) throw new Error("expected retained UI request");
		try {
			const viewer = await joinAsGuest(host.viewLink, "retained-viewer");
			guestCleanups.push(() => viewer.socket.close());
			const viewerWelcome = await viewer.nextFrame();
			if (viewerWelcome.t !== "welcome") throw new Error(`expected welcome, got ${viewerWelcome.t}`);
			expect(viewerWelcome.readOnly).toBe(true);
			// This reply is ordered after every frame emitted during hello. If the
			// retained ask leaked to the viewer, it would arrive before the error.
			viewer.socket.send({ t: "prompt", text: "read-only barrier" });
			const viewerReply = await viewer.nextFrame();
			if (viewerReply.t !== "error") throw new Error(`expected error, got ${viewerReply.t}`);

			const writer = await joinAsGuest(host.link, "retained-writer-first");
			guestCleanups.push(() => writer.socket.close());
			const writerWelcome = await writer.nextFrame();
			if (writerWelcome.t !== "welcome") throw new Error(`expected welcome, got ${writerWelcome.t}`);
			writer.socket.send({ t: "agent-cmd", cmd: "chat", agentId: "barrier", text: "" });
			const request = await writer.nextFrame();
			if (request.t !== "ui-request") throw new Error(`expected ui-request, got ${request.t}`);
			expect(request.request).toMatchObject({ title: "Retained before join?", options: ["Yes"] });
			const writerBarrier = await writer.nextFrame();
			if (writerBarrier.t !== "error") throw new Error(`expected error, got ${writerBarrier.t}`);
			writer.socket.close();

			const replacement = await joinAsGuest(host.link, "retained-writer-replacement");
			guestCleanups.push(() => replacement.socket.close());
			const replacementWelcome = await replacement.nextFrame();
			if (replacementWelcome.t !== "welcome") {
				throw new Error(`expected welcome, got ${replacementWelcome.t}`);
			}
			replacement.socket.send({ t: "agent-cmd", cmd: "chat", agentId: "barrier", text: "" });
			expect(await replacement.nextFrame()).toEqual(request);
			const replacementBarrier = await replacement.nextFrame();
			if (replacementBarrier.t !== "error") {
				throw new Error(`expected error, got ${replacementBarrier.t}`);
			}

			replacement.socket.send({ t: "ui-response", reqId: request.request.reqId, value: "Yes" });
			expect(await pending).toEqual({ kind: "answered", value: "Yes" });
			expect(await replacement.nextFrame()).toEqual({ t: "ui-request-end", reqId: request.request.reqId });
		} finally {
			abort.abort();
		}
	});

	it("rejects a pre-aborted request without consuming a request ID", async () => {
		const firstAbort = new AbortController();
		const secondAbort = new AbortController();
		const first = host.requestGuestUi({ kind: "editor", title: "First" }, firstAbort.signal);
		if (!first) throw new Error("expected first retained request");
		const preAborted = new AbortController();
		preAborted.abort();
		expect(host.requestGuestUi({ kind: "editor", title: "Rejected" }, preAborted.signal)).toBeNull();
		const second = host.requestGuestUi({ kind: "editor", title: "Second" }, secondAbort.signal);
		if (!second) throw new Error("expected second retained request");
		try {
			const writer = await joinAsGuest(host.link, "pre-abort-writer");
			guestCleanups.push(() => writer.socket.close());
			const welcome = await writer.nextFrame();
			if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
			writer.socket.send({ t: "agent-cmd", cmd: "chat", agentId: "barrier", text: "" });
			const firstFrame = await writer.nextFrame();
			const secondFrame = await writer.nextFrame();
			if (firstFrame.t !== "ui-request" || secondFrame.t !== "ui-request") {
				throw new Error("expected retained ui-request frames");
			}
			expect(secondFrame.request.reqId).toBe(firstFrame.request.reqId + 1);
		} finally {
			firstAbort.abort();
			secondAbort.abort();
			await Promise.all([first, second]);
		}
	});

	it("caps retained host UI at 64 and reuses an aborted slot without consuming an ID", async () => {
		const aborts = Array.from({ length: 64 }, () => new AbortController());
		const pending = aborts.map((abort, index) => {
			const request = host.requestGuestUi({ kind: "editor", title: `Pending ${index}` }, abort.signal);
			if (!request) throw new Error(`request ${index} was rejected before the cap`);
			return request;
		});
		const replacementAbort = new AbortController();
		let replacement: Promise<unknown> | null = null;
		try {
			expect(host.requestGuestUi({ kind: "editor", title: "Overflow" })).toBeNull();
			aborts[0]?.abort();
			expect(await pending[0]).toEqual({ kind: "unavailable" });
			replacement = host.requestGuestUi({ kind: "editor", title: "Replacement" }, replacementAbort.signal);
			if (!replacement) throw new Error("expected replacement after releasing one request");

			const writer = await joinAsGuest(host.link, "cap-writer");
			guestCleanups.push(() => writer.socket.close());
			const welcome = await writer.nextFrame();
			if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
			writer.socket.send({ t: "agent-cmd", cmd: "chat", agentId: "barrier", text: "" });
			const requestIds: number[] = [];
			for (let index = 0; index < 64; index += 1) {
				const frame = await writer.nextFrame();
				if (frame.t !== "ui-request") throw new Error(`expected ui-request, got ${frame.t}`);
				requestIds.push(frame.request.reqId);
			}
			const firstRequestId = requestIds[0];
			if (firstRequestId === undefined) throw new Error("expected retained request IDs");
			expect(requestIds).toEqual(Array.from({ length: 64 }, (_, index) => firstRequestId + index));
			const barrier = await writer.nextFrame();
			if (barrier.t !== "error") throw new Error(`expected error, got ${barrier.t}`);
		} finally {
			for (const abort of aborts) abort.abort();
			replacementAbort.abort();
			await Promise.all(pending);
			if (replacement) await replacement;
		}
	});

	it("welcomes view-link guests read-only and refuses their mutating frames", async () => {
		const { prompts, aborts } = harness;
		expect(host.viewLink).not.toBe(host.link);

		const guest = await joinAsGuest(host.viewLink, "viewer");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		expect(welcome.readOnly).toBe(true);

		guest.socket.send({ t: "prompt", text: "do something" });
		const promptReply = await guest.nextFrame();
		if (promptReply.t !== "error") throw new Error(`expected error, got ${promptReply.t}`);
		expect(promptReply.message).toContain("read-only");
		expect(prompts).toHaveLength(0);

		guest.socket.send({ t: "abort" });
		const abortReply = await guest.nextFrame();
		expect(abortReply.t).toBe("error");
		expect(aborts.count).toBe(0);

		guest.socket.send({ t: "agent-cmd", cmd: "kill", agentId: "nope" });
		const cmdReply = await guest.nextFrame();
		expect(cmdReply.t).toBe("error");

		expect(host.participants.find(p => p.name === "viewer")?.readOnly).toBe(true);
	});

	it("keeps full write capability for guests holding the write token", async () => {
		const { prompts, nextPrompt } = harness;

		const guest = await joinAsGuest(host.link, "writer");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		expect(welcome.readOnly).toBeUndefined();

		const prompted = nextPrompt();
		guest.socket.send({ t: "prompt", text: "real prompt" });
		expect(await prompted).toEqual({ from: "writer" });
		expect(prompts).toHaveLength(1);
		expect(host.participants.find(p => p.name === "writer")?.readOnly).toBeUndefined();
	});

	it("keeps a remotely killed subagent tombstoned", async () => {
		const guest = await joinAsGuest(host.link, "writer-kill");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		const id = "Remote-Killed-Sub";
		const registry = AgentRegistry.global();
		let aborts = 0;
		const session = {
			abort: async () => {
				aborts++;
			},
			dispose: async () => {},
		} as unknown as AgentSession;
		const ref = registry.register({
			id,
			displayName: "remote kill",
			kind: "sub",
			session,
			sessionFile: "/tmp/Remote-Killed-Sub.jsonl",
			status: "running",
		});
		const killed = Promise.withResolvers<void>();
		const unsubscribe = registry.onChange(event => {
			if (event.ref === ref && event.type === "status_changed" && event.ref.status === "aborted") killed.resolve();
		});
		try {
			guest.socket.send({ t: "agent-cmd", cmd: "kill", agentId: id });
			await killed.promise;
			expect(aborts).toBe(1);
			expect(registry.get(id)).toMatchObject({ status: "aborted", session: null });
		} finally {
			unsubscribe();
			registry.unregister(id, ref);
		}
	});

	it("routes host UI requests to write guests and resolves their response", async () => {
		const guest = await joinAsGuest(host.link, "writer-ui");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		const pending = host.requestGuestUi({ kind: "select", title: "Continue?", options: ["Yes"] });
		if (!pending) throw new Error("expected writable guest UI request");
		const request = await guest.nextFrame();
		if (request.t !== "ui-request") throw new Error(`expected ui-request, got ${request.t}`);
		expect(request.request).toMatchObject({ kind: "select", title: "Continue?", options: ["Yes"] });

		guest.socket.send({ t: "ui-response", reqId: request.request.reqId, value: "Yes" });
		expect(await pending).toEqual({ kind: "answered", value: "Yes" });
		const end = await guest.nextFrame();
		expect(end).toEqual({ t: "ui-request-end", reqId: request.request.reqId });
	});

	it("acknowledges a late or duplicate writable response after the request settled", async () => {
		const answerer = await joinAsGuest(host.link, "writer-answer");
		guestCleanups.push(() => answerer.socket.close());
		const answererWelcome = await answerer.nextFrame();
		if (answererWelcome.t !== "welcome") throw new Error(`expected welcome, got ${answererWelcome.t}`);

		const pending = host.requestGuestUi({ kind: "select", title: "Settle once?", options: ["Yes"] });
		if (!pending) throw new Error("expected writable guest UI request");
		const request = await answerer.nextFrame();
		if (request.t !== "ui-request") throw new Error(`expected ui-request, got ${request.t}`);
		const reqId = request.request.reqId;

		answerer.socket.send({ t: "ui-response", reqId, value: "Yes" });
		expect(await pending).toEqual({ kind: "answered", value: "Yes" });
		expect(await answerer.nextFrame()).toEqual({ t: "ui-request-end", reqId });

		// A writer that reconnects after settlement never saw the broadcast end frame
		// and resends its answer. The barrier orders the reply: before the fix, the
		// resend was dropped and the barrier error arrived first.
		const late = await joinAsGuest(host.link, "writer-late");
		guestCleanups.push(() => late.socket.close());
		const lateWelcome = await late.nextFrame();
		if (lateWelcome.t !== "welcome") throw new Error(`expected welcome, got ${lateWelcome.t}`);
		late.socket.send({ t: "ui-response", reqId, value: "Yes" });
		late.socket.send({ t: "agent-cmd", cmd: "chat", agentId: "barrier", text: "" });
		expect(await late.nextFrame()).toEqual({ t: "ui-request-end", reqId });
		const lateBarrier = await late.nextFrame();
		if (lateBarrier.t !== "error") throw new Error(`expected error, got ${lateBarrier.t}`);

		// The acknowledgement is targeted: the original writer sees only its own barrier reply.
		answerer.socket.send({ t: "agent-cmd", cmd: "chat", agentId: "barrier", text: "" });
		const answererBarrier = await answerer.nextFrame();
		if (answererBarrier.t !== "error") throw new Error(`expected error, got ${answererBarrier.t}`);
	});

	it("treats a forged write token as read-only", async () => {
		const { prompts } = harness;

		// A viewer knows the room key but not the token; garbage must not escalate.
		const forged = Buffer.alloc(16, 0xab).toString("base64url");
		const guest = await joinAsGuest(host.viewLink, "forger", forged);
		guestCleanups.push(() => guest.socket.close());

		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		expect(welcome.readOnly).toBe(true);

		guest.socket.send({ t: "prompt", text: "escalation attempt" });
		const reply = await guest.nextFrame();
		expect(reply.t).toBe("error");
		expect(prompts).toHaveLength(0);
	});
});
