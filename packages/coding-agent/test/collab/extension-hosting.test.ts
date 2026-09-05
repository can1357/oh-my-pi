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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { collabHostLinks, startCollabHosting } from "@oh-my-pi/pi-coding-agent/collab/start-hosting";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	ExtensionRuntime,
	ExtensionRuntimeNotInitializedError,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface CtxHarness {
	ctx: InteractiveModeContext;
	/** Every string any presentation surface received, in order. */
	printed: string[];
}

/**
 * Minimal InteractiveModeContext double: the members CollabHost touches,
 * plus recording of every presentation call so the key-hygiene test can
 * assert that starting a room prints nothing at all.
 */
function makeCtx(options: { relayUrl?: string; webUrl?: string; guest?: boolean } = {}): CtxHarness {
	const printed: string[] = [];
	const settings: Record<string, string> = {
		"collab.relayUrl": options.relayUrl ?? "",
		"collab.webUrl": options.webUrl ?? "",
	};
	const ctx = {
		settings: { get: (key: string) => settings[key] ?? "" },
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
			emitNotice: (_level: string, message: string) => printed.push(message),
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
		showStatus: (message: string) => printed.push(message),
		showError: (message: string) => printed.push(message),
		present: () => printed.push("<component>"),
		collabHost: undefined,
		collabGuest: options.guest ? {} : undefined,
	} as unknown as InteractiveModeContext;
	return { ctx, printed };
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

beforeAll(() => {
	installInMemoryRelay();
});

afterEach(async () => {
	for (const host of startedHosts.splice(0).reverse()) await host.stop("test done");
});

afterAll(() => {
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
		expect((secondResult.reason as Error).message).toMatch(
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

		const welcome = await expectGuestWelcome(liveHost.link);
		expect(welcome.t).toBe("welcome");
	});
});

describe("collab hosting on non-interactive extension hosts", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-collab-runner-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

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

	it("delegates to the wired actions when a host provides them", async () => {
		const runtime = new ExtensionRuntime();
		const runner = new ExtensionRunner([], runtime, tempDir.path(), SessionManager.inMemory(), modelRegistry);
		const sentinel = { link: "l", viewLink: "v", webLink: "w", webViewLink: "wv" };
		const actions = headlessActions();
		let stops = 0;
		actions.startCollab = () => Promise.resolve(sentinel);
		actions.getCollabLinks = () => sentinel;
		actions.stopCollab = () => {
			stops += 1;
			return Promise.resolve();
		};
		runner.initialize(actions, headlessContextActions());
		// The runtime passed to the runner is the same object initialize wires,
		// so its methods are the extension-facing surface under test.
		expect(await runtime.startCollab()).toBe(sentinel);
		expect(runtime.getCollabLinks()).toBe(sentinel);
		await runtime.stopCollab();
		expect(stops).toBe(1);
	});

	it("the uninitialized runtime refuses before initialize wires actions", () => {
		const runtime = new ExtensionRuntime();
		expect(() => runtime.startCollab()).toThrow(ExtensionRuntimeNotInitializedError);
		expect(() => runtime.getCollabLinks()).toThrow(ExtensionRuntimeNotInitializedError);
	});
});
