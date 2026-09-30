/**
 * `pi.sendUserInput()` runs text the way a headless host runs typed input and
 * says how it handled it. A bridge extension (a chat or web front end that
 * forwards what a person typed into a live session) relies on each answer:
 * which inputs start a turn, which run locally, which it must refuse, and how
 * to find the message its input became (`tag` on `message_start`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

interface Harness {
	api: ExtensionAPI;
	session: AgentSession;
	manager: SessionManager;
	/** Every message whose `message_start` reached the extension, in order. */
	started: AgentMessage[];
	/** Arguments each `/deploy` extension-command run received. */
	deployRuns: string[];
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	return content.map(part => (part.type === "text" ? part.text : "")).join("");
}

function userTurns(started: AgentMessage[]): AgentMessage[] {
	return started.filter(message => message.role === "user" || message.role === "custom");
}

describe("pi.sendUserInput", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let tempDir: string | undefined;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = undefined;
	});

	async function start(options?: {
		skills?: Skill[];
		promptTemplates?: PromptTemplate[];
		/** Wire the host's actions the way RPC and print modes do (default), or leave `sendUserInput` out. */
		wired?: boolean;
	}): Promise<Harness> {
		const manager = SessionManager.inMemory();
		const runtime = new ExtensionRuntime();
		const started: AgentMessage[] = [];
		const deployRuns: string[] = [];
		let api: ExtensionAPI | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				api = pi;
				pi.registerCommand("deploy", {
					handler: async args => {
						deployRuns.push(args);
					},
				});
				pi.on("message_start", event => {
					started.push(event.message);
				});
			},
			manager.getCwd(),
			new EventBus(),
			runtime,
			"bridge",
		);
		if (!api) throw new Error("extension factory did not run");

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["First reply"] }, { content: ["Second reply"] }] }).stream,
		});
		const runner = new ExtensionRunner([extension], runtime, manager.getCwd(), manager, modelRegistry);
		const created = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner: runner,
			skills: options?.skills,
			skillsSettings: { enableSkillCommands: true },
			promptTemplates: options?.promptTemplates,
		});
		session = created;

		if (options?.wired === false) {
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => created.model,
					isIdle: () => !created.isStreaming,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);
		} else {
			await initializeExtensions(created, {
				reportSendError: (_action, error) => {
					throw error;
				},
				reportRuntimeError: error => {
					throw new Error(error.error);
				},
			});
		}
		return { api, session: created, manager, started, deployRuns };
	}

	it("submits plain text as a user turn whose message carries the caller's tag", async () => {
		const { api, session, manager, started } = await start();

		expect(await api.sendUserInput("hello there", { tag: "msg-1" })).toEqual({ handled: "prompt" });
		await session.waitForIdle();

		const [turn, ...rest] = userTurns(started);
		expect(rest).toHaveLength(0);
		expect(turn?.role).toBe("user");
		expect(messageText(turn!)).toBe("hello there");
		expect(turn && "tag" in turn ? turn.tag : undefined).toBe("msg-1");
		expect(session.messages.some(message => message.role === "assistant")).toBe(true);
		// A bridge that rebuilds from the transcript finds the same tag on disk.
		const persisted = manager
			.getEntries()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.message] : []));
		expect(persisted.map(message => ("tag" in message ? message.tag : undefined))).toEqual(["msg-1"]);
	});

	it("runs an extension command locally and submits nothing", async () => {
		const { api, session, started, deployRuns } = await start();

		expect(await api.sendUserInput("/deploy staging", { tag: "msg-2" })).toEqual({ handled: "command" });
		await session.waitForIdle();

		expect(deployRuns).toEqual(["staging"]);
		expect(userTurns(started)).toHaveLength(0);
		expect(session.messages.some(message => message.role === "assistant")).toBe(false);
	});

	it("expands a prompt template into the tagged user turn it submits", async () => {
		const { api, session, started } = await start({
			promptTemplates: [
				{ name: "greet", description: "Greet someone", content: "Say hello to $1", source: "(test)" },
			],
		});

		expect(await api.sendUserInput("/greet Sami", { tag: "msg-3" })).toEqual({ handled: "prompt" });
		await session.waitForIdle();

		const [turn] = userTurns(started);
		expect(messageText(turn!)).toBe("Say hello to Sami");
		expect(turn && "tag" in turn ? turn.tag : undefined).toBe("msg-3");
	});

	it("invokes /skill:<name> as the user's skill prompt, tagged and persisted with its tag", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-send-user-input-${Snowflake.next()}-`));
		const skillPath = path.join(tempDir, "SKILL.md");
		await Bun.write(skillPath, "---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code.\n");
		const { api, session, manager, started } = await start({
			skills: [
				{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: tempDir, source: "project" },
			],
		});

		expect(await api.sendUserInput("/skill:reviewer focus on risks", { tag: "msg-4" })).toEqual({ handled: "skill" });
		await session.waitForIdle();

		const [turn, ...rest] = userTurns(started);
		expect(rest).toHaveLength(0);
		expect(turn?.role).toBe("custom");
		expect(turn && turn.role === "custom" ? turn.customType : undefined).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(turn && turn.role === "custom" ? turn.attribution : undefined).toBe("user");
		expect(messageText(turn!)).toContain("Review the supplied code.");
		expect(turn && "tag" in turn ? turn.tag : undefined).toBe("msg-4");
		const persisted = manager.getEntries().flatMap(entry => (entry.type === "custom_message" ? [entry] : []));
		expect(persisted.map(entry => entry.tag)).toEqual(["msg-4"]);
	});

	it("runs a built-in the headless modes run and returns what it printed", async () => {
		const { api, session, started } = await start();

		const result = await api.sendUserInput("/jobs");
		await session.waitForIdle();

		expect(result.handled).toBe("command");
		expect(result.output).toBeString();
		expect(result.output?.length).toBeGreaterThan(0);
		expect(userTurns(started)).toHaveLength(0);
	});

	it.each(["/new", "/resume"])("answers terminal-only for %s and sends nothing", async text => {
		const { api, session, started } = await start();
		const sessionId = session.sessionId;

		expect(await api.sendUserInput(text)).toEqual({ handled: "terminal-only" });
		await session.waitForIdle();

		expect(userTurns(started)).toHaveLength(0);
		expect(session.sessionId).toBe(sessionId);
	});

	it("answers unknown for a slash command nothing defines and does not send it to the model", async () => {
		const { api, session, started } = await start();

		expect(await api.sendUserInput("/nosuch argument")).toEqual({ handled: "unknown" });
		await session.waitForIdle();

		expect(userTurns(started)).toHaveLength(0);
		expect(session.messages.some(message => message.role === "assistant")).toBe(false);
	});

	it("answers unavailable when the host mode does not wire sendUserInput", async () => {
		const { api, started } = await start({ wired: false });

		expect(await api.sendUserInput("hello there")).toEqual({ handled: "unavailable" });
		expect(userTurns(started)).toHaveLength(0);
	});
});
