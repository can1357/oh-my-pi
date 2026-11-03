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
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayShowTokenUsage } from "@oh-my-pi/pi-coding-agent/modes/settings";
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

	it("asks a run's blocks again once its agent_end handlers have settled", async () => {
		// Regression guard: re-asking when agent_end starts, before an async handler updated the
		// presenter's state, leaves a turn's routine calls compact instead of hidden.
		const gate = Promise.withResolvers<void>();
		let answered = false;
		const { runner } = await installExtensions(pi => {
			pi.registerTranscriptPresenter(block =>
				block.type !== "toolCall" ? undefined : answered ? "hidden" : { compact: { label: `ROW-${block.id}` } },
			);
			pi.on("agent_end", async () => {
				await gate.promise;
				answered = true;
			});
		});
		appendToolCall("call1", 10);
		await start();
		await mode.renderInitialMessages();
		expect(chat()).toContain("ROW-call1");

		const ended = runner.emit({ type: "agent_end", messages: [] });
		// The handler is now parked on the gate; nothing may have re-asked yet.
		await Promise.resolve();
		expect(chat()).toContain("ROW-call1");
		gate.resolve();
		await ended;
		expect(chat()).not.toContain("ROW-call1");
		expect(chat()).not.toContain("OUTPUT-call1");
	});

	/**
	 * Start a run as the session does: its `agent_start` reaches every session listener, the
	 * transcript's run tracking included. Call before {@link start}, which subscribes them.
	 */
	function captureRunStarts(): () => void {
		const sessionListeners: Array<Parameters<AgentSession["subscribe"]>[0]> = [];
		const subscribe = session.subscribe.bind(session);
		vi.spyOn(session, "subscribe").mockImplementation(listener => {
			sessionListeners.push(listener);
			return subscribe(listener);
		});
		return () => {
			for (const listener of sessionListeners) void listener({ type: "agent_start" });
		};
	}

	/**
	 * A presenter recording the ids it is asked about (plus `extra` extensions), a way to start a
	 * run, a way to run one call, and a way to end a run as the session does: its terminal
	 * `agent_end` reaches the transcript first, then the extensions' broadcast starts.
	 */
	async function runHarness(...extra: ExtensionFactory[]) {
		const asked: string[] = [];
		const { runner } = await installExtensions(
			presenter(block => {
				if (block.type !== "toolCall") return undefined;
				asked.push(block.id);
				return "compact";
			}),
			...extra,
		);
		const startRun = captureRunStarts();
		await start();
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const addCard = (id: string): void => {
			const card = new ToolExecutionComponent("bash", { command: `echo ${id}` }, {}, undefined, ui, "/tmp", id);
			card.setArgsComplete(id);
			card.setExecutionStarted(id);
			card.updateResult({ content: [{ type: "text", text: `OUTPUT-${id}` }], isError: false });
			mode.chatContainer.addChild(card);
			chat();
		};
		const runCall = (id: string): void => {
			startRun();
			addCard(id);
		};
		const endRun = async (): Promise<void> => {
			await mode.eventController.handleEvent({ type: "agent_end", messages: [] });
			return runner.emit({ type: "agent_end", messages: [] }).then(() => {});
		};
		return { asked, runner, runCall, startRun, addCard, endRun };
	}

	it("asks only the latest run's blocks when the next run settles", async () => {
		// Regression guard: an ended run's boundary surviving, so the next run's settle re-asked
		// earlier turns.
		const { asked, runCall, endRun } = await runHarness();
		runCall("run1");
		await endRun();

		runCall("run2");
		asked.length = 0;
		await endRun();
		expect(asked).toEqual(["run2"]);
	});

	it("asks each run's own blocks when a later run settles before an earlier one", async () => {
		// Regression guard: run 1's slow agent_end handler settling after run 2 started, and the
		// settle reading run 2's boundary: run 2's calls re-asked, run 1's never.
		const gate = Promise.withResolvers<void>();
		let calls = 0;
		const { asked, runner, runCall, endRun } = await runHarness(pi => {
			pi.on("agent_end", async () => {
				if (calls++ === 0) await gate.promise;
			});
		});
		runCall("run1");
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] });
		// Run 1's broadcast starts; its handler is parked on the gate.
		const first = runner.emit({ type: "agent_end", messages: [] });

		runCall("run2");
		asked.length = 0;
		await endRun();
		expect(asked).toEqual(["run2"]);

		asked.length = 0;
		gate.resolve();
		await first;
		expect(asked).toEqual(["run1"]);
	});

	it("starts a new run after a terminal settle the transcript's own agent_end never finalized", async () => {
		// Regression guard: the boundary ending only through the UI's teardown, which an end
		// re-tagged as a continuation never reaches, so later settles re-asked every earlier run.
		const { asked, runner, runCall } = await runHarness();
		runCall("run1");
		await runner.emit({ type: "agent_end", messages: [] });

		runCall("run2");
		asked.length = 0;
		await runner.emit({ type: "agent_end", messages: [] });
		expect(asked).toEqual(["run2"]);
	});

	it("asks a run's blocks the transcript added after its broadcast started, and nothing for an empty run", async () => {
		// Regression guard: a run's span fixed when its broadcast started, missing its last cards the
		// UI added afterwards, and an empty run's settle re-asking a later run's blocks.
		// Each broadcast's handler waits on the next gate in line.
		const gates: Array<Promise<void>> = [];
		const { asked, runner, runCall, startRun, addCard } = await runHarness(pi => {
			pi.on("agent_end", async () => {
				await gates.shift();
			});
		});
		const gate = Promise.withResolvers<void>();
		gates.push(gate.promise);
		runCall("run1");
		const first = runner.emit({ type: "agent_end", messages: [] });
		// The UI lands the run's last card after the broadcast started.
		addCard("late1");
		asked.length = 0;
		gate.resolve();
		await first;
		expect(asked.sort()).toEqual(["late1", "run1"]);

		// An empty run whose settle is slow while the next run adds its cards.
		const emptyGate = Promise.withResolvers<void>();
		gates.push(emptyGate.promise);
		startRun();
		const empty = runner.emit({ type: "agent_end", messages: [] });
		runCall("run3");
		asked.length = 0;
		emptyGate.resolve();
		await empty;
		expect(asked).toEqual([]);
	});

	it("asks only the latest run's blocks after a continuing run ended without another agent_end", async () => {
		// Regression guard: a settle announcing a continuation that was then cancelled (a retry, a
		// background wait) leaving its boundary set, so the next run's settle re-asked earlier turns.
		const { asked, runner, runCall } = await runHarness();
		runCall("run1");
		await runner.emit({ type: "agent_end", messages: [], willContinue: true });
		// The continuation never starts; the run is finalized as the cancel paths do.
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] });

		runCall("run2");
		asked.length = 0;
		await runner.emit({ type: "agent_end", messages: [] });
		expect(asked).toEqual(["run2"]);
	});

	it("asks only the latest run's blocks when a live setting rebuilt the transcript during that run", async () => {
		// Regression guard: a rebuild mid-run (display.showTokenUsage toggled) replacing earlier runs'
		// blocks with new components, which the run's settle then took for its own and asked again.
		const { asked, startRun, endRun } = await runHarness();
		startRun();
		appendToolCall("run1", 10);
		await mode.renderInitialMessages();
		await endRun();

		startRun();
		appendToolCall("run2", 20);
		const earlier = mode.chatContainer.children.find(child => child instanceof ToolExecutionComponent);
		cfgDisplayShowTokenUsage.set(mode.settings, true);
		// The setting applies on the next microtask, building every block anew from the session.
		await Promise.resolve();
		expect(earlier).toBeDefined();
		expect(mode.chatContainer.children).not.toContain(earlier);
		chat();
		asked.length = 0;
		await endRun();
		expect(asked).toEqual(["run2"]);
	});

	it("keeps a settled run's calls hidden when a live setting rebuilds the transcript during the next run", async () => {
		// Regression guard: presenter state reset per run (the old docs example) showing an earlier
		// run's hidden calls again once a rebuild asked anew; state keyed by block id answers the same.
		const finished = new Set<string>();
		const { runner } = await installExtensions(pi => {
			pi.on("agent_end", event => {
				for (const message of event.messages) {
					if (message.role !== "assistant") continue;
					for (const part of message.content) if (part.type === "toolCall") finished.add(part.id);
				}
			});
			pi.registerTranscriptPresenter(block =>
				block.type !== "toolCall"
					? undefined
					: finished.has(block.id)
						? "hidden"
						: { compact: { label: `ROW-${block.id}` } },
			);
		});
		const startRun = captureRunStarts();
		await start();
		startRun();
		const run1 = appendToolCall("run1", 10);
		await mode.renderInitialMessages();
		expect(chat()).toContain("ROW-run1");
		await mode.eventController.handleEvent({ type: "agent_end", messages: [run1] });
		await runner.emit({ type: "agent_end", messages: [run1] });
		expect(chat()).not.toContain("ROW-run1");

		startRun();
		appendToolCall("run2", 20);
		const earlier = mode.chatContainer.children.find(child => child instanceof ToolExecutionComponent);
		cfgDisplayShowTokenUsage.set(mode.settings, true);
		// The setting applies on the next microtask, building every block anew from the session.
		await Promise.resolve();
		expect(mode.chatContainer.children).not.toContain(earlier);
		expect(chat()).toContain("ROW-run2");
		expect(chat()).not.toContain("ROW-run1");
		expect(chat()).not.toContain("OUTPUT-run1");
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

	for (const refreshSameTick of [false, true]) {
		it(`replays once when a fully retired block's late final result changes its presentation${refreshSameTick ? ", even with a refresh in the same tick" : ""}`, async () => {
			// Regression guard: a retired card never drawn again, so its late result left the old row in
			// scrollback with no refresh or agent_end to ask again; and a refresh in the same tick
			// replaying it a second time.
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
			expect(mode.chatContainer.canRemoveBlock(tool)).toBe(false);

			const resets = vi.spyOn(mode.ui, "resetDisplay");
			tool.updateResult({ content: [{ type: "text", text: "LATE" }], isError: false });
			if (refreshSameTick) runner.getUIContext().refreshTranscript(["call1"]);
			await term.waitForRender(() => !buffer().includes("ROW-call1"));
			await Promise.resolve();
			expect(resets).toHaveBeenCalledTimes(1);
			expect(buffer()).not.toContain("ROW-call1");
			expect(buffer()).toContain("First reply.");
		});
	}

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
});
