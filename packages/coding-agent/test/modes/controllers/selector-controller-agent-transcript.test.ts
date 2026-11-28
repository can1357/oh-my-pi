/**
 * The Agent Hub's transcript viewer in Tern, opened through
 * `SelectorController.showAgentHub`: a page of its own holding the agent's
 * transcript with the session's transcript controls, a message draft that
 * sends, Escape back to the hub and the hub key closing both.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentHubRemote } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/agent-hub";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/task/session-observer-registry";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { Shell } from "../../../src/ui/shell/shell";
import { initTheme } from "../../../src/ui/theme/service";
import { nativeShell } from "../../helpers/native-shell";

const AGENT_ID = "Worker";
const TEST_CWD = path.resolve("agent-transcript-cwd");
const PROMPT_AT = Date.UTC(2026, 6, 30, 9, 45);
const KEYS: Record<string, string[]> = {
	"app.agents.hub": ["alt+a"],
	"app.tools.expand": ["ctrl+o"],
};

const usage = {
	input: 1_000,
	output: 78,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1_078,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A subagent's session as the host serves it: its assignment (agent-attributed), then its reply. */
const TRANSCRIPT = `${[
	{
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: new Date(PROMPT_AT).toISOString(),
		message: { role: "user", content: "Reply with a greeting.", attribution: "agent", timestamp: PROMPT_AT },
	},
	{
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: new Date(PROMPT_AT + 900).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Hello from the worker." }],
			api: "openai-completions",
			provider: "parity",
			model: "alpha",
			usage,
			stopReason: "stop",
			timestamp: PROMPT_AT + 100,
			completedAt: PROMPT_AT + 900,
		},
	},
]
	.map(entry => JSON.stringify(entry))
	.join("\n")}\n`;

interface Acted {
	prompts: [act: string, text: string, timestamp: number][];
	replies: [act: string, copyText: string | undefined][];
	chats: [id: string, text: string][];
}

/** A collab guest's hub (its agents chat in the viewer) over a composer field, in Tern. */
async function openHub() {
	const agents = new AgentRegistry();
	agents.register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		parentId: "Main",
		session: { subscribe: () => () => {} } as unknown as AgentSession,
		sessionFile: null,
		status: "parked",
	});
	const acted: Acted = { prompts: [], replies: [], chats: [] };
	const loaded = Promise.withResolvers<void>();
	const remote: AgentHubRemote = {
		chat: (id, text) => void acted.chats.push([id, text]),
		kill: () => {},
		revive: () => {},
		readTranscript: async (_id, fromByte) => {
			queueMicrotask(loaded.resolve);
			return fromByte === 0
				? { text: TRANSCRIPT, newSize: Buffer.byteLength(TRANSCRIPT) }
				: { text: "", newSize: fromByte };
		},
	};
	const shell = new Shell();
	const field = jsx("editor", { key: "input", text: "", cursor: 0 }) as UiNode;
	shell.dock.slot("composer").set(() => field);
	const ui = await nativeShell(shell);
	shell.setHome(field);
	const ctx = {
		keybindings: { keysFor: (id: string) => KEYS[id] ?? [] },
		shell,
		collabGuest: { agentRegistry: agents, hubRemote: remote },
		focusAgentSession: async () => {},
		session: {},
		sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => null },
	} as unknown as InteractiveModeContext;
	new SelectorController(ctx).showAgentHub(new SessionObserverRegistry(), undefined, {
		prompt: (act, text, timestamp) => void acted.prompts.push([act, text, timestamp]),
		reply: (act, _message, copyText) => void acted.replies.push([act, copyText]),
	});
	/** Enter on the hub's agent: a guest's agents open in the viewer. */
	const openViewer = async () => {
		ui.type("\r");
		await loaded.promise;
	};
	return { ui, acted, openViewer };
}

describe("the Agent Hub's transcript viewer in Tern", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("opens as a page of its own: the viewer card in main, the message draft focused", async () => {
		const { ui, openViewer } = await openHub();
		await using _ui = ui;
		expect(ui.surface().layer.map(node => node.k)).toEqual(["picker"]);

		await openViewer();

		const page = ui.surface();
		expect({ mode: page.mode, role: page.role }).toEqual({ mode: "screen", role: "omp.session" });
		expect(page.main.map(node => [node.k, node.p.role])).toEqual([["card", "omp.hub.transcript"]]);
		expect(page.dock).toEqual([]);
		expect(page.layer).toEqual([]);
		expect(page.focus).toBe(ui.node("editor").id);
	});

	it("shows the session's transcript controls on the agent's turns and runs the session's handlers", async () => {
		const { ui, acted, openViewer } = await openHub();
		await using _ui = ui;
		await openViewer();

		// The prompt: a hold menu, and Copy, Edit & resend and the time sent under it.
		const tools = ui.node("row", "tools");
		const prompt = ui.get(tools.parent!);
		expect(prompt.p.role).toBe("omp.user");
		expect(tools.c).toHaveLength(4);
		expect(ui.get(tools.c[3]!).p.role).toBe("omp.user.time");
		expect((prompt.p.actions as { hold: { id: string }[] }).hold.map(entry => entry.id)).toEqual([
			"copy-message",
			"edit-turn",
			"retry-turn",
			"rewind-turn",
			"fork-turn",
		]);
		ui.click("icon", "copy");
		ui.click("icon", "edit");
		expect(acted.prompts).toEqual([
			["copy-message", "Reply with a greeting.", PROMPT_AT],
			["edit-turn", "Reply with a greeting.", PROMPT_AT],
		]);

		// The reply: an agent-attributed assignment starts no turn clock, so the usage line has no duration.
		const usageRow = ui.node("row", "turn-usage");
		expect(usageRow.p.title).toBe("This turn: 1,078 tokens (1,000 in · 78 out)");
		const copy = ui.get(usageRow.c[0]!);
		expect(copy.p.role).toBe("omp.turn.copy");
		ui.send({ ev: "action", sf: ui.sf, id: copy.id, act: "copy-answer" });
		expect(acted.replies).toEqual([["copy-answer", "Hello from the worker."]]);
	});

	it("types into the draft, clears it on Escape and sends it on Enter", async () => {
		const { ui, acted, openViewer } = await openHub();
		await using _ui = ui;
		await openViewer();

		ui.type("hello");
		expect(ui.node("editor").p.text).toBe("hello");
		ui.type("\x1b");
		expect(ui.node("editor").p.text).toBe("");
		expect(ui.surface().mode).toBe("screen");

		ui.type("steer left");
		ui.type("\r");
		expect(acted.chats).toEqual([[AGENT_ID, "steer left"]]);
		expect(ui.node("editor").p.text).toBe("");
		expect(ui.surface().mode).toBe("screen");
	});

	it("goes back to the hub on Escape and on its close control", async () => {
		const { ui, openViewer } = await openHub();
		await using _ui = ui;

		await openViewer();
		ui.type("\x1b");
		expect(ui.surface().mode).toBe("inline");
		expect(ui.surface().layer.map(node => node.k)).toEqual(["picker"]);

		ui.type("\r");
		expect(ui.surface().mode).toBe("screen");
		ui.click("button", "esc-close");
		expect(ui.surface().mode).toBe("inline");
		expect(ui.surface().layer.map(node => node.k)).toEqual(["picker"]);
	});

	it("closes the viewer and the hub on the hub key, back on the composer", async () => {
		const { ui, openViewer } = await openHub();
		await using _ui = ui;
		await openViewer();

		// Alt+A.
		ui.type("\x1ba");

		const session = ui.surface();
		expect(session.mode).toBe("inline");
		expect(session.layer).toEqual([]);
		expect(session.focus).toBe(ui.node("editor").id);
	});
});
