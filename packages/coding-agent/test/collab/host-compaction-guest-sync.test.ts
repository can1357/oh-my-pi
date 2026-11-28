/**
 * Contract: after the host compacts, a joined guest's replicated model context
 * must collapse behind the compaction summary exactly as the host's does —
 * appending the compaction entry alone leaves the guest holding the stale
 * pre-compaction transcript (issue #9781).
 *
 * A real host `SessionManager` broadcasts live entries through `CollabHost`; a
 * real guest `CollabGuestLink` (backed by a real `AgentSession`) applies them.
 * The in-memory relay (see ./helpers/in-memory-relay) runs the real socket,
 * host, and guest unchanged, so the full welcome → snapshot → live-entry path
 * is exercised.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as os from "node:os";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TOOL_EXECUTION_START_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { refreshDirsFromEnv, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

/** Minimal host `InteractiveModeContext`: only the members `CollabHost` reads. */
function makeHostContext(manager: SessionManager): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: manager,
		session: {
			isStreaming: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "host session",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			facts: () => ({ context: { tokens: 0, window: 0, percent: null } }),
		},
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

interface GuestHarness {
	guest: CollabGuestLink;
	session: AgentSession;
	dispose: () => Promise<void>;
}

/**
 * Real guest: a live `AgentSession` + `SessionManager` behind a `CollabGuestLink`.
 * Every UI touchpoint the join/finalize/apply path calls is a no-op double; the
 * session and manager are real so `session.messages` reflects the replicated
 * (and rebuilt-on-compaction) model context.
 */
function makeGuestHarness(model: Model, modelRegistry: ModelRegistry): GuestHarness {
	const tempDir = TempDir.createSync("@pi-collab-guest-sync-");
	const manager = SessionManager.create(tempDir.path(), tempDir.path());
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({ agent, sessionManager: manager, settings: Settings.isolated(), modelRegistry });

	const ctx = {
		settings: Settings.isolated(),
		sessionManager: manager,
		session,
		clearTransientSessionUi: () => {},
		clearWorking: () => false,
		ensureWorkingRow: () => {},
		updatePendingMessagesDisplay: () => {},
		compactionQueuedMessages: [],
		streamingMessage: undefined,
		pendingTools: new Map(),
		statusLine: {
			setCollabStatus: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
			facts: () => ({ context: { tokens: 0, window: 0, percent: null } }),
			resetActiveTime: () => {},
			refresh: () => {},
		},
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		syncRunningSubagentBadge: () => {},
		setCollabGuest: (guest: InteractiveModeContext["collabGuest"]) => {
			Object.assign(ctx, { collabGuest: guest });
		},
		renderInitialMessages: () => Promise.resolve(),
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		eventController: {
			dispatchSessionEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		eventBus: undefined,
		collabGuest: undefined,
		handleResumeSession: () => Promise.resolve(),
	} as unknown as InteractiveModeContext;

	const guest = new CollabGuestLink(ctx);
	return {
		guest,
		session,
		dispose: async () => {
			await guest.leave("test cleanup").catch(() => {});
			await session.dispose().catch(() => {});
			await tempDir.remove().catch(() => {});
		},
	};
}

// Frames traverse the real CollabSocket, whose AES-GCM seal/open run on
// WebCrypto — genuine async that resolves on the event loop, not on a clock
// this test controls, so fake timers cannot drive it. Poll event-loop ticks
// until the awaited state lands, bounded by wall time rather than a tick
// count: under a loaded parallel test run 500 zero-delay yields can elapse
// before the WebCrypto work is ever scheduled.
async function settleFrames(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	if (!predicate()) throw new Error("condition not met while settling collab frames");
}

// The guest writes its replica under getConfigRootDir(); redirect the config
// root to a temp HOME so the test never touches the real ~/.omp.
let homedirSpy: Mock<typeof os.homedir> | undefined;
let homeDir: TempDir | undefined;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let model: Model;

beforeAll(() => {
	homeDir = TempDir.createSync("@pi-collab-guest-home-");
	homedirSpy = spyOn(os, "homedir").mockReturnValue(homeDir.path());
	refreshDirsFromEnv();
	installInMemoryRelay();
	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("expected bundled anthropic model");
	model = bundled;
});

/** Run every step in order, each even when one before it throws; then throw the failures together. */
async function runEach(steps: readonly (() => unknown)[]): Promise<void> {
	const failures: unknown[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "collab test cleanup failed");
}

afterAll(async () => {
	await runEach([
		() => uninstallInMemoryRelay(),
		() => authStorage?.close(),
		() => homedirSpy?.mockRestore(),
		() => refreshDirsFromEnv(),
		() => homeDir?.remove(),
	]);
}, 30_000);

/** Stops a host and disposes a guest harness after each test, newest first. */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	await runEach(cleanups.splice(0).reverse());
}, 30_000);

describe("collab host compaction → guest sync (#9781)", () => {
	it("collapses the guest's model context behind the summary after the host compacts", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		hostManager.appendMessage(createAssistantMessage("reply"));
		const keptId = hostManager.appendMessage({ role: "user", content: "keep", timestamp: Date.now() });

		const host = new CollabHost(makeHostContext(hostManager));
		cleanups.push(() => host.stop("test done"));
		await host.start("ws://localhost:8788");

		const harness = makeGuestHarness(model, modelRegistry);
		cleanups.push(harness.dispose);

		await harness.guest.join(host.link);

		// Snapshot replicated the full pre-compaction transcript.
		await settleFrames(() => harness.session.messages.length === 3);
		expect(
			harness.session.messages.map(m => ("content" in m && typeof m.content === "string" ? m.content : m.role)),
		).toEqual(["first", "assistant", "keep"]);

		// Host compacts: everything before `keptId` collapses behind the summary.
		hostManager.appendCompaction("SUMMARY", undefined, keptId, 100);

		await settleFrames(() => harness.session.messages[0]?.role === "compactionSummary");
		const compacted = harness.session.messages;
		expect(compacted).toHaveLength(2);
		expect(compacted[0]).toMatchObject({ role: "compactionSummary", summary: "SUMMARY" });
		expect(compacted[1]).toMatchObject({ role: "user", content: "keep" });
		// The stale pre-compaction turns are gone.
		expect(compacted.some(m => "content" in m && (m.content === "first" || m.content === "reply"))).toBe(false);

		// A live message after compaction builds on the compacted base, not the
		// stale full history.
		hostManager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });
		await settleFrames(() => harness.session.messages.length === 3);
		const withFollowup = harness.session.messages;
		expect(withFollowup[0]?.role).toBe("compactionSummary");
		expect(withFollowup.at(-1)).toMatchObject({ role: "user", content: "after" });
	}, 30_000);
});

describe("collab guest replica identity", () => {
	it("gives the replica its own session id, kept across a resync, so a guest never contends for the host's lease", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		hostManager.appendMessage(createAssistantMessage("reply"));
		const keptId = hostManager.appendMessage({ role: "user", content: "keep", timestamp: Date.now() });
		const host = new CollabHost(makeHostContext(hostManager));
		cleanups.push(() => host.stop("test done"));
		await host.start("ws://localhost:8788");
		const harness = makeGuestHarness(model, modelRegistry);
		cleanups.push(harness.dispose);

		await harness.guest.join(host.link);
		await settleFrames(() => harness.session.messages.length === 3);

		// The lease is keyed by session id: sharing the host's id would make a
		// guest on the host's machine displace the host (or be displaced).
		const replica = harness.session.sessionManager;
		const replicaId = replica.getSessionId();
		expect(replicaId).not.toBe(hostManager.getSessionId());
		expect(replica.getHeader()?.parentSession).toBe(hostManager.getSessionId());
		// `omp gc` probes this lease: an idle joined guest's replica is live.
		const leaseFree = () => {
			const probe = tryAcquireSessionLease(replicaId);
			probe?.release();
			return probe !== null;
		};
		expect(leaseFree()).toBe(false);

		// A host compaction resyncs the replica. A new id there would hand the
		// lease off and leave the replica briefly unowned.
		hostManager.appendCompaction("SUMMARY", undefined, keptId, 100);
		await settleFrames(() => harness.session.messages[0]?.role === "compactionSummary");
		expect(harness.session.sessionManager.getSessionId()).toBe(replicaId);
		expect(leaseFree()).toBe(false);
	}, 30_000);
});

describe("collab host entry_patch records → guest", () => {
	/** The text of each message the guest's model context holds, or its role. */
	const contents = (session: AgentSession) =>
		session.messages.map(m => ("content" in m && typeof m.content === "string" ? m.content : m.role));

	// An elide pass on the host appends a record that sets an entry's content: a
	// joined guest must set it on its replica, or its context and `/dump` keep
	// the heavy content until it rejoins. The record is written by hand, as a
	// file holds it, so the case fails for the live path on a tree without it.
	it("sends a record in a live entry frame, and the guest applies it to the entry it holds", async () => {
		const hostManager = SessionManager.inMemory();
		const firstId = hostManager.appendMessage({ role: "user", content: "heavy first", timestamp: Date.now() });
		hostManager.appendMessage(createAssistantMessage("reply"));
		const host = new CollabHost(makeHostContext(hostManager));
		cleanups.push(() => host.stop("test done"));
		await host.start("ws://localhost:8788");
		const harness = makeGuestHarness(model, modelRegistry);
		cleanups.push(harness.dispose);
		await harness.guest.join(host.link);
		await settleFrames(() => harness.session.messages.length === 2);

		const recordId = hostManager.appendCustomEntry("entry_patch", {
			patches: [{ entryId: firstId, message: { content: "[elided]" } }],
		});
		// A live entry after the record: once it lands, the record (sent before it) has too.
		hostManager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });
		await settleFrames(() => harness.session.messages.length === 3);

		expect({
			messages: contents(harness.session),
			replicaHoldsRecord: harness.session.sessionManager.getEntry(recordId)?.type,
		}).toEqual({ messages: ["[elided]", "assistant", "after"], replicaHoldsRecord: "custom" });
	}, 30_000);

	// A record past the frame ceiling cannot be shrunk without setting a
	// truncated value: it goes as a record that sets nothing, which keeps the
	// guest's parent chain, and the guest keeps the entry as it was.
	it("sends a record too large for one frame as one that sets nothing", async () => {
		const hostManager = SessionManager.inMemory();
		const firstId = hostManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		const host = new CollabHost(makeHostContext(hostManager));
		cleanups.push(() => host.stop("test done"));
		await host.start("ws://localhost:8788");
		const harness = makeGuestHarness(model, modelRegistry);
		cleanups.push(harness.dispose);
		await harness.guest.join(host.link);
		await settleFrames(() => harness.session.messages.length === 1);

		const recordId = hostManager.appendCustomEntry("entry_patch", {
			patches: [{ entryId: firstId, message: { content: "x".repeat(1_100_000) } }],
		});
		hostManager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });
		await settleFrames(() => harness.session.messages.length === 2);

		const replicated = harness.session.sessionManager.getEntry(recordId);
		expect({
			messages: contents(harness.session),
			record: replicated?.type === "custom" ? replicated.data : undefined,
		}).toEqual({ messages: ["first", "after"], record: { patches: [] } });
	}, 30_000);

	/**
	 * One tool turn as `AgentSession` writes it: the user's request, the call, the
	 * `tool_execution_start` record (which the host never sends), the result, the
	 * reply. Returns the tool result's id.
	 */
	function appendToolTurn(manager: SessionManager): string {
		manager.appendMessage({ role: "user", content: "read a.txt", timestamp: 1 });
		const call: AssistantMessage = {
			...createAssistantMessage(""),
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }],
			stopReason: "toolUse",
		};
		manager.appendMessage(call);
		manager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "call-1",
			toolName: "read",
			startedAt: new Date(0).toISOString(),
		});
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "heavy tool output" }],
			isError: false,
			timestamp: 3,
		};
		const toolId = manager.appendMessage(result);
		manager.appendMessage(createAssistantMessage("done"));
		return toolId;
	}

	/** What a model context holds of each message: its role and its content. */
	const contextView = (messages: readonly AgentMessage[]) =>
		messages.map(message => ({ role: message.role, ...("content" in message && { content: message.content }) }));

	/** Wait for the guest to hold `lastId`, then check its model context is the host's. */
	async function expectHostContext(harness: GuestHarness, hostManager: SessionManager, lastId: string): Promise<void> {
		await settleFrames(() => harness.session.sessionManager.getEntry(lastId) !== undefined);
		const hostContext = contextView(hostManager.buildSessionContext().messages);
		expect(hostContext.map(message => message.role)).toEqual([
			"user",
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"user",
		]);
		expect(contextView(harness.session.messages)).toEqual(hostContext);
		expect(contextView(harness.session.buildDisplaySessionContext().messages)).toEqual(hostContext);
	}

	// The host sends each entry with the parent its session gives it, and a tool
	// result's parent is the `tool_execution_start` record the host never sends.
	// A record makes the guest build its context by walking the replica's parent
	// links: a link to an entry the replica lacks would end the walk there and
	// drop the history above it.
	it("keeps the whole context when a record follows a tool result whose parent the host never sends", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "seed", timestamp: 0 });
		const host = new CollabHost(makeHostContext(hostManager));
		cleanups.push(() => host.stop("test done"));
		await host.start("ws://localhost:8788");
		const harness = makeGuestHarness(model, modelRegistry);
		cleanups.push(harness.dispose);
		await harness.guest.join(host.link);
		await settleFrames(() => harness.session.messages.length === 1);

		const toolId = appendToolTurn(hostManager);
		await hostManager.patchEntries([{ entryId: toolId, message: { content: [{ type: "text", text: "[elided]" }] } }]);
		const lastId = hostManager.appendMessage({ role: "user", content: "after", timestamp: 9 });
		await expectHostContext(harness, hostManager, lastId);
	}, 30_000);

	// The welcome snapshot holds the entries the host sends, each with the parent
	// its session gives it: the replica the guest resumes walks the same links.
	it("gives a joining guest the whole context of a session whose tool result's parent the host never sends", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "seed", timestamp: 0 });
		appendToolTurn(hostManager);
		const lastId = hostManager.appendMessage({ role: "user", content: "after", timestamp: 9 });
		const host = new CollabHost(makeHostContext(hostManager));
		cleanups.push(() => host.stop("test done"));
		await host.start("ws://localhost:8788");
		const harness = makeGuestHarness(model, modelRegistry);
		cleanups.push(harness.dispose);
		await harness.guest.join(host.link);
		await expectHostContext(harness, hostManager, lastId);
	}, 30_000);
});
