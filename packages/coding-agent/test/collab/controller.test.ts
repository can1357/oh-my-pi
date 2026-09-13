/**
 * Contract: `CollabController` owns hosting for one interactive process.
 * `collab.autoStart` installs a room before extension hooks run and retains
 * dialogs raised before the relay connects; the registry sees one entry per
 * process keyed by a stable instance ID with an increasing generation; a
 * session switch revokes the old room before its successor is published; and
 * the published access level caps what `omp collab link` can obtain.
 *
 * Real CollabHost/CollabSocket run over the in-memory relay; the registry's
 * real Unix-socket IPC is redirected into a temp dir via a spy on
 * `publishCollabHost`, exactly as in host-registry.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CollabController } from "@oh-my-pi/pi-coding-agent/collab/controller";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import type { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const RELAY_URL = "ws://localhost:8788";
const WEB_URL = "https://collab.example";

interface ControllerContextState {
	sessionId: string;
	autoStart: "off" | "view" | "control";
	relayUrl: string;
	showStatus: string[];
	/** Resolves with the first status message the controller shows. */
	firstStatus: PromiseWithResolvers<string>;
	/** Session-change callbacks registered by the controller under test. */
	sessionChangeCallbacks: Set<() => void>;
	/** Resolves each time a host clears its status-line segment (tore down). */
	tornDown: (() => void)[];
}

/**
 * Minimal InteractiveModeContext for a controller: settings, the mutable
 * session identity, the session-change subscription, and the observable
 * seams (status messages, status-line collab segment).
 */
function makeControllerContext(over: Partial<Pick<ControllerContextState, "autoStart" | "relayUrl">> = {}): {
	ctx: InteractiveModeContext;
	state: ControllerContextState;
} {
	const state: ControllerContextState = {
		sessionId: `sess-${crypto.randomUUID()}`,
		autoStart: over.autoStart ?? "off",
		relayUrl: over.relayUrl ?? RELAY_URL,
		showStatus: [],
		firstStatus: Promise.withResolvers<string>(),
		sessionChangeCallbacks: new Set(),
		tornDown: [],
	};
	const settingValues = (): Record<string, string> => ({
		"collab.autoStart": state.autoStart,
		"collab.relayUrl": state.relayUrl,
		"collab.webUrl": WEB_URL,
	});
	const ctx = {
		settings: { get: (key: string) => settingValues()[key] ?? "" },
		sessionManager: {
			getSessionId: () => state.sessionId,
			getCwd: () => "/tmp/collab-controller-test",
			snapshotForReplication: () => ({
				header: {
					type: "session",
					id: state.sessionId,
					timestamp: "2026-07-20T00:00:00Z",
					cwd: "/tmp/collab-controller-test",
				},
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "controller-test",
			model: { provider: "test-provider", id: "test-model" },
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
			registerSessionChangeCallback: (cb: () => void) => {
				state.sessionChangeCallbacks.add(cb);
				return () => state.sessionChangeCallbacks.delete(cb);
			},
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: (status: unknown) => {
				if (status === null) state.tornDown.shift()?.();
			},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: (message: string) => {
			state.showStatus.push(message);
			state.firstStatus.resolve(message);
		},
		collabHost: undefined,
	};
	return { ctx: ctx as unknown as InteractiveModeContext, state };
}

/** Simulate AgentSession adopting a new session id: mutate, then notify. */
function switchSession(state: ControllerContextState, sessionId: string): void {
	state.sessionId = sessionId;
	for (const cb of state.sessionChangeCallbacks) cb();
}

/** Join `host`'s room through the relay as a writer; resolves after `welcome`. */
async function joinAsWriter(host: CollabHost, onFrame?: (frame: CollabFrame) => void) {
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	guestCleanups.push(() => socket.close());
	const welcomed = Promise.withResolvers<void>();
	socket.onFrame = frame => {
		if (frame.t === "welcome") welcomed.resolve();
		onFrame?.(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "writer", writeToken });
	socket.connect();
	await welcomed.promise;
	return socket;
}

/**
 * Resolves once the controller's background start has published `calls`
 * times and every publication finished. The spy implementation wakes waiters
 * on each call, so this awaits the real event rather than spinning.
 */
async function settled(publishSpy: Mock<typeof registry.publishCollabHost>, calls: number): Promise<void> {
	while (publishSpy.mock.calls.length < calls) {
		const waiter = Promise.withResolvers<void>();
		publishWaiters.push(waiter.resolve);
		await waiter.promise;
	}
	await Promise.all(publishSpy.mock.results.map(result => result.value));
}

let tmp: string;
let publishSpy: Mock<typeof registry.publishCollabHost>;
let controller: CollabController | undefined;
const guestCleanups: (() => void)[] = [];
const publishWaiters: (() => void)[] = [];
let capturedSockets: FakeWebSocket[] = [];

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collabctl-"));
	installInMemoryRelay();
	// Record every fake socket so a test can drive a terminal close on the host's transport.
	capturedSockets = [];
	const Capturing = class extends FakeWebSocket {
		constructor(url: string) {
			super(url);
			capturedSockets.push(this);
		}
	};
	globalThis.WebSocket = Capturing as unknown as typeof WebSocket;
	const real = registry.publishCollabHost;
	publishSpy = spyOn(registry, "publishCollabHost").mockImplementation((source, options) => {
		const publication = real(source, { ...options, dir: tmp });
		for (const wake of publishWaiters.splice(0)) wake();
		return publication;
	});
	controller = undefined;
});

afterEach(async () => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	await controller?.shutdown("test cleanup").catch(() => {});
	uninstallInMemoryRelay();
	publishSpy?.mockRestore();
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("CollabController", () => {
	it("auto-start installs the room synchronously and retains an early dialog for the first writer", async () => {
		const { ctx } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);

		controller.autoStart();

		// Before any await: the host exists and accepts a mirrored dialog even
		// though the relay socket has not been created yet.
		const host = ctx.collabHost;
		if (!host) throw new Error("auto-start did not install a host synchronously");
		const pending = host.requestGuestUi({ kind: "select", title: "From session_start", options: ["Yes", "No"] });
		if (!pending) throw new Error("host dropped a dialog raised before the relay connected");

		await settled(publishSpy, 1);
		const [snapshot] = await registry.listCollabHosts({ dir: tmp });
		expect(snapshot).toMatchObject({
			instanceId: controller.instanceId,
			generation: 1,
			access: "control",
			inputRequired: true,
			model: { provider: "test-provider", id: "test-model" },
		});

		const replayed = Promise.withResolvers<number>();
		const socket = await joinAsWriter(host, frame => {
			if (frame.t === "ui-request") replayed.resolve(frame.request.reqId);
		});
		socket.send({ t: "ui-response", reqId: await replayed.promise, value: "Yes" });
		expect(await pending).toEqual({ kind: "answered", value: "Yes" });
	});

	it("auto-start off leaves the session unhosted and reports nothing", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "off" });
		controller = new CollabController(ctx);

		controller.autoStart();
		await controller.shutdown("done");

		expect(ctx.collabHost).toBeUndefined();
		expect(publishSpy).toHaveBeenCalledTimes(0);
		expect(state.showStatus).toEqual([]);
	});

	it("reports an auto-start failure without throwing into startup", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control", relayUrl: "" });
		controller = new CollabController(ctx);

		expect(() => controller!.autoStart()).not.toThrow();

		expect(await state.firstStatus.promise).toMatch(/auto-start failed: No relay configured/);
		expect(ctx.collabHost).toBeUndefined();
	});

	it("revokes the old room before publishing the next generation on a session switch", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await settled(publishSpy, 1);
		const first = ctx.collabHost;
		if (!first) throw new Error("first room missing");
		const goodbye = Promise.withResolvers<string>();
		await joinAsWriter(first, frame => {
			if (frame.t === "bye") goodbye.resolve(frame.reason);
		});

		// Record the old room's state at the moment the successor publishes.
		let firstStoppedWhenSecondPublished: boolean | undefined;
		const redirected = publishSpy.getMockImplementation();
		if (!redirected) throw new Error("publish spy has no implementation");
		publishSpy.mockImplementation((source, options) => {
			firstStoppedWhenSecondPublished = first.stopped;
			return redirected(source, options);
		});
		// `redirected` is the wrapped beforeEach implementation, so waiters still wake.

		switchSession(state, `sess-next-${crypto.randomUUID()}`);
		await settled(publishSpy, 2);

		expect(firstStoppedWhenSecondPublished).toBe(true);
		// The writer in the old room was told explicitly, not left to time out.
		expect(await goodbye.promise).toBe("session switched");
		const second = ctx.collabHost;
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		const hosts = await registry.listCollabHosts({ dir: tmp });
		expect(hosts).toHaveLength(1);
		expect(hosts[0]).toMatchObject({ instanceId: controller.instanceId, generation: 2, sessionId: state.sessionId });
		// A card that still names generation 1 cannot obtain the new room.
		await expect(
			registry.resolveCollabHostLink(controller.instanceId, "control", { dir: tmp }).then(link => link.generation),
		).resolves.toBe(2);
		expect(second!.webLink).not.toBe(first.webLink);
	});

	it("stops a manually started room on session switch when auto-start is off", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "off" });
		controller = new CollabController(ctx);
		const host = await controller.start({ access: "control" });
		expect(await registry.listCollabHosts({ dir: tmp })).toHaveLength(1);

		switchSession(state, `sess-next-${crypto.randomUUID()}`);
		await controller.shutdown("done");

		expect(host.stopped).toBe(true);
		expect(ctx.collabHost).toBeUndefined();
		expect(publishSpy).toHaveBeenCalledTimes(1);
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("caps registry access at view for auto-start view until control is requested", async () => {
		const { ctx } = makeControllerContext({ autoStart: "view" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await settled(publishSpy, 1);
		const viewRoom = ctx.collabHost;
		if (!viewRoom) throw new Error("view room missing");

		await expect(
			registry.resolveCollabHostLink(controller.instanceId, "control", { dir: tmp }),
		).rejects.toMatchObject({ code: "access_unavailable" });
		expect((await registry.resolveCollabHostLink(controller.instanceId, "view", { dir: tmp })).url).toBe(
			viewRoom.webViewLink,
		);

		// `/collab view` reuses the room; `/collab` (control) replaces it.
		expect(await controller.start({ access: "view" })).toBe(viewRoom);
		const controlRoom = await controller.start({ access: "control" });
		expect(controlRoom).not.toBe(viewRoom);
		expect(viewRoom.stopped).toBe(true);
		const hosts = await registry.listCollabHosts({ dir: tmp });
		expect(hosts).toHaveLength(1);
		expect(hosts[0]).toMatchObject({ generation: 2, access: "control" });
		expect((await registry.resolveCollabHostLink(controller.instanceId, "control", { dir: tmp })).url).toBe(
			controlRoom.webLink,
		);
	});

	it("waits for a room that ended on its own to finish withdrawing before the next room publishes", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		// Hold the first room's publication open after the real registry work, so
		// the endpoint is bound while start() still awaits the result.
		const redirected = publishSpy.getMockImplementation();
		if (!redirected) throw new Error("publish spy has no implementation");
		const firstPublishing = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let gated = false;
		publishSpy.mockImplementation(async (source, options) => {
			const publication = await redirected(source, options);
			if (!gated) {
				gated = true;
				firstPublishing.resolve();
				await gate.promise;
			}
			return publication;
		});
		controller.autoStart();
		const first = ctx.collabHost;
		if (!first) throw new Error("auto-start did not install a host");
		await firstPublishing.promise;

		// The relay closes the room for good: the host tears itself down (nobody
		// awaits that) and its publication is still being withdrawn …
		const hostSocket = capturedSockets.find(s => s.role === "host");
		if (!hostSocket) throw new Error("host transport socket was never created");
		hostSocket.onclose?.({ code: 4001, reason: "room closed" });
		expect(first.stopped).toBe(true);
		// … when the session switches. The successor must not bind the same
		// instance endpoint until that withdrawal completes.
		switchSession(state, `sess-next-${crypto.randomUUID()}`);
		gate.resolve();
		await controller.idle();

		const hosts = await registry.listCollabHosts({ dir: tmp });
		expect(hosts.map(h => ({ generation: h.generation, sessionId: h.sessionId }))).toEqual([
			{ generation: 2, sessionId: state.sessionId },
		]);
		expect(state.showStatus.some(m => /discovery unavailable/.test(m))).toBe(false);
	});

	it("shutdown withdraws the room and ignores later session changes", async () => {
		const { ctx, state } = makeControllerContext({ autoStart: "control" });
		controller = new CollabController(ctx);
		controller.autoStart();
		await settled(publishSpy, 1);

		await controller.shutdown("host exited");
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		expect(ctx.collabHost).toBeUndefined();

		switchSession(state, `sess-after-shutdown-${crypto.randomUUID()}`);
		await controller.shutdown("again");
		expect(publishSpy).toHaveBeenCalledTimes(1);
		expect(ctx.collabHost).toBeUndefined();
	});

	describe("while the relay has not opened yet", () => {
		/** Fake socket that never reaches OPEN: the relay is up but unresponsive. */
		class NeverOpens extends FakeWebSocket {
			constructor(url: string) {
				super(url);
				// The base class opens on a microtask unless the socket already left CONNECTING.
				this.readyState = FakeWebSocket.CLOSING;
			}
		}

		beforeEach(() => {
			globalThis.WebSocket = NeverOpens as unknown as typeof WebSocket;
		});

		it("shutdown aborts the pending start instead of waiting for the connect timeout", async () => {
			const { ctx } = makeControllerContext({ autoStart: "control" });
			controller = new CollabController(ctx);
			controller.autoStart();
			const pending = ctx.collabHost;
			if (!pending) throw new Error("auto-start did not install a host");

			// Bounded by the test timeout: a stall here means shutdown waited on
			// the 15 s relay connect timeout instead of aborting the start.
			await controller.shutdown("host exited");

			expect(pending.stopped).toBe(true);
			expect(ctx.collabHost).toBeUndefined();
			expect(publishSpy).toHaveBeenCalledTimes(0);
		});

		it("a session switch aborts the pending start and installs the new session's room at once", async () => {
			const { ctx, state } = makeControllerContext({ autoStart: "control" });
			controller = new CollabController(ctx);
			controller.autoStart();
			const first = ctx.collabHost;
			if (!first) throw new Error("auto-start did not install a host");
			const firstTornDown = Promise.withResolvers<void>();
			state.tornDown.push(firstTornDown.resolve);

			switchSession(state, `sess-next-${crypto.randomUUID()}`);

			// The stale room ends without waiting for its 15 s connect timeout
			// (bounded by the test timeout) …
			await firstTornDown.promise;
			expect(first.stopped).toBe(true);
			// … and once its stop settles, the successor owns the context, so a
			// dialog raised now is retained by the new session's room. Only
			// microtask hops separate the two; no timer or I/O is involved.
			for (let flush = 0; flush < 10 && ctx.collabHost === undefined; flush++) await Promise.resolve();
			const second = ctx.collabHost;
			expect(second).toBeDefined();
			expect(second).not.toBe(first);
			expect(second!.generation).toBe(2);
			expect(second!.sessionId).toBe(state.sessionId);
		});
	});
});
