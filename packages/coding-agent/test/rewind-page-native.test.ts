/**
 * The rewind page and the session resets as Tern receives them: the page is a
 * screen surface of the branch's own blocks with the bar docked under them,
 * and a reset leaves the welcome card over the new session's first line.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/transcript/messages";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal } from "./helpers/mode-terminal";
import { type NativeNode, nativeShell } from "./helpers/native-shell";

const UP = "\x1b[A";
const ESCAPE = "\x1b";

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 2,
	};
}

/** A reply that only calls `bash`: the run goes on. */
function bashCall(callId: string): AssistantMessage {
	return {
		...assistant(""),
		content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } }],
		stopReason: "toolUse",
	};
}

function bashResult(callId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text: "file.txt" }],
		isError: false,
		timestamp: 3,
	};
}

type Ui = Awaited<ReturnType<typeof nativeShell>>;

/** `kind:role` of a node, with its mark when it carries one. */
function sig(node: NativeNode): string {
	const { role, mark } = node.p;
	return `${node.k}${typeof role === "string" ? `:${role}` : ""}${typeof mark === "string" ? ` [${mark}]` : ""}`;
}

/** The text a node shows: its spans or plain text, and its children's. */
function textOf(ui: Ui, node: NativeNode): string {
	const { text, spans } = node.p;
	const own = Array.isArray(spans)
		? spans.map((span: { t: string }) => span.t).join("")
		: typeof text === "string"
			? text
			: "";
	return [own, ...node.c.map(id => textOf(ui, ui.get(id)))].filter(Boolean).join(" ");
}

function find(ui: Ui, nodes: readonly NativeNode[], kind: string): NativeNode | undefined {
	for (const node of nodes) {
		if (node.k === kind) return node;
		const inner = find(
			ui,
			node.c.map(id => ui.get(id)),
			kind,
		);
		if (inner) return inner;
	}
	return undefined;
}

/** Whether `node` or a node under it has role `role`. */
function hasRole(ui: Ui, node: NativeNode, role: string): boolean {
	return node.p.role === role || node.c.some(id => hasRole(ui, ui.get(id), role));
}

describe("native rewind page and session reset", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-rewind-page-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
		const manager = session.sessionManager;
		manager.appendMessage(user("first prompt"));
		manager.appendMessage(assistant("first answer"));
		manager.appendMessage(user("second prompt"));
		manager.appendMessage(assistant("second answer"));
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("opens a screen surface of the branch's blocks with the latest turn picked and the bar docked", async () => {
		await using ui = await nativeShell(mode.shell);
		await mode.showUserMessageSelector();

		const page = ui.surface("screen");
		expect(page?.role).toBe("omp.rewind");
		expect(page?.main.map(sig)).toEqual([
			"card:omp.user",
			"col:omp.assistant",
			"card:omp.user",
			"text:omp.rewind.here",
			"col:omp.assistant [pick]",
		]);
		expect(textOf(ui, page!.main[3]!)).toContain("Continue from here · nothing below to drop");
		expect(page?.dock.map(sig)).toEqual(["row:omp.rewind.bar"]);
		expect(textOf(ui, page!.dock[0]!)).toContain("4/4");
		// The page is no sheet of the session.
		expect(ui.surface("inline")?.layer).toEqual([]);
	});

	it("moves the outline with the keys: the turns a rewind drops are marked", async () => {
		await using ui = await nativeShell(mode.shell);
		await mode.showUserMessageSelector();
		ui.type(UP);

		const page = ui.surface("screen")!;
		expect(page.main.map(sig)).toEqual([
			"card:omp.user",
			"col:omp.assistant",
			"text:omp.rewind.here",
			"card:omp.user [pick]",
			"col:omp.assistant [drop]",
		]);
		expect(textOf(ui, page.main[2]!)).toContain(
			"Rewind to here · the prompt returns to the editor · 1 turn below dropped",
		);
		expect(textOf(ui, page.dock[0]!)).toContain("3/4");
	});

	it("outlines the turn Tern clicks", async () => {
		await using ui = await nativeShell(mode.shell);
		await mode.showUserMessageSelector();
		const first = ui.surface("screen")!.main[0]!;
		expect(first.p).toMatchObject({ actions: { click: "rewind-pick" } });
		ui.send({ ev: "action", sf: ui.sf, id: first.id, act: "rewind-pick" });

		const page = ui.surface("screen")!;
		expect(page.main.map(sig)).toEqual([
			"text:omp.rewind.here",
			"card:omp.user [pick]",
			"col:omp.assistant [drop]",
			"card:omp.user [drop]",
			"col:omp.assistant [drop]",
		]);
		expect(textOf(ui, page.dock[0]!)).toContain("1/4");
	});

	it("filters the page to the matching turns and Escape leaves the filter, then the page", async () => {
		await using ui = await nativeShell(mode.shell);
		await mode.showUserMessageSelector();
		ui.type("f");
		const field = find(ui, ui.surface("screen")!.dock, "input")!;
		expect(field.p).toMatchObject({ text: "", prompt: "filter: ", sendable: false });
		ui.send({ ev: "edit", sf: ui.sf, id: field.id, from: 0, to: 0, text: "second", cursor: 6, len: 0 });

		let page = ui.surface("screen")!;
		expect(page.main.map(sig)).toEqual(["card:omp.user", "text:omp.rewind.here", "col:omp.assistant [pick]"]);
		expect(textOf(ui, page.dock[0]!)).toContain("2/2");
		expect(textOf(ui, page.dock[0]!)).toContain("Show all");

		ui.send({ ev: "edit", sf: ui.sf, id: field.id, from: 6, to: 6, text: " zzz", cursor: 10, len: 6 });
		page = ui.surface("screen")!;
		expect(page.main.map(sig)).toEqual(["text:omp.rewind.empty"]);
		expect(textOf(ui, page.main[0]!)).toBe('No turns match "second zzz"');
		expect(textOf(ui, page.dock[0]!)).toContain("no matches");

		ui.type(ESCAPE);
		page = ui.surface("screen")!;
		expect(find(ui, page.dock, "input")).toBeUndefined();
		expect(page.main).toHaveLength(5);

		ui.type(ESCAPE);
		expect(ui.surface("screen")).toBeUndefined();
		expect(mode.shell.overlays.open()).toBe(false);
	});

	it("replays a long branch's tail first and loads the rest on `a`", async () => {
		const manager = session.sessionManager;
		for (let index = 0; index < 640; index++) manager.appendMessage(user(`prompt ${index}`));
		await using ui = await nativeShell(mode.shell);
		await mode.showUserMessageSelector();

		let page = ui.surface("screen")!;
		expect(sig(page.main[0]!)).toBe("row:omp.rewind.earlier");
		expect(textOf(ui, page.main[0]!)).toBe("load earlier turns");
		expect(textOf(ui, page.dock[0]!)).toContain("600/600");
		expect(textOf(ui, page.dock[0]!)).toContain("earlier turns");

		ui.type("a");
		page = ui.surface("screen")!;
		expect(sig(page.main[0]!)).toBe("card:omp.user");
		expect(textOf(ui, page.main[0]!)).toContain("first prompt");
		// The outline stays on the turn it was on.
		expect(textOf(ui, page.dock[0]!)).toContain("644/644");
		expect(sig(page.main.at(-1)!)).toBe("card:omp.user [pick]");
	});

	it("shows the totals of the branch's first run, however that run started", async () => {
		// A run an extension starts (`sendCustomMessage(…, { triggerTurn: true })`) opens with no prompt.
		const manager = session.sessionManager;
		manager.resetLeaf();
		const trigger: CustomMessage = {
			role: "custom",
			customType: "test-trigger",
			content: "check the build",
			display: true,
			attribution: "agent",
			timestamp: 1,
		};
		manager.appendMessage(trigger);
		manager.appendMessage(assistant("the build passes"));
		await using ui = await nativeShell(mode.shell);
		await mode.showUserMessageSelector();

		const reply = ui.surface("screen")!.main.at(-1)!;
		expect(sig(reply)).toBe("col:omp.assistant [pick]");
		expect(hasRole(ui, reply, "omp.turn.usage")).toBe(true);
	});

	it("leaves out the totals of a run the tail opens partway through, until `a` loads its start", async () => {
		const manager = session.sessionManager;
		manager.appendMessage(user("run the sweep"));
		for (let index = 0; index < 330; index++) {
			manager.appendMessage(bashCall(`call-${index}`));
			manager.appendMessage(bashResult(`call-${index}`));
		}
		manager.appendMessage(assistant("swept"));
		await using ui = await nativeShell(mode.shell);
		await mode.showUserMessageSelector();

		// The tail's totals would count only its part of the run.
		let reply = ui.surface("screen")!.main.at(-1)!;
		expect(sig(reply)).toBe("col:omp.assistant [pick]");
		expect(hasRole(ui, reply, "omp.turn.usage")).toBe(false);

		ui.type("a");
		reply = ui.surface("screen")!.main.at(-1)!;
		expect(sig(reply)).toBe("col:omp.assistant [pick]");
		expect(hasRole(ui, reply, "omp.turn.usage")).toBe(true);
	});

	it("shows the welcome card again over the first line of a new session", async () => {
		// The mode's own frame: it shows the welcome card (the shared test frame starts quiet).
		mode.stop();
		mode = new InteractiveMode(session, "test");
		await using ui = await nativeShell(mode.shell);
		mode.present(() => "an old line");
		expect(ui.surface("inline")?.main.map(sig)).toEqual(["spacer", "card:omp.welcome", "spacer", "text"]);
		await mode.handleClearCommand();

		const main = ui.surface("inline")!.main;
		expect(main.map(sig)).toEqual(["spacer", "card:omp.welcome", "spacer", "spacer", "text"]);
		expect(textOf(ui, main[4]!)).toContain("New session started");
	});
});
