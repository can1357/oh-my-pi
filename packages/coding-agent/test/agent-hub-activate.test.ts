/**
 * Hub Enter contract: activating a non-remote agent row delegates to the
 * `focusAgent` dep (session focus proxy) and closes the hub on success; a
 * focus failure keeps the hub open and surfaces the error as a notice.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { visitEntriesFromFileStream } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { TempDir } from "@oh-my-pi/pi-utils";

const AGENT_ID = "Worker";
const TEST_CWD = path.resolve("agent-hub-cwd");

function persistedChildJsonl(id: string): string {
	return [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-07-30T01:13:37.835Z", cwd: TEST_CWD }),
		JSON.stringify({
			type: "session_init",
			id: "init",
			parentId: null,
			timestamp: "2026-07-30T01:13:37.835Z",
			systemPrompt: "system",
			task: "work",
			tools: ["read"],
		}),
	].join("\n");
}

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
		settings: Settings.isolated(),
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

const ROSTER_ENTRY_PATTERN = /^(❯| ) (?:(?:(?:│ {3}| {4})*)(?:├── |└── ))?(\S+) (\S+)/u;

function renderedRosterEntry(hub: AgentHubOverlayComponent, id: string, width: number): string {
	const cells = hub.render(width).map(raw => {
		const line = Bun.stripANSI(raw);
		if (!line.startsWith("│ ")) return undefined;
		const divider = line.indexOf("│", Math.max(2, Math.floor(line.length / 3)));
		return divider < 0 ? undefined : line.slice(2, Math.max(2, divider - 1));
	});
	const start = cells.findIndex(cell => {
		const match = cell ? ROSTER_ENTRY_PATTERN.exec(cell) : null;
		return match?.[3] === id;
	});
	expect(start).toBeGreaterThanOrEqual(0);
	const entry: string[] = [];
	for (let i = start; i < cells.length; i++) {
		const cell = cells[i];
		if (cell === undefined || cell.trim().length === 0) break;
		if (i > start && ROSTER_ENTRY_PATTERN.test(cell)) break;
		entry.push(cell.trimEnd());
	}
	return entry.join("\n");
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

		hub.handleInput("\r");
		await done; // activation is fire-and-forget async; onDone signals completion

		expect(focusedIds).toEqual([AGENT_ID]);
		expect(doneCalls()).toBe(1);
		hub.dispose();
	});

	it("a focus failure keeps the hub open and shows the error as a notice", async () => {
		const message = 'Agent "X" is aborted and cannot be revived';
		const { hub, doneCalls, renderRequested } = makeHub(() => Promise.reject(new Error(message)));

		hub.handleInput("\r");
		await renderRequested; // the rejection path requests a render after setting the notice

		expect(doneCalls()).toBe(0);
		const rendered = Bun.stripANSI(hub.render(120).join("\n"));
		expect(rendered).toContain(message);
		hub.dispose();
	});

	it("Enter opens an aborted agent's read-only transcript instead of focusing it", () => {
		const agents = new AgentRegistry();
		agents.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: null,
			status: "aborted",
		});
		const focusAgent = vi.fn(async () => {});
		let viewer: { render(width: number): readonly string[] } | undefined;
		const showOverlay = vi.fn((component: { render(width: number): readonly string[] }) => {
			viewer = component;
			return { hide: () => {} };
		});
		const setFocus = vi.fn();
		const onDone = vi.fn();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone,
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent,
			ui: {
				requestRender: () => {},
				requestComponentRender: () => {},
				showOverlay,
				setFocus,
			} as never,
		});

		hub.handleInput("\r");

		expect(focusAgent).not.toHaveBeenCalled();
		expect(showOverlay).toHaveBeenCalledWith(expect.anything(), {
			width: "100%",
			margin: 0,
			fullscreen: true,
		});
		expect(setFocus).toHaveBeenCalledWith(expect.anything());
		expect(Bun.stripANSI(viewer!.render(120).join("\n"))).not.toContain("Enter:send");
		expect(onDone).not.toHaveBeenCalled();
		hub.dispose();
	});

	it("lists persisted subagent session files after restart", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, persistedChildJsonl("worker"));
		const agents = new AgentRegistry();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
			sessionFile,
		});
		await hub.persistedSubagentsReady;

		const workerEntry = renderedRosterEntry(hub, "Worker", 120);
		expect(workerEntry).toContain("○ Worker");
		expect(agents.get("Worker")?.sessionFile).toBe(workerSessionFile);
		hub.dispose();
	});

	it("stops persisted discovery when the Hub is disposed", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-disposed-scan-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(path.join(tempDir.path(), "main", "Worker.jsonl"), "");
		const agents = new AgentRegistry();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			sessionFile,
		});

		hub.dispose();
		await hub.persistedSubagentsReady;

		expect(agents.get("Worker")).toBeUndefined();
	});
	it("restores nested parent lineage after restart", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-tree-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const parentSessionFile = path.join(tempDir.path(), "main", "Parent.jsonl");
		const childSessionFile = path.join(tempDir.path(), "main", "Parent", "Child.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(parentSessionFile, persistedChildJsonl("parent"));
		await Bun.write(childSessionFile, persistedChildJsonl("child"));
		const agents = new AgentRegistry();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			sessionFile,
		});
		await hub.persistedSubagentsReady;

		expect(agents.get("Parent")?.parentId).toBe("Main");
		expect(agents.get("Child")?.parentId).toBe("Parent");
		hub.handleInput("t");
		expect(Bun.stripANSI(renderedRosterEntry(hub, "Child", 120))).toContain("└── ○ Child");
		hub.dispose();
	});

	it("restores saved task metadata and timestamps for completed agents", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-metadata-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		const createdAt = "2026-07-30T01:13:37.835Z";
		const lastActivity = new Date("2026-07-30T01:15:00.000Z");
		await Bun.write(sessionFile, "");
		await Bun.write(
			workerSessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "worker-session", timestamp: createdAt, cwd: TEST_CWD }),
				JSON.stringify({
					type: "session_init",
					id: "init",
					parentId: null,
					timestamp: createdAt,
					systemPrompt: "system",
					task: "Complete the assignment below, thoroughly:\n\n# Target\nInspect dependency boundaries and report unsafe coupling.\n\n# Change\nRead the implementation.",
					tools: ["read"],
				}),
			].join("\n"),
		);
		await fs.utimes(workerSessionFile, lastActivity, lastActivity);
		const agents = new AgentRegistry();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			sessionFile,
		});
		await hub.persistedSubagentsReady;

		expect(agents.get("Worker")).toMatchObject({
			activity: "Inspect dependency boundaries and report unsafe coupling.",
			createdAt: Date.parse(createdAt),
			lastActivity: lastActivity.getTime(),
			status: "parked",
		});
		const workerEntry = renderedRosterEntry(hub, "Worker", 120);
		expect(workerEntry).toContain("Inspect dependency boundaries and report unsafe coupling.");
		expect(workerEntry.replace(/\s+/g, " ")).toContain("usage ·");
		expect(workerEntry).not.toContain("$0.000");
		hub.dispose();
	});

	it("restores persisted model role, usage, spend, and tool totals", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-persisted-usage-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		const createdAt = "2026-07-30T01:13:30.000Z";
		const lastActivity = new Date("2026-07-30T01:15:00.000Z");
		await Bun.write(sessionFile, "");
		await Bun.write(
			workerSessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "worker-session", timestamp: createdAt, cwd: TEST_CWD }),
				JSON.stringify({
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp: createdAt,
					model: "openai-codex/gpt-5.6-luna",
					// Historical concrete overrides did not persist a model-role field.
				}),
				JSON.stringify({
					type: "session_init",
					id: "init",
					parentId: "model",
					timestamp: createdAt,
					systemPrompt: `base prompt\n\nROLE\n====\n${getBundledAgent("scout")?.systemPrompt}`,
					task: "Inspect persisted telemetry.",
					tools: ["read", "grep"],
				}),
				JSON.stringify({
					type: "message",
					id: "assistant",
					parentId: "init",
					timestamp: lastActivity.toISOString(),
					message: {
						role: "assistant",
						timestamp: lastActivity.getTime(),
						content: [
							{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "src/a.ts" } },
							{ type: "toolCall", id: "grep-call", name: "grep", arguments: { pattern: "needle" } },
						],
						usage: {
							input: 100,
							output: 25,
							cacheRead: 200,
							cacheWrite: 10,
							totalTokens: 335,
							cost: { input: 0.01, output: 0.1, cacheRead: 0.01, cacheWrite: 0.003, total: 0.123 },
						},
					},
				}),
			].join("\n"),
		);
		await fs.utimes(workerSessionFile, lastActivity, lastActivity);
		const agents = new AgentRegistry();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			sessionFile,
		});
		await hub.persistedSubagentsReady;

		const workerEntry = renderedRosterEntry(hub, "Worker", 120).replace(/\s+/g, " ");
		expect(workerEntry).toContain("SMOL");
		expect(workerEntry).toContain("$0.123");
		expect(workerEntry).toContain("1m30s");
		expect(workerEntry).toContain("1 req");
		expect(workerEntry).toContain("2 tools");
		expect(workerEntry).toContain("135 tok");
		expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("Read-only · 0 LoC");
		hub.dispose();
	});
	it("yields to a macrotask at the configured streaming threshold", async () => {
		vi.useFakeTimers();
		using tempDir = TempDir.createSync("@omp-agent-hub-responsive-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const entry = JSON.stringify({
			type: "message",
			id: "entry",
			parentId: null,
			timestamp: "2026-07-30T01:13:30.000Z",
			message: { role: "user", content: [{ type: "text", text: "small" }] },
		});
		await Bun.write(sessionFile, `${entry}\n`.repeat(3));
		const thresholdVisited = Promise.withResolvers<void>();
		let complete = false;
		let yieldedBeforeComplete = false;
		let visited = 0;
		const visit = visitEntriesFromFileStream(
			sessionFile,
			() => {
				visited++;
				if (visited !== 2) return;
				setTimeout(() => {
					if (!complete) yieldedBeforeComplete = true;
				}, 0);
				thresholdVisited.resolve();
			},
			{ yieldEveryBytes: 0, yieldEveryEntries: 2 },
		).finally(() => {
			complete = true;
		});
		try {
			await thresholdVisited.promise;
			vi.runOnlyPendingTimers();
			await visit;
			expect(visited).toBe(3);
			expect(yieldedBeforeComplete).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not generically revive active or tombstoned Vibe children copied by a post-exit fork", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-vibe-fork-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendModeChange("vibe");
		const parentSessionId = manager.getSessionId();
		for (const id of ["ActiveVibe", "KilledVibe"]) {
			manager.appendCustomEntry("vibe-session-lifecycle", {
				version: 1,
				action: "spawn",
				id,
				ownerId: "Main",
				parentSessionId,
				cli: "fast",
				agent: "sonic",
				childSessionFile: `${id}.jsonl`,
				createdAt: Date.now(),
			});
		}
		manager.appendCustomEntry("vibe-session-lifecycle", {
			version: 1,
			action: "tombstone",
			id: "KilledVibe",
			ownerId: "Main",
			parentSessionId,
			reason: "mode-exit",
		});
		manager.appendModeChange("none");
		await manager.ensureOnDisk();
		await manager.flush();
		const sourceSessionFile = manager.getSessionFile();
		if (!sourceSessionFile) throw new Error("Expected source session file");
		const sourceArtifacts = sourceSessionFile.slice(0, -6);
		await fs.mkdir(sourceArtifacts, { recursive: true });
		for (const id of ["ActiveVibe", "KilledVibe"]) {
			await fs.writeFile(path.join(sourceArtifacts, `${id}.jsonl`), "persisted child");
		}
		await fs.writeFile(path.join(sourceArtifacts, "OrdinaryTask.jsonl"), persistedChildJsonl("OrdinaryTask"));
		const fork = await manager.fork();
		if (!fork) throw new Error("Expected persisted fork");
		await fs.cp(sourceArtifacts, fork.newSessionFile.slice(0, -6), { recursive: true });
		await manager.close();

		const agents = new AgentRegistry();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
			sessionFile: fork.newSessionFile,
		});
		await hub.persistedSubagentsReady;

		expect(agents.get("ActiveVibe")).toBeUndefined();
		expect(agents.get("KilledVibe")).toBeUndefined();
		expect(agents.get("OrdinaryTask")?.status).toBe("parked");
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
		const focusedIds: string[] = [];
		const focusResolved = Promise.withResolvers<void>();
		const editorFocused = Promise.withResolvers<void>();
		const focusTargets: unknown[] = [];
		const editorContainer = {
			children: [editor],
			clear: () => {},
			addChild: () => {},
		};
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				showOverlay: (component: AgentHubOverlayComponent) => {
					capturedHub = component;
					return { hide: () => {} };
				},
				setFocus: (target: unknown) => {
					focusTargets.push(target);
					if (target === editor) editorFocused.resolve();
				},
				requestRender: () => {},
			},
			editor,
			editorContainer,
			collabGuest: { agentRegistry: agents, hubRemote: undefined },
			focusAgentSession: async (id: string) => {
				focusedIds.push(id);
				focusResolved.resolve();
			},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => null },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);

		controller.showAgentHub(new SessionObserverRegistry());

		expect(focusTargets[0]).toBe(capturedHub);

		capturedHub!.handleInput("\r");
		await focusResolved.promise;
		await editorFocused.promise;

		expect(focusedIds).toEqual([AGENT_ID]);
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

	function setup(agents: AgentRegistry, sessionFile: string | null = null) {
		let shown: AgentHubOverlayComponent | undefined;
		let overlayOptions: Record<string, unknown> | undefined;
		const shownReady = Promise.withResolvers<AgentHubOverlayComponent>();
		const editor = {};
		const focusTargets: unknown[] = [];
		const ctx = {
			keybindings: { getKeys: () => [] },
			ui: {
				showOverlay: (component: AgentHubOverlayComponent, options: Record<string, unknown>) => {
					shown = component;
					overlayOptions = options;
					shownReady.resolve(component);
					return { hide: () => {} };
				},
				setFocus: (target: unknown) => {
					focusTargets.push(target);
				},
				requestRender: () => {},
			},
			editor,
			editorContainer: {
				children: [editor],
				clear: () => {},
				addChild: () => {},
			},
			collabGuest: { agentRegistry: agents, hubRemote: undefined },
			focusAgentSession: async () => {},
			session: { getToolByName: () => undefined, extensionRunner: undefined },
			sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => sessionFile },
			hideThinkingBlock: false,
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);
		return {
			controller,
			editor,
			shown: () => shown,
			shownReady: shownReady.promise,
			overlayOptions: () => overlayOptions,
			focusTargets,
		};
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
		const { controller, shown } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(shown()).toBeDefined();
		shown()!.dispose();
	});

	it("requireContent opens the hub after persisted subagents load", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-require-content-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, persistedChildJsonl("worker"));
		const agents = new AgentRegistry();
		const { controller, shown, shownReady } = setup(agents, sessionFile);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(shown()).toBeUndefined();
		const shownHub = await shownReady;
		expect(agents.get("Worker")?.sessionFile).toBe(workerSessionFile);
		shownHub!.dispose();
	});

	it("the explicit hub opens fullscreen before persisted subagents load", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-explicit-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(path.join(tempDir.path(), "main", "Worker.jsonl"), persistedChildJsonl("worker"));
		const agents = new AgentRegistry();
		const { controller, shown, overlayOptions } = setup(agents, sessionFile);

		controller.showAgentHub(new SessionObserverRegistry());

		const hub = shown();
		expect(hub).toBeDefined();
		expect(overlayOptions()).toMatchObject({ width: "100%", maxHeight: "100%", margin: 0, fullscreen: true });
		expect(agents.get("Worker")).toBeUndefined();
		expect(Bun.stripANSI(hub!.render(120).join("\n"))).toContain("Loading saved agents");
		await hub!.persistedSubagentsReady;
		expect(agents.get("Worker")?.status).toBe("parked");
		hub!.dispose();
	});

	it("armCloseTap lets a single ← dismiss the hub the opening ←← raised", () => {
		const agents = new AgentRegistry();
		// A parked/persisted agent opens the hub under requireContent (issue #4780).
		agents.register({
			id: "Parked",
			displayName: "Parked",
			kind: "sub",
			parentId: "Main",
			session: { subscribe: () => () => {} } as unknown as AgentSession,
			sessionFile: null,
			status: "parked",
		});
		const { controller, editor, shown, focusTargets } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true, armCloseTap: true });

		const hub = shown();
		expect(hub).toBeDefined();
		expect(focusTargets.at(-1)).toBe(hub);

		// One ← — the editor's detector consumed the ←← that opened the hub — now
		// closes it, returning focus to the editor. Without armCloseTap this ← only
		// primes the hub's fresh detector and the user stays trapped.
		hub!.handleInput("\x1b[D");

		expect(focusTargets.at(-1)).toBe(editor);
	});
});

describe("Agent hub data refresh coalescing", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("coalesces a synchronous registry burst into one render and refreshes rows", async () => {
		vi.useFakeTimers();
		const agents = new AgentRegistry();
		const observers = new SessionObserverRegistry();
		const requestRender = vi.fn();
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender,
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});

		try {
			await hub.persistedSubagentsReady;
			requestRender.mockClear();

			for (const id of ["BurstA", "BurstB", "BurstC"]) {
				agents.register({
					id,
					displayName: id,
					kind: "sub",
					parentId: "Main",
					session: { subscribe: () => () => {} } as unknown as AgentSession,
					sessionFile: null,
					status: "running",
				});
			}

			expect(requestRender).not.toHaveBeenCalled();
			expect(Bun.stripANSI(hub.render(120).join("\n"))).not.toContain("BurstA");

			vi.advanceTimersByTime(99);
			expect(requestRender).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1);
			expect(requestRender).toHaveBeenCalledTimes(1);

			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).toContain("BurstA");
			expect(rendered).toContain("BurstB");
			expect(rendered).toContain("BurstC");
		} finally {
			hub.dispose();
			vi.useRealTimers();
		}
	});

	it("refreshes direct-session fallback stats on the age cadence, not paints or heartbeats", async () => {
		vi.useFakeTimers();
		const agents = new AgentRegistry();
		const observers = new SessionObserverRegistry();
		const requestRender = vi.fn();
		let inputTokens = 100;
		let assistantMessages = 1;
		const getSessionStats = vi.fn(() => ({
			sessionFile: undefined,
			sessionId: "sdk-agent",
			userMessages: 1,
			assistantMessages,
			toolCalls: 2,
			toolResults: 2,
			totalMessages: 6,
			tokens: {
				input: inputTokens,
				output: 50,
				reasoning: 0,
				cacheRead: 20,
				cacheWrite: 0,
				total: inputTokens + 70,
			},
			premiumRequests: 0,
			cost: 0.1,
		}));
		agents.register({
			id: "SdkAgent",
			displayName: "SDK agent",
			kind: "sub",
			parentId: "Main",
			session: { getSessionStats, subscribe: () => () => {} } as unknown as AgentSession,
			status: "running",
		});
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender,
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});

		try {
			await hub.persistedSubagentsReady;
			expect(getSessionStats).toHaveBeenCalledTimes(1);
			for (let i = 0; i < 4; i++) hub.render(120);
			expect(getSessionStats).toHaveBeenCalledTimes(1);
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("150 tok");

			inputTokens = 400;
			assistantMessages = 2;
			agents.setActivity("SdkAgent", "heartbeat");
			vi.advanceTimersByTime(100);
			expect(getSessionStats).toHaveBeenCalledTimes(1);
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("150 tok");

			vi.advanceTimersByTime(4_899);
			expect(getSessionStats).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1);
			expect(getSessionStats).toHaveBeenCalledTimes(2);
			const refreshed = Bun.stripANSI(hub.render(120).join("\n"));
			expect(refreshed).toContain("450 tok");
			expect(refreshed).toContain("2 req");
			expect(refreshed).toContain("1/1");
			expect(refreshed).toContain("measured");
			hub.render(120);
			expect(getSessionStats).toHaveBeenCalledTimes(2);
		} finally {
			hub.dispose();
			vi.useRealTimers();
		}
	});

	it("counts shared fallback session usage once across parent and descendant rows", () => {
		const agents = new AgentRegistry();
		const getSessionStats = vi.fn(() => ({
			tokens: { input: 100, output: 40, cacheRead: 10, cacheWrite: 10, total: 160 },
			assistantMessages: 1,
			toolCalls: 2,
			cost: 0.1,
			contextUsage: undefined,
		}));
		const session = { getSessionStats } as unknown as AgentSession;
		agents.register({ id: "Parent", displayName: "Parent", kind: "sub", session, status: "idle" });
		agents.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Parent",
			session,
			status: "idle",
		});
		const hub = new AgentHubOverlayComponent({
			settings: Settings.isolated(),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});
		try {
			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(rendered).toContain("150 tok");
			expect(rendered).toContain("1/2");
			expect(rendered).toContain("measured");
			expect(getSessionStats).toHaveBeenCalledTimes(1);
		} finally {
			hub.dispose();
		}
	});
});
