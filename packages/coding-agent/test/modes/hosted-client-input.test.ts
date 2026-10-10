/**
 * A TUI that is a client of a session host sends its input there and runs nothing of its own: the host's session
 * is the only one that executes, and the local `AgentSession` is an idle replica of it. Real hosts, links, editors
 * and controllers; the local engine is observed through spies on the replica's own mutating methods.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ExtensionRuntime,
	ExtensionRuntimeNotInitializedError,
	loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { privateEndpoint } from "@oh-my-pi/pi-coding-agent/ipc/private-endpoint";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgCompletionNotify, cfgLoopMode, cfgStartupQuiet } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { listSessionRecaps, resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { HostedClientLink } from "@oh-my-pi/pi-coding-agent/session-host/hosted-client";
import { newHostId, type SessionHostEntry } from "@oh-my-pi/pi-coding-agent/session-host/registry";
import { cfgTasksTodoClearDelay } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import type { Component } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { drive, driveTurn, elapse, flush, nextIdleRecap, until, wait } from "../helpers/fake-clock";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { createTestSession } from "../helpers/rpc-server-harness";
import { listTree, SessionHostFixture, type TestSessionHost, waitFor } from "../helpers/session-host-harness";

const CTRL_ENTER = "\x1b[13;5u";
const PIXEL: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
};

let fixture: SessionHostFixture;
const gates: PromiseWithResolvers<void>[] = [];
const inputs: HostedInput[] = [];
/** Stops for the hosts a test started itself; they run once every client of the host has left. */
const hostStops: (() => Promise<void>)[] = [];

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	fixture = await SessionHostFixture.create();
});

afterEach(async () => {
	vi.restoreAllMocks();
	// A held host reply must finish before its host can be stopped.
	for (const gate of gates.splice(0)) gate.resolve();
	for (const input of inputs.splice(0)) await input.close();
	for (const stop of hostStops.splice(0)) await stop();
	await fixture.dispose();
	resetSettingsForTest();
});

/** The text of every user message a session holds, oldest first. */
function userTexts(session: AgentSession): string[] {
	return session.messages.flatMap(message => {
		if (message.role !== "user") return [];
		const blocks: readonly (TextContent | ImageContent)[] =
			typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		return [blocks.flatMap(block => (block.type === "text" ? [block.text] : [])).join("")];
	});
}

function userImageCount(session: AgentSession): number {
	return session.messages.reduce(
		(count, message) =>
			message.role === "user" && typeof message.content !== "string"
				? count + message.content.filter(block => block.type === "image").length
				: count,
		0,
	);
}

/** Which entries a session holds, in order: a local append the host never made breaks the match. */
function entryShape(session: AgentSession): string[] {
	return session.sessionManager
		.getEntries()
		.map(entry => `${entry.id}:${entry.type}:${entry.type === "message" ? entry.message.role : ""}`);
}

/** Start a host whose replies stay held mid-stream until the test (or its teardown) releases them. */
async function startHeldHost(): Promise<{ host: TestSessionHost; release: () => void }> {
	const gate = Promise.withResolvers<void>();
	gates.push(gate);
	return { host: await fixture.startHost({}, gate.promise), release: gate.resolve };
}

/** A spy, as far as these tests ask about it. */
interface Spy {
	readonly mock: { readonly calls: readonly unknown[] };
}

/**
 * A hosted TUI: a real editor and input controller over a real passive replica. `hostedClientMode` is on from the
 * start; the link joins once the host's first snapshot is applied, like the real startup.
 */
class HostedInput {
	readonly editor = new CustomEditor(getEditorTheme());
	readonly statuses: string[] = [];
	readonly errors: string[] = [];
	/** The labels of every selector the controllers opened, in order. */
	readonly selectors: string[][] = [];
	readonly overlays: Component[] = [];
	readonly closed: { hostAlive: boolean; message: string }[] = [];
	/** While set, the next repaint of the transcript waits for it: the view stays on the old session. */
	renderGate: PromiseWithResolvers<void> | undefined;
	link: HostedClientLink | undefined;
	readonly ctx: InteractiveModeContext;
	readonly controller: InputController;
	readonly commands = {
		handlePlanModeCommand: vi.fn<InteractiveModeContext["handlePlanModeCommand"]>(async () => true),
		handleClearCommand: vi.fn<InteractiveModeContext["handleClearCommand"]>(async () => {}),
		handleBashCommand: vi.fn<InteractiveModeContext["handleBashCommand"]>(async () => {}),
		handlePythonCommand: vi.fn<InteractiveModeContext["handlePythonCommand"]>(async () => {}),
		handleHotkeysCommand: vi.fn<InteractiveModeContext["handleHotkeysCommand"]>(() => {}),
		handleSessionCommand: vi.fn<InteractiveModeContext["handleSessionCommand"]>(async () => {}),
		handleLiveCommand: vi.fn<InteractiveModeContext["handleLiveCommand"]>(async () => {}),
	};
	/**
	 * The replica's own mutating entry points: none of them may run for anything a hosted client does. Spied only
	 * once the link has loaded its replica (that is itself a `switchSession` on the replica).
	 */
	localEngine: Record<string, Spy> = {};
	readonly #followUp;
	#enter: Promise<void> | undefined;
	#host: TestSessionHost | undefined;
	/** What the composer reads as the focused agent; the real controller never gets one while hosted. */
	readonly focused: { id?: string } = {};
	readonly registry = new AgentRegistry();
	readonly lifecycle = new AgentLifecycleManager(this.registry);
	/** Reviving a local agent: nothing a hosted client does may reach it. */
	readonly ensureLive = vi.spyOn(this.lifecycle, "ensureLive");

	private constructor(
		readonly local: AgentSession,
		readonly replicaDir: string,
	) {
		const editor = this.editor;
		const focused = this.focused;
		this.ctx = createInteractiveModeContext({
			get focusedAgentId() {
				return focused.id;
			},
			session: local,
			sessionManager: local.sessionManager,
			hostedClientMode: true,
			editor,
			ui: {
				addInputListener: vi.fn(),
				addStartListener: vi.fn(),
				getFocused: () => editor,
				hasOverlay: () => false,
				showOverlay: (component: Component) => {
					this.overlays.push(component);
					return { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false };
				},
				terminal: { write: vi.fn(), rows: 40 },
			},
			dictationSpaceHold: vi.fn(),
			lastSigintTime: 0,
			lastEscapeTime: 0,
			hasActiveBtw: () => false,
			hasActiveOmfg: () => false,
			hasActiveCleanse: () => false,
			handlesBtwBranchKey: () => false,
			isGuidedGoalInterviewActive: () => false,
			skillCommands: new Map(),
			fileSlashCommands: new Set(),
			compactionQueuedMessages: [],
			showStatus: message => void this.statuses.push(message),
			showError: message => void this.errors.push(message),
			showHookSelector: async (_title, options) => {
				this.selectors.push(options.map(option => (typeof option === "string" ? option : option.label)));
				return undefined;
			},
			eventController: {
				handleEvent: async () => {},
				resetTranscriptAnchors: () => {},
				takeDisplaceableComponents: () => [],
				restorePendingToolResults: () => {},
			},
			statusLine: { setCollabStatus: vi.fn() },
			renderInitialMessages: async () => {
				await this.renderGate?.promise;
			},
			...this.commands,
		});
		const helpers = new UiHelpers(this.ctx);
		const selector = new SelectorController(this.ctx);
		this.controller = new InputController(this.ctx);
		this.ctx.updatePendingMessagesDisplay = () => helpers.updatePendingMessagesDisplay();
		this.ctx.handleDequeue = () => this.controller.handleDequeue();
		this.ctx.showTreeSelector = () => selector.showTreeSelector();
		this.ctx.showUserMessageSelector = () => selector.showUserMessageSelector();
		this.ctx.showSessionSelector = source => void selector.showSessionSelector(source);
		this.ctx.showDebugSelector = () => selector.showDebugSelector();
		this.ctx.showSettingsSelector = () => selector.showSettingsSelector();
		this.ctx.showAgentHub = options => selector.showAgentHub(new SessionObserverRegistry(), options);
		this.ctx.showModelSelector = options => selector.showModelSelector(options);
		const focus = new SessionFocusController(this.ctx, this.registry, () => this.lifecycle);
		this.ctx.focusAgentSession = id => focus.focusAgent(id);
		this.#followUp = vi.spyOn(this.controller, "handleFollowUp");
		this.controller.setupKeyHandlers();
		this.controller.setupEditorSubmitHandler();
		const onSubmit = editor.onSubmit;
		editor.onSubmit = text => {
			this.#enter = Promise.resolve(onSubmit?.(text));
			return this.#enter;
		};
	}

	/** A hosted TUI on a fresh replica; joined to `host` when given, still initializing otherwise. */
	static async open(host?: TestSessionHost): Promise<HostedInput> {
		const dir = await fs.mkdtemp(path.join(fixture.dir, "input-"));
		const local = await createTestSession(dir, { handler: { content: ["never asked"] } }, undefined, {
			passiveReplica: true,
		});
		const input = new HostedInput(local, path.join(dir, "replicas"));
		inputs.push(input);
		if (host) await input.connect(host);
		input.watchLocalEngine();
		return input;
	}

	/** Join `host`; `entry` redirects the connection (through a tap, say) instead of the host's published endpoint. */
	async connect(host: TestSessionHost, entry?: SessionHostEntry): Promise<void> {
		this.#host = host;
		this.link = await HostedClientLink.connect({
			ctx: this.ctx,
			entry: entry ?? (await fixture.entry(host)),
			replicaDir: this.replicaDir,
			onClosed: reason => this.closed.push(reason),
		});
		this.ctx.hostedClient = this.link;
	}

	watchLocalEngine(): void {
		const local = this.local;
		this.localEngine = {
			prompt: vi.spyOn(local, "prompt"),
			steer: vi.spyOn(local, "steer"),
			followUp: vi.spyOn(local, "followUp"),
			abort: vi.spyOn(local, "abort"),
			setModel: vi.spyOn(local, "setModel"),
			setModelTemporary: vi.spyOn(local, "setModelTemporary"),
			setThinkingLevel: vi.spyOn(local, "setThinkingLevel"),
			cycleThinkingLevel: vi.spyOn(local, "cycleThinkingLevel"),
			cycleRoleModels: vi.spyOn(local, "cycleRoleModels"),
			compact: vi.spyOn(local, "compact"),
			newSession: vi.spyOn(local, "newSession"),
			switchSession: vi.spyOn(local, "switchSession"),
			clearQueue: vi.spyOn(local, "clearQueue"),
			popLastQueuedMessage: vi.spyOn(local, "popLastQueuedMessage"),
		};
	}

	get hostLink(): HostedClientLink {
		if (!this.link) throw new Error("not connected");
		return this.link;
	}

	/** Put `text` (and `images`) in the composer and press Enter. */
	async submit(text: string, images: ImageContent[] = []): Promise<void> {
		this.editor.pendingImages = [...images];
		this.editor.pendingImageLinks = images.map(() => undefined);
		this.editor.imageLinks = this.editor.pendingImageLinks;
		this.editor.setText(text);
		this.#enter = undefined;
		this.editor.handleInput("\r");
		if (!this.#enter) throw new Error("the editor did not submit");
		await this.#enter;
	}

	/** Put `text` (and `images`) in the composer and press Ctrl+Enter. */
	async followUp(text: string, images: ImageContent[] = []): Promise<void> {
		this.editor.pendingImages = [...images];
		this.editor.pendingImageLinks = images.map(() => undefined);
		this.editor.imageLinks = this.editor.pendingImageLinks;
		this.editor.setText(text);
		const calls = this.#followUp.mock.calls.length;
		this.editor.handleInput(CTRL_ENTER);
		if (this.#followUp.mock.calls.length !== calls + 1) throw new Error("the editor did not queue a follow-up");
		await (this.#followUp.mock.results[calls].value as Promise<void>);
	}

	/**
	 * A round trip on a connection of its own: the host has answered everything this client sent before it (its
	 * writes are all awaited by the time a gesture returns), so what the host holds now is what it will hold.
	 */
	async hostSawEverything(): Promise<void> {
		if (!this.#host) throw new Error("not connected");
		const client = await fixture.client(this.#host);
		await client.start();
		await client.getState();
	}

	expectNothingRanLocally(): void {
		for (const [name, spy] of Object.entries(this.localEngine))
			expect([name, spy.mock.calls.length]).toEqual([name, 0]);
		for (const [name, spy] of Object.entries(this.commands)) expect([name, spy.mock.calls.length]).toEqual([name, 0]);
	}

	async close(): Promise<void> {
		await this.link?.detach();
		await this.local.dispose();
	}
}

describe("a hosted client's input", () => {
	it("sends Enter to the host as one prompt and leaves the local session untouched", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		await input.submit("hello host");

		await waitFor(() => userTexts(host.session).includes("hello host"));
		await waitFor(() => host.session.messages.some(message => message.role === "assistant"));
		// The turn comes back as the host's events and entries; the replica never appended anything of its own.
		await waitFor(() => entryShape(input.local).join() === entryShape(host.session).join());
		expect(input.editor.getText()).toBe("");
		expect(input.errors).toEqual([]);
		input.expectNothingRanLocally();
	});

	it("sends an image-only draft with its image", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		await input.submit("[Image #1]", [PIXEL]);

		await waitFor(() => userImageCount(host.session) === 1);
		expect(input.editor.pendingImages).toEqual([]);
		input.expectNothingRanLocally();
	});

	it("steers on Enter and queues a follow-up on Ctrl+Enter while the host is mid-turn, and shows the host's queue", async () => {
		const { host } = await startHeldHost();
		const input = await HostedInput.open(host);
		await input.submit("first");
		await waitFor(() => input.hostLink.isStreaming);

		await input.submit("steered");
		await input.followUp("queued after");

		await waitFor(() => {
			const queued = host.session.getQueuedMessages();
			return queued.steering.includes("steered") && queued.followUp.includes("queued after");
		});
		// The pending band shows the host's queue; the replica has none of its own.
		expect(input.local.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		const band = () => Bun.stripANSI(input.ctx.pendingMessagesContainer.render(100).join("\n"));
		await waitFor(() => band().includes("steered") && band().includes("queued after"));
		input.expectNothingRanLocally();
	});

	it("takes the newest queued message back from the host into the editor", async () => {
		const { host } = await startHeldHost();
		const input = await HostedInput.open(host);
		await input.submit("first");
		await waitFor(() => input.hostLink.isStreaming);
		await input.followUp("later one");
		await input.followUp("later two");
		await waitFor(() => input.hostLink.queued.followUp.length === 2);
		input.editor.setText("typing");

		input.editor.onDequeue?.();
		await waitFor(() => input.editor.getText() !== "typing");

		// Newest first, and ahead of what is already being typed.
		expect(input.editor.getText()).toBe("later two\n\ntyping");
		await waitFor(() => host.session.getQueuedMessages().followUp.length === 1);
		expect(host.session.getQueuedMessages().followUp).toEqual(["later one"]);
		input.expectNothingRanLocally();
	});

	it("says there is nothing to take back when the host's queue is empty", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		input.editor.onDequeue?.();

		await waitFor(() => input.statuses.includes("No queued messages to restore"));
		input.expectNothingRanLocally();
	});

	it("takes the newest of equal queued messages back and keeps the older ones queued in their order", async () => {
		const { host } = await startHeldHost();
		const input = await HostedInput.open(host);
		await input.submit("first");
		await waitFor(() => input.hostLink.isStreaming);
		for (const text of ["A", "B", "A"]) await input.followUp(text);
		await waitFor(() => input.hostLink.queued.followUp.length === 3);

		input.editor.onDequeue?.();
		await waitFor(() => input.editor.getText() === "A");

		expect(host.session.getQueuedMessages().followUp).toEqual(["A", "B"]);
		input.expectNothingRanLocally();
	});

	it("leaves a queued image where it is, with or without a marker in its text, and says why", async () => {
		const { host } = await startHeldHost();
		const input = await HostedInput.open(host);
		await input.submit("first");
		await waitFor(() => input.hostLink.isStreaming);
		// Another client's prompts: a caption with no `[Image #N]` in it, then an image with no text (chip `[Image]`).
		const other = await fixture.client(host);
		await other.start();
		await other.prompt("look at this", [PIXEL], "followUp");
		await other.prompt("", [PIXEL], "followUp");
		await waitFor(() => input.hostLink.queued.followUp.length === 2);
		input.editor.setText("typing");
		const refusal = "That queued message has an attachment; it cannot be taken back when attached";

		input.editor.onDequeue?.();
		await waitFor(() => input.statuses.filter(status => status === refusal).length === 1);
		expect(host.session.getQueuedMessages().followUp).toEqual(["look at this", "[Image]"]);

		await other.removeQueuedMessage("[Image]", "followUp");
		await waitFor(() => input.hostLink.queued.followUp.length === 1);
		input.editor.onDequeue?.();
		await waitFor(() => input.statuses.filter(status => status === refusal).length === 2);

		expect(host.session.getQueuedMessages().followUp).toEqual(["look at this"]);
		expect(host.session.queuedMessageHasAttachments("look at this", "followUp")).toBe(true);
		expect(input.editor.getText()).toBe("typing");
		input.expectNothingRanLocally();
	});

	it("takes nothing back from a host that does not say which queued messages have attachments", async () => {
		const { host } = await startHeldHost();
		vi.spyOn(host.session, "getQueuedMessageAttachments").mockReturnValue({ steering: [], followUp: [] });
		const input = await HostedInput.open(host);
		await input.submit("first");
		await waitFor(() => input.hostLink.isStreaming);
		await input.followUp("later");
		await waitFor(() => input.hostLink.queued.followUp.length === 1);

		input.editor.onDequeue?.();

		await waitFor(() =>
			input.statuses.includes("This session host does not report queued attachments; nothing was taken back"),
		);
		expect(host.session.getQueuedMessages().followUp).toEqual(["later"]);
		expect(input.editor.getText()).toBe("");
	});

	it("interrupts the host's run on Esc, not the idle replica", async () => {
		const { host } = await startHeldHost();
		const hostAbort = vi.spyOn(host.session, "abort");
		const input = await HostedInput.open(host);
		await input.submit("first");
		await waitFor(() => input.hostLink.isStreaming);

		input.editor.onEscape?.();

		await waitFor(() => hostAbort.mock.calls.length === 1);
		input.expectNothingRanLocally();
	});

	it("runs a builtin the host can run on the host, with the submitted text and no prompt for the model", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		await input.submit("/session");
		await waitFor(() => input.statuses.some(status => status.includes(host.session.sessionId)));
		await input.submit("/rename Hosted title");
		await waitFor(() => host.session.sessionName === "Hosted title");

		await input.hostSawEverything();
		expect(userTexts(host.session)).toEqual([]);
		input.expectNothingRanLocally();
	});

	it("sends a command it does not know to the host as a normal prompt", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		await input.submit("/mytemplate with args");

		await waitFor(() => userTexts(host.session).includes("/mytemplate with args"));
		input.expectNothingRanLocally();
	});

	it("runs the local-only commands here and sends nothing for them", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		await input.submit("/hotkeys");

		expect(input.commands.handleHotkeysCommand).toHaveBeenCalledTimes(1);
		await input.hostSawEverything();
		expect(userTexts(host.session)).toEqual([]);
	});

	it("keeps a command that cannot run anywhere in the editor, with a status, and sends nothing", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		await input.submit("/plan build it");

		expect(input.statuses).toContain("/plan is unavailable when attached");
		expect(input.editor.getText()).toBe("/plan build it");
		await input.hostSawEverything();
		expect(userTexts(host.session)).toEqual([]);
		input.expectNothingRanLocally();
	});

	it("keeps a command's images with it when it cannot run", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		await input.submit("/plan see [Image #1]", [PIXEL]);

		expect(input.statuses).toContain("/plan is unavailable when attached");
		expect(input.editor.getExpandedText()).toBe("/plan see [Image #1]");
		expect(input.editor.pendingImages).toEqual([PIXEL]);
		await input.hostSawEverything();
		expect(userImageCount(host.session)).toBe(0);
	});

	// Arguments a builtin does not take make it "not a command" for an ordinary session, i.e. a prompt for the model.
	// For a hosted client that prompt would be the host's model.
	it.each([
		["/settings now", "/settings is unavailable when attached"],
		["/hotkeys now", "/hotkeys takes no arguments"],
		["/dirs now", "/dirs takes no arguments"],
	])("keeps %s with its image in the editor instead of handing it to the host's model", async (command, status) => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		await input.submit(`${command} [Image #1]`, [PIXEL]);

		expect(input.statuses).toContain(status);
		expect(input.editor.getExpandedText()).toBe(`${command} [Image #1]`);
		expect(input.editor.pendingImages).toEqual([PIXEL]);
		await input.hostSawEverything();
		expect(host.session.messages).toEqual([]);
		expect(userImageCount(host.session)).toBe(0);
		input.expectNothingRanLocally();
	});

	it("refuses local shell and python input, keeping the draft", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		await input.submit("!ls -la");
		expect(input.editor.getText()).toBe("!ls -la");
		input.editor.setText("");
		await input.submit("$ print(1)");
		expect(input.editor.getText()).toBe("$ print(1)");

		expect(input.statuses.filter(status => status === "Local execution is unavailable when attached")).toHaveLength(
			2,
		);
		await input.hostSawEverything();
		expect(userTexts(host.session)).toEqual([]);
		input.expectNothingRanLocally();
	});

	// A command with a secret in its arguments runs on the host; this client must not remember it.
	it("keeps a host-run command that carries a secret out of the saved and recalled history", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);
		const saved: string[] = [];
		input.editor.setHistoryStorage({ add: async prompt => void saved.push(prompt), getRecent: () => [] });

		await input.submit("recall me");
		await input.submit("/mcp add --token SECRET");

		expect(saved).toEqual(["recall me"]);
		input.editor.handleInput("\x1b[A");
		expect(input.editor.getText()).toBe("recall me");
	});

	it("refuses the queue shorthand and the continue shortcut instead of sending them as text", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		await input.submit("=> later");
		expect(input.editor.getText()).toBe("=> later");
		input.editor.setText("");
		await input.submit("c");
		expect(input.editor.getText()).toBe("c");

		expect(input.statuses).toContain("The continue shortcut is unavailable when attached");
		expect(input.statuses.some(status => status.startsWith("Queue shorthand is unavailable when attached"))).toBe(
			true,
		);
		await input.hostSawEverything();
		expect(userTexts(host.session)).toEqual([]);
		input.expectNothingRanLocally();
	});

	it("keeps the draft and runs nothing locally while the connection is not up", async () => {
		const input = await HostedInput.open();

		await input.submit("hello [Image #1]", [PIXEL]);
		expect(input.editor.getExpandedText()).toBe("hello [Image #1]");
		expect(input.editor.pendingImages).toEqual([PIXEL]);
		input.editor.setText("");
		await input.followUp("queued");

		expect(input.statuses.filter(status => status === "Not connected to the session host yet")).toHaveLength(2);
		expect(input.editor.getText()).toBe("queued");
		input.expectNothingRanLocally();
	});

	it("returns the draft, text and images, when the host moved past the view, and sends it once the view catches up", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);
		const staleEpoch = input.hostLink.epoch;
		input.renderGate = Promise.withResolvers<void>();
		await host.session.newSession();

		await input.submit("keep me [Image #1]", [PIXEL]);

		expect(input.errors).toHaveLength(1);
		expect(input.editor.getExpandedText()).toBe("keep me [Image #1]");
		expect(input.editor.pendingImages).toEqual([PIXEL]);
		expect(userTexts(host.session)).toEqual([]);
		input.renderGate.resolve();
		await waitFor(() => input.hostLink.epoch > staleEpoch);
		await input.submit("keep me [Image #1]", [PIXEL]);
		await waitFor(() => userTexts(host.session).includes("keep me [Image #1]"));
		expect(input.errors).toHaveLength(1);
	});
});

describe("a hosted client's focus", () => {
	/** A parked local agent, the kind a click on an inline card or the hub would revive. */
	function registerParked(input: HostedInput) {
		return input.registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "parked",
		});
	}

	it.each([
		["connected", true],
		["still connecting", false],
	])("refuses to focus a local agent while %s, without reviving it", async (_state, connected) => {
		const input = await HostedInput.open(connected ? await fixture.startHost() : undefined);
		const worker = registerParked(input);
		const refusal = "Viewing agents is unavailable when attached.";

		await expect(input.ctx.focusAgentSession("Worker")).rejects.toThrow(refusal);
		input.editor.onFocusAgent?.("Worker");
		await waitFor(() => input.statuses.includes(refusal));

		expect(input.ensureLive).not.toHaveBeenCalled();
		expect(worker.status).toBe("parked");
		expect(input.ctx.focusedAgentId).toBeUndefined();
		input.expectNothingRanLocally();
	});

	it("sends Enter and Ctrl+Enter to the host even when a local agent looks focused", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);
		input.focused.id = "Worker";

		await input.submit("to the host");
		await waitFor(() => userTexts(host.session).includes("to the host"));
		await input.followUp("and again");
		await waitFor(() => userTexts(host.session).includes("and again"));

		// A focused agent's submit would have gone to the view session: the replica's own prompt.
		input.expectNothingRanLocally();
		expect(input.ensureLive).not.toHaveBeenCalled();
	});

	it("keeps the draft of a submit that a focused local agent would have taken while the connection is not up", async () => {
		const input = await HostedInput.open();
		input.focused.id = "Worker";

		await input.submit("keep me");
		expect(input.editor.getText()).toBe("keep me");
		await input.followUp("and me");
		expect(input.editor.getText()).toBe("and me");

		expect(input.statuses.filter(status => status === "Not connected to the session host yet")).toHaveLength(2);
		input.expectNothingRanLocally();
	});
});

describe("a hosted client's controls", () => {
	it("cycles the host's thinking level, not the replica's", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);
		const before = host.session.thinkingLevel;

		input.editor.onCycleThinkingLevel?.();

		await waitFor(() => host.session.thinkingLevel !== before);
		// What the composer and border read is the session's own selector, not the raw agent effort (which has no
		// `off`: the host's "off" is an undefined effort plus a disabled-reasoning flag).
		await waitFor(() => input.local.thinkingLevel === host.session.thinkingLevel);
		expect(input.local.configuredThinkingLevel()).toBe(host.session.configuredThinkingLevel());
		input.expectNothingRanLocally();
		await waitFor(() => entryShape(input.local).join() === entryShape(host.session).join());
	});

	it("cycles the host's model forward, and refuses to cycle backward as if it were forward", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);
		const before = host.session.model?.id;

		input.editor.onCycleModelBackward?.();
		expect(input.statuses).toContain("Cycling to the previous model is unavailable when attached");
		await input.hostSawEverything();
		expect(host.session.model?.id).toBe(before);

		input.editor.onCycleModelForward?.();
		await waitFor(() => host.session.model?.id !== before);
		await waitFor(() => input.local.agent.state.model?.id === host.session.model?.id);
		input.expectNothingRanLocally();
	});

	it("picks the host's model from the host's model list and changes no local role or setting", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);
		const defaultRole = settings.getModelRole("default");

		input.editor.onSelectModel?.();
		await waitFor(() => input.overlays.length === 1);
		const picker = input.overlays[0];
		for (const character of "opus") picker.handleInput?.(character);
		picker.handleInput?.("\r");

		await waitFor(() => host.session.model?.id.includes("opus") === true);
		await waitFor(() => input.local.agent.state.model?.id === host.session.model?.id);
		expect(settings.getModelRole("default")).toBe(defaultRole);
		input.expectNothingRanLocally();
	});

	const gestures: [name: string, trigger: (input: HostedInput) => void, status: string][] = [
		["retry", input => input.editor.onRetry?.(), "Retry is unavailable when attached"],
		["plan mode key", input => input.editor.handleInput("\x1bP"), "Plan mode is unavailable when attached"],
		["live mode key", input => input.editor.handleInput("\x0c"), "Live mode is unavailable when attached"],
		["session tree", input => input.ctx.showTreeSelector(), "The session tree is unavailable when attached"],
		["rewind", input => input.ctx.showUserMessageSelector(), "Rewinding is unavailable when attached"],
		["session switcher", input => input.ctx.showSessionSelector(), "Switching sessions is unavailable when attached"],
		["debug panel", input => void input.ctx.showDebugSelector(), "The debug panel is unavailable when attached"],
		["settings", input => input.ctx.showSettingsSelector(), "Settings is unavailable when attached"],
		["agent hub", input => input.ctx.showAgentHub(), "The agent hub is unavailable when attached"],
	];
	it.each(gestures)("says %s is unavailable instead of changing the replica", async (_name, trigger, status) => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		trigger(input);

		expect(input.statuses).toContain(status);
		await input.hostSawEverything();
		expect(userTexts(host.session)).toEqual([]);
		input.expectNothingRanLocally();
	});

	it("does not open the rewind selector on a double Esc", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		input.editor.onEscape?.();
		input.editor.onEscape?.();

		expect(input.statuses.some(status => status.endsWith("is unavailable when attached"))).toBe(true);
		input.expectNothingRanLocally();
	});

	it("offers no replica-local file for a large paste: the host could not read it", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);

		await input.controller.presentLargePasteMenu("one\ntwo\nthree", 3);

		expect(input.selectors).toEqual([["Attach as a wrapped block", "Paste inline"]]);
	});

	it("sends a pasted clipboard image to the host as bytes, with no file in the local copy's directory", async () => {
		const host = await fixture.startHost();
		const input = await HostedInput.open(host);
		const copy = await listTree(input.replicaDir);
		const clipboard = new InputController(input.ctx, {
			readImage: async () => ({ data: Buffer.from(PIXEL.data, "base64"), mimeType: "image/png" }),
			readText: async () => "",
		});

		expect(await clipboard.handleImagePaste()).toBe(true);

		expect(input.editor.pendingImages).toHaveLength(1);
		// The host cannot open a `local://` file in the copy's artifact directory, and the copy is deleted on leaving.
		expect(input.editor.pendingImageLinks.filter(link => link?.startsWith("local://"))).toEqual([]);
		expect(await listTree(input.replicaDir)).toEqual(copy);
	});
});

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

// ── idle maintenance under frozen time ─────────────────────────────────────
//
// A real `AgentSession` runs real turns against scripted providers, so the observable results are provider requests,
// journaled recaps and the transcript. Fake timers freeze the clock; real async work (promises, sockets, files,
// `setImmediate`) keeps running under them, so the shared `helpers/fake-clock` waits yield the event loop instead of guessing durations.

const RECAP = "Reworked the login flow; next: wire the focused token-refresh test.";
const WORKER_RECAP = "The worker is mid-way through the migration; next: run the backfill.";
/** `recap.idleSeconds` is set explicitly, to the smallest delay the scheduler allows, never inherited from a default. */
const RECAP_DELAY_MS = 1_000;
const RECAP_SETTINGS = { "compaction.enabled": false, "todo.reminders": false, "recap.idleSeconds": 1 };

/** The providers of one session: `main` answers its turns, `side` its idle recaps. Both record every request. */
interface Models {
	main: MockModel;
	side: MockModel;
}

/** An `InteractiveMode` over a real session, with the means to tear it down and to put a second agent beside it. */
interface OpenedMode {
	mode: InteractiveMode;
	session: AgentSession;
	dispose: () => Promise<void>;
	/** Another real session over the same registry and directory. */
	spawn: (models: Models) => Promise<AgentSession>;
}

/** An {@link OpenedMode} that finished starting up, over the scripted providers of its session. */
interface RecapMode extends OpenedMode {
	models: Models;
}

function scriptedModels(recap: string): Models {
	return {
		main: createMockModel({ handler: { content: ["Work finished."] } }),
		side: createMockModel({ handler: { content: [recap] } }),
	};
}

/** Park the next request `model` gets until `release`; `started` settles once the provider has been asked. */
function holdNext(model: MockModel): { started: Promise<void>; release(response: MockResponse): void } {
	const started = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<MockResponse>();
	model.push(() => {
		started.resolve();
		return reply.promise;
	});
	return { started: started.promise, release: response => reply.resolve(response) };
}

/** One real turn of `session`. The clock stands still once the terminal `agent_end` is out, so the idle stretch starts there. */
async function runTurn(session: AgentSession, text = "please work"): Promise<void> {
	await driveTurn(session, session.prompt(text));
	await wait(session.waitForIdle());
	await flush();
}

/**
 * A host whose session answers its turns and its idle recaps from scripted providers, with recaps due after one
 * second. The fixture's side-channel seam keeps the recaps off the network.
 */
async function startRecapHost(): Promise<{ host: TestSessionHost; side: MockModel }> {
	const models = scriptedModels(RECAP);
	const host = await fixture.startHost({}, undefined, {
		mock: models.main,
		settings: RECAP_SETTINGS,
		sideStreamFn: models.side.stream,
	});
	return { host, side: models.side };
}

interface Tap {
	/** The host's entry with its endpoint redirected through the tap. */
	entry: SessionHostEntry;
	/** Everything the client has written so far. */
	sent(): string;
	/**
	 * How many idle-activity reports the host has accepted, counted from its answers as they leave the host: a held
	 * answer counts, since the host has accepted the report whether or not the client has been told.
	 */
	acceptedReports(): number;
	/** Keep what the host writes to the client from reaching it, until {@link Tap.releaseReplies}. */
	holdReplies(): void;
	releaseReplies(): void;
	close(): void;
}

/** The complete JSON lines in a socket stream, kept across chunks; anything that is not JSON is not a frame. */
class FrameLines {
	#pending = "";

	take(chunk: Buffer): Record<string, unknown>[] {
		this.#pending += chunk.toString("utf8");
		const lines = this.#pending.split("\n");
		this.#pending = lines.pop() ?? "";
		return lines.flatMap(line => {
			try {
				const frame: unknown = JSON.parse(line);
				return isRecord(frame) ? [frame] : [];
			} catch {
				return [];
			}
		});
	}
}

/**
 * A unix socket in front of a host's endpoint that records what the client writes, counts the idle-activity reports the
 * host accepts, and can delay what the host answers.
 */
async function tapHost(entry: SessionHostEntry): Promise<Tap> {
	const endpoint = await privateEndpoint(fixture.dir, `tap-${newHostId()}`, { prefix: "tap", label: "test" });
	const sent: Buffer[] = [];
	const held: (() => void)[] = [];
	const sockets = new Set<net.Socket>();
	let holding = false;
	let accepted = 0;
	const server = net.createServer(client => {
		const upstream = net.connect(entry.endpoint);
		const answers = new FrameLines();
		client.on("data", (chunk: Buffer | string) => {
			const bytes = Buffer.from(chunk);
			sent.push(bytes);
			upstream.write(bytes);
		});
		upstream.on("data", (chunk: Buffer | string) => {
			const bytes = Buffer.from(chunk);
			for (const frame of answers.take(bytes)) {
				if (frame.type === "response" && frame.command === "set_idle_activity" && frame.success === true)
					accepted++;
			}
			if (holding) held.push(() => client.write(bytes));
			else client.write(bytes);
		});
		for (const socket of [client, upstream]) {
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => {
				sockets.delete(socket);
				client.destroy();
				upstream.destroy();
			});
		}
	});
	const listening = Promise.withResolvers<void>();
	server.listen(endpoint, listening.resolve);
	await listening.promise;
	return {
		entry: { ...entry, endpoint },
		sent: () => Buffer.concat(sent).toString("utf8"),
		acceptedReports: () => accepted,
		holdReplies: () => {
			holding = true;
		},
		releaseReplies: () => {
			holding = false;
			for (const write of held.splice(0)) write();
		},
		close: () => {
			server.close();
			for (const socket of sockets) socket.destroy();
		},
	};
}

describe("a hosted client's automation", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("InteractiveMode", () => {
		const cleanups: (() => Promise<void> | void)[] = [];

		afterEach(async () => {
			vi.useRealTimers();
			// Last opened, first closed.
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		});

		async function openMode(
			hostedClientMode: boolean,
			options: {
				settings?: Settings;
				sessionManager?: (dir: string) => SessionManager | Promise<SessionManager>;
				withTools?: boolean;
				passiveReplica?: boolean;
				extension?: ExtensionFactory;
				/** Scripted providers for the session's turns and idle recaps; without them neither can be asked. */
				models?: Models;
			} = {},
		): Promise<OpenedMode> {
			const dir = TempDir.createSync("@pi-hosted-mode-");
			const authStorage = await AuthStorage.create(path.join(dir.path(), "testauth.db"));
			authStorage.keys.setRuntime("anthropic", "test-key");
			const registry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
			const model = registry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 to exist");
			const readTool: AgentTool = {
				name: "read",
				label: "read",
				description: "Fake read",
				parameters: type({}),
				async execute() {
					return { content: [{ type: "text" as const, text: "ok" }] };
				},
			};
			const sessionManager =
				(await options.sessionManager?.(dir.path())) ?? SessionManager.create(dir.path(), dir.path());
			let extensionRunner: ExtensionRunner | undefined;
			if (options.extension) {
				const runtime = new ExtensionRuntime();
				const extension = await loadExtensionFromFactory(
					options.extension,
					dir.path(),
					new EventBus(),
					runtime,
					"hosted-probe",
				);
				extensionRunner = new ExtensionRunner([extension], runtime, dir.path(), sessionManager, registry);
			}
			const session = new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["Test"],
						tools: options.withTools ? [readTool] : [],
						messages: [],
					},
					...(options.models ? { getApiKey: () => "test-key", streamFn: options.models.main.stream } : {}),
				}),
				sessionManager,
				settings: options.settings ?? Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: registry,
				extensionRunner,
				passiveReplica: options.passiveReplica,
				sideStreamFn: options.models?.side.stream,
				...(options.withTools
					? { toolRegistry: new Map([[readTool.name, readTool]]), builtInToolNames: ["read"] }
					: {}),
			});
			const mode = new InteractiveMode(session, "test");
			mode.hostedClientMode = hostedClientMode;
			let disposed = false;
			const dispose = async (): Promise<void> => {
				if (disposed) return;
				disposed = true;
				mode.stop();
				await session.dispose();
				authStorage.close();
				dir.removeSync();
			};
			cleanups.push(dispose);
			const spawn = async (models: Models): Promise<AgentSession> => {
				const worker = new AgentSession({
					agent: new Agent({
						getApiKey: () => "test-key",
						initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
						streamFn: models.main.stream,
					}),
					sessionManager: SessionManager.create(dir.path(), dir.path()),
					settings: Settings.isolated(RECAP_SETTINGS),
					modelRegistry: registry,
					sideStreamFn: models.side.stream,
				});
				cleanups.push(() => worker.dispose());
				return worker;
			};
			return { mode, session, dispose, spawn };
		}

		/** The HUD's dismissal entries a session journaled and whether its todo panel still shows them. */
		async function finishTodosAndWait(hostedClientMode: boolean): Promise<{ dismissals: number; shown: boolean }> {
			const { mode, session } = await openMode(hostedClientMode);
			vi.useFakeTimers();
			const phases: TodoPhase[] = [{ name: "Done", tasks: [{ content: "ship it", status: "completed" }] }];
			cfgTasksTodoClearDelay.override(session.settings, 0);
			session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
			session.setTodoPhases(phases);
			mode.setTodos(phases);
			vi.advanceTimersByTime(0);
			await session.settleInFlightMessagePersistence();
			await session.sessionManager.flush();
			return {
				dismissals: session.sessionManager
					.getBranch()
					.filter(entry => entry.type === "custom" && entry.customType === "todo_hud_state").length,
				shown: Bun.stripANSI(mode.todoContainer.render(120).join("\n")).includes("ship it"),
			};
		}

		it("dismisses a finished todo list into an ordinary session's journal, never into a hosted replica's", async () => {
			expect(await finishTodosAndWait(false)).toEqual({ dismissals: 1, shown: false });
			vi.useRealTimers();
			expect(await finishTodosAndWait(true)).toEqual({ dismissals: 0, shown: true });
		});

		async function loopSubmissionsAfterBeat(hostedClientMode: boolean): Promise<string[]> {
			cfgLoopMode.set(settings, "prompt");
			const { mode } = await openMode(hostedClientMode);
			vi.useFakeTimers();
			mode.ui.requestRender = vi.fn();
			vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
			vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
			mode.loopModeEnabled = true;
			mode.loopPrompt = "repeat this";
			const pending: Promise<SubmittedUserInput> = mode.getUserInput();
			const resolved: string[] = [];
			void pending.then(input => resolved.push(input.text));
			vi.advanceTimersByTime(800);
			await flushMicrotasks();
			cleanups.push(async () => {
				mode.disableLoopMode("Loop mode disabled.");
				mode.cancelPendingSubmission();
				mode.onInputCallback?.({ text: "", cancelled: true, started: false });
				await pending;
			});
			return resolved;
		}

		it("resubmits a loop prompt locally only when it is not a hosted client", async () => {
			expect(await loopSubmissionsAfterBeat(false)).toEqual(["repeat this"]);
			vi.useRealTimers();
			expect(await loopSubmissionsAfterBeat(true)).toEqual([]);
		});

		async function planStateAfterInit(
			hostedClientMode: boolean,
			sessionSettings: Settings,
			sessionManager?: (dir: string) => SessionManager,
		): Promise<{ enabled: boolean; paused: boolean; modeEntries: number }> {
			cfgStartupQuiet.set(Settings.instance, true);
			const { mode, session, dispose } = await openMode(hostedClientMode, {
				settings: sessionSettings,
				sessionManager,
				withTools: true,
			});
			await mode.init({ suppressWelcomeIntro: true });
			const state = {
				enabled: mode.planModeEnabled,
				paused: mode.planModePaused,
				modeEntries: session.sessionManager.getEntries().filter(entry => entry.type === "mode_change").length,
			};
			// One initialized mode at a time: init claims process-wide handlers.
			await dispose();
			return state;
		}

		it("enters plan mode at startup only when it is not a hosted client", async () => {
			const defaultOnStartup = () =>
				Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false });
			const ordinary = await planStateAfterInit(false, defaultOnStartup());
			const hosted = await planStateAfterInit(true, defaultOnStartup());

			expect(ordinary.enabled).toBe(true);
			expect(hosted).toEqual({ enabled: false, paused: false, modeEntries: 0 });
		});

		it("restores the mode its session journaled only when it is not a hosted client", async () => {
			const paused = (dir: string) => {
				const manager = SessionManager.create(dir, dir);
				manager.appendModeChange("plan_paused");
				return manager;
			};
			const sessionSettings = () => Settings.isolated({ "compaction.enabled": false });
			const ordinary = await planStateAfterInit(false, sessionSettings(), paused);
			const hosted = await planStateAfterInit(true, sessionSettings(), paused);

			expect(ordinary.paused).toBe(true);
			expect(hosted.paused).toBe(false);
			expect(hosted.enabled).toBe(false);
		});

		it("mounts the welcome header in a hosted client exactly as startup.quiet says", async () => {
			const previous = cfgStartupQuiet.get(Settings.instance);
			const welcomeAfterInit = async (quiet: boolean): Promise<boolean> => {
				cfgStartupQuiet.set(Settings.instance, quiet);
				const { mode, dispose } = await openMode(true);
				await mode.init({ suppressWelcomeIntro: true });
				const mounted = mode.composer.welcome !== undefined;
				await dispose();
				return mounted;
			};
			try {
				expect(await welcomeAfterInit(false)).toBe(true);
				expect(await welcomeAfterInit(true)).toBe(false);
			} finally {
				cfgStartupQuiet.set(Settings.instance, previous);
			}
		});

		it("keeps a passive replica's session switches from its local extensions", async () => {
			const switches = async (passiveReplica: boolean): Promise<{ before: number; after: number }> => {
				const seen = { before: 0, after: 0 };
				const { session, dispose } = await openMode(false, {
					passiveReplica,
					extension: pi => {
						pi.on("session_before_switch", () => {
							seen.before++;
						});
						pi.on("session_switch", () => {
							seen.after++;
						});
					},
				});
				await session.sessionManager.ensureOnDisk();
				expect(await session.switchSession(session.sessionManager.getSessionFile()!)).toBe(true);
				await dispose();
				return seen;
			};

			expect(await switches(false)).toEqual({ before: 1, after: 1 });
			expect(await switches(true)).toEqual({ before: 0, after: 0 });
		});

		/** What a local extension got to do, and the composer afterwards, with the same extension in both modes. */
		async function extensionActivity(hostedClientMode: boolean): Promise<{
			startups: number;
			shortcuts: number;
			inputHooks: number;
			journaled: number;
			composer: string;
		}> {
			const seen = { startups: 0, shortcuts: 0, inputHooks: 0 };
			cfgStartupQuiet.set(Settings.instance, true);
			const { mode, session, dispose } = await openMode(hostedClientMode, {
				extension: pi => {
					pi.on("session_start", () => {
						seen.startups++;
						pi.appendEntry("probe", {});
					});
					// Handled, so the ordinary run ends here instead of reaching a model.
					pi.on("input", () => {
						seen.inputHooks++;
						return { handled: true };
					});
					pi.registerShortcut("alt+x", {
						handler: () => {
							seen.shortcuts++;
						},
					});
				},
			});
			await mode.init({ suppressWelcomeIntro: true });
			mode.editor.handleInput("\x1bx");
			let submitting: Promise<void> | undefined;
			const onSubmit = mode.editor.onSubmit;
			mode.editor.onSubmit = text => (submitting = Promise.resolve(onSubmit?.(text)));
			mode.editor.setText("hello");
			mode.editor.handleInput("\r");
			await submitting;
			const journaled = session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === "probe").length;
			const composer = mode.editor.getText();
			await dispose();
			return { ...seen, journaled, composer };
		}

		/**
		 * An extension's own handle on the session after `InteractiveMode.initializeHookRunner` (the public entry that
		 * re-binds the runner, e.g. after a reload): what its actions do, same extension, both modes.
		 */
		async function actionsAfterReinitialization(hostedClientMode: boolean): Promise<{
			appended: "journaled" | "runtime-not-initialized" | "other-error";
			renamed: "renamed" | "runtime-not-initialized" | "other-error";
			journaled: number;
			name: string | undefined;
		}> {
			let api: ExtensionAPI | undefined;
			const { mode, session, dispose } = await openMode(hostedClientMode, {
				extension: pi => void (api = pi),
			});
			if (!api) throw new Error("the extension was not loaded");
			const runner = session.extensionRunner;
			if (!runner) throw new Error("the session has no extension runner");
			mode.initializeHookRunner(runner.getUIContext(), true);
			const attempt = async <Done extends string>(
				act: () => unknown,
				done: Done,
			): Promise<Done | "runtime-not-initialized" | "other-error"> => {
				try {
					await act();
					return done;
				} catch (error) {
					// The failure path that matters is the loader's "actions not bound" error, by type.
					return error instanceof ExtensionRuntimeNotInitializedError ? "runtime-not-initialized" : "other-error";
				}
			};
			const appended = await attempt(() => api?.appendEntry("reinit-probe", {}), "journaled");
			const renamed = await attempt(() => api?.setSessionName("Extension title"), "renamed");
			const journaled = session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === "reinit-probe").length;
			const name = session.sessionManager.getSessionName();
			await dispose();
			return { appended, renamed, journaled, name };
		}

		it("binds a local extension's actions on re-initialization only when it is not a hosted client", async () => {
			expect(await actionsAfterReinitialization(false)).toEqual({
				appended: "journaled",
				renamed: "renamed",
				journaled: 1,
				name: "Extension title",
			});
			// The actions stay the loader's throwing stubs: the extension cannot write into the replica.
			expect(await actionsAfterReinitialization(true)).toEqual({
				appended: "runtime-not-initialized",
				renamed: "runtime-not-initialized",
				journaled: 0,
				name: undefined,
			});
		});

		it("runs a local extension's startup, shortcut and input hooks only when it is not a hosted client", async () => {
			expect(await extensionActivity(false)).toEqual({
				startups: 1,
				shortcuts: 1,
				inputHooks: 1,
				journaled: 1,
				composer: "",
			});
			// Hosted and still connecting: the extension did nothing, nothing was journaled, the draft is still there.
			expect(await extensionActivity(true)).toEqual({
				startups: 0,
				shortcuts: 0,
				inputHooks: 0,
				journaled: 0,
				composer: "hello",
			});
		});

		/** The composer after startup and whether the session's saved draft is still on disk, for a session with one saved. */
		async function draftAfterInit(hostedClientMode: boolean): Promise<{ composer: string; sidecar: string | null }> {
			cfgStartupQuiet.set(Settings.instance, true);
			const { mode, session, dispose } = await openMode(hostedClientMode, {
				sessionManager: async dir => {
					const manager = SessionManager.create(dir, dir);
					await manager.saveDraft("unsent draft");
					return manager;
				},
			});
			await mode.init({ suppressWelcomeIntro: true });
			const composer = mode.editor.getText();
			const sidecar = await session.sessionManager.consumeDraft();
			await dispose();
			return { composer, sidecar };
		}

		it("restores and consumes a saved draft at startup only when it is not a hosted client", async () => {
			expect(await draftAfterInit(false)).toEqual({ composer: "unsent draft", sidecar: null });
			// A hosted client never saves a draft, so one it finds is not its to restore or delete.
			expect(await draftAfterInit(true)).toEqual({ composer: "", sidecar: "unsent draft" });
		});

		/**
		 * Idle recap in a real `InteractiveMode`: a real session runs real turns against scripted providers, and the
		 * recap is judged by the provider requests it made, the journal it wrote and the transcript the user reads.
		 */
		describe("idle recap", () => {
			beforeEach(() => {
				resetSessionIndexForTests();
			});
			afterEach(() => {
				resetSessionIndexForTests();
			});

			/** An initialized TUI (its startup is done) over a session whose turns and recaps come from scripted providers. */
			async function openRecapMode(hostedClientMode: boolean): Promise<RecapMode> {
				cfgStartupQuiet.set(Settings.instance, true);
				cfgCompletionNotify.set(Settings.instance, "off");
				const models = scriptedModels(RECAP);
				const opened = await openMode(hostedClientMode, { settings: Settings.isolated(RECAP_SETTINGS), models });
				await opened.mode.init({ suppressWelcomeIntro: true });
				return { ...opened, models };
			}

			/** A second real agent, registered like a task subagent and with a recap text of its own. */
			async function spawnAgent(opened: RecapMode, id: string) {
				const models = scriptedModels(WORKER_RECAP);
				const session = await opened.spawn(models);
				const registry = AgentRegistry.global();
				const ref = registry.register({
					id,
					displayName: id,
					kind: "sub",
					parentId: MAIN_AGENT_ID,
					session,
					status: "running",
				});
				cleanups.push(async () => {
					if (opened.mode.focusedAgentId) await opened.mode.unfocusSession();
					registry.unregister(id, ref);
				});
				return { id, session, models };
			}

			const screen = (mode: InteractiveMode): string => Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
			const shown = (mode: InteractiveMode, text: string): number => screen(mode).split(text).length - 1;
			const journal = (session: AgentSession): string[] =>
				listSessionRecaps({ sessionIds: [session.sessionManager.getSessionId()] }).map(row => row.recap);

			/** One turn ends and the screen idles past the recap delay: what the provider, the journal and the transcript show. */
			async function recapAfterTurn(hostedClientMode: boolean) {
				const { mode, session, models, dispose } = await openRecapMode(hostedClientMode);
				vi.useFakeTimers();
				await runTurn(session);
				await elapse(RECAP_DELAY_MS);
				// An ordinary session is given until its recap shows; a hosted one as long as the event loop will run it.
				if (hostedClientMode) await flush();
				else await until(() => shown(mode, RECAP) > 0, "the recap on screen");
				await elapse(3 * RECAP_DELAY_MS);
				const result = {
					providerRequests: models.side.calls.length,
					journaled: journal(session),
					shown: shown(mode, RECAP),
				};
				vi.useRealTimers();
				// One initialized mode at a time: init claims process-wide handlers.
				await dispose();
				return result;
			}

			it("recaps an idle session once, on screen and in the journal, only when it is not a hosted client", async () => {
				expect(await recapAfterTurn(false)).toEqual({ providerRequests: 1, journaled: [RECAP], shown: 1 });
				expect(await recapAfterTurn(true)).toEqual({ providerRequests: 0, journaled: [], shown: 0 });
			}, 30_000);

			it("holds the recap back while a draft is being composed and delivers it once the draft is gone", async () => {
				const { mode, session, models } = await openRecapMode(false);
				vi.useFakeTimers();
				await runTurn(session);

				// The recap is due in a second; the draft arrives before that.
				mode.editor.setText("half-written draft");
				await flush();
				await elapse(3 * RECAP_DELAY_MS);
				expect(models.side.calls).toHaveLength(0);
				expect(journal(session)).toEqual([]);

				// Whitespace is not a draft.
				mode.editor.setText("  ");
				await flush();
				await elapse(RECAP_DELAY_MS);
				await until(() => shown(mode, RECAP) > 0, "the recap on screen");
				await elapse(3 * RECAP_DELAY_MS);

				expect(models.side.calls).toHaveLength(1);
				expect(journal(session)).toEqual([RECAP]);
				expect(shown(mode, RECAP)).toBe(1);
			}, 30_000);

			it("does idle work only for the agent on screen: a viewed subagent recaps, the root waits until it is back", async () => {
				const opened = await openRecapMode(false);
				const { mode, session: root, models: rootModels } = opened;
				const worker = await spawnAgent(opened, "RecapWorker");
				vi.useFakeTimers();

				// Nobody has opened the worker: its turn ends unattended and nothing is started on its behalf.
				await runTurn(worker.session);
				await elapse(3 * RECAP_DELAY_MS);
				expect(worker.models.side.calls).toHaveLength(0);

				// The root owes a recap, but the view moves to the worker before it is due.
				await runTurn(root);
				await wait(mode.focusAgentSession(worker.id));
				await elapse(3 * RECAP_DELAY_MS);
				expect(rootModels.side.calls).toHaveLength(0);
				expect(worker.models.side.calls).toHaveLength(0);

				// Viewed now, the worker's own turn is the one that gets recapped.
				await runTurn(worker.session);
				await elapse(RECAP_DELAY_MS);
				await until(() => shown(mode, WORKER_RECAP) > 0, "the worker's recap on screen");
				await elapse(3 * RECAP_DELAY_MS);
				expect(worker.models.side.calls).toHaveLength(1);
				expect(journal(worker.session)).toEqual([WORKER_RECAP]);
				expect(shown(mode, WORKER_RECAP)).toBe(1);
				expect(rootModels.side.calls).toHaveLength(0);
				expect(journal(root)).toEqual([]);

				// Back on main, the recap it still owes arrives, once.
				await wait(mode.unfocusSession());
				await flush();
				await elapse(RECAP_DELAY_MS);
				await until(() => shown(mode, RECAP) > 0, "the root's recap on screen");
				await elapse(3 * RECAP_DELAY_MS);
				expect(rootModels.side.calls).toHaveLength(1);
				expect(journal(root)).toEqual([RECAP]);
				expect(shown(mode, RECAP)).toBe(1);
				expect(worker.models.side.calls).toHaveLength(1);
			}, 30_000);

			it("abandons a recap being written when the view leaves its agent, and recaps the stretch that ended while away once it is viewed again", async () => {
				const opened = await openRecapMode(false);
				const { mode } = opened;
				const worker = await spawnAgent(opened, "LeavingWorker");
				const announced: string[] = [];
				worker.session.subscribe(event => {
					if (event.type === "idle_recap") announced.push(event.recap);
				});
				vi.useFakeTimers();
				await wait(mode.focusAgentSession(worker.id));
				await runTurn(worker.session);
				const held = holdNext(worker.models.side);
				await elapse(RECAP_DELAY_MS);
				await wait(held.started);
				const signal = worker.models.side.calls[0]?.options?.signal;
				expect(signal?.aborted).toBe(false);

				await wait(mode.unfocusSession());
				expect(signal?.aborted).toBe(true);
				held.release({ content: ["Late reply from a view that is gone."] });
				await flush();
				expect(announced).toEqual([]);
				expect(journal(worker.session)).toEqual([]);

				// The worker works on while nobody looks: that stretch is owed, not started.
				await runTurn(worker.session);
				await elapse(3 * RECAP_DELAY_MS);
				expect(worker.models.side.calls).toHaveLength(1);

				await wait(mode.focusAgentSession(worker.id));
				await elapse(RECAP_DELAY_MS);
				await until(() => shown(mode, WORKER_RECAP) > 0, "the owed recap on screen");
				await elapse(3 * RECAP_DELAY_MS);
				expect(worker.models.side.calls).toHaveLength(2);
				expect(announced).toEqual([WORKER_RECAP]);
				expect(journal(worker.session)).toEqual([WORKER_RECAP]);
				expect(shown(mode, WORKER_RECAP)).toBe(1);
			}, 30_000);

			it("recaps the stretch once a goal continuation is cancelled before it starts, with no other turn to restart the clock", async () => {
				const { mode, session, models } = await openRecapMode(false);
				await session.goalRuntime.createGoal({ objective: "Ship the login flow" });
				vi.useFakeTimers();
				// The main loop waits for input, so the end of the turn schedules the goal's next continuation.
				const input = mode.getUserInput();
				await runTurn(session);
				expect(models.main.calls).toHaveLength(1);

				// The continuation is submitted 800 ms after the turn ended; until its turn starts it holds the recap back.
				await elapse(800);
				expect((await wait(input)).customType).toBe("goal-continuation");
				await elapse(3 * RECAP_DELAY_MS);
				expect(models.side.calls).toHaveLength(0);

				// Esc before the turn begins: no `agent_end` will ever follow to end this stretch.
				expect(mode.cancelPendingSubmission()).toBe(true);
				await flush();
				await elapse(RECAP_DELAY_MS);
				await until(() => shown(mode, RECAP) > 0, "the recap on screen");
				await elapse(3 * RECAP_DELAY_MS);
				expect(models.main.calls).toHaveLength(1);
				expect(models.side.calls).toHaveLength(1);
				expect(journal(session)).toEqual([RECAP]);
				expect(shown(mode, RECAP)).toBe(1);
			}, 30_000);
		});
	});
});

/**
 * What the editor of a hosted client tells the session host about its draft, judged by the host's own idle work: a
 * real host, link, editor and input controller over real sockets, and a host session that recaps from a scripted
 * provider. The TUI itself never schedules anything here; whether the host may recap is the only thing that varies.
 */
describe("a hosted client's idle activity", () => {
	beforeEach(() => {
		resetSessionIndexForTests();
	});
	afterEach(() => {
		vi.useRealTimers();
		resetSessionIndexForTests();
	});

	const hostJournal = (): string[] => listSessionRecaps().map(row => row.recap);

	it("keeps the host from recapping while the editor holds a draft, and lets it recap in each session once the draft is gone", async () => {
		const { host, side } = await startRecapHost();
		const tap = await tapHost(await fixture.entry(host));
		// After the input has left through it, and before the fixture ends.
		hostStops.push(async () => tap.close());
		const input = await HostedInput.open();
		// Typed before the connection exists: the first snapshot is what tells the host.
		input.editor.setText("half-written draft");
		await input.connect(host, tap.entry);
		vi.useFakeTimers();

		await runTurn(host.session);
		await elapse(3 * RECAP_DELAY_MS);
		expect(side.calls).toHaveLength(0);
		expect(hostJournal()).toEqual([]);

		// The clearing report crosses a real socket, which fake time cannot hurry or wait for: idle time may only
		// pass once the host has accepted it. The recap is awaited as a consumer sees it, as the `idle_recap` of the
		// host's session, with the clock nudged until it arrives however late the host arms its timer.
		const firstRecap = nextIdleRecap(host.session);
		const reported = tap.acceptedReports();
		input.editor.setText("");
		await until(() => tap.acceptedReports() > reported, "the host to accept the cleared draft");
		expect(await drive(firstRecap)).toBe(RECAP);
		expect(side.calls).toHaveLength(1);
		expect(hostJournal()).toEqual([RECAP]);

		// The host moves to a new session. Nothing is being composed, and the view says so again for that session.
		const epoch = input.hostLink.epoch;
		const reportedBefore = tap.acceptedReports();
		await wait(host.session.newSession());
		await until(() => input.hostLink.epoch > epoch, "the view of the new session");
		await until(() => tap.acceptedReports() > reportedBefore, "the host to accept the new view's report");
		const secondRecap = nextIdleRecap(host.session);
		await runTurn(host.session);
		expect(await drive(secondRecap)).toBe(RECAP);
		expect(side.calls).toHaveLength(2);
		expect(hostJournal()).toEqual([RECAP, RECAP]);
		expect(input.errors).toEqual([]);
		expect(input.closed).toEqual([]);
	}, 30_000);

	it("tells the host the newest state of the draft without waiting for older reports to be answered, and never sends the draft", async () => {
		const { host, side } = await startRecapHost();
		const tap = await tapHost(await fixture.entry(host));
		// After the input has left through it, and before the fixture ends.
		hostStops.push(async () => tap.close());
		try {
			const input = await HostedInput.open();
			await input.connect(host, tap.entry);
			const reported = tap.acceptedReports();
			tap.holdReplies();

			// Three edits in one tick: the host is told where the draft ended up, whatever it was a moment ago. The
			// client is told nothing back; what the host has accepted is read from its answers as they leave the host.
			input.editor.setText("first-draft-text");
			input.editor.setText("");
			input.editor.setText("second-draft-text");
			await until(() => tap.acceptedReports() > reported, "the host to accept the draft report");
			vi.useFakeTimers();

			await runTurn(host.session);
			await elapse(3 * RECAP_DELAY_MS);
			expect(side.calls).toHaveLength(0);

			// The editor still holds that report's answer back. Clearing the draft must not wait for it.
			const recapped = nextIdleRecap(host.session);
			const accepted = tap.acceptedReports();
			input.editor.setText("");
			await until(() => tap.acceptedReports() > accepted, "the host to accept the cleared draft");
			expect(await drive(recapped)).toBe(RECAP);
			expect(side.calls).toHaveLength(1);
			expect(tap.sent()).not.toContain("draft-text");
		} finally {
			vi.useRealTimers();
			// The input detaches in teardown, and that needs the answers it is owed.
			tap.releaseReplies();
		}
	}, 30_000);
});
