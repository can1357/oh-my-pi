/**
 * Contract for programmatic collab hosting: `startCollabHosting` starts (or
 * reuses) the one room a session can host, hands back both link strengths,
 * and never prints a byte of key material anywhere. Also covered: the
 * extension runner's fallback for hosts with no TUI, where collab hosting
 * must refuse loudly instead of half-working.
 *
 * Runs over the same in-memory relay transport as the other collab suites
 * (see ./helpers/in-memory-relay): real CollabSocket, real AES-GCM sealing,
 * real hello to welcome handshake; only the network and the TUI context are
 * stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import {
	activeCollabHostLinks,
	collabHostLinks,
	hasInFlightCollabHosting,
	startCollabHosting,
	stopCollabHosting,
} from "@oh-my-pi/pi-coding-agent/collab/start-hosting";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	ExtensionRuntime,
	ExtensionRuntimeNotInitializedError,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	CollabHostLinks,
	Extension,
	ExtensionActions,
	ExtensionContextActions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionTransitionOutcome } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type InMemoryRelay, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface CtxHarness {
	ctx: InteractiveModeContext;
	/** Every string any presentation surface received, in order. */
	printed: string[];
	collabStatus: () => unknown;
}

/**
 * Minimal InteractiveModeContext double: the members CollabHost touches,
 * plus recording of every presentation call so the key-hygiene test can
 * assert that starting a room prints nothing at all.
 */
function makeCtx(
	options: {
		relayUrl?: string;
		webUrl?: string;
		guest?: boolean;
		extensionRunner?: ExtensionRunner | (() => ExtensionRunner | undefined);
		isSessionTransitionInFlight?: boolean | (() => boolean);
		onTransitionSettledRegistered?: (fire: (outcome: SessionTransitionOutcome) => void) => void;
	} = {},
): CtxHarness {
	const printed: string[] = [];
	const settings: Record<string, string> = {
		"collab.relayUrl": options.relayUrl ?? "",
		"collab.webUrl": options.webUrl ?? "",
	};
	let collabStatus: unknown = null;
	const ctx = {
		settings: { get: (key: string) => settings[key] ?? "" },
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionFile: () => null,
			getSessionName: () => "test",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			get extensionRunner(): ExtensionRunner | undefined {
				return typeof options.extensionRunner === "function" ? options.extensionRunner() : options.extensionRunner;
			},
			get isSessionTransitionInFlight(): boolean {
				if (typeof options.isSessionTransitionInFlight === "function") {
					return options.isSessionTransitionInFlight();
				}
				if (typeof options.isSessionTransitionInFlight === "boolean") {
					return options.isSessionTransitionInFlight;
				}
				return false;
			},
			registerSessionTransitionSettledCallback: (
				callback: (outcome: SessionTransitionOutcome) => void,
			): (() => void) => {
				options.onTransitionSettledRegistered?.(callback);
				return () => {};
			},
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			messages: [],
			switchSession: () => Promise.resolve(true),
			newSession: () => Promise.resolve(),
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: (_level: string, message: string) => printed.push(message),
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: (status: unknown) => {
				collabStatus = status;
			},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: (message: string) => printed.push(message),
		showError: (message: string) => printed.push(message),
		present: () => printed.push("<component>"),
		syncRunningSubagentBadge: () => {},
		resetObserverRegistry: () => {},
		updateEditorBorderColor: () => {},
		renderInitialMessages: () => Promise.resolve(),
		reloadTodos: () => Promise.resolve(),
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		collabHost: undefined,
		collabGuest: options.guest ? {} : undefined,
	} as unknown as InteractiveModeContext;
	return { ctx, printed, collabStatus: () => collabStatus };
}

/** Hosts started by a test, stopped in afterEach so no socket outlives it. */
const startedHosts: CollabHost[] = [];

async function startHosting(ctx: InteractiveModeContext, relayUrl?: string): Promise<CollabHost> {
	const host = await startCollabHosting(ctx, relayUrl === undefined ? {} : { relayUrl });
	startedHosts.push(host);
	return host;
}

/** Frames that interleave nondeterministically with the welcome this suite waits for. */
const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

/** Join with a link the helper produced and wait for the host's welcome. */
async function expectGuestWelcome(link: string): Promise<CollabFrame> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	try {
		const welcome = Promise.withResolvers<CollabFrame>();
		socket.onFrame = frame => {
			if (!FILTERED_FRAME_TYPES[frame.t]) welcome.resolve(frame);
		};
		socket.onOpen = () =>
			socket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: "probe",
				writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
			});
		socket.connect();
		return await welcome.promise;
	} finally {
		socket.close();
	}
}

/**
 * Join, wait for the welcome, then run `append` and resolve with the replicated
 * `entry` frame. Proves replication end to end rather than inspecting the tap:
 * a host that released another host's entry tap never sends this frame.
 */
async function expectGuestReceivesEntry(link: string, append: () => void): Promise<CollabFrame> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	try {
		const welcomed = Promise.withResolvers<void>();
		const replicated = Promise.withResolvers<CollabFrame>();
		socket.onFrame = frame => {
			// `entry` is in FILTERED_FRAME_TYPES for the welcome-only helper above,
			// but it is precisely the frame this one exists to observe.
			if (frame.t === "entry") {
				replicated.resolve(frame);
				return;
			}
			if (!FILTERED_FRAME_TYPES[frame.t]) welcomed.resolve();
		};
		socket.onOpen = () =>
			socket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: "probe",
				writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
			});
		socket.connect();
		await welcomed.promise;
		append();
		return await replicated.promise;
	} finally {
		socket.close();
	}
}

let relay: InMemoryRelay;
let tempDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

/** The actions a print/RPC host wires: every required action, none of the optional collab ones. */
function headlessActions(): ExtensionActions {
	return {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => Promise.resolve(),
		getCommands: () => [],
		setModel: () => Promise.resolve(false),
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		getSessionName: () => undefined,
		setSessionName: () => Promise.resolve(),
	};
}

function headlessContextActions(): ExtensionContextActions {
	return {
		getModel: () => undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => Promise.resolve(),
		getSystemPrompt: () => [],
	};
}

beforeAll(async () => {
	relay = installInMemoryRelay();
	tempDir = TempDir.createSync("@pi-collab-runner-");
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	modelRegistry = new ModelRegistry(authStorage);
});

afterEach(async () => {
	for (const host of startedHosts.splice(0).reverse()) await host.stop("test done");
});

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
	uninstallInMemoryRelay();
});

describe("startCollabHosting", () => {
	it("starts a room and returns both link strengths, usable by a real guest", async () => {
		const { ctx } = makeCtx();
		const host = await startHosting(ctx, "ws://localhost:7475");

		const links = collabHostLinks(host);
		expect(host.relayOrigin).toBe("ws://localhost:7475");
		expect(ctx.collabHost).toBe(host);
		expect(links.link).not.toBe(links.viewLink);

		const full = parseCollabLink(links.link);
		if ("error" in full) throw new Error(full.error);
		expect(full.wsUrl.startsWith("ws://localhost:7475/r/")).toBe(true);
		// The full link carries the 16-byte write token; the view link is the bare room key.
		expect(full.writeToken).toBeDefined();
		const view = parseCollabLink(links.viewLink);
		if ("error" in view) throw new Error(view.error);
		expect(view.writeToken).toBeUndefined();
		expect(view.wsUrl).toBe(full.wsUrl);
		expect(links.webLink.startsWith("http://localhost:7475/#")).toBe(true);

		// The link is not merely well-formed: a guest holding it completes the handshake.
		const welcome = await expectGuestWelcome(links.link);
		expect(welcome.t).toBe("welcome");
	});

	it("returns the existing room when the requested relay matches", async () => {
		const { ctx } = makeCtx();
		const host = await startHosting(ctx, "ws://localhost:7475");
		const again = await startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" });
		expect(again).toBe(host);
		expect(collabHostLinks(again)).toEqual(collabHostLinks(host));
	});

	it("refuses a different relay while hosting and keeps the original room", async () => {
		const { ctx } = makeCtx();
		const host = await startHosting(ctx, "ws://localhost:7475");
		const linkBefore = host.link;
		await expect(startCollabHosting(ctx, { relayUrl: "ws://localhost:9999" })).rejects.toThrow(
			/Already hosting a collab session on relay ws:\/\/localhost:7475/,
		);
		expect(ctx.collabHost).toBe(host);
		expect(host.link).toBe(linkBefore);
	});

	it("refuses while the session is a guest in someone else's room", async () => {
		const { ctx } = makeCtx({ guest: true });
		await expect(startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" })).rejects.toThrow(
			/Already in a collab session as a guest/,
		);
		expect(ctx.collabHost).toBeUndefined();
	});

	it("throws when no relay is configured or passed", async () => {
		const { ctx } = makeCtx();
		await expect(startCollabHosting(ctx)).rejects.toThrow(/No relay configured/);
	});

	it("falls back to the collab.relayUrl setting", async () => {
		const { ctx } = makeCtx({ relayUrl: "ws://localhost:7475" });
		const host = await startHosting(ctx);
		expect(host.relayOrigin).toBe("ws://localhost:7475");
	});

	it("rejects plain ws to a non-localhost relay", async () => {
		const { ctx } = makeCtx();
		await expect(startCollabHosting(ctx, { relayUrl: "ws://relay.example.com" })).rejects.toThrow(
			/relay link must be wss/,
		);
		expect(ctx.collabHost).toBeUndefined();
	});

	it("defaults a scheme-less relay to wss", async () => {
		const { ctx } = makeCtx();
		const host = await startHosting(ctx, "relay.example.com");
		expect(host.relayOrigin).toBe("wss://relay.example.com");
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl.startsWith("wss://relay.example.com/r/")).toBe(true);
	});

	it("prints nothing: no status line, notice, or component carries the room key", async () => {
		const { ctx, printed } = makeCtx();
		const host = await startHosting(ctx, "ws://localhost:7475");
		const full = parseCollabLink(host.link);
		if ("error" in full) throw new Error(full.error);
		// The room id alone would already leak which room to probe; the key is the credential itself.
		expect(printed).toHaveLength(0);
		for (const message of printed) {
			expect(message).not.toContain(full.roomId);
		}
	});

	it("stop clears hosting and a restart mints a fresh room", async () => {
		const { ctx } = makeCtx();
		const first = await startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" });
		startedHosts.push(first);
		const firstParsed = parseCollabLink(first.link);
		if ("error" in firstParsed) throw new Error(firstParsed.error);
		await first.stop("test done");
		expect(ctx.collabHost).toBeUndefined();

		const second = await startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" });
		startedHosts.push(second);
		const secondParsed = parseCollabLink(second.link);
		if ("error" in secondParsed) throw new Error(secondParsed.error);
		expect(secondParsed.roomId).not.toBe(firstParsed.roomId);
	});

	it("concurrent starts against the same relay return the same host and links without opening duplicate rooms", async () => {
		const { ctx } = makeCtx();
		const [first, second] = await Promise.all([
			startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" }),
			startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" }),
		]);
		startedHosts.push(first);
		expect(first).toBe(second);
		expect(first.link).toBe(second.link);
		expect(ctx.collabHost).toBe(first);

		const parsed = parseCollabLink(first.link);
		if ("error" in parsed) throw new Error(parsed.error);

		// Exactly one room is live: a guest can join and complete the handshake.
		const welcome = await expectGuestWelcome(first.link);
		expect(welcome.t).toBe("welcome");
	});

	it("a concurrent start against a different relay rejects with the already-hosting error and leaves the first room intact", async () => {
		const { ctx } = makeCtx();
		const startFirst = startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" });
		const startSecond = startCollabHosting(ctx, { relayUrl: "ws://localhost:9999" });

		const results = await Promise.allSettled([startFirst, startSecond]);
		const [firstResult, secondResult] = results;

		expect(firstResult.status).toBe("fulfilled");
		if (firstResult.status !== "fulfilled") throw new Error("first start failed");

		const host = firstResult.value;
		startedHosts.push(host);

		expect(secondResult.status).toBe("rejected");
		if (secondResult.status !== "rejected") throw new Error("second start should have rejected");
		if (!(secondResult.reason instanceof Error)) throw new Error("second start reason must be an Error");
		expect(secondResult.reason.message).toMatch(
			/Already hosting a collab session on relay ws:\/\/localhost:7475 \(stop it first\)/,
		);
		expect(ctx.collabHost).toBe(host);
		expect(host.relayOrigin).toBe("ws://localhost:7475");
		const welcome = await expectGuestWelcome(host.link);
		expect(welcome.t).toBe("welcome");
	});

	it("stopping a host that is not ctx.collabHost leaves ctx.collabHost pointing at the live host", async () => {
		const { ctx } = makeCtx();
		const liveHost = await startHosting(ctx, "ws://localhost:7475");
		expect(ctx.collabHost).toBe(liveHost);

		const otherHost = new CollabHost(ctx);
		await otherHost.stop("stopped other host");
		expect(ctx.collabHost).toBe(liveHost);
		expect(ctx.collabHost?.relayOrigin).toBe("ws://localhost:7475");

		// A welcome only proves the room still accepts guests. `onEntryAppended`
		// is a single slot on the session manager, so what actually breaks when a
		// stale host clears it is replication of entries appended afterwards.
		const replicated = await expectGuestReceivesEntry(liveHost.link, () => {
			ctx.sessionManager.onEntryAppended?.({
				type: "message",
				id: "after-stale-stop",
				parentId: null,
				timestamp: "2026-06-20T00:00:00Z",
				message: { role: "user", content: "still replicating", timestamp: 0 },
			});
		});
		expect(replicated.t).toBe("entry");
	});

	it("cancels an in-flight start when stopped, leaving no relay socket and no session tap", async () => {
		const { ctx } = makeCtx();
		const startPromise = startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" });
		expect(hasInFlightCollabHosting(ctx)).toBe(true);

		await stopCollabHosting(ctx);
		expect(hasInFlightCollabHosting(ctx)).toBe(false);
		expect(ctx.collabHost).toBeUndefined();

		await expect(startPromise).rejects.toThrow(/Collab hosting was stopped/);
		expect(ctx.collabHost).toBeUndefined();
		// A start cancelled before its key import must never reach the relay
		// and never tap the session: teardown already ran and cannot run again.
		expect(relay.hasHost).toBe(false);
		expect(ctx.sessionManager.onEntryAppended).toBeUndefined();
	});

	it("restarts hosting with a fresh room when the active session changes", async () => {
		let currentSessionId = "sess-1";
		const { ctx } = makeCtx();
		ctx.sessionManager.getSessionId = () => currentSessionId;

		const firstHost = await startHosting(ctx, "ws://localhost:7475");
		expect(firstHost.sessionId).toBe("sess-1");
		expect(ctx.collabHost).toBe(firstHost);
		const firstLink = firstHost.link;

		// Switch session: getSessionId now returns sess-2 while firstHost is still ctx.collabHost
		currentSessionId = "sess-2";

		const secondHost = await startHosting(ctx, "ws://localhost:7475");
		expect(secondHost.sessionId).toBe("sess-2");
		expect(ctx.collabHost).toBe(secondHost);
		expect(secondHost).not.toBe(firstHost);
		expect(secondHost.link).not.toBe(firstLink);

		// Second room is live and usable by guests
		const welcome = await expectGuestWelcome(secondHost.link);
		expect(welcome.t).toBe("welcome");
	});

	it("hands both new-session callers the same room when a session switch cancels an in-flight start", async () => {
		let currentSessionId = "sess-1";
		const { ctx } = makeCtx();
		ctx.sessionManager.getSessionId = () => currentSessionId;

		// A start reserved by the outgoing session, still mid-handshake.
		const stale = startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" });
		expect(hasInFlightCollabHosting(ctx)).toBe(true);
		currentSessionId = "sess-2";

		// Two callbacks in the new session both observe that stale reservation.
		const [first, second] = await Promise.all([
			startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" }),
			startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" }),
		]);
		startedHosts.push(first);

		expect(first).toBe(second);
		expect(first.link).toBe(second.link);
		expect(first.sessionId).toBe("sess-2");
		expect(ctx.collabHost).toBe(first);
		await expect(stale).rejects.toThrow(/Collab hosting was stopped/);
	});

	it("retries with a room bound to the new session when the switch lands during the handshake", async () => {
		let currentSessionId = "sess-1";
		const { ctx } = makeCtx();
		ctx.sessionManager.getSessionId = () => currentSessionId;
		// The switch lands after the room bound its session id and before the
		// start publishes it: the window the handshake await leaves open.
		const realStart = CollabHost.prototype.start;
		const spy = vi.spyOn(CollabHost.prototype, "start").mockImplementation(async function (
			this: CollabHost,
			relayUrl: string,
			webUrl?: string,
		) {
			await realStart.call(this, relayUrl, webUrl);
			currentSessionId = "sess-2";
		});
		try {
			const host = await startHosting(ctx, "ws://localhost:7475");
			expect(host.sessionId).toBe("sess-2");
			expect(ctx.collabHost).toBe(host);
			// The room published is the one a guest can actually reach.
			const welcome = await expectGuestWelcome(host.link);
			expect(welcome.t).toBe("welcome");
		} finally {
			spy.mockRestore();
		}
	});

	it("a stop landing during the superseded teardown wins over the retry", async () => {
		let currentSessionId = "sess-1";
		const { ctx } = makeCtx();
		ctx.sessionManager.getSessionId = () => currentSessionId;

		// Switch the session across the handshake so the post-handshake
		// mismatch branch runs, then park inside its teardown.
		const realStart = CollabHost.prototype.start;
		const startSpy = vi.spyOn(CollabHost.prototype, "start").mockImplementation(async function (
			this: CollabHost,
			relayUrl: string,
			webUrl?: string,
		) {
			await realStart.call(this, relayUrl, webUrl);
			currentSessionId = "sess-2";
		});
		const teardownEntered = Promise.withResolvers<void>();
		const releaseTeardown = Promise.withResolvers<void>();
		const realStop = CollabHost.prototype.stop;
		const stopSpy = vi.spyOn(CollabHost.prototype, "stop").mockImplementation(async function (
			this: CollabHost,
			reason: string,
		) {
			if (reason === "session switched") {
				teardownEntered.resolve();
				await releaseTeardown.promise;
			}
			await realStop.call(this, reason);
		});

		try {
			const startPromise = startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" });
			await teardownEntered.promise;

			const stopping = stopCollabHosting(ctx);
			releaseTeardown.resolve();
			await stopping;

			// Without honouring the cancellation the superseded branch retries,
			// claims a fresh reservation, and publishes a room the stop already
			// concluded did not exist.
			await expect(startPromise).rejects.toThrow(/Collab hosting was stopped/);
			expect(ctx.collabHost).toBeUndefined();
			expect(hasInFlightCollabHosting(ctx)).toBe(false);
			expect(relay.hasHost).toBe(false);
		} finally {
			releaseTeardown.resolve();
			stopSpy.mockRestore();
			startSpy.mockRestore();
		}
	});

	it("refuses to publish a room when a /join won the race during the handshake", async () => {
		const { ctx } = makeCtx();
		const realStart = CollabHost.prototype.start;
		const spy = vi.spyOn(CollabHost.prototype, "start").mockImplementation(async function (
			this: CollabHost,
			relayUrl: string,
			webUrl?: string,
		) {
			await realStart.call(this, relayUrl, webUrl);
			ctx.collabGuest = {} as NonNullable<InteractiveModeContext["collabGuest"]>;
		});
		try {
			await expect(startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" })).rejects.toThrow(
				/Already in a collab session as a guest/,
			);
			expect(ctx.collabHost).toBeUndefined();
			expect(relay.hasHost).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	it("refuses to publish a room when a session transition began during the handshake", async () => {
		// The transition has not committed its id yet, so `getSessionId()` still
		// reads the outgoing one and the mismatch check below cannot see it.
		let transitioning = false;
		const { ctx } = makeCtx({ isSessionTransitionInFlight: () => transitioning });
		const realStart = CollabHost.prototype.start;
		const spy = vi.spyOn(CollabHost.prototype, "start").mockImplementation(async function (
			this: CollabHost,
			relayUrl: string,
			webUrl?: string,
		) {
			await realStart.call(this, relayUrl, webUrl);
			transitioning = true;
		});
		try {
			await expect(startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" })).rejects.toThrow(
				/session switch is still settling/,
			);
			expect(ctx.collabHost).toBeUndefined();
			expect(relay.hasHost).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	it("stops a room whose session was rolled back, once the transition settles", async () => {
		let currentSessionId = "sess-target";
		let fireSettled: ((outcome: SessionTransitionOutcome) => void) | undefined;
		const { ctx } = makeCtx({
			onTransitionSettledRegistered: fire => {
				fireSettled = fire;
			},
		});
		ctx.sessionManager.getSessionId = () => currentSessionId;

		// A `session_switch` handler hosts against the session the switch just
		// committed to.
		const host = await startHosting(ctx, "ws://localhost:7475");
		expect(host.sessionId).toBe("sess-target");
		const stopped = Promise.withResolvers<string>();
		const realStop = CollabHost.prototype.stop;
		const spy = vi.spyOn(CollabHost.prototype, "stop").mockImplementation(async function (
			this: CollabHost,
			reason: string,
		) {
			await realStop.call(this, reason);
			if (this === host) stopped.resolve(reason);
		});
		try {
			// The switch then throws and restores the previous id. That restore
			// is deliberately silent, so settlement is the only signal the room
			// gets that its session did not survive.
			currentSessionId = "sess-previous";
			if (!fireSettled) throw new Error("publishing must register a transition-settled callback");
			fireSettled({ rolledBack: true });
			expect(await stopped.promise).toBe("session switch rolled back");
			expect(activeCollabHostLinks(ctx)).toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	});

	it("stops a room when a same-file reload rolls back, where the session id never changes", async () => {
		// `reload()` calls switchSession() on the current file, so a rollback
		// restores the transcript under an unchanged id. An observer comparing
		// ids sees nothing; only the settled outcome reports it.
		let fireSettled: ((outcome: SessionTransitionOutcome) => void) | undefined;
		const { ctx } = makeCtx({
			onTransitionSettledRegistered: fire => {
				fireSettled = fire;
			},
		});
		ctx.sessionManager.getSessionId = () => "sess-1";

		const host = await startHosting(ctx, "ws://localhost:7475");
		expect(host.sessionId).toBe("sess-1");
		const stopped = Promise.withResolvers<string>();
		const realStop = CollabHost.prototype.stop;
		const spy = vi.spyOn(CollabHost.prototype, "stop").mockImplementation(async function (
			this: CollabHost,
			reason: string,
		) {
			await realStop.call(this, reason);
			if (this === host) stopped.resolve(reason);
		});
		try {
			if (!fireSettled) throw new Error("publishing must register a transition-settled callback");
			fireSettled({ rolledBack: true });
			expect(await stopped.promise).toBe("session switch rolled back");
		} finally {
			spy.mockRestore();
		}
	});

	it("link reads hide a room left over from the previous session", async () => {
		let currentSessionId = "sess-1";
		const { ctx } = makeCtx();
		ctx.sessionManager.getSessionId = () => currentSessionId;
		const host = await startHosting(ctx, "ws://localhost:7475");
		expect(activeCollabHostLinks(ctx)).toEqual(collabHostLinks(host));

		currentSessionId = "sess-2";
		expect(activeCollabHostLinks(ctx)).toBeUndefined();
		// Reading links must not stop or restart anything.
		expect(ctx.collabHost).toBe(host);
	});

	it("stale-host replacement registers in-flight hosting and cancels if stopped during cleanup", async () => {
		let currentSessionId = "sess-1";
		const { ctx } = makeCtx();
		ctx.sessionManager.getSessionId = () => currentSessionId;
		const firstHost = await startHosting(ctx, "ws://localhost:7475");
		expect(ctx.collabHost).toBe(firstHost);

		currentSessionId = "sess-2";

		// Intercept existing.stop to pause during the stale-host cleanup.
		const stopDeferred = Promise.withResolvers<void>();
		const stopStarted = Promise.withResolvers<void>();
		const realStop = firstHost.stop.bind(firstHost);
		vi.spyOn(firstHost, "stop").mockImplementation(async function (reason: string) {
			stopStarted.resolve();
			await stopDeferred.promise;
			return realStop(reason);
		});

		const replacePromise = startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" });

		// Wait until stop is entered
		await stopStarted.promise;
		try {
			// hasInFlightCollabHosting must report true across this cleanup window!
			expect(hasInFlightCollabHosting(ctx)).toBe(true);

			// Now stopCollabHosting lands while cleanup is awaiting
			const stopPromise = stopCollabHosting(ctx);

			// Allow existing.stop to finish
			stopDeferred.resolve();
			await stopPromise;

			// The in-flight replacement must reject with stopped error
			await expect(replacePromise).rejects.toThrow(/Collab hosting was stopped/);
			expect(ctx.collabHost).toBeUndefined();
			expect(hasInFlightCollabHosting(ctx)).toBe(false);
			expect(relay.hasHost).toBe(false);
		} finally {
			stopDeferred.resolve();
		}
	});

	it("a superseding start holds the reservation while it cancels the stale one", async () => {
		let currentSessionId = "sess-1";
		const { ctx } = makeCtx();
		ctx.sessionManager.getSessionId = () => currentSessionId;

		// Pause only the first start, so the second one supersedes a reservation
		// that is still mid-handshake.
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let starts = 0;
		const realStart = CollabHost.prototype.start;
		const spy = vi.spyOn(CollabHost.prototype, "start").mockImplementation(async function (
			this: CollabHost,
			relayUrl: string,
			webUrl?: string,
		) {
			starts += 1;
			if (starts === 1) {
				firstEntered.resolve();
				await releaseFirst.promise;
			}
			await realStart.call(this, relayUrl, webUrl);
		});

		try {
			const first = startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" });
			await firstEntered.promise;
			currentSessionId = "sess-2";

			// The superseding call must own the slot the moment it returns, with
			// no window where a stop lands on an empty map and resolves as a
			// no-op while this start is suspended on the stale teardown.
			const second = startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" });
			expect(hasInFlightCollabHosting(ctx)).toBe(true);

			const stopPromise = stopCollabHosting(ctx);
			releaseFirst.resolve();
			await stopPromise;

			await expect(first).rejects.toThrow();
			await expect(second).rejects.toThrow(/Collab hosting was stopped/);
			expect(ctx.collabHost).toBeUndefined();
			expect(hasInFlightCollabHosting(ctx)).toBe(false);
			expect(relay.hasHost).toBe(false);
		} finally {
			releaseFirst.resolve();
			spy.mockRestore();
		}
	});

	it("refuses to publish a room while a join is mid-handshake", async () => {
		const otherHarness = makeCtx();
		const targetHost = await startHosting(otherHarness.ctx, "ws://localhost:7475");

		const { ctx } = makeCtx();
		let currentSessionId = "sess-local";
		ctx.sessionManager.getSessionId = () => currentSessionId;
		const guest = new CollabGuestLink(ctx);

		const guestPaused = Promise.withResolvers<void>();
		const guestProceed = Promise.withResolvers<void>();
		// The replica is the live session from here on, which is exactly the
		// window a published room would bind itself to before being rolled back.
		vi.spyOn(ctx.session, "switchSession").mockImplementation(async () => {
			currentSessionId = "sess-replica";
			guestPaused.resolve();
			await guestProceed.promise;
			return true;
		});
		vi.spyOn(ctx.session, "newSession").mockImplementation(async () => {
			currentSessionId = "sess-local";
			return true;
		});

		const guestJoinPromise = guest.join(targetHost.link);
		try {
			await guestPaused.promise;

			await expect(startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" })).rejects.toThrow(
				/collab guest session is still settling/,
			);
			expect(ctx.collabHost).toBeUndefined();
			expect(hasInFlightCollabHosting(ctx)).toBe(false);
		} finally {
			guestProceed.resolve();
			await guestJoinPromise.catch(() => {});
			await guest.leave("test done");
		}
	});

	it("a second concurrent join is refused and cannot release the first one's reservation", async () => {
		const otherHarness = makeCtx();
		const targetHost = await startHosting(otherHarness.ctx, "ws://localhost:7475");

		const { ctx } = makeCtx();
		let currentSessionId = "sess-local";
		ctx.sessionManager.getSessionId = () => currentSessionId;
		const first = new CollabGuestLink(ctx);
		const second = new CollabGuestLink(ctx);

		const firstPaused = Promise.withResolvers<void>();
		const firstProceed = Promise.withResolvers<void>();
		// Only the first join parks here. A second join must be refused before
		// it gets this far, so leaving it unblocked makes that assertion fail
		// fast instead of deadlocking on the first join's pause.
		let switches = 0;
		vi.spyOn(ctx.session, "switchSession").mockImplementation(async () => {
			currentSessionId = "sess-replica";
			switches += 1;
			if (switches === 1) {
				firstPaused.resolve();
				await firstProceed.promise;
			}
			return true;
		});
		vi.spyOn(ctx.session, "newSession").mockImplementation(async () => {
			currentSessionId = "sess-local";
			return true;
		});

		const firstJoin = first.join(targetHost.link);
		try {
			await firstPaused.promise;

			await expect(second.join(targetHost.link)).rejects.toThrow(/Already joining a collab session/);
			// The refused join must not have released the reservation the first
			// one still holds, so a hosting start is still refused.
			await expect(startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" })).rejects.toThrow(
				/collab guest session is still settling/,
			);
			expect(ctx.collabHost).toBeUndefined();
		} finally {
			firstProceed.resolve();
			await firstJoin.catch(() => {});
			await first.leave("test done");
		}
	});

	it("a join rolls the replica back when a host is published under it", async () => {
		const otherHarness = makeCtx();
		const targetHost = await startHosting(otherHarness.ctx, "ws://localhost:7475");

		const { ctx } = makeCtx();
		let currentSessionId = "sess-local";
		ctx.sessionManager.getSessionId = () => currentSessionId;
		const guest = new CollabGuestLink(ctx);

		const guestPaused = Promise.withResolvers<void>();
		const guestProceed = Promise.withResolvers<void>();
		vi.spyOn(ctx.session, "switchSession").mockImplementation(async () => {
			currentSessionId = "sess-replica";
			guestPaused.resolve();
			await guestProceed.promise;
			return true;
		});
		const newSession = vi.spyOn(ctx.session, "newSession").mockImplementation(async () => {
			currentSessionId = "sess-local";
			return true;
		});

		const guestJoinPromise = guest.join(targetHost.link);
		await guestPaused.promise;
		// `ctx.collabHost` is a public field, so a host can appear without
		// going through startCollabHosting. The join must roll the replica back
		// rather than latch shutdown and strand the user inside it.
		ctx.collabHost = new CollabHost(ctx);
		guestProceed.resolve();

		await expect(guestJoinPromise).rejects.toThrow(/Already hosting a collab session/);
		expect(ctx.collabGuest).toBeUndefined();
		expect(newSession).toHaveBeenCalled();
		expect(currentSessionId).toBe("sess-local");
		// The rollback nests inside the join, so both reservations must have
		// been released: an unbalanced counter would refuse hosting forever.
		ctx.collabHost = undefined;
		const afterRollback = await startHosting(ctx, "ws://localhost:7475");
		expect(afterRollback.sessionId).toBe("sess-local");
	});

	it("refuses to publish a room while a guest rollback is still restoring", async () => {
		const otherHarness = makeCtx();
		const targetHost = await startHosting(otherHarness.ctx, "ws://localhost:7475");

		const { ctx } = makeCtx();
		let currentSessionId = "sess-local";
		ctx.sessionManager.getSessionId = () => currentSessionId;
		const guest = new CollabGuestLink(ctx);
		vi.spyOn(ctx.session, "switchSession").mockImplementation(async () => {
			currentSessionId = "sess-replica";
			return true;
		});

		// Park inside the restore, which is where a session_before_switch
		// handler would run: ctx.collabGuest is already cleared but the local
		// session is not back yet.
		const restoring = Promise.withResolvers<void>();
		const releaseRestore = Promise.withResolvers<void>();
		vi.spyOn(ctx.session, "newSession").mockImplementation(async () => {
			restoring.resolve();
			await releaseRestore.promise;
			currentSessionId = "sess-local";
			return true;
		});
		// `leave()` cannot be the join point: CollabSocket.close() fires onClose
		// synchronously, so the rollback is already running fire-and-forget and
		// leave() returns as soon as it sees the latch. The last statement of
		// the rollback is this render, so wait on that instead.
		const restored = Promise.withResolvers<void>();
		const realRequestRender = ctx.ui.requestRender;
		vi.spyOn(ctx.ui, "requestRender").mockImplementation((...args: unknown[]) => {
			const options = args[1] as { clearScrollback?: boolean } | undefined;
			if (options?.clearScrollback) restored.resolve();
			return Reflect.apply(realRequestRender, ctx.ui, args) as void;
		});

		await guest.join(targetHost.link);
		expect(ctx.collabGuest).toBe(guest);

		const leaving = guest.leave("test done");
		try {
			await restoring.promise;
			expect(ctx.collabGuest).toBeUndefined();

			await expect(startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" })).rejects.toThrow(
				/collab guest session is still settling/,
			);
			expect(ctx.collabHost).toBeUndefined();
		} finally {
			releaseRestore.resolve();
			await leaving;
			await restored.promise;
		}

		// Once the rollback settles, hosting is allowed again.
		const host = await startHosting(ctx, "ws://localhost:7475");
		expect(ctx.collabHost).toBe(host);
	});

	it("a room whose session changed under it serves no snapshot to an arriving guest", async () => {
		let currentSessionId = "sess-1";
		const { ctx } = makeCtx();
		ctx.sessionManager.getSessionId = () => currentSessionId;
		const host = await startHosting(ctx, "ws://localhost:7475");
		expect(relay.hasHost).toBe(true);

		// The room stays bound to sess-1 while the live session moves on, which
		// is what a rolled-back join or an out-of-band switch leaves behind.
		currentSessionId = "sess-2";

		// The guard's observable is the host dropping the room, so wait on that
		// rather than on a frame that must never arrive. Teardown clears
		// `ctx.collabHost`, which #teardown does before the socket close lands.
		const dropped = Promise.withResolvers<void>();
		const realTeardownProbe = ctx.ui.requestRender;
		vi.spyOn(ctx.ui, "requestRender").mockImplementation((...args: unknown[]) => {
			if (!ctx.collabHost) dropped.resolve();
			return Reflect.apply(realTeardownProbe, ctx.ui, args) as void;
		});

		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(parsed.key);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		const frames: CollabFrame[] = [];
		try {
			socket.onFrame = frame => frames.push(frame);
			socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "probe" });
			socket.connect();
			await dropped.promise;
		} finally {
			socket.close();
		}

		expect(relay.hasHost).toBe(false);
		expect(frames).toEqual([]);
		expect(ctx.collabHost).toBeUndefined();
	});

	it("an abandoned host does not overwrite active guest collab status with host status", async () => {
		const harness = makeCtx();
		const ctx = harness.ctx;
		ctx.statusLine.setCollabStatus({ role: "guest", participantCount: 2 });
		expect(harness.collabStatus()).toEqual({ role: "guest", participantCount: 2 });

		const realStart = CollabHost.prototype.start;
		const spy = vi.spyOn(CollabHost.prototype, "start").mockImplementation(async function (
			this: CollabHost,
			relayUrl: string,
			webUrl?: string,
		) {
			await realStart.call(this, relayUrl, webUrl);
			ctx.collabGuest = {} as NonNullable<InteractiveModeContext["collabGuest"]>;
		});

		try {
			await expect(startCollabHosting(ctx, { relayUrl: "ws://localhost:7475" })).rejects.toThrow(
				/Already in a collab session as a guest/,
			);
			expect(ctx.collabHost).toBeUndefined();
			expect(harness.collabStatus()).toEqual({ role: "guest", participantCount: 2 });
		} finally {
			spy.mockRestore();
		}
	});

	it("rejects startCollab during session_before_switch so extensions cannot hold links for outgoing session", async () => {
		let currentSessionId = "sess-outgoing";
		let runnerRef: ExtensionRunner | undefined = undefined;
		let sessionTransitionInFlight = false;
		const { ctx } = makeCtx({
			relayUrl: "ws://localhost:7475",
			extensionRunner: () => runnerRef,
			isSessionTransitionInFlight: () => sessionTransitionInFlight,
		});
		ctx.sessionManager.getSessionId = () => currentSessionId;
		const runtime = new ExtensionRuntime();
		let handlerLinks: CollabHostLinks | undefined;
		let handlerError: unknown;

		const extension: Extension = {
			path: "test-collab-ext",
			resolvedPath: "/test-collab-ext",
			handlers: new Map([
				[
					"session_before_switch",
					[
						async () => {
							try {
								handlerLinks = await runtime.startCollab();
							} catch (err) {
								handlerError = err;
							}
						},
					],
				],
			]),
			tools: new Map(),
			assistantThinkingRenderers: [],
			fileWriteFallbackHandlers: [],
			fileDeleteFallbackHandlers: [],
			messageRenderers: new Map(),
			composerShapes: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};

		const runner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);
		runnerRef = runner;
		runner.initialize(
			{
				...headlessActions(),
				startCollab: async options => collabHostLinks(await startCollabHosting(ctx, options)),
				getCollabLinks: () => activeCollabHostLinks(ctx),
				stopCollab: async () => {
					await stopCollabHosting(ctx);
				},
			},
			headlessContextActions(),
		);

		sessionTransitionInFlight = true;
		await runner.emit({
			type: "session_before_switch",
			reason: "new",
		});

		// During session_before_switch, startCollab must reject and leave collabHost unset.
		expect(handlerError).toBeInstanceOf(Error);
		expect((handlerError as Error).message).toMatch(/session switch is still settling/);
		expect(handlerLinks).toBeUndefined();
		expect(ctx.collabHost).toBeUndefined();

		// The guard clears once the session commits, so the post-switch hook,
		// which runs after the new id has committed, can host normally.
		sessionTransitionInFlight = false;
		currentSessionId = "sess-target";
		let postSwitchLinks: CollabHostLinks | undefined;
		let postSwitchError: unknown;
		extension.handlers.set("session_switch", [
			async () => {
				try {
					postSwitchLinks = await runtime.startCollab();
				} catch (err) {
					postSwitchError = err;
				}
			},
		]);
		await runner.emit({ type: "session_switch", reason: "new", previousSessionFile: undefined });
		startedHosts.push(ctx.collabHost!);
		expect(postSwitchError).toBeUndefined();
		expect(postSwitchLinks).toBeDefined();
		expect(ctx.collabHost?.sessionId).toBe("sess-target");
	});
});

describe("collab hosting on non-interactive extension hosts", () => {
	it("startCollab and stopCollab throw, getCollabLinks answers undefined", async () => {
		const runtime = new ExtensionRuntime();
		const runner = new ExtensionRunner([], runtime, tempDir.path(), SessionManager.inMemory(), modelRegistry);
		runner.initialize(headlessActions(), headlessContextActions());
		// The fallback throws synchronously (like the loader's pre-init stubs); the
		// real action rejects. Either way an awaiting caller sees the same error.
		expect(() => runtime.startCollab()).toThrow(/does not support collab hosting/);
		expect(runtime.getCollabLinks()).toBeUndefined();
		expect(() => runtime.stopCollab()).toThrow(/does not support collab hosting/);
	});

	it("an interactive host's wired actions start, expose, and stop a real room", async () => {
		const { ctx } = makeCtx({ relayUrl: "ws://localhost:7475" });
		const runtime = new ExtensionRuntime();
		const runner = new ExtensionRunner([], runtime, tempDir.path(), SessionManager.inMemory(), modelRegistry);
		runner.initialize(
			{
				...headlessActions(),
				startCollab: async options => collabHostLinks(await startCollabHosting(ctx, options)),
				getCollabLinks: () => activeCollabHostLinks(ctx),
				stopCollab: async () => {
					await stopCollabHosting(ctx);
				},
			},
			headlessContextActions(),
		);

		const links = await runtime.startCollab();
		startedHosts.push(ctx.collabHost!);
		// The room the extension was handed is real: a guest can join with it.
		const welcome = await expectGuestWelcome(links.link);
		expect(welcome.t).toBe("welcome");
		expect(runtime.getCollabLinks()).toEqual(links);

		await runtime.stopCollab();
		expect(ctx.collabHost).toBeUndefined();
		expect(runtime.getCollabLinks()).toBeUndefined();
		expect(relay.hasHost).toBe(false);
	});

	it("the uninitialized runtime refuses before initialize wires actions", () => {
		const runtime = new ExtensionRuntime();
		expect(() => runtime.startCollab()).toThrow(ExtensionRuntimeNotInitializedError);
		expect(() => runtime.getCollabLinks()).toThrow(ExtensionRuntimeNotInitializedError);
	});
});
