/**
 * `pi.sendUserMessage(text, { expand: true, tag })`: running text as if the user had typed it.
 *
 * Each case drives the real extension API against a real `AgentSession` with a mock model, so what
 * it asserts is what a bridge extension observes: the answer it gets back, the messages the session
 * records, and the `tag` that survives onto the transcript.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionAPI,
	InputEvent,
	InputEventResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

interface Harness {
	api: ExtensionAPI;
	session: AgentSession;
	manager: SessionManager;
	/** Every message whose `message_start` reached the extension, in order. */
	started: AgentMessage[];
	/** Arguments each `/deploy` extension-command run received. */
	deployRuns: string[];
	/** Each turn-ownership task `initializeExtensions` reported, in order. */
	invoking: Promise<unknown>[];
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

function tagOf(message: AgentMessage | undefined): string | undefined {
	return message && (message.role === "user" || message.role === "custom") ? message.tag : undefined;
}

describe("pi.sendUserMessage with expand", () => {
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
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	async function start(options?: {
		skills?: Skill[];
		promptTemplates?: PromptTemplate[];
		/** An `input` handler the bridge extension registers. */
		onInput?: (event: InputEvent) => InputEventResult | undefined;
	}): Promise<Harness> {
		const manager = SessionManager.inMemory();
		const runtime = new ExtensionRuntime();
		const started: AgentMessage[] = [];
		const deployRuns: string[] = [];
		const invoking: Promise<unknown>[] = [];
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
				const onInput = options?.onInput;
				if (onInput) pi.on("input", event => onInput(event));
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
			streamFn: createMockModel({
				responses: [{ content: ["First reply"] }, { content: ["Second reply"] }, { content: ["Third reply"] }],
			}).stream,
		});
		const created = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], runtime, manager.getCwd(), manager, modelRegistry),
			skills: options?.skills,
			skillsSettings: { enableSkillCommands: true },
			promptTemplates: options?.promptTemplates,
		});
		session = created;
		await initializeExtensions(created, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw new Error(error.error);
			},
			trackAgentInvokingMessage: task => {
				invoking.push(task);
			},
		});
		return { api, session: created, manager, started, deployRuns, invoking };
	}

	async function writeReviewerSkill(): Promise<Skill> {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-send-user-input-"));
		const filePath = path.join(tempDir, "SKILL.md");
		await Bun.write(filePath, "---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code.\n");
		return { name: "reviewer", description: "Review code", filePath, baseDir: tempDir, source: "project" };
	}

	it("submits plain text as a user turn whose message carries the caller's tag, live and on disk", async () => {
		const { api, session, manager, started, invoking } = await start();

		expect(await api.sendUserMessage("hello there", { expand: true, tag: "msg-1" })).toEqual({ handled: "prompt" });
		await session.waitForIdle();

		const turns = userTurns(started);
		expect(turns.map(messageText)).toEqual(["hello there"]);
		expect(tagOf(turns[0])).toBe("msg-1");
		expect(session.messages.some(message => message.role === "assistant")).toBe(true);
		// A bridge that rebuilds from the transcript finds the same tag on disk.
		const persisted = manager
			.getEntries()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.message] : []));
		expect(persisted.map(message => tagOf(message))).toEqual(["msg-1"]);
		// The host counts a submitted prompt as a turn the extension started.
		await expect(invoking[0]).resolves.toBeUndefined();
	});

	it("records the tag on a plain send too, which still sends slash text verbatim", async () => {
		const { api, session, started, deployRuns } = await start();

		expect(await api.sendUserMessage("/deploy staging", { tag: "msg-plain" })).toEqual({ handled: "prompt" });
		await session.waitForIdle();

		// No command ran: the text reached the model as the user's words, as it always has.
		expect(deployRuns).toEqual([]);
		const turns = userTurns(started);
		expect(turns.map(messageText)).toEqual(["/deploy staging"]);
		expect(tagOf(turns[0])).toBe("msg-plain");
	});

	it("runs an extension command locally, submits nothing, and claims no turn", async () => {
		const { api, session, started, deployRuns, invoking } = await start();

		expect(await api.sendUserMessage("/deploy staging", { expand: true, tag: "msg-2" })).toEqual({
			handled: "command",
		});
		await session.waitForIdle();

		expect(deployRuns).toEqual(["staging"]);
		expect(userTurns(started)).toHaveLength(0);
		expect(session.messages.some(message => message.role === "assistant")).toBe(false);
		// RPC waits on this task for agent events; a local command must not make it wait.
		expect(invoking).toHaveLength(1);
		await expect(invoking[0]).rejects.toThrow("send did not invoke the agent");
	});

	it("runs extension input handlers first, with source extension, and answers command when one consumes the text", async () => {
		const sources: string[] = [];
		const { api, session, started } = await start({
			onInput: event => {
				sources.push(event.source);
				return event.text.startsWith("secret:") ? { handled: true } : undefined;
			},
		});

		expect(await api.sendUserMessage("secret: keep this local", { expand: true })).toEqual({ handled: "command" });
		await session.waitForIdle();

		expect(sources).toEqual(["extension"]);
		expect(userTurns(started)).toHaveLength(0);
		expect(session.messages.some(message => message.role === "assistant")).toBe(false);
	});

	it("dispatches the text an input handler rewrites it to", async () => {
		const { api, session, started, deployRuns } = await start({
			onInput: event => (event.text.startsWith("ship ") ? { text: `/deploy ${event.text.slice(5)}` } : undefined),
		});

		expect(await api.sendUserMessage("ship staging", { expand: true })).toEqual({ handled: "command" });
		await session.waitForIdle();

		expect(deployRuns).toEqual(["staging"]);
		expect(userTurns(started)).toHaveLength(0);
	});

	it("expands a prompt template into the tagged user turn it submits", async () => {
		const { api, session, started } = await start({
			promptTemplates: [
				{ name: "greet", description: "Greet someone", content: "Say hello to $1", source: "(test)" },
			],
		});

		expect(await api.sendUserMessage("/greet Sami", { expand: true, tag: "msg-3" })).toEqual({ handled: "prompt" });
		await session.waitForIdle();

		const turns = userTurns(started);
		expect(turns.map(messageText)).toEqual(["Say hello to Sami"]);
		expect(tagOf(turns[0])).toBe("msg-3");
	});

	it("invokes /skill:<name> as the user's skill prompt, tagged and persisted with its tag", async () => {
		const skill = await writeReviewerSkill();
		const { api, session, manager, started } = await start({ skills: [skill] });

		expect(await api.sendUserMessage("/skill:reviewer focus on risks", { expand: true, tag: "msg-4" })).toEqual({
			handled: "skill",
		});
		await session.waitForIdle();

		const turns = userTurns(started);
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({ role: "custom", customType: SKILL_PROMPT_MESSAGE_TYPE, attribution: "user" });
		expect(messageText(turns[0]!)).toContain("Review the supplied code.");
		expect(tagOf(turns[0])).toBe("msg-4");
		const persisted = manager.getEntries().flatMap(entry => (entry.type === "custom_message" ? [entry] : []));
		expect(persisted.map(entry => entry.tag)).toEqual(["msg-4"]);
		// Rebuilding the session from disk keeps the tag on the skill message.
		const rebuilt = manager.buildSessionContext().messages.filter(message => message.role === "custom");
		expect(rebuilt.map(message => tagOf(message))).toEqual(["msg-4"]);
	});

	it("bills a relayed /skill: as the caller attributes it", async () => {
		const skill = await writeReviewerSkill();
		const { api, session, started } = await start({ skills: [skill] });

		expect(await api.sendUserMessage("/skill:reviewer", { expand: true, attribution: "agent" })).toEqual({
			handled: "skill",
		});
		await session.waitForIdle();

		expect(userTurns(started)).toEqual([
			expect.objectContaining({ customType: SKILL_PROMPT_MESSAGE_TYPE, attribution: "agent" }),
		]);
	});

	it("sends slash text that names no command to the model, as typed input does", async () => {
		const { api, session, started } = await start();
		// Both shapes: a bare `/name` word, and prose that starts with an absolute path.
		const inputs = ["/nosuch argument", "/var/log/app.log shows a crash, why?"];

		for (const text of inputs) {
			expect(await api.sendUserMessage(text, { expand: true })).toEqual({ handled: "prompt" });
			await session.waitForIdle();
		}

		expect(userTurns(started).map(messageText)).toEqual(inputs);
		expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(2);
	});
});
