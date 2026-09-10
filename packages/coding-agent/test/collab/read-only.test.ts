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
import { logger } from "@oh-my-pi/pi-utils";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// In-memory transport: FakeWebSocket + InMemoryRelay (see ./helpers/in-memory-relay)
// replace the real Bun.serve relay and loopback WebSocket with a zero-latency
// microtask transport. Real CollabSocket / CollabHost run unchanged on top, so
// sealing, enveloping, the hello→welcome handshake, and read-only enforcement
// are all exercised.

interface HostHarness {
	ctx: InteractiveModeContext;
	prompts: { from?: string; content?: unknown }[];
	aborts: { count: number };
	/** Resolves on the next promptCustomMessage call — no polling. */
	nextPrompt(): Promise<{ from?: string }>;
}

/** Minimal InteractiveModeContext double: only the members CollabHost touches. */
function makeHostContext(): HostHarness {
	const prompts: { from?: string; content?: unknown }[] = [];
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
			promptCustomMessage: (message: { details?: { from?: string }; content?: unknown }) => {
				const details = message.details ?? {};
				prompts.push({ ...details, content: message.content });
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

/**
 * Guest that sends a `hello` this host's own types say is impossible. The frame is
 * `JSON.parse`d out of an encrypted envelope and cast, so a field's declared type
 * is a claim the sender makes, and these tests are about what happens when it is
 * false.
 */
function parseWriteToken(link: string): Uint8Array {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	if (!parsed.writeToken) throw new Error("expected a write link");
	return parsed.writeToken;
}

async function joinWithRawHello(link: string, hello: Record<string, unknown>): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
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
	socket.onOpen = () => socket.send({ t: "hello", ...hello } as unknown as CollabFrame);
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

/** `ERROR_MESSAGE_MAX` in host.ts, in UTF-16 code units as `slice` counts them. */
const ERROR_MESSAGE_MAX_UNITS = 512;

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

describe("collab frames a guest can send that the host must still answer", () => {
	it("treats a write token that is not a string as one that does not match", async () => {
		// `Buffer.from({}, "base64url")` throws ERR_INVALID_ARG_TYPE, and the frame
		// handler's catch would swallow it: no welcome, no error, nothing the guest
		// can distinguish from a queue that refused the join.
		const guest = await joinWithRawHello(host.link, {
			proto: COLLAB_PROTO,
			name: "malformed-token",
			writeToken: {},
		});
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		// The same outcome a wrong token gets, and the same one the write-token
		// tests above assert for a view link.
		expect(welcome.readOnly).toBe(true);
		expect(host.participants.find(p => p.name === "malformed-token")?.readOnly).toBe(true);

		// And the permission it did not get is still enforced, not merely unset.
		guest.socket.send({ t: "prompt", text: "do something" });
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("read-only");
		expect(harness.prompts).toHaveLength(0);
	});

	it("treats a name that is not a string as one it cannot use", async () => {
		// `.trim()` throws on a number, and on null, in the line before the token is
		// even read. A hello that names nothing usable gets the generated name.
		const guest = await joinWithRawHello(host.link, {
			proto: COLLAB_PROTO,
			name: 42,
			writeToken: Buffer.from(parseWriteToken(host.link)).toString("base64url"),
		});
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		// Named, not dropped — and the valid token on the same frame was still read,
		// which it could not have been if the name had thrown first.
		expect(welcome.readOnly).toBeUndefined();
		const named = host.participants.filter(p => /^guest-\d+$/.test(p.name));
		expect(named).toHaveLength(1);
		expect(named[0]?.readOnly).toBeFalsy();
	});

	it("reports a protocol version that is not a number instead of dropping the hello", async () => {
		// No narrowing needed for this one, and the test says so: a non-number is
		// never equal to COLLAB_PROTO, and String() is total for anything JSON carries.
		const guest = await joinWithRawHello(host.link, { proto: { evil: true }, name: "bad-proto" });
		guestCleanups.push(() => guest.socket.close());
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("protocol mismatch");
		expect(host.participants.find(p => p.name === "bad-proto")).toBeUndefined();
	});

	it("carries a prompt whose images are not an array, without the images", async () => {
		// `{ length: 1 }` passes the length test the spread was guarded by and then
		// throws "Spread syntax requires ...iterable", which the frame handler's catch
		// swallows: the prompt disappears and the guest is told nothing.
		const guest = await joinAsGuest(host.link, "bad-images");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// Registered before the send, and raced against a timer so a prompt that never
		// arrives fails on the assertion below rather than on the suite's timeout.
		const delivered = harness.nextPrompt();
		guest.socket.send({ t: "prompt", text: "still a prompt", images: { length: 1 } } as unknown as CollabFrame);
		await Promise.race([delivered, Bun.sleep(1_000)]);

		// Delivered, and delivered down the no-images path: the text goes through as
		// a bare string exactly as a prompt that carried no images would.
		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]?.from).toBe("bad-images");
		expect(harness.prompts[0]?.content).toBe("still a prompt");
	});

	it("answers an agent command it does not recognize", async () => {
		const guest = await joinAsGuest(host.link, "bad-cmd");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// The switch had no default, so a `cmd` matching none of the three fell out
		// of it and the handler returned: nothing run, nothing sent, and nothing the
		// guest can tell apart from a frame the send queue refused.
		guest.socket.send({ t: "agent-cmd", cmd: 42, agentId: "nope" } as unknown as CollabFrame);
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("unknown agent command");
	});

	it("answers a kill for an agent it does not have", async () => {
		const guest = await joinAsGuest(host.link, "kill-nobody");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// `chat` and `revive` both answer an unknown id, because `ensureLive` rejects
		// and `fail` replies. `kill` looked the id up itself and returned on a miss,
		// which is not a rejection, so nothing answered. A writable guest is required
		// to reach this at all — the read-only suite's refusal happens first.
		guest.socket.send({ t: "agent-cmd", cmd: "kill", agentId: "no-such-agent" } as unknown as CollabFrame);
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("no-such-agent");
	});

	it("keeps a reply bounded when the agent id is not", async () => {
		const guest = await joinAsGuest(host.link, "huge-id");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// Quoted into the reply unbounded, a 100,000-character id produced a
		// 200,031-byte error frame — and the queue admits one oversized entry, so a
		// large enough one closes the host socket on the relay's payload limit. An
		// error path exists to be polite; it must not be a disconnect a guest sizes.
		const huge = `long-agent-${"x".repeat(100_000)}`;
		guest.socket.send({ t: "agent-cmd", cmd: "kill", agentId: huge } as unknown as CollabFrame);
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(1024);
		// Bounded, and still an answer about *this* agent: nothing caps a real agent
		// id, so a long one is likelier to be one the guest typed than a short one,
		// and a reply that disowned it would be both bounded and wrong.
		expect(reply.message).toContain(`${huge.slice(0, 64)}…`);
		expect(reply.message).not.toContain(huge);
		expect(reply.message).not.toContain("(unnamed)");
	});

	it("answers rather than throwing when the agent id is a nested array", async () => {
		const guest = await joinAsGuest(host.link, "nested-id");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// Reachable, unlike a value the wire itself rejects: 5,000 levels survive
		// `JSON.stringify` and `JSON.parse` on the way here, and then throw
		// `RangeError` out of the interpolation that quotes them, back into the
		// silent-drop class. 60,000 does not survive, which is why the depth is this.
		let nested: unknown[] = [];
		const root = nested;
		for (let i = 0; i < 5_000; i++) {
			const next: unknown[] = [];
			nested.push(next);
			nested = next;
		}
		guest.socket.send({ t: "agent-cmd", cmd: "revive", agentId: root } as unknown as CollabFrame);
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("(unnamed)");
	});

	it("refuses a prompt whose text is not a string, with or without images", async () => {
		const guest = await joinAsGuest(host.link, "bad-text");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// Without images this already failed, at `promptCustomMessage`'s first
		// statement. With images nothing rejected it: the number went into a
		// `TextContent`, was persisted as sent, and threw a turn later inside a
		// provider serializer at `item.text.toWellFormed()`. Both refuse here now,
		// identically, and neither reaches the session.
		const images = [{ type: "image", data: "AAAA", mimeType: "image/png" }];
		for (const frame of [
			{ t: "prompt", text: 42 },
			{ t: "prompt", text: 42, images },
		]) {
			guest.socket.send(frame as unknown as CollabFrame);
			const reply = await guest.nextFrame();
			if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
			expect(reply.message).toContain("text must be a string");
		}
		expect(harness.prompts).toHaveLength(0);
	});

	it("bounds a reply composed somewhere else, not just the parts it chooses", async () => {
		const guest = await joinAsGuest(host.link, "composed-reply");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// `chat` and `revive` reach `ensureLive`, which embeds the id it was handed
		// twice, in prose of its own, in another module. Bounding the id at this
		// handler left that untouched: 100,011 characters came back as a 200,211-byte
		// reply, larger than the unbounded version the bound was added to fix. The cap
		// has to sit on the finished message.
		const huge = `long-agent-${"x".repeat(100_000)}`;
		guest.socket.send({ t: "agent-cmd", cmd: "revive", agentId: huge } as unknown as CollabFrame);
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).not.toContain(huge);
		// The exact cap, not a generous ceiling. Two layers bound this message and
		// only this assertion separates them: the error text is cut to 512 before it
		// is quoted, and the finished `agent <label>: <text>` is longer than that
		// again, so a reply over the cap means #sendError stopped enforcing it.
		expect(reply.message.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_UNITS + 1);
	});

	it("bounds the protocol-mismatch reply it quotes the guest's version into", async () => {
		const huge = "v".repeat(100_000);
		const guest = await joinWithRawHello(host.link, { proto: huge, name: "huge-proto" });
		guestCleanups.push(() => guest.socket.close());
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("protocol mismatch");
		expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(1024);
		expect(reply.message).not.toContain(huge);
	});

	it("refuses a prompt whose images are not image content", async () => {
		const guest = await joinAsGuest(host.link, "bad-image-element");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// The text defect one field over. An element the host cannot represent is
		// content the guest meant to send, so it is refused rather than dropped —
		// accepted, it is persisted and throws a turn later inside a serializer.
		for (const images of [
			[{ type: "text", text: 42 }],
			[{ type: "image", data: 7, mimeType: "image/png" }],
			[{ type: "image", data: "AAAA" }],
		]) {
			guest.socket.send({ t: "prompt", text: "carry me", images } as unknown as CollabFrame);
			const reply = await guest.nextFrame();
			if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
			expect(reply.message).toContain("every image must carry string data and mimeType");
		}
		// Well-formed images still go through, so the guard rejects shape and not use.
		const delivered = harness.nextPrompt();
		guest.socket.send({
			t: "prompt",
			text: "carry me",
			images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
		} as unknown as CollabFrame);
		await Promise.race([delivered, Bun.sleep(1_000)]);
		expect(harness.prompts).toHaveLength(1);
	});

	it("narrows the transcript reply's echoed fields instead of quoting them back", async () => {
		const guest = await joinAsGuest(host.link, "bad-reqid");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// A second carrier, and one #sendError cannot reach: the transcript reply
		// echoes `reqId` so the guest can match it and `fromByte` as the resume
		// point. A 100,000-character reqId measured a 100,051-byte reply.
		const huge = "r".repeat(100_000);
		guest.socket.send({ t: "fetch-transcript", reqId: huge, agentId: "nope", fromByte: 0 } as unknown as CollabFrame);
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(1024);
		expect(reply.message).toContain("integer reqId");

		// And the contract is a byte offset and a correlation id, not merely a
		// number: -1, 0.5 and 2 ** 53 are all finite and none of them is either.
		for (const [field, value] of [
			["reqId", -1],
			["reqId", 0.5],
			["fromByte", -1],
			["fromByte", 1.5],
			["fromByte", 2 ** 53],
		] as const) {
			guest.socket.send({
				t: "fetch-transcript",
				reqId: 1,
				agentId: "nope",
				fromByte: 0,
				[field]: value,
			} as unknown as CollabFrame);
			const rejected = await guest.nextFrame();
			if (rejected.t !== "error") throw new Error(`expected error for ${field}=${value}, got ${rejected.t}`);
			expect(rejected.message).toContain(`integer ${field}`);
		}
	});

	it("bounds the log line a foreign error composes, not only the reply", async () => {
		// The reply and the log take the same text, and `ensureLive` embeds the id it
		// was handed twice. Bounding one consumer and not the other leaves the same
		// 200 KB on the other side of the same call.
		const records: { error?: unknown }[] = [];
		const sink = (event: { message: string; context?: Record<string, unknown> }) => {
			if (event.message.includes("agent-cmd failed")) records.push(event.context ?? {});
		};
		const unregister = logger.registerLogSink(sink);
		try {
			const guest = await joinAsGuest(host.link, "logged-error");
			guestCleanups.push(() => guest.socket.close());
			const welcome = await guest.nextFrame();
			if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

			const huge = `long-agent-${"x".repeat(100_000)}`;
			guest.socket.send({ t: "agent-cmd", cmd: "revive", agentId: huge } as unknown as CollabFrame);
			const reply = await guest.nextFrame();
			if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);

			expect(records).toHaveLength(1);
			const logged = String(records[0]?.error ?? "");
			expect(logged.length).toBeLessThan(1024);
			expect(logged).not.toContain(huge);
		} finally {
			unregister();
		}
	});

	it("refuses an image whose optional fields are the wrong type", async () => {
		const guest = await joinAsGuest(host.link, "bad-optional");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// `ImageContent` declares `detail`, `url` and `providerFile` too. Checking
		// only the required fields let a declared one through with the wrong type,
		// which is the same reach-a-serializer defect the required checks close.
		for (const extra of [
			{ detail: 42 },
			{ detail: "enormous" },
			{ url: 7 },
			{ providerFile: 5 },
			{ providerFile: { provider: "nope" } },
			{ providerFile: { provider: "openai", id: 9 } },
			{ providerFile: { provider: "openai", expiresAt: "soon" } },
		]) {
			guest.socket.send({
				t: "prompt",
				text: "carry me",
				images: [{ type: "image", data: "AAAA", mimeType: "image/png", ...extra }],
			} as unknown as CollabFrame);
			const reply = await guest.nextFrame();
			if (reply.t !== "error") throw new Error(`expected error for ${JSON.stringify(extra)}, got ${reply.t}`);
			expect(reply.message).toContain("every image must carry string data and mimeType");
		}

		// The well-formed optional fields still pass, and so does an unknown one: a
		// newer guest may carry fields this host has no opinion about.
		const delivered = harness.nextPrompt();
		guest.socket.send({
			t: "prompt",
			text: "carry me",
			images: [
				{
					type: "image",
					data: "AAAA",
					mimeType: "image/png",
					detail: "high",
					url: "https://example.invalid/a.png",
					providerFile: { provider: "openai", id: "file-1", expiresAt: 1 },
					somethingNewer: true,
				},
			],
		} as unknown as CollabFrame);
		await Promise.race([delivered, Bun.sleep(1_000)]);
		expect(harness.prompts).toHaveLength(1);
	});

	it("answers an agent chat whose message is not a string instead of dropping it", async () => {
		const guest = await joinAsGuest(host.link, "bad-chat");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// `text?.trim()` guards null and undefined but not a number, so this threw
		// where an absent message is answered.
		guest.socket.send({ t: "agent-cmd", cmd: "chat", agentId: "nope", text: 42 } as unknown as CollabFrame);
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		// The same answer an empty message gets.
		expect(reply.message).toContain("empty chat message");
	});
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
