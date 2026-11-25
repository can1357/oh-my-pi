/**
 * `SelectorController.showAgentHub`: the hub opens fullscreen and takes the keys,
 * Enter on an agent focuses it and gives the keys back to the editor area, and
 * the editor's double-← gesture (`requireContent`) opens it only when there is
 * an agent to show.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { defaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/task/session-observer-registry";
import { type KeyEvent, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { bubbleKey, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Overlays } from "../../../src/ui/shell/overlays";
import { initTheme } from "../../../src/ui/theme/service";

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

function key(id: string, raw: string): KeyEvent {
	return { id, kind: "press", raw };
}

function registerSub(agents: AgentRegistry, id: string, status: "running" | "parked"): void {
	agents.register({
		id,
		displayName: id,
		kind: "sub",
		parentId: "Main",
		session: { subscribe: () => () => {} } as unknown as AgentSession,
		sessionFile: null,
		status,
	});
}

function setup(
	agents: AgentRegistry,
	options: { sessionFile?: string | null; focusAgent?: (id: string) => Promise<void> } = {},
) {
	const focused = signal<UiNode | null>(null);
	/** The editor area: where the shell's home focus rests. */
	const home = jsx("col", {}) as UiNode;
	const overlays = new Overlays({ focused, focus: node => focused.set(node), fallback: () => home });
	const ctx = {
		keybindings: { keysFor: () => [] },
		shell: {
			overlays,
			focused,
			focus: (node: UiNode | null) => focused.set(node ?? home),
			size: () => ({ columns: 120, rows: 40 }),
		},
		collabGuest: { agentRegistry: agents, hubRemote: undefined },
		focusAgentSession: options.focusAgent ?? (async () => {}),
		session: {},
		sessionManager: {
			getCwd: () => TEST_CWD,
			getSessionFile: () => options.sessionFile ?? null,
			getStorage: defaultSessionStorage,
		},
	} as unknown as InteractiveModeContext;
	const controller = new SelectorController(ctx);
	return {
		controller,
		home,
		overlays,
		focused,
		/** Press `id` on the focused node (the hub's picker), bubbling up as the terminal routes it. */
		press(id: string, raw: string): void {
			const target = focused();
			if (!target) throw new Error("Nothing holds the keys");
			bubbleKey(pathTo(overlays.nodes(), target), key(id, raw));
		},
	};
}

describe("SelectorController.showAgentHub", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("opens the hub fullscreen with its picker holding the keys", () => {
		const agents = new AgentRegistry();
		registerSub(agents, AGENT_ID, "running");
		const { controller, overlays, focused } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry());

		const layer = overlays.top()?.node;
		expect(layer?.kind).toBe("overlay");
		expect(layer?.props()).toMatchObject({ size: "full" });
		expect(focused()?.kind).toBe("picker");
		overlays.closeAll();
	});

	it("restores focus to the editor area after Enter focuses an agent", async () => {
		const agents = new AgentRegistry();
		registerSub(agents, AGENT_ID, "running");
		const focusedIds: string[] = [];
		const activated = Promise.withResolvers<void>();
		const { controller, overlays, focused, home, press } = setup(agents, {
			focusAgent: async id => {
				focusedIds.push(id);
				activated.resolve();
			},
		});

		controller.showAgentHub(new SessionObserverRegistry());
		press("enter", "\r");
		await activated.promise;
		// Activation settles its focus promise before the hub closes.
		await Promise.resolve();

		expect(focusedIds).toEqual([AGENT_ID]);
		expect(overlays.open()).toBe(false);
		expect(focused()).toBe(home);
	});

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
		const { controller, overlays } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(overlays.open()).toBe(false);
	});

	it("requireContent opens the hub once a subagent exists", () => {
		const agents = new AgentRegistry();
		registerSub(agents, AGENT_ID, "running");
		const { controller, overlays } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(overlays.open()).toBe(true);
		overlays.closeAll();
	});

	it("requireContent opens the hub after persisted subagents load", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-require-content-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, persistedChildJsonl("worker"));
		const agents = new AgentRegistry();
		const { controller, overlays } = setup(agents, { sessionFile });
		const shown = Promise.withResolvers<void>();
		const show = overlays.show.bind(overlays);
		overlays.show = (factory, options) => {
			const handle = show(factory, options);
			shown.resolve();
			return handle;
		};

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expect(overlays.open()).toBe(false);
		await shown.promise;
		expect(overlays.open()).toBe(true);
		expect(agents.get("Worker")?.sessionFile).toBe(workerSessionFile);
		overlays.closeAll();
	});

	it("the explicit hub opens before persisted subagents load", async () => {
		using tempDir = TempDir.createSync("@omp-agent-hub-explicit-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(path.join(tempDir.path(), "main", "Worker.jsonl"), persistedChildJsonl("worker"));
		const agents = new AgentRegistry();
		const { controller, overlays } = setup(agents, { sessionFile });

		controller.showAgentHub(new SessionObserverRegistry());

		expect(overlays.open()).toBe(true);
		expect(agents.get("Worker")).toBeUndefined();
		// The hub's own scan registers the saved agent.
		const registered = Promise.withResolvers<void>();
		const stop = agents.onChange(() => {
			if (agents.get("Worker")) registered.resolve();
		});
		await registered.promise;
		stop();
		expect(agents.get("Worker")?.status).toBe("parked");
		overlays.closeAll();
	});

	it("armCloseTap lets a single ← dismiss the hub the opening ←← raised", () => {
		const agents = new AgentRegistry();
		// A parked/persisted agent opens the hub under requireContent (issue #4780).
		registerSub(agents, "Parked", "parked");
		const { controller, overlays, focused, home, press } = setup(agents);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true, armCloseTap: true });
		expect(focused()?.kind).toBe("picker");

		// One ← — the editor's detector consumed the ←← that opened the hub — now
		// closes it, returning focus to the editor area.
		press("left", "\x1b[D");

		expect(overlays.open()).toBe(false);
		expect(focused()).toBe(home);
	});
});
