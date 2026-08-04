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
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
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
			getSessionFile: () => null,
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
let registry: AgentRegistry;
let lifecycle: AgentLifecycleManager;
let irc: IrcBus;

beforeAll(async () => {
	installInMemoryRelay();
	harness = makeHostContext();
	registry = new AgentRegistry();
	lifecycle = new AgentLifecycleManager(registry);
	irc = new IrcBus(registry, lifecycle);
	host = new CollabHost(harness.ctx, { registry, lifecycle, irc });
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
	await lifecycle.dispose();
});

describe("collab read-only links", () => {
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

		guest.socket.send({ t: "irc-send", reqId: 1, to: "Worker", body: "mutate" });
		const ircReply = await guest.nextFrame();
		if (ircReply.t !== "irc-sent") throw new Error(`expected irc-sent, got ${ircReply.t}`);
		expect(ircReply.error).toContain("read-only");

		guest.socket.send({
			t: "fetch-irc-history",
			reqId: { amplify: "x".repeat(1024 * 1024) },
		} as unknown as CollabFrame);
		guest.socket.send({ t: "fetch-irc-history", reqId: 2 });
		const historyReply = await guest.nextFrame();
		if (historyReply.t !== "irc-history") throw new Error(`expected irc-history, got ${historyReply.t}`);
		expect(historyReply.error).toBeUndefined();
		expect(Array.isArray(historyReply.records)).toBe(true);
		guest.socket.send({ t: "fetch-irc-history", reqId: 3 });
		const rateLimitedReply = await guest.nextFrame();
		if (rateLimitedReply.t !== "irc-history") {
			throw new Error(`expected irc-history, got ${rateLimitedReply.t}`);
		}
		expect(rateLimitedReply.error).toContain("rate limit");
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

	it("fetches IRC history and sends through the host-owned bus for writable guests", async () => {
		const guest = await joinAsGuest(host.link, "writer-irc");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		const delivered = Promise.withResolvers<{ body: string; replyTo?: string }>();
		const session = {
			deliverIrcMessage: async (message: { body: string; replyTo?: string }) => {
				delivered.resolve(message);
				return "injected" as const;
			},
			emitIrcRelayObservation() {},
		} as unknown as AgentSession;
		registry.register({ id: "IrcWorker", displayName: "IRC Worker", kind: "sub", parentId: "Main", session });
		irc.history.clear();
		guestCleanups.push(() => registry.unregister("IrcWorker"));

		guest.socket.send({ t: "irc-send", reqId: 10, to: "IrcWorker", body: "Patch auth", replyTo: "prior" });
		expect(await delivered.promise).toMatchObject({ body: "Patch auth", replyTo: "prior" });
		const sendReply = await guest.nextFrame();
		if (sendReply.t !== "irc-sent") throw new Error(`expected irc-sent, got ${sendReply.t}`);
		expect(sendReply.error).toBeUndefined();

		for (let index = 0; index < 40; index++) {
			irc.history.recordMessage({
				id: `large-${index}`,
				from: "Worker",
				to: "Main",
				body: "x".repeat(20_000),
				ts: 10_000 + index,
			});
		}
		guest.socket.send({ t: "fetch-irc-history", reqId: 11 });
		const historyReply = await guest.nextFrame();
		if (historyReply.t !== "irc-history") throw new Error(`expected irc-history, got ${historyReply.t}`);
		expect(historyReply.records.find(record => record.message.body === "Patch auth")?.message).toMatchObject({
			from: "Main",
			to: "IrcWorker",
			replyTo: "prior",
		});
		expect(Buffer.byteLength(JSON.stringify(historyReply), "utf8")).toBeLessThanOrEqual(512 * 1024);
		expect(historyReply.records.length).toBeLessThan(40);

		guest.socket.send({ t: "irc-send", reqId: 12, to: "IrcWorker", body: 42 } as unknown as CollabFrame);
		const malformedReply = await guest.nextFrame();
		if (malformedReply.t !== "irc-sent") throw new Error(`expected irc-sent, got ${malformedReply.t}`);
		expect(malformedReply.error).toContain("Malformed");

		guest.socket.send({ t: "irc-send", reqId: 13, to: "IrcWorker", body: "x".repeat(64 * 1024 + 1) });

		const oversizedReply = await guest.nextFrame();
		if (oversizedReply.t !== "irc-sent") throw new Error(`expected irc-sent, got ${oversizedReply.t}`);
		expect(oversizedReply.error).toContain("exceeds");
		guest.socket.send({ t: "irc-send", reqId: 16, to: "Main", body: "self" });
		const selfReply = await guest.nextFrame();
		if (selfReply.t !== "irc-sent") throw new Error(`expected irc-sent, got ${selfReply.t}`);
		expect(selfReply.error).toContain("yourself");

		const failingSession = {
			deliverIrcMessage: async () => {
				throw new Error("recipient failed");
			},
			emitIrcRelayObservation() {},
		} as unknown as AgentSession;
		registry.register({
			id: "FailingWorker",
			displayName: "Failing Worker",
			kind: "sub",
			parentId: "Main",
			session: failingSession,
		});
		guestCleanups.push(() => registry.unregister("FailingWorker"));
		guest.socket.send({ t: "irc-send", reqId: 14, to: "all", body: "Status" });
		const partialReply = await guest.nextFrame();
		if (partialReply.t !== "irc-sent") throw new Error(`expected irc-sent, got ${partialReply.t}`);
		expect(partialReply.error).toContain("1/2 agents");
	});

	it("keeps a remotely killed subagent tombstoned", async () => {
		const guest = await joinAsGuest(host.link, "writer-kill");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		const id = "Remote-Killed-Sub";
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

	it("replays pending host UI requests to writable guests that join later", async () => {
		const firstGuest = await joinAsGuest(host.link, "writer-ui-first");
		guestCleanups.push(() => firstGuest.socket.close());
		const firstWelcome = await firstGuest.nextFrame();
		if (firstWelcome.t !== "welcome") throw new Error(`expected welcome, got ${firstWelcome.t}`);

		const pending = host.requestGuestUi({ kind: "editor", title: "Pending?", prefill: "draft" });
		if (!pending) throw new Error("expected writable guest UI request");
		const firstRequest = await firstGuest.nextFrame();
		if (firstRequest.t !== "ui-request") throw new Error(`expected ui-request, got ${firstRequest.t}`);

		const secondGuest = await joinAsGuest(host.link, "writer-ui-second");
		guestCleanups.push(() => secondGuest.socket.close());
		const secondWelcome = await secondGuest.nextFrame();
		if (secondWelcome.t !== "welcome") throw new Error(`expected welcome, got ${secondWelcome.t}`);
		const replayed = await secondGuest.nextFrame();
		expect(replayed).toEqual(firstRequest);

		secondGuest.socket.send({ t: "ui-response", reqId: firstRequest.request.reqId, value: "late" });
		expect(await pending).toEqual({ kind: "answered", value: "late" });
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
