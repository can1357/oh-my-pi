/**
 * Contract: the CollabHost wires its lifetime to the local host registry
 * (#6099). It publishes exactly once — and only after the relay connection
 * succeeds — withdraws on every teardown path (explicit stop, session switch,
 * terminal relay close), keeps hosting when publication fails, and guests
 * joining through the relay never add a registry entry.
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
	subscribed: ((event: { type: string; [k: string]: unknown }) => void) | null;
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
		subscribed: null,
	};
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => state.sessionId,
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
	publishSpy = spyOn(registry, "publishCollabHost").mockImplementation(provider => real(provider, { dir: tmp }));
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
	it("publishes exactly one host only after the relay connection succeeds", async () => {
		const { ctx, state } = makeHostContext();
		host = new CollabHost(ctx);

		// Constructing the host publishes nothing; the registry is empty.
		expect(publishSpy).toHaveBeenCalledTimes(0);
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);

		await host.start(RELAY_URL, WEB_URL);

		// Sanity: the spy on the same module host.ts resolves was actually hit,
		// exactly once, by the host after the relay connected.
		expect(publishSpy).toHaveBeenCalledTimes(1);

		const write = await registry.listCollabHosts({ dir: tmp });
		expect(write).toHaveLength(1);
		expect(write[0]!.mode).toBe("write");
		expect(write[0]!.url).toBe(host.webLink);
		expect(write[0]!.sessionId).toBe(state.sessionId);
		expect(write[0]!.participants).toBeGreaterThanOrEqual(1);

		// A view-mode query gets the read-only URL, never the write link.
		const view = await registry.listCollabHosts({ dir: tmp, mode: "view" });
		expect(view).toHaveLength(1);
		expect(view[0]!.mode).toBe("view");
		expect(view[0]!.url).toBe(host.webViewLink);
	});

	it("withdraws from the registry on explicit stop", async () => {
		const { ctx } = makeHostContext();
		host = new CollabHost(ctx);
		await host.start(RELAY_URL, WEB_URL);
		expect(await registry.listCollabHosts({ dir: tmp })).toHaveLength(1);

		await host.stop("host stopped");

		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("withdraws when the underlying session is switched out", async () => {
		const { ctx, state } = makeHostContext();
		host = new CollabHost(ctx);
		await host.start(RELAY_URL, WEB_URL);
		expect(await registry.listCollabHosts({ dir: tmp })).toHaveLength(1);
		if (!state.subscribed) throw new Error("host never subscribed to session events");

		// The active session changed; the next broadcast detects the mismatch
		// and tears the host down.
		state.sessionId = `sess-switched-${Date.now()}`;
		state.subscribed({ type: "notice", level: "info", message: "switched", source: "test" });

		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("withdraws on the next discovery query when the session switched while idle", async () => {
		const { ctx, state } = makeHostContext();
		host = new CollabHost(ctx);
		await host.start(RELAY_URL, WEB_URL);
		expect(await registry.listCollabHosts({ dir: tmp })).toHaveLength(1);

		// No broadcast happens after the switch (idle host, e.g. /resume): the
		// stale room must not be served to `omp collab list`, and the query
		// itself triggers withdrawal.
		state.sessionId = `sess-idle-switched-${Date.now()}`;

		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
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
