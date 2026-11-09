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
import { importRoomKey, sealSerialized } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	COLLAB_PROTO,
	type CollabFrame,
	packEnvelope,
	parseCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

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
		settings: Settings.isolated(),
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

type PromptOutcome = { kind: "error"; message: string } | { kind: "delivered" } | { kind: "other"; t: string };

/**
 * Send a prompt and settle on whichever of its two mutually exclusive outcomes
 * happens: the host answers with an `error` frame and delivers nothing, or it
 * delivers the prompt and answers nothing.
 *
 * Raced rather than awaited one at a time because there is no frame to wait for
 * on the accepting path. Waiting on `nextFrame` alone turns "wrongly accepted"
 * into a test timeout, which reports elapsed time rather than the behaviour that
 * changed — and reports it five seconds late, per row.
 */
function promptOutcome(guest: TestGuest, harness: HostHarness, frame: unknown): Promise<PromptOutcome> {
	const delivered = harness.nextPrompt().then((): PromptOutcome => ({ kind: "delivered" }));
	const answered = guest
		.nextFrame()
		.then((reply): PromptOutcome =>
			reply.t === "error" ? { kind: "error", message: reply.message } : { kind: "other", t: reply.t },
		);
	guest.socket.send(frame as CollabFrame);
	return Promise.race([delivered, answered]);
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

/** Guest transports the relay has seen, newest last, so a test can send raw bytes. */
const guestTransports: FakeWebSocket[] = [];

/**
 * Deliver a frame to the host as bytes, skipping `CollabSocket.send`.
 *
 * `send` serializes with `JSON.stringify`, so anything routed through it can only
 * carry what this library is able to produce. The host reads `JSON.parse` output,
 * which is a strictly larger set — that gap is the reachability argument behind
 * the image rebuild, and this is what lets a test stand on it instead of a
 * comment.
 */
async function sendRawFrame(rawFrame: string): Promise<void> {
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const transport = guestTransports.at(-1);
	if (!transport) throw new Error("no guest transport connected");
	const sealed = await sealSerialized(key, rawFrame);
	transport.send(packEnvelope(0, sealed));
}

// ── Shared host/relay, booted once ──────────────────────────────────────────
// Booting the relay + host and connecting the host socket is the only heavy
// step; it is identical across all three tests (none mutate host config), so it
// runs once. Per-test guest state is reset in afterEach.

const guestCleanups: (() => void)[] = [];
let harness: HostHarness;
let host: CollabHost;

beforeAll(async () => {
	const relay = installInMemoryRelay();
	const connect = relay.connect.bind(relay);
	relay.connect = ws => {
		connect(ws);
		if (ws.role === "guest") guestTransports.push(ws);
	};
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

	it("reports a protocol version that is not a number instead of dropping the hello", async () => {
		// A non-number is never equal to COLLAB_PROTO, so reaching the mismatch branch
		// needs no narrowing. Quoting it back does: `String` is not total for
		// everything JSON carries — a nested array throws out of it — which is why the
		// reply runs the value through #label.
		const guest = await joinWithRawHello(host.link, { proto: { evil: true }, name: "bad-proto" });
		guestCleanups.push(() => guest.socket.close());
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("protocol mismatch");
		expect(host.participants.find(p => p.name === "bad-proto")).toBeUndefined();
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

	it("keeps a reply bounded when the agent id is not", async () => {
		const guest = await joinAsGuest(host.link, "huge-id");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// Quoted into the reply unbounded, the id below came back twice — once in the
		// prefix, once inside the error — so the frame ran to about twice its length.
		// The queue admits one oversized entry, so a large enough one closes the host
		// socket on the relay's payload limit. An error path exists to be polite; it
		// must not be a disconnect a guest sizes.
		const huge = `long-agent-${"x".repeat(100_000)}`;
		guest.socket.send({ t: "agent-cmd", cmd: "kill", agentId: huge } as unknown as CollabFrame);
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(1024);
		// Bounded, and still about this agent.
		expect(reply.message).toContain(huge.slice(0, 32));
		expect(reply.message).not.toContain(huge);
		expect(reply.message).not.toContain("(unnamed)");
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

	it("refuses a prompt whose images are not image content", async () => {
		const guest = await joinAsGuest(host.link, "bad-image-element");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// The text defect one field over. An element the host cannot represent is
		// content the guest meant to send, so it is refused rather than dropped —
		// accepted, it is persisted and throws a turn later inside a serializer.
		for (const images of [
			// The null arm of the element check, distinct from a non-object element.
			[null],
			[{ type: "text", text: 42 }],
			[{ type: "image", data: 7, mimeType: "image/png" }],
			[{ type: "image", data: "AAAA" }],
		]) {
			guest.socket.send({ t: "prompt", text: "carry me", images } as unknown as CollabFrame);
			const reply = await guest.nextFrame();
			if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
			expect(reply.message).toContain("every image must carry string data and a supported image type");
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

	it("refuses an image whose media type is not one this codebase can carry", async () => {
		const guest = await joinAsGuest(host.link, "bad-mime");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// Every row is a string, so the `typeof` check that used to be the whole test
		// passes all of them. Each one is here for a different reason:
		//
		// - `text/html` becomes the response `content-type` the blob broker serves
		//   the guest's own bytes back under (`blob-broker/store.ts`), on an origin
		//   this process operates.
		// - `__proto__` and `constructor` are looked up in `EXT_BY_MIME`, a plain
		//   object, so they resolve to `Object.prototype` and `Object` instead of
		//   `undefined`; the `?? "bin"` fallback never fires and the path the broker
		//   publishes stops matching the `BLOB_PATH_PATTERN` it parses requests with.
		// - a `,` ends the media type early in `data:${mimeType};base64,${data}`,
		//   which the OpenAI, Cursor and completions converters build.
		// - CRLF separates the parts of the multipart bodies the blob uploaders
		//   compose (`blob-broker/uploaders-object-storage.ts`).
		// - `IMAGE/PNG` is a case `providers/anthropic.ts` folds and `EXT_BY_MIME`
		//   does not, so accepting it means two sinks disagreeing about the same
		//   image. Nothing in this repo emits it.
		// - `image/svg+xml` is the one image type that carries script, and no
		//   provider converter accepts it — only `session/blob-store.ts` maps it, for
		//   a local file extension.
		for (const mimeType of [
			"text/html",
			"__proto__",
			"constructor",
			"image/png,text/html",
			"image/png\r\nX-Injected: 1",
			"IMAGE/PNG",
			"image/svg+xml",
		]) {
			const outcome = await promptOutcome(guest, harness, {
				t: "prompt",
				text: "carry me",
				images: [{ type: "image", data: "AAAA", mimeType }],
			});
			if (outcome.kind !== "error") {
				throw new Error(`expected an error reply for ${JSON.stringify(mimeType)}, got ${outcome.kind}`);
			}
			expect(outcome.message).toContain("every image must carry string data and a supported image type");
		}
		expect(harness.prompts).toHaveLength(0);

		// The accept side, so the guard is pinned as an allowlist and not as a ban on
		// the rows above. `image/jpg` is in it because `providers/anthropic.ts` reads
		// it as a spelling of `image/jpeg` and `providers/amazon-bedrock.ts` takes it
		// outright; `EXT_BY_MIME` does not have it, which costs a `.bin` extension on
		// a broker blob and nothing else.
		for (const mimeType of ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"]) {
			const delivered = harness.nextPrompt();
			guest.socket.send({
				t: "prompt",
				text: "carry me",
				images: [{ type: "image", data: "AAAA", mimeType }],
			} as unknown as CollabFrame);
			await Promise.race([delivered, Bun.sleep(1_000)]);
		}
		expect(harness.prompts).toHaveLength(5);
		expect(harness.prompts.map(prompt => (prompt.content as { mimeType?: string }[])[1]?.mimeType)).toEqual([
			"image/jpeg",
			"image/jpg",
			"image/png",
			"image/gif",
			"image/webp",
		]);
	});

	it("strips an image property it does not know instead of carrying it into the session", async () => {
		const guest = await joinAsGuest(host.link, "unknown-prop");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		// Tolerating an unknown property was reasoned as safe because such a field is
		// read and dropped. It is not: the image goes into a session message, is
		// persisted, and is handed to shrinkForReplication, which measures it with
		// `JSON.stringify` before walking it — both recurse, so a deep value can take
		// either step down, and which one it reaches first is a property of the
		// runtime rather than of the payload.
		//
		// Sent past `CollabSocket.send` deliberately, and the reason is structural
		// rather than a matter of thresholds. `JSON.stringify` and `shrinkWalk` both
		// recurse, so both are bounded by the stack; where each gives out, and which
		// gives out first, depends on the runtime and its stack budget and has
		// measured differently on different machines. `JSON.parse` does not recurse.
		// That asymmetry is the durable part and the numbers are not: a client that
		// serializes with this library cannot build a payload the host's own walk
		// will refuse, and one that emits bytes directly can. This builds the frame
		// the way the second client would.
		const depth = 100_000;
		const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
		const raw = `{"t":"prompt","text":"carry me","images":[{"type":"image","data":"AAAA","mimeType":"image/png","somethingNewer":${nested}}]}`;
		const delivered = harness.nextPrompt();
		await sendRawFrame(raw);
		await Promise.race([delivered, Bun.sleep(2_000)]);

		// Delivered — the image is still the guest's — carrying only the fields
		// ImageContent declares. Exact keys, not a shape check: a rebuild that spread
		// the original would still satisfy `toEqual` on the declared ones.
		expect(harness.prompts).toHaveLength(1);
		const stored = harness.prompts[0]?.content as Record<string, unknown>[];
		expect(Object.keys(stored?.[1] ?? {}).sort()).toEqual(["data", "mimeType", "type"]);
		expect(stored?.[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
	});
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
	for (const kind of ["advisor", "sub"] as const) {
		it(`${kind === "advisor" ? "denies" : "serves"} ${kind} transcripts requested by a view-link guest`, async () => {
			await using dir = await TempDir.create("@pi-collab-transcript-");
			const id = `transcript-${kind}-${crypto.randomUUID()}`;
			const text = `${JSON.stringify({ type: "message", content: id })}\n`;
			const file = dir.join("session.jsonl");
			await Bun.write(file, text);
			const registry = AgentRegistry.global();
			const ref = registry.register({ id, displayName: id, kind, session: null, sessionFile: file });
			try {
				const guest = await joinAsGuest(host.viewLink, `reader-${kind}`);
				guestCleanups.push(() => guest.socket.close());
				const welcome = await guest.nextFrame();
				if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
				guest.socket.send({ t: "fetch-transcript", reqId: 1, agentId: id, fromByte: 0 });
				const reply = await guest.nextFrame();
				if (reply.t !== "transcript") throw new Error(`expected transcript, got ${reply.t}`);
				if (kind === "advisor") {
					expect(reply.text).not.toContain(id);
					expect(reply).toMatchObject({ reqId: 1, text: "", newSize: 0, error: "no transcript available" });
				} else {
					expect(reply).toEqual({ t: "transcript", reqId: 1, text, newSize: Buffer.byteLength(text) });
				}
			} finally {
				registry.unregister(id, ref);
			}
		});
	}

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

		// The message, not merely that one arrived: an unregistered id errors on the
		// unknown-agent branch whether or not admission rejected it first, so
		// `t === "error"` alone proves nothing about the guard under test.
		guest.socket.send({ t: "agent-cmd", cmd: "kill", agentId: "nope" });
		const cmdReply = await guest.nextFrame();
		if (cmdReply.t !== "error") throw new Error(`expected error, got ${cmdReply.t}`);
		expect(cmdReply.message).toContain("agent control is disabled on a read-only link");

		// Answering an ask is the fourth mutating frame. The guard has always been
		// there; what was missing is a test that fails if it goes.
		guest.socket.send({ t: "ui-response", reqId: 1, value: "yes" });
		const uiReply = await guest.nextFrame();
		if (uiReply.t !== "error") throw new Error(`expected error, got ${uiReply.t}`);
		expect(uiReply.message).toContain("responding to ask is disabled on a read-only link");

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
