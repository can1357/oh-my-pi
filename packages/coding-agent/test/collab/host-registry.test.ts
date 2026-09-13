/**
 * Contract: the CollabHost wires its lifetime to the local host registry
 * (#6099). It publishes exactly once — and only after the relay connection
 * succeeds — serves metadata without links, hands out a link only for its
 * current generation and published access, withdraws on every teardown path
 * (explicit stop, terminal relay close), suspends without withdrawing while
 * another session is provisionally active, keeps hosting when publication
 * fails, and guests joining through the relay never add an entry.
 *
 * The in-memory relay harness (./helpers/in-memory-relay) replaces the real
 * WebSocket so a real CollabHost/CollabSocket run unchanged; a per-test spy on
 * the `publishCollabHost` export redirects discovery metadata into a temp dir,
 * so the registry's real Unix-socket IPC is exercised without touching ~/.omp.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const RELAY_URL = "ws://localhost:8788";
const WEB_URL = "https://collab.example";

/** Mutable, observable surface of a host context fixture. */
interface HostContextState {
	sessionId: string;
	showStatus: string[];
	/** Guest prompts the host forwarded into the session. */
	prompts: string[];
	subscribed: ((event: { type: string; [k: string]: unknown }) => void) | null;
	/** Invoked on every `getSessionId()` read, i.e. each time the host checks the session it mirrors. */
	onSessionIdRead: (() => void) | undefined;
	/** Resolves when the host clears its status-line segment, i.e. tore down. */
	tornDown: PromiseWithResolvers<void>;
}

/**
 * Minimal InteractiveModeContext the host needs to `start()` and serve a
 * registry snapshot, plus the handles a test drives: the mutable session id,
 * captured `showStatus` messages, and the session-event subscriber callback.
 */
function makeHostContext(): { ctx: InteractiveModeContext; state: HostContextState } {
	const state: HostContextState = {
		sessionId: `sess-${crypto.randomUUID()}`,
		showStatus: [],
		prompts: [],
		subscribed: null,
		onSessionIdRead: undefined,
		tornDown: Promise.withResolvers<void>(),
	};
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => {
				state.onSessionIdRead?.();
				return state.sessionId;
			},
			getCwd: () => "/tmp/collab-registry-test",
			snapshotForReplication: () => ({
				header: {
					type: "session",
					id: state.sessionId,
					timestamp: "2026-07-20T00:00:00Z",
					cwd: "/tmp/collab-registry-test",
				},
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "registry-test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: (cb: HostContextState["subscribed"]) => {
				state.subscribed = cb;
				return () => {};
			},
			emitNotice: () => {},
			promptCustomMessage: (message: { content: unknown }) => {
				state.prompts.push(String(message.content));
				return Promise.resolve();
			},
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: (status: unknown) => {
				if (status === null) state.tornDown.resolve();
			},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: (message: string) => {
			state.showStatus.push(message);
		},
		collabHost: undefined,
	};
	return { ctx: ctx as unknown as InteractiveModeContext, state };
}

let tmp: string;
let publishSpy: Mock<typeof registry.publishCollabHost>;
let capturedSockets: FakeWebSocket[] = [];
let host: CollabHost | undefined;
const guestCleanups: (() => void)[] = [];

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hostreg-"));
	installInMemoryRelay();
	// Record every fake socket the host/guests construct so a test can drive a
	// terminal close on the host's transport directly.
	capturedSockets = [];
	const Capturing = class extends FakeWebSocket {
		constructor(url: string) {
			super(url);
			capturedSockets.push(this);
		}
	};
	globalThis.WebSocket = Capturing as unknown as typeof WebSocket;
	// Redirect publication into the temp dir. Captured before the spy so the
	// implementation calls the genuine registry (real Unix-socket IPC).
	const real = registry.publishCollabHost;
	publishSpy = spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
		real(source, { ...options, dir: tmp }),
	);
	host = undefined;
});

afterEach(async () => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	if (host) await host.stop("test cleanup").catch(() => {});
	uninstallInMemoryRelay();
	publishSpy?.mockRestore();
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("collab host registry lifecycle (#6099)", () => {
	it("publishes metadata after the relay connects and hands out links per access", async () => {
		const { ctx, state } = makeHostContext();
		host = new CollabHost(ctx, { instanceId: "host-under-test", generation: 3, access: "control" });

		// Constructing the host publishes nothing; the registry is empty.
		expect(publishSpy).toHaveBeenCalledTimes(0);
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);

		await host.start(RELAY_URL, WEB_URL);

		// Sanity: the spy on the same module host.ts resolves was actually hit,
		// exactly once, by the host after the relay connected.
		expect(publishSpy).toHaveBeenCalledTimes(1);

		const hosts = await registry.listCollabHosts({ dir: tmp });
		expect(hosts).toHaveLength(1);
		const [snapshot] = hosts;
		expect(snapshot).toMatchObject({
			instanceId: "host-under-test",
			generation: 3,
			pid: process.pid,
			sessionId: state.sessionId,
			access: "control",
			relayConnected: true,
			inputRequired: false,
		});
		expect(snapshot!.participants).toBeGreaterThanOrEqual(1);
		// A listing never carries a link in any field.
		expect(JSON.stringify(snapshot)).not.toContain(WEB_URL);

		// Links come only from an explicit, generation-bound request.
		const control = await registry.resolveCollabHostLink("host-under-test", "control", { dir: tmp });
		expect(control).toEqual({ instanceId: "host-under-test", generation: 3, access: "control", url: host.webLink });
		const view = await registry.resolveCollabHostLink("host-under-test", "view", { dir: tmp });
		expect(view.url).toBe(host.webViewLink);
	});

	it("refuses a control link for a room published with view access", async () => {
		const { ctx } = makeHostContext();
		host = new CollabHost(ctx, { instanceId: "view-only-host", access: "view" });
		await host.start(RELAY_URL, WEB_URL);

		const [snapshot] = await registry.listCollabHosts({ dir: tmp });
		expect(snapshot!.access).toBe("view");
		await expect(registry.resolveCollabHostLink("view-only-host", "control", { dir: tmp })).rejects.toMatchObject({
			code: "access_unavailable",
		});
		const view = await registry.resolveCollabHostLink("view-only-host", "view", { dir: tmp });
		expect(view.url).toBe(host.webViewLink);
	});

	it("reports inputRequired while a guest UI request is retained", async () => {
		const { ctx } = makeHostContext();
		host = new CollabHost(ctx, { instanceId: "attention-host" });
		await host.start(RELAY_URL, WEB_URL);

		const abort = new AbortController();
		const pending = host.requestGuestUi(
			{ kind: "select", title: "Deploy?", options: [{ label: "Yes" }, { label: "No" }] },
			abort.signal,
		);
		if (!pending) throw new Error("host refused the guest UI request");
		expect((await registry.listCollabHosts({ dir: tmp }))[0]!.inputRequired).toBe(true);

		abort.abort();
		expect(await pending).toEqual({ kind: "unavailable" });
		expect((await registry.listCollabHosts({ dir: tmp }))[0]!.inputRequired).toBe(false);
	});

	it("retains a guest UI request raised before the relay connects", async () => {
		const { ctx } = makeHostContext();
		host = new CollabHost(ctx);
		const started = host.start(RELAY_URL, WEB_URL);
		// Issued synchronously after start(): the relay socket does not exist yet.
		const pending = host.requestGuestUi({
			kind: "select",
			title: "Early question",
			options: [{ label: "Yes" }, { label: "No" }],
		});
		if (!pending) throw new Error("host dropped a request raised during startup");
		await started;

		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
		guestCleanups.push(() => socket.close());
		const replayed = Promise.withResolvers<number>();
		socket.onFrame = frame => {
			if (frame.t === "ui-request") replayed.resolve(frame.request.reqId);
		};
		socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "writer", writeToken });
		socket.connect();

		// The first writer to join receives the retained question and can answer it.
		const reqId = await replayed.promise;
		socket.send({ t: "ui-response", reqId, value: "Yes" });
		expect(await pending).toEqual({ kind: "answered", value: "Yes" });
	});

	it("withdraws from the registry on explicit stop", async () => {
		const { ctx } = makeHostContext();
		host = new CollabHost(ctx);
		await host.start(RELAY_URL, WEB_URL);
		expect(await registry.listCollabHosts({ dir: tmp })).toHaveLength(1);

		await host.stop("host stopped");

		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("suspends mirroring and discovery while another session is active and resumes when the switch rolls back", async () => {
		const { ctx, state } = makeHostContext();
		host = new CollabHost(ctx);
		await host.start(RELAY_URL, WEB_URL);
		const original = state.sessionId;
		if (!state.subscribed) throw new Error("host never subscribed to session events");
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(parsed.key);

		// A guest already in the room records every notice it is shown.
		const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		guestCleanups.push(() => guest.close());
		const welcomed = Promise.withResolvers<void>();
		const seen: string[] = [];
		const restored = Promise.withResolvers<void>();
		guest.onFrame = frame => {
			if (frame.t === "welcome") welcomed.resolve();
			if (frame.t === "event" && frame.event.type === "notice") {
				seen.push(frame.event.message);
				if (frame.event.message === "restored") restored.resolve();
			}
		};
		guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "viewer" });
		guest.connect();
		await welcomed.promise;

		// `switchSession()` adopted the target id but has not committed: whatever
		// the other session emits stays out of this room, and the room is not
		// listed — yet its entry is left in place and the room is not ended.
		state.sessionId = `sess-provisional-${Date.now()}`;
		state.subscribed({ type: "notice", level: "info", message: "from the other session", source: "test" });
		expect(host.requestGuestUi({ kind: "select", title: "Other session's hook", options: ["Yes"] })).toBeNull();
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		expect((await fs.readdir(tmp)).filter(name => name.endsWith(".json"))).toHaveLength(1);
		expect(host.stopped).toBe(false);

		// The switch failed and the previous id was restored without any
		// callback: the room is current again, mirrors again, and is listed again.
		state.sessionId = original;
		state.subscribed({ type: "notice", level: "info", message: "restored", source: "test" });
		await restored.promise;
		expect(seen).toEqual(["restored"]);
		const pending = host.requestGuestUi({ kind: "select", title: "After rollback", options: ["Yes"] });
		expect(pending).not.toBeNull();
		expect((await registry.listCollabHosts({ dir: tmp })).map(h => h.sessionId)).toEqual([original]);
	});

	it("never welcomes a guest while another session is active, and welcomes one after the switch rolls back", async () => {
		const { ctx, state } = makeHostContext();
		host = new CollabHost(ctx);
		await host.start(RELAY_URL, WEB_URL);
		const original = state.sessionId;
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(parsed.key);
		const join = (name: string): { welcomed: Promise<void>; saw: () => boolean } => {
			const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
			guestCleanups.push(() => socket.close());
			let welcomed = false;
			const done = Promise.withResolvers<void>();
			socket.onFrame = frame => {
				if (frame.t === "welcome") {
					welcomed = true;
					done.resolve();
				}
			};
			socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name });
			socket.connect();
			return { welcomed: done.promise, saw: () => welcomed };
		};

		// A guest holding the old link joins during the uncommitted switch: a
		// welcome would snapshot the *other* session, so none is sent. The
		// host's check of the session id is the moment its hello was refused.
		state.sessionId = `sess-provisional-${Date.now()}`;
		const helloRefused = Promise.withResolvers<void>();
		state.onSessionIdRead = () => helloRefused.resolve();
		const early = join("early-guest");
		await helloRefused.promise;
		state.onSessionIdRead = undefined;

		// After the rollback the room serves joins again.
		state.sessionId = original;
		const late = join("late-guest");
		await late.welcomed;
		expect(early.saw()).toBe(false);
		expect(late.saw()).toBe(true);
	});

	it("refuses guest actions from the moment stop() begins, while the goodbye is still draining", async () => {
		const { ctx, state } = makeHostContext();
		host = new CollabHost(ctx);
		await host.start(RELAY_URL, WEB_URL);
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const writer = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
		guestCleanups.push(() => writer.close());
		const welcomed = Promise.withResolvers<void>();
		writer.onFrame = frame => {
			if (frame.t === "welcome") welcomed.resolve();
		};
		writer.onOpen = () => writer.send({ t: "hello", proto: COLLAB_PROTO, name: "writer", writeToken });
		writer.connect();
		await welcomed.promise;

		// Hold the goodbye drain open: stop() has begun but has not torn the
		// room down, and the relay socket is still up — the window under test.
		const drain = Promise.withResolvers<void>();
		let hostSocket: CollabSocket | undefined;
		const flush = spyOn(CollabSocket.prototype, "flush").mockImplementation(function (this: CollabSocket) {
			hostSocket = this;
			return drain.promise;
		});
		const stopping = host.stop("host stopped");
		if (!hostSocket) throw new Error("stop() did not reach the goodbye flush");
		const handled = Promise.withResolvers<void>();
		const deliver = hostSocket.onFrame;
		hostSocket.onFrame = (frame, fromPeer) => {
			deliver?.(frame, fromPeer);
			if (frame.t === "prompt") handled.resolve();
		};

		// A writable guest prompts inside that window: the host must not forward it.
		writer.send({ t: "prompt", text: "after stop began" });
		await handled.promise;
		flush.mockRestore();
		drain.resolve();
		await stopping;

		expect(state.prompts).toEqual([]);
		expect(host.stopped).toBe(true);
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("withdraws on a terminal (non-reconnecting) relay close", async () => {
		const { ctx } = makeHostContext();
		host = new CollabHost(ctx);
		await host.start(RELAY_URL, WEB_URL);
		expect(await registry.listCollabHosts({ dir: tmp })).toHaveLength(1);

		const hostSocket = capturedSockets.find(s => s.role === "host");
		if (!hostSocket) throw new Error("host transport socket was never created");
		// Code 4001 ("room closed") is classified fatal/non-reconnecting by
		// relay-client, so the host tears down instead of retrying.
		hostSocket.onclose?.({ code: 4001, reason: "room closed" });

		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("withdraws a publication that completes after a fatal relay close during startup", async () => {
		const { ctx } = makeHostContext();
		// Hold publication open so the relay can die while start() awaits it;
		// `publishing` resolves once the host actually entered that await.
		const redirected = publishSpy.getMockImplementation();
		if (!redirected) throw new Error("publish spy has no implementation");
		const publishing = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		publishSpy.mockImplementation(async provider => {
			publishing.resolve();
			await gate.promise;
			return redirected(provider);
		});
		host = new CollabHost(ctx);
		const started = host.start(RELAY_URL, WEB_URL);
		await publishing.promise;

		const hostSocket = capturedSockets.find(s => s.role === "host");
		if (!hostSocket) throw new Error("host transport socket was never created");
		hostSocket.onclose?.({ code: 4001, reason: "room closed" });
		gate.resolve();

		// Startup fails instead of handing back a dead host, and the late
		// publication is withdrawn rather than left discoverable.
		await expect(started).rejects.toThrow(/closed during startup/);
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("stop() resolves only after a publication still in flight has been withdrawn", async () => {
		const { ctx, state } = makeHostContext();
		// Model production timing: the room is stopped (session switch) while the
		// registry work is still ahead of it. The gate opens from the host's own
		// teardown, so publication completes strictly after the room ended.
		const redirected = publishSpy.getMockImplementation();
		if (!redirected) throw new Error("publish spy has no implementation");
		const events: string[] = [];
		const publishing = Promise.withResolvers<void>();
		publishSpy.mockImplementation(async (source, options) => {
			publishing.resolve();
			await state.tornDown.promise;
			const publication = await redirected(source, options);
			const close = publication.close.bind(publication);
			publication.close = () => {
				// close() is idempotent and both teardown and the aborted start call it.
				if (!events.includes("withdrawn")) events.push("withdrawn");
				return close();
			};
			return publication;
		});
		host = new CollabHost(ctx, { instanceId: "reused-endpoint" });
		const started = host.start(RELAY_URL, WEB_URL);
		await publishing.promise;

		await host.stop("session switched").then(() => events.push("stopped"));
		await started.catch(() => {});

		// The successor room (same instance id, same endpoint path) can only be
		// started safely if the withdrawal happened before stop() resolved.
		expect(events).toEqual(["withdrawn", "stopped"]);
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		const successor = new CollabHost(ctx, { instanceId: "reused-endpoint", generation: 2 });
		await successor.start(RELAY_URL, WEB_URL);
		expect((await registry.listCollabHosts({ dir: tmp })).map(h => h.generation)).toEqual([2]);
		await successor.stop("done");
	});

	it("keeps hosting when publication fails, surfacing a discovery warning", async () => {
		const { ctx, state } = makeHostContext();
		// Publication rejects; start() must still resolve and hosting continue.
		publishSpy.mockImplementation(() => Promise.reject(new Error("registry write failed")));
		host = new CollabHost(ctx);

		await host.start(RELAY_URL, WEB_URL);

		expect(host.link.length).toBeGreaterThan(0);
		expect(host.webLink.length).toBeGreaterThan(0);
		expect(host.participants.length).toBeGreaterThanOrEqual(1);
		// The failure is surfaced to the user via the fixture-observable seam.
		expect(state.showStatus.some(m => /discovery unavailable/i.test(m))).toBe(true);

		// Teardown is still clean even though nothing was published.
		await host.stop("done");
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("never publishes for guests joining through the relay", async () => {
		const { ctx } = makeHostContext();
		host = new CollabHost(ctx);
		await host.start(RELAY_URL, WEB_URL);

		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const key = await importRoomKey(parsed.key);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		guestCleanups.push(() => socket.close());

		const joined = Promise.withResolvers<void>();
		socket.onFrame = frame => {
			if (frame.t === "welcome") joined.resolve();
		};
		socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "guest", writeToken });
		socket.connect();
		await joined.promise;

		// The guest is a real relay peer, but joining published nothing extra:
		// only the host's single entry exists.
		expect(host.participants.length).toBeGreaterThanOrEqual(2);
		expect(publishSpy).toHaveBeenCalledTimes(1);
		const jsonFiles = (await fs.readdir(tmp)).filter(name => name.endsWith(".json"));
		expect(jsonFiles).toHaveLength(1);
	});
});
