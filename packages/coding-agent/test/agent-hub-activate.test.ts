/**
 * Hub Enter contract: activating a non-remote agent row delegates to the
 * `focusAgent` dep (session focus proxy) and closes the hub on success; a
 * focus failure keeps the hub open and surfaces the error as a notice.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { IrcBus } from "@pk-nerdsaver-ai/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/agent-hub";
import { SelectorController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/selector-controller";
import { SessionObserverRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

const AGENT_ID = "Worker";
const TEST_CWD = path.resolve("agent-hub-cwd");

function makeHub(focusAgent: (id: string) => Promise<void>) {
	const agents = new AgentRegistry();
	agents.register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		parentId: "Main",
		session: { subscribe: () => () => {} } as unknown as AgentSession,
		sessionFile: null,
		status: "running",
	});
	let doneCalls = 0;
	const done = Promise.withResolvers<void>();
	const renderRequested = Promise.withResolvers<void>();
	const hub = new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {
			doneCalls++;
			done.resolve();
		},
		requestRender: () => renderRequested.resolve(),
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent,
	});
	return { hub, doneCalls: () => doneCalls, done: done.promise, renderRequested: renderRequested.promise };
}

describe("Agent hub Enter activation", () => {
	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("Enter focuses the selected agent and closes the hub", async () => {
		const focusedIds: string[] = [];
		const { hub, doneCalls, done } = makeHub(async id => {
			focusedIds.push(id);
		});

		// Rows: folder (0) → current session (1) → Worker (2). Select Worker.
		hub.handleInput("j");
		hub.handleInput("j");
		hub.handleInput("\r");
		await done; // activation is fire-and-forget async; onDone signals completion

		expect(focusedIds).toEqual([AGENT_ID]);
		expect(doneCalls()).toBe(1);
		hub.dispose();
	});

	it("a focus failure keeps the hub open and shows the error as a notice", async () => {
		const message = 'Agent "X" is aborted and cannot be revived';
		const { hub, doneCalls, renderRequested } = makeHub(() => Promise.reject(new Error(message)));

		hub.handleInput("j");
		hub.handleInput("j");
		hub.handleInput("\r");
		await renderRequested; // the rejection path requests a render after setting the notice

		expect(doneCalls()).toBe(0);
		const rendered = Bun.stripANSI(hub.render(120).join("\n"));
		expect(rendered).toContain(message);
		hub.dispose();
	});

	it("lists persisted subagent session files after restart", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");
		const agents = new AgentRegistry();
		const hub = new AgentHubOverlayComponent({
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
			sessionFile,
		});

		const rendered = Bun.stripANSI(hub.render(120).join("\n"));
		expect(rendered).toContain("Worker");
		expect(rendered).toContain("parked");
		expect(agents.get("Worker")?.sessionFile).toBe(workerSessionFile);
		hub.dispose();
	});

	it("selector controller restores focus to the editor after Enter focuses an agent", async () => {
		const agents = new AgentRegistry();
		agents.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Main",
			session: { subscribe: () => () => {} } as unknown as AgentSession,
			sessionFile: null,
			status: "running",
		});

		const editor = {};
		let capturedHub: AgentHubOverlayComponent | undefined;
		let editorRestoredCount = 0;
		let remountCalls = 0;
		const focusedIds: string[] = [];
		const focusResolved = Promise.withResolvers<void>();
		const editorFocused = Promise.withResolvers<void>();
		const focusTargets: unknown[] = [];
		const editorContainer = {
			clear: () => {},
			addChild: (child: unknown) => {
				if (child === editor) editorRestoredCount++;
				else capturedHub = child as AgentHubOverlayComponent;
			},
		};
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				setFocus: (target: unknown) => {
					focusTargets.push(target);
					if (target === editor) editorFocused.resolve();
				},
				requestRender: () => {},
			},
			editor,
			editorContainer,
			remountEditorComposer: () => {
				remountCalls++;
				editorContainer.clear();
				editorContainer.addChild(editor);
			},
			collabGuest: { agentRegistry: agents, hubRemote: undefined },
			focusAgentSession: async (id: string) => {
				focusedIds.push(id);
				focusResolved.resolve();
			},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => null, getSessionDir: () => undefined },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);

		controller.showAgentHub(new SessionObserverRegistry());

		expect(capturedHub).toBeDefined();
		expect(focusTargets[0]).toBe(capturedHub);

		capturedHub!.handleInput("j");
		capturedHub!.handleInput("j");
		capturedHub!.handleInput("\r");
		await focusResolved.promise;
		await editorFocused.promise;

		expect(focusedIds).toEqual([AGENT_ID]);
		expect(remountCalls).toBe(1);
		expect(editorRestoredCount).toBe(1);
		expect(focusTargets.at(-1)).toBe(editor);
		capturedHub!.dispose();
	});
});

describe("Agent hub double-← gating", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	function setup(agents: AgentRegistry) {
		let shown: AgentHubOverlayComponent | undefined;
		const editor = {};
		let remountCalls = 0;
		const editorContainer = {
			clear: () => {},
			addChild: (child: unknown) => {
				if (child !== editor) shown = child as AgentHubOverlayComponent;
			},
		};
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				setFocus: () => {},
				requestRender: () => {},
			},
			editor,
			editorContainer,
			remountEditorComposer: () => {
				remountCalls++;
				editorContainer.clear();
				editorContainer.addChild(editor);
			},
			collabGuest: { agentRegistry: agents, hubRemote: undefined },
			focusAgentSession: async () => {},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => null, getSessionDir: () => undefined },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);
		return { controller, shown: () => shown, remountCalls: () => remountCalls };
	}

	function registerWorker(agents: AgentRegistry) {
		agents.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Main",
			session: { subscribe: () => () => {} } as unknown as AgentSession,
			sessionFile: null,
			status: "running",
		});
	}

	it("requireContent keeps the hub closed when only Main is registered", () => {
		const agents = new AgentRegistry();
		agents.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: null,
			sessionFile: null,
			status: "running",
		});
		const { controller, shown } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(shown()).toBeUndefined();
	});

	it("requireContent opens the hub once a subagent exists", () => {
		const agents = new AgentRegistry();
		registerWorker(agents);
		const { controller, shown, remountCalls } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(shown()).toBeDefined();
		// Close through the hub's own quit key so teardown runs the controller's
		// done callback (which delegates to remountEditorComposer).
		shown()!.handleInput("q");
		expect(remountCalls()).toBe(1);
	});

	it("the explicit hub key opens the empty roster even with no subagents", () => {
		const agents = new AgentRegistry();
		const { controller, shown, remountCalls } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry());

		expect(shown()).toBeDefined();
		shown()!.handleInput("q");
		expect(remountCalls()).toBe(1);
	});
});
