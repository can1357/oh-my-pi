/**
 * Contract: while an SDK session's `ask` dialog waits for the user, the session's agent counts as blocked on the
 * user, so a peer's `wait` for its reply returns at once naming it instead of sitting out the reply cap.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { USER_AWAIT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-awaits";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("a reply wait on an agent in `ask`", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		await initTheme(false);
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-wait-reply-ask-${Snowflake.next()}-`));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	it("returns at once, naming the agent as waiting on the user, until the user answers", async () => {
		const dialog = Promise.withResolvers<(label: string) => void>();
		const ui = {
			select: () => {
				const answered = Promise.withResolvers<string | undefined>();
				dialog.resolve(answered.resolve);
				return answered.promise;
			},
			notify: () => {},
		} as unknown as ExtensionUIContext;
		const created = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "async.enabled": false }),
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
			toolNames: ["ask"],
		});
		session = created.session;
		created.setToolUIContext(ui, true);
		await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {}, uiContext: ui });
		session.agent.streamFn = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "ask",
							arguments: {
								questions: [{ id: "go", question: "Go on?", options: [{ label: "Yes" }, { label: "No" }] }],
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["done"] },
			],
		}).stream;
		const registry = AgentRegistry.global();
		const child = {
			cwd: tempDir,
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: registry,
			getAgentId: () => "Child",
		} as unknown as ToolSession;

		const running = session.prompt("go");
		const answer = await dialog.promise;
		expect(registry.awaits.blocksOn(MAIN_AGENT_ID, USER_AWAIT_ID, Date.now())).toBe(true);
		await IrcBus.global().send({ from: "Child", to: MAIN_AGENT_ID, body: "which codeword?" });
		const result = await new WaitTool(child).execute("child-wait", {});
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining(`\`${MAIN_AGENT_ID}\` is waiting on the user`),
		});

		answer("Yes");
		await running;
		expect(registry.awaits.blocksOn(MAIN_AGENT_ID, USER_AWAIT_ID, Date.now())).toBe(false);
	});
});
