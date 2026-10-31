/**
 * Contract: in an SDK session, the dialogs a turn opens for the user's answer (`ask` through the tool UI context, a
 * tool approval through the extension runner's) end the computer turn's display hold while they wait, and the turn
 * holds again after the answer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { trackUserWaits } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/user-wait";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computerTurnInFlight, registerComputerController } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("SDK session dialogs and the computer display hold", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let unregister: (() => void) | undefined;

	beforeAll(async () => {
		await initTheme(false);
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-computer-user-wait-${Snowflake.next()}-`));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		unregister?.();
		unregister = undefined;
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	/** Turns whose end, or wait for the user, released the display on the session's computer controller. */
	const releases: number[] = [];
	/** The open dialog: what the computer turn was while it waited, and how to answer it. */
	let dialog = Promise.withResolvers<{ turn: number | undefined; releases: number; answer(label: string): void }>();

	/** A UI whose `select` waits until the test answers it. */
	const ui = {
		select: (_title: string) => {
			const answered = Promise.withResolvers<string | undefined>();
			dialog.resolve({ turn: computerTurnInFlight(owner), releases: releases.length, answer: answered.resolve });
			return answered.promise;
		},
		notify: () => {},
	} as unknown as ExtensionUIContext;
	let owner = "";

	async function createSession(settings: Record<string, unknown>, responses: MockResponse[]): Promise<AgentSession> {
		releases.length = 0;
		dialog = Promise.withResolvers();
		const created = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "async.enabled": false, "bash.autoBackground.enabled": false, ...settings }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			hasUI: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["ask", "bash"],
		});
		session = created.session;
		created.setToolUIContext(ui, true);
		await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {}, uiContext: ui });
		session.agent.streamFn = createMockModel({ responses }).stream;
		owner = session.getEvalKernelOwnerId();
		unregister = registerComputerController(owner, {
			async run() {
				throw new Error("not used");
			},
			async capabilities() {
				return undefined;
			},
			releaseDisplay(turn) {
				releases.push(turn);
			},
			async close() {},
		});
		return session;
	}

	const call = (name: string, args: Record<string, unknown>): MockResponse => ({
		content: [{ type: "toolCall", name, arguments: args }],
		stopReason: "toolUse",
	});

	it("ends the hold while `ask` waits for an answer", async () => {
		const target = await createSession({}, [
			call("ask", { questions: [{ id: "go", question: "Go on?", options: [{ label: "Yes" }, { label: "No" }] }] }),
			{ content: ["done"] },
		]);
		const running = target.prompt("go");
		const open = await dialog.promise;
		expect(open).toMatchObject({ turn: undefined, releases: 1 });
		open.answer("Yes");
		await running;
		// The answer began turn 2, which ended with the prompt.
		expect(releases).toEqual([1, 2]);
	});

	it("keeps the hold while an `ask` with an `ask.timeout` deadline waits, since the turn goes on unattended", async () => {
		const target = await createSession({ "ask.timeout": 30 }, [
			call("ask", { questions: [{ id: "go", question: "Go on?", options: [{ label: "Yes" }, { label: "No" }] }] }),
			{ content: ["done"] },
		]);
		const running = target.prompt("go");
		const open = await dialog.promise;
		expect(open).toMatchObject({ turn: 1, releases: 0 });
		open.answer("Yes");
		await running;
		expect(releases).toEqual([1]);
	});

	it("ends the hold while a tool approval waits for an answer", async () => {
		const target = await createSession({ "tools.approvalMode": "always-ask" }, [
			call("bash", { command: "echo hi" }),
			{ content: ["done"] },
		]);
		const running = target.prompt("go");
		const open = await dialog.promise;
		expect(open).toMatchObject({ turn: undefined, releases: 1 });
		open.answer("Deny");
		await running;
		expect(releases).toEqual([1, 2]);
	});
});

describe("trackUserWaits", () => {
	it("re-reads an optional dialog getter on every access", async () => {
		// Like the RPC UI context's `askDialog`, which `set_ask_dialog` turns off: once off, the ask must fall back to
		// `select`, not keep the wrapper of the dialog it read while on.
		const tracked: string[] = [];
		const rpcLike = {
			enabled: true,
			get askDialog(): ExtensionUIContext["askDialog"] {
				if (!this.enabled) return undefined;
				return async () => undefined;
			},
		};
		const ui = trackUserWaits(rpcLike as unknown as ExtensionUIContext, dialog => {
			tracked.push("ask");
			return dialog();
		});
		await ui.askDialog?.([]);
		expect(tracked).toEqual(["ask"]);
		rpcLike.enabled = false;
		expect(ui.askDialog).toBeUndefined();
		rpcLike.enabled = true;
		expect(ui.askDialog).toBeFunction();
	});

	it("calls a dialog the context replaced after the first access", async () => {
		const calls: string[] = [];
		const replaceable = { select: async () => calls.push("first") };
		const ui = trackUserWaits(replaceable as unknown as ExtensionUIContext, dialog => dialog());
		await ui.select("a", []);
		replaceable.select = async () => calls.push("second");
		await ui.select("b", []);
		expect(calls).toEqual(["first", "second"]);
	});
});
