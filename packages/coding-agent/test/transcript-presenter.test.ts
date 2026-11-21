import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type {
	Extension,
	ExtensionError,
	ExtensionFactory,
	TranscriptBlock,
	TranscriptPresentation,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, type CollabFrame, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { cfgExtensionTranscriptPresenters } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { minFrameIntervalMs, setMaxFps } from "@oh-my-pi/pi-tui/frame-rate";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as piUtils from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./collab/helpers/in-memory-relay";

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("extension transcript presenters", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let eventBus: EventBus;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-transcript-presenter-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		// Leaving a collab guest restores the local session's model, which needs auth for its provider.
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = new VirtualTerminal(120, 32);
		eventBus = new EventBus();
		mode = new InteractiveMode(
			session,
			"test",
			() => {},
			undefined,
			undefined,
			eventBus,
			new Composer({ terminal: term }),
		);
		// Presenters are opt-in; every test but the opt-in one runs with them on.
		cfgExtensionTranscriptPresenters.set(mode.settings, true);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setNativeRendering(false);
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Load `factories` as extensions (in this load order) through the real API, and install their runner. */
	async function installExtensions(...factories: ExtensionFactory[]): Promise<{
		runner: ExtensionRunner;
		extensions: Extension[];
		errors: ExtensionError[];
	}> {
		return installExtensionsOn(session, ...factories);
	}

	/** {@link installExtensions} for the session `target`. */
	async function installExtensionsOn(
		target: AgentSession,
		...factories: ExtensionFactory[]
	): Promise<{ runner: ExtensionRunner; extensions: Extension[]; errors: ExtensionError[] }> {
		const runtime = new ExtensionRuntime();
		const extensions: Extension[] = [];
		for (const [index, factory] of factories.entries()) {
			extensions.push(
				await loadExtensionFromFactory(factory, tempDir.path(), eventBus, runtime, `/ext/${index}.ts`),
			);
		}
		const runner = new ExtensionRunner(
			extensions,
			runtime,
			tempDir.path(),
			target.sessionManager,
			modelRegistry,
			undefined,
			mode.settings,
		);
		const errors: ExtensionError[] = [];
		runner.onError(error => errors.push(error));
		Object.defineProperty(target, "extensionRunner", { configurable: true, get: () => runner });
		return { runner, extensions, errors };
	}

	function presenter(present: (block: TranscriptBlock) => TranscriptPresentation): ExtensionFactory {
		return pi => {
			pi.registerTranscriptPresenter(present);
		};
	}

	/** One model `bash` call (`id`) in `target`'s session, whose output reads `OUTPUT-<id>`; returns the call. */
	function appendToolCall(id: string, timestamp: number, target: AgentSession = session): AssistantMessage {
		const call: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "bash", arguments: { command: `echo ${id}` } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: USAGE,
			timestamp,
		};
		target.sessionManager.appendMessage(call);
		target.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: `OUTPUT-${id}` }],
			isError: false,
			timestamp: timestamp + 1,
		});
		return call;
	}

	function appendReply(text: string, timestamp: number): void {
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: USAGE,
			timestamp,
		});
	}

	async function start(): Promise<void> {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
	}

	const chat = () => plainRows(mode.chatContainer.render(120)).join("\n");
	const screen = () => plainRows(term.getViewport()).join("\n");

	it("takes the first answer in load order, skips a suspended extension and draws a throwing presenter's block in full", async () => {
		// Regression guard: a later extension overriding an earlier one, a suspended extension still
		// presenting, or one throwing presenter blanking or crashing the transcript.
		let firstThrows = false;
		const { runner, extensions, errors } = await installExtensions(
			presenter(() => {
				if (firstThrows) throw new Error("presenter broke");
				return undefined;
			}),
			presenter(block => (block.type === "toolCall" ? { compact: { label: `ROW-${block.id}` } } : undefined)),
			presenter(() => "hidden"),
		);
		appendToolCall("call1", 10);
		await start();
		await mode.renderInitialMessages();
		expect(chat()).toContain("ROW-call1");
		expect(chat()).not.toContain("OUTPUT-call1");

		// The second extension suspended: the third one's answer applies.
		runner.setSuspendedExtensions(extension => extension === extensions[1]);
		await Promise.resolve();
		expect(chat()).not.toContain("ROW-call1");
		expect(chat()).not.toContain("OUTPUT-call1");

		runner.setSuspendedExtensions(() => false);
		await Promise.resolve();
		expect(chat()).toContain("ROW-call1");

		// The first presenter throws: reported once, and its block is omp's full card.
		firstThrows = true;
		runner.getUIContext().refreshTranscript(["call1"]);
		runner.getUIContext().refreshTranscript(["call1"]);
		expect(chat()).toContain("OUTPUT-call1");
		expect(chat()).not.toContain("ROW-call1");
		expect(errors.map(error => [error.event, error.error])).toEqual([["transcript_presenter", "presenter broke"]]);
	});

	it("draws a block in full and reports each presenter once when it answers something unknown", async () => {
		// Regression guard: a misspelt mode or an async presenter's Promise silently drawing in full,
		// a rejected one going unhandled, or a throwing getter in an answer escaping into the render.
		const brokenAnswer: TranscriptPresentation = {
			compact: {
				get label(): string {
					throw new Error("label broke");
				},
			},
		};
		const { runner, errors } = await installExtensions(
			presenter(block => (block.id === "call1" ? ("Hidden" as TranscriptPresentation) : undefined)),
			presenter(block => (block.id === "call3" ? brokenAnswer : undefined)),
			presenter((async () => {
				throw new Error("async broke");
			}) as unknown as (block: TranscriptBlock) => TranscriptPresentation),
		);
		appendToolCall("call1", 10);
		appendToolCall("call2", 20);
		appendToolCall("call3", 30);
		await start();
		await mode.renderInitialMessages();
		runner.getUIContext().refreshTranscript(["call1", "call2", "call3"]);
		// Any unhandled rejection surfaces once the event loop turns.
		const tick = Promise.withResolvers<void>();
		setImmediate(tick.resolve);
		await tick.promise;
		for (const id of ["call1", "call2", "call3"]) expect(chat()).toContain(`OUTPUT-${id}`);
		const reported = new Map(errors.map(error => [error.extensionPath, error]));
		expect(errors).toHaveLength(3);
		expect(errors.every(error => error.event === "transcript_presenter")).toBe(true);
		expect(reported.get("/ext/0.ts")?.error).toContain('"Hidden"');
		expect(reported.get("/ext/1.ts")?.error).toBe("label broke");
		expect(reported.get("/ext/2.ts")?.error).toContain("Promise");
	});

	it("draws an expanded block in full whatever the presenters answer", async () => {
		// Regression guard: Ctrl+O failing to reveal a hidden or compact block's full card.
		await installExtensions(presenter(() => "hidden"));
		appendToolCall("call1", 10);
		await start();
		await mode.renderInitialMessages();
		expect(chat()).not.toContain("OUTPUT-call1");

		mode.setToolsExpanded(true);
		expect(chat()).toContain("OUTPUT-call1");
		mode.setToolsExpanded(false);
		expect(chat()).not.toContain("OUTPUT-call1");
	});

	it("asks again only the blocks refreshTranscript names", async () => {
		// Regression guard: a refresh re-asking (and possibly replaying) blocks it did not name, or
		// missing the ones it did, when the presenter's own state changed.
		const finished = new Set<string>();
		const { runner } = await installExtensions(
			presenter(block =>
				block.type !== "toolCall"
					? undefined
					: finished.has(block.id)
						? "hidden"
						: { compact: { label: `ROW-${block.id}` } },
			),
		);
		appendToolCall("call1", 10);
		appendToolCall("call2", 20);
		await start();
		await mode.renderInitialMessages();
		expect(chat()).toContain("ROW-call1");
		expect(chat()).toContain("ROW-call2");

		finished.add("call1");
		finished.add("call2");
		runner.getUIContext().refreshTranscript(["call1"]);
		expect(chat()).not.toContain("ROW-call1");
		expect(chat()).not.toContain("OUTPUT-call1");
		expect(chat()).toContain("ROW-call2");
	});

	it("draws a collab guest's transcript with stock cards, and the local presenters again after leaving", async () => {
		// Regression guard: the local session's presenters drawing the host's transcript, whose runs
		// they never see, or the restored local transcript staying stock after leaving.
		const asked: string[] = [];
		await installExtensions(
			presenter(block => {
				if (block.type !== "toolCall") return undefined;
				asked.push(block.id);
				return { compact: { label: `ROW-${block.id}` } };
			}),
		);
		appendToolCall("local1", 10);
		await start();
		await mode.renderInitialMessages();
		expect(chat()).toContain("ROW-local1");
		// The joined replica's file goes under the config root.
		vi.spyOn(piUtils, "getConfigRootDir").mockReturnValue(tempDir.path());
		installInMemoryRelay();
		const roomId = "transcript-presenter-guest";
		const roomKey = generateRoomKey();
		const hostSocket = new CollabSocket({
			wsUrl: `ws://localhost:8788/r/${roomId}`,
			role: "host",
			key: await importRoomKey(roomKey),
		});
		const hostOpen = Promise.withResolvers<void>();
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t !== "hello") return;
			hostSocket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "host-session", timestamp: "2026-11-03T00:00:00Z", cwd: "/tmp" },
				state: {
					isStreaming: false,
					queuedMessageCount: 0,
					sessionName: "host session",
					cwd: "/tmp",
					participants: [{ name: "Host", role: "host" }],
				},
				agents: [],
				entryCount: 0,
			} as CollabFrame);
		};
		hostSocket.connect();
		await hostOpen.promise;
		const guest = new CollabGuestLink(mode);
		try {
			const joined = guest.join(formatCollabLink("ws://localhost:8788", roomId, roomKey));
			// The guest claims the process before connecting; the local transcript keeps its drawing meanwhile.
			expect(chat()).toContain("ROW-local1");
			await joined;
			const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
			const card = new ToolExecutionComponent("bash", { command: "echo host1" }, {}, undefined, ui, "/tmp", "host1");
			card.setArgsComplete("host1");
			card.setExecutionStarted("host1");
			card.updateResult({ content: [{ type: "text", text: "OUTPUT-host1" }], isError: false });
			mode.chatContainer.addChild(card);
			expect(chat()).toContain("OUTPUT-host1");
			expect(asked).not.toContain("host1");

			await guest.leave("test");
			expect(chat()).toContain("ROW-local1");
		} finally {
			await guest.leave("test cleanup").catch(() => {});
			hostSocket.close();
			uninstallInMemoryRelay();
		}
	});

	it("draws a focused subagent's transcript with stock cards, and the main presenters again on return", async () => {
		// Regression guard: presenters (the main session's or the subagent's own) drawing a focused
		// subagent's transcript, whose runs the main session's settle never sees.
		await installExtensions(
			presenter(block => (block.type === "toolCall" ? { compact: { label: `ROW-${block.id}` } } : undefined)),
		);
		appendToolCall("main1", 10);
		await start();
		await mode.renderInitialMessages();
		expect(chat()).toContain("ROW-main1");
		const childDir = path.join(tempDir.path(), "child");
		const child = new AgentSession({
			agent: new Agent({
				initialState: { model: session.model!, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(childDir, childDir),
			settings: Settings.isolated(),
			modelRegistry,
		});
		try {
			await installExtensionsOn(
				child,
				presenter(() => "hidden"),
			);
			appendToolCall("kid1", 10, child);
			// The view switches to the subagent, as focusing it does, and replays its transcript.
			Object.defineProperty(mode, "viewSession", { configurable: true, get: () => child });
			await mode.renderInitialMessages();
			expect(chat()).toContain("OUTPUT-kid1");
			expect(chat()).not.toContain("ROW-kid1");

			// Focus returns to the main session.
			Reflect.deleteProperty(mode, "viewSession");
			await mode.renderInitialMessages();
			expect(chat()).toContain("ROW-main1");
		} finally {
			await child.dispose();
		}
	});

	it("repaints a changed block that is still on screen without replaying the scrollback", async () => {
		// Regression guard: every presenter change erasing and replaying native history (slow on long sessions).
		let hidden = false;
		const { runner } = await installExtensions(
			presenter(block => (block.type !== "toolCall" ? undefined : hidden ? "hidden" : "compact")),
		);
		appendToolCall("call1", 10);
		appendReply("Answer here.", 20);
		await start();
		await mode.renderInitialMessages();
		await term.waitForRender(() => screen().includes("Answer here."));
		expect(screen()).toContain("echo call1");

		const resets = vi.spyOn(mode.ui, "resetDisplay");
		hidden = true;
		runner.getUIContext().refreshTranscript(["call1"]);
		await term.waitForRender(() => !screen().includes("echo call1"));
		expect(screen()).not.toContain("echo call1");
		expect(screen()).toContain("Answer here.");
		expect(resets).not.toHaveBeenCalled();
	});

	it("replays the scrollback once when a changed block already has rows in it, keeping earlier history", async () => {
		// Regression guard: a block hidden after it scrolled into terminal history staying there
		// forever, or the replay losing the history above it.
		let hidden = false;
		const { runner } = await installExtensions(
			presenter(block =>
				block.type !== "toolCall" ? undefined : hidden ? "hidden" : { compact: { label: `ROW-${block.id}` } },
			),
		);
		appendReply("First reply.", 1);
		appendToolCall("call1", 10);
		appendToolCall("call2", 12);
		for (let index = 0; index < 20; index++) appendReply(`Filler paragraph ${index}.`, 100 + index);
		// A short screen, so the calls scroll into terminal history whatever the welcome banner's height.
		term.resize(120, 12);
		await start();
		await mode.renderInitialMessages();
		const buffer = () => plainRows(term.getScrollBuffer()).join("\n");
		// Retirement to scrollback is spread over frames; wait until the calls reached it.
		await term.waitForRender(() => screen().includes("Filler paragraph 19.") && buffer().includes("ROW-call1"));
		expect(screen()).not.toContain("ROW-call1");
		expect(buffer()).toContain("ROW-call1");

		const resets = vi.spyOn(mode.ui, "resetDisplay");
		const emissions = vi.spyOn(mode.chatContainer, "resetStableEmission");
		hidden = true;
		runner.getUIContext().refreshTranscript(["call1", "call2"]);
		await term.waitForRender(() => !buffer().includes("ROW-call1"));
		expect(resets).toHaveBeenCalledTimes(1);
		expect(emissions).toHaveBeenCalledTimes(1);
		expect(buffer()).not.toContain("ROW-call1");
		expect(buffer()).not.toContain("ROW-call2");
		expect(buffer()).toContain("First reply.");
		expect(buffer()).toContain("Filler paragraph 0.");
	});

	it("replays a retired block whose late result changed its presentation before the refresh", async () => {
		// Regression guard: a late result marking the presentation stale, and the refresh then
		// comparing the new answer against itself, leaving the old compact row in scrollback.
		const { runner } = await installExtensions(
			presenter(block => {
				if (block.type !== "toolCall") return undefined;
				const late = JSON.stringify(block.result?.content ?? []).includes("LATE");
				return late ? "hidden" : { compact: { label: `ROW-${block.id}` } };
			}),
		);
		appendReply("First reply.", 1);
		appendToolCall("call1", 10);
		for (let index = 0; index < 20; index++) appendReply(`Filler paragraph ${index}.`, 100 + index);
		term.resize(120, 12);
		await start();
		await mode.renderInitialMessages();
		const buffer = () => plainRows(term.getScrollBuffer()).join("\n");
		await term.waitForRender(() => screen().includes("Filler paragraph 19.") && buffer().includes("ROW-call1"));
		const tool = mode.chatContainer.children.find(child => child instanceof ToolExecutionComponent);
		if (!(tool instanceof ToolExecutionComponent)) throw new Error("Expected the call's card");

		const resets = vi.spyOn(mode.ui, "resetDisplay");
		tool.updateResult({ content: [{ type: "text", text: "LATE" }], isError: false });
		mode.ui.requestRender();
		await term.waitForRender();
		// The late result already replayed; the refresh must not replay a second time.
		runner.getUIContext().refreshTranscript(["call1"]);
		await term.waitForRender(() => !buffer().includes("ROW-call1"));
		expect(resets).toHaveBeenCalledTimes(1);
		expect(buffer()).not.toContain("ROW-call1");
		expect(buffer()).toContain("First reply.");
	});

	it("replays once when a block split across scrollback and the screen draws its late result live", async () => {
		// Regression guard: a live frame drawing the block's new presentation, so the later refresh
		// saw nothing changed and its committed head stayed in scrollback.
		const rows = Array.from({ length: 20 }, (_, index) => `ROWLINE-${index}`);
		const { runner } = await installExtensions(
			presenter(block => {
				if (block.type !== "toolCall") return undefined;
				const late = JSON.stringify(block.result?.content ?? []).includes("LATE");
				return late ? "hidden" : { compact: { label: `ROW-${block.id}`, rows } };
			}),
		);
		appendReply("First reply.", 1);
		appendToolCall("call1", 10);
		appendReply("Last reply.", 30);
		term.resize(120, 12);
		await start();
		await mode.renderInitialMessages();
		const buffer = () => plainRows(term.getScrollBuffer()).join("\n");
		const card = () => mode.chatContainer.children.find(child => child instanceof ToolExecutionComponent);
		// Retirement is spread over frames: wait until the card's head is committed (split), its tail live.
		await term.waitForRender(() => {
			const shown = card();
			return (
				screen().includes("Last reply.") &&
				buffer().includes("ROW-call1") &&
				shown !== undefined &&
				!mode.chatContainer.canRemoveBlock(shown)
			);
		});
		const tool = card();
		if (!(tool instanceof ToolExecutionComponent)) throw new Error("Expected the call's card");
		expect(mode.chatContainer.canRemoveBlock(tool)).toBe(false);
		expect(screen()).toContain("ROWLINE-19");

		const resets = vi.spyOn(mode.ui, "resetDisplay");
		tool.updateResult({ content: [{ type: "text", text: "LATE" }], isError: false });
		mode.ui.requestRender();
		await term.waitForRender(() => !buffer().includes("ROW-call1"));
		runner.getUIContext().refreshTranscript(["call1"]);
		await term.waitForRender();
		expect(resets).toHaveBeenCalledTimes(1);
		expect(buffer()).not.toContain("ROW-call1");
		expect(buffer()).toContain("First reply.");
	});

	it("replays once for late results that land on retired blocks in separate ticks before the next frame", async () => {
		// Regression guard: each background result landing on a block already in scrollback
		// replaying the whole transcript on its own.
		await installExtensions(
			presenter(block => {
				if (block.type !== "toolCall") return undefined;
				const late = JSON.stringify(block.result?.content ?? []).includes("LATE");
				return late ? "hidden" : { compact: { label: `ROW-${block.id}` } };
			}),
		);
		appendReply("First reply.", 1);
		for (const [index, id] of ["call1", "call2", "call3"].entries()) appendToolCall(id, 10 + index * 2);
		for (let index = 0; index < 20; index++) appendReply(`Filler paragraph ${index}.`, 100 + index);
		term.resize(120, 12);
		await start();
		await mode.renderInitialMessages();
		const buffer = () => plainRows(term.getScrollBuffer()).join("\n");
		await term.waitForRender(() => screen().includes("Filler paragraph 19.") && buffer().includes("ROW-call3"));
		const tools = mode.chatContainer.children.filter(child => child instanceof ToolExecutionComponent);
		expect(tools).toHaveLength(3);

		const resets = vi.spyOn(mode.ui, "resetDisplay");
		// A 200 ms frame, so a loaded runner still lands all three results inside it.
		const fps = 1000 / minFrameIntervalMs();
		setMaxFps(5);
		try {
			for (const tool of tools) {
				tool.updateResult({ content: [{ type: "text", text: "LATE" }], isError: false });
				// The next result lands in a later event-loop turn, as background results do.
				const tick = Promise.withResolvers<void>();
				setImmediate(tick.resolve);
				await tick.promise;
			}
			await term.waitForRender(() => !buffer().includes("ROW-call"));
		} finally {
			setMaxFps(fps);
		}
		expect(resets).toHaveBeenCalledTimes(1);
		expect(buffer()).toContain("First reply.");
	});

	it("never replays in a natively drawn transcript", async () => {
		// Regression guard: Tern, which keeps no terminal history, paying for a full replay.
		let hidden = false;
		const { runner } = await installExtensions(
			presenter(block => (block.type !== "toolCall" ? undefined : hidden ? "hidden" : "compact")),
		);
		appendToolCall("call1", 10);
		for (let index = 0; index < 40; index++) appendReply(`Filler paragraph ${index}.`, 100 + index);
		await start();
		await mode.renderInitialMessages();
		await term.waitForRender(() => screen().includes("Filler paragraph 39."));

		setNativeRendering(true);
		await Promise.resolve();
		const resets = vi.spyOn(mode.ui, "resetDisplay");
		hidden = true;
		runner.getUIContext().refreshTranscript(["call1"]);
		expect(resets).not.toHaveBeenCalled();
		expect(chat()).not.toContain("echo call1");
	});

	it("asks presenters only while the opt-in setting is on, redrawing the transcript when it flips", async () => {
		// Regression guard: an installed extension changing the transcript without the user opting in,
		// or flipping the setting leaving the old drawing on screen.
		await installExtensions(
			presenter(block => (block.type === "toolCall" ? { compact: { label: `ROW-${block.id}` } } : undefined)),
		);
		cfgExtensionTranscriptPresenters.set(mode.settings, false);
		appendToolCall("call1", 10);
		await start();
		await mode.renderInitialMessages();
		expect(chat()).toContain("OUTPUT-call1");
		expect(chat()).not.toContain("ROW-call1");

		cfgExtensionTranscriptPresenters.set(mode.settings, true);
		await Promise.resolve();
		expect(chat()).toContain("ROW-call1");
		cfgExtensionTranscriptPresenters.set(mode.settings, false);
		await Promise.resolve();
		expect(chat()).toContain("OUTPUT-call1");
	});

	it("restores omp's own drawing when the presenter is disposed", async () => {
		// Regression guard: an unloaded or toggled-off plugin leaving its compact rows behind.
		let dispose: (() => void) | undefined;
		await installExtensions(pi => {
			dispose = pi.registerTranscriptPresenter(block =>
				block.type === "toolCall" ? { compact: { label: `ROW-${block.id}` } } : undefined,
			);
		});
		appendToolCall("call1", 10);
		await start();
		await mode.renderInitialMessages();
		expect(chat()).toContain("ROW-call1");

		dispose!();
		expect(chat()).not.toContain("ROW-call1");
		expect(chat()).toContain("OUTPUT-call1");
	});

	it("installs the presenter of an extension bound after startup", async () => {
		// Regression guard: `-e` and plugin extensions load deferred, after interactive mode
		// installed the presenters, and their presenter was never asked.
		const { runner } = await installExtensions();
		appendToolCall("call1", 10);
		await start();
		await mode.renderInitialMessages();
		expect(chat()).toContain("OUTPUT-call1");

		const deferred = await loadExtensionFromFactory(
			presenter(block => (block.type === "toolCall" ? { compact: { label: `ROW-${block.id}` } } : undefined)),
			tempDir.path(),
			eventBus,
			new ExtensionRuntime(),
			"/ext/deferred.ts",
		);
		await runner.addExtensions([deferred]);
		expect(chat()).toContain("ROW-call1");
		expect(chat()).not.toContain("OUTPUT-call1");
	});

	it("leaves the transcript alone when another session's runner registers a presenter", async () => {
		// Regression guard: an unfocused subagent binding its extensions re-asking (and replaying)
		// the viewed transcript although its presenter set did not change.
		let asked = 0;
		await installExtensions(
			presenter(block => {
				if (block.type !== "toolCall") return undefined;
				asked++;
				return { compact: { label: `ROW-${block.id}` } };
			}),
		);
		appendToolCall("call1", 10);
		await start();
		await mode.renderInitialMessages();
		expect(chat()).toContain("ROW-call1");
		const before = asked;
		const resets = vi.spyOn(mode.ui, "resetDisplay");

		// A child session's extension, loaded through the same process-wide registry.
		await loadExtensionFromFactory(
			presenter(() => "hidden"),
			tempDir.path(),
			eventBus,
			new ExtensionRuntime(),
			"/ext/child.ts",
		);
		expect(asked).toBe(before);
		expect(resets).not.toHaveBeenCalled();
		expect(chat()).toContain("ROW-call1");
	});

	it("presents advisor, skill and background-job blocks as message blocks, full again when expanded", async () => {
		// Regression guard: non-tool cards staying full while every tool call is compact, or a
		// compact one that Ctrl+O cannot open.
		await installExtensions(
			presenter(block =>
				block.type === "message" && block.message.role === "custom"
					? { compact: { label: `MSG-${block.message.customType}` } }
					: undefined,
			),
		);
		const custom = (customType: string, details: unknown, timestamp: number) =>
			session.sessionManager.appendMessage({
				role: "custom",
				customType,
				content: "body",
				display: true,
				details,
				timestamp,
			});
		custom("advisor", { notes: [{ note: "ADVISOR-NOTE" }] }, 10);
		custom("skill-prompt", { name: "demo-skill", path: "/skills/demo/SKILL.md", lineCount: 1 }, 20);
		custom("async-result", { jobId: "bg-7", type: "bash", durationMs: 1200 }, 30);
		await start();
		await mode.renderInitialMessages();
		for (const type of ["advisor", "skill-prompt", "async-result"]) expect(chat()).toContain(`MSG-${type}`);
		expect(chat()).not.toContain("ADVISOR-NOTE");
		expect(chat()).not.toContain("Background job completed");

		mode.setToolsExpanded(true);
		expect(chat()).not.toContain("MSG-");
		expect(chat()).toContain("ADVISOR-NOTE");
		expect(chat()).toContain("Background job completed");
	});

	/** Answer every `!` run with `LIVE-OUT` instead of running a shell, once `ready` (if any) resolves. */
	function stubShell(ready?: () => Promise<void>): void {
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			await ready?.();
			return {
				output: "LIVE-OUT",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 8,
				outputLines: 1,
				outputBytes: 8,
			};
		});
	}

	/** Run `command` as a `!` run while the agent streams: it waits outside the transcript. */
	async function runBashMidRun(command: string): Promise<void> {
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		try {
			await mode.handleBashCommand(command);
		} finally {
			Reflect.deleteProperty(session, "isStreaming");
		}
	}

	it("gives a live `!` run the id its resumed block gets", async () => {
		// Regression guard: a presenter keying its choice by block id losing it on resume, because the
		// live block and the recorded message disagree on the id.
		const ids: string[] = [];
		await installExtensions(pi => {
			pi.registerTranscriptPresenter(block => {
				if (block.type === "message" && block.message.role === "bashExecution") ids.push(block.id);
				return undefined;
			});
		});
		stubShell();
		await start();
		await mode.handleBashCommand("echo live");
		mode.chatContainer.render(120);
		const recorded = session.sessionManager
			.getEntries()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "bashExecution" ? [entry.message] : []));
		expect(recorded).toHaveLength(1);
		const recordedId = String(recorded[0]!.timestamp);
		expect(ids.at(-1)).toBe(recordedId);

		ids.length = 0;
		await mode.renderInitialMessages();
		mode.chatContainer.render(120);
		expect(ids).toEqual([recordedId]);
	});

	it("asks a `!` run waiting outside the transcript again when refreshTranscript names it", async () => {
		// Regression guard: a refresh visiting only the transcript, so a `!` run queued mid-run kept
		// its old drawing and carried it into the transcript.
		let label = "BEFORE-ROW";
		let runId: string | undefined;
		const { runner } = await installExtensions(
			presenter(block => {
				if (block.type !== "message" || block.message.role !== "bashExecution") return undefined;
				runId = block.id;
				return { compact: { label } };
			}),
		);
		stubShell();
		await start();
		await runBashMidRun("echo live");
		const pending = () => plainRows(mode.pendingShellContainer.render(120)).join("\n");
		expect(pending()).toContain("BEFORE-ROW");

		label = "AFTER-ROW";
		runner.getUIContext().refreshTranscript([runId!]);
		expect(pending()).toContain("AFTER-ROW");
		mode.flushPendingBashComponents();
		expect(chat()).toContain("AFTER-ROW");
		expect(chat()).not.toContain("BEFORE-ROW");
	});

	it("draws a `!` run in full while every block is expanded, live and resumed", async () => {
		// Regression guard: Ctrl+O opening every block but a `!` run, which a presenter kept compact.
		await installExtensions(
			presenter(block =>
				block.type === "message" && block.message.role === "bashExecution"
					? { compact: { label: "RUN-ROW" } }
					: undefined,
			),
		);
		await start();
		mode.setToolsExpanded(true);
		await mode.handleBashCommand("echo live");
		expect(chat()).not.toContain("RUN-ROW");
		expect(chat()).toContain("$ echo live");

		await mode.renderInitialMessages();
		expect(chat()).not.toContain("RUN-ROW");
		expect(chat()).toContain("$ echo live");
	});

	it("replays a retired message block when the presenter's answer for it changes", async () => {
		// Regression guard: a message block's refresh comparing against an answer it never drew,
		// so `refreshTranscript` left its old compact row in scrollback.
		let hidden = false;
		const { runner } = await installExtensions(
			presenter(block =>
				block.type === "message" && block.message.role === "custom"
					? hidden
						? "hidden"
						: { compact: { label: "MSG-ROW" } }
					: undefined,
			),
		);
		appendReply("First reply.", 1);
		session.sessionManager.appendMessage({
			role: "custom",
			customType: "advisor",
			content: "body",
			display: true,
			details: { notes: [] },
			timestamp: 10,
		});
		for (let index = 0; index < 20; index++) appendReply(`Filler paragraph ${index}.`, 100 + index);
		term.resize(120, 12);
		await start();
		await mode.renderInitialMessages();
		const buffer = () => plainRows(term.getScrollBuffer()).join("\n");
		await term.waitForRender(() => screen().includes("Filler paragraph 19.") && buffer().includes("MSG-ROW"));

		const resets = vi.spyOn(mode.ui, "resetDisplay");
		hidden = true;
		runner.getUIContext().refreshTranscript(["10"]);
		expect(resets).toHaveBeenCalledTimes(1);
		await term.waitForRender(() => !buffer().includes("MSG-ROW"));
		expect(buffer()).not.toContain("MSG-ROW");
		expect(buffer()).toContain("First reply.");
	});

	it("draws a compact `!` run's command without its control sequences", async () => {
		// Regression guard: omp's own compact head writing a recorded command's escape sequences
		// (a terminal title, a bell) straight to the terminal.
		await installExtensions(
			presenter(block =>
				block.type === "message" && block.message.role === "bashExecution" ? "compact" : undefined,
			),
		);
		session.sessionManager.appendMessage({
			role: "bashExecution",
			command: "echo \x1b]0;PWNED\x07hi\tthere",
			output: "OUT",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 10,
		});
		await start();
		await mode.renderInitialMessages();
		const rows = mode.chatContainer.render(120).join("\n");
		expect(rows).not.toContain("\x07");
		expect(rows).not.toContain("\x1b]0;");
		expect(Bun.stripANSI(rows)).toContain("echo hi there");
		expect(Bun.stripANSI(rows)).not.toContain("OUT");
	});
});
