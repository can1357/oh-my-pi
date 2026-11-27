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
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
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
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runHeadlessBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandHost } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { isRecord, readJsonl, removeWithRetries } from "@oh-my-pi/pi-utils";

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
	/** Every line a built-in slash command printed through the host's `output` hook. */
	commandOutput: string[];
	/** Status lines the interactive host showed (`host: "interactive"` only). */
	statuses: string[];
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
		/** The model's scripted replies, one per turn. */
		responses?: MockResponse[];
		/** Which host wires the extension actions: `initializeExtensions` (default) or the TUI's controller. */
		host?: "runtime-init" | "interactive";
		/** False leaves the host lending no built-in runner, as print mode and subagents do. */
		builtins?: boolean;
	}): Promise<Harness> {
		const manager = SessionManager.inMemory();
		const runtime = new ExtensionRuntime();
		const started: AgentMessage[] = [];
		const deployRuns: string[] = [];
		const invoking: Promise<unknown>[] = [];
		const commandOutput: string[] = [];
		const statuses: string[] = [];
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
				responses: options?.responses ?? [
					{ content: ["First reply"] },
					{ content: ["Second reply"] },
					{ content: ["Third reply"] },
				],
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
		if (options?.host === "interactive") {
			const ctx = {
				session: created,
				sessionManager: manager,
				settings: created.settings,
				showStatus: (text: string) => {
					statuses.push(text);
				},
				showError: (text: string) => {
					throw new Error(text);
				},
				setToolUIContext: () => {},
				syncComposerShape: () => {},
				syncExtensionLinks: () => {},
			} as unknown as InteractiveModeContext;
			await new ExtensionUiController(ctx).initHooksAndCustomTools();
		} else {
			// What RPC lends expanded input: its own typed-input hooks, here recording what they are given.
			const slashCommandHost: SlashCommandHost = {
				output: text => {
					commandOutput.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			};
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
				runBuiltinSlashCommand:
					options?.builtins === false
						? undefined
						: text => runHeadlessBuiltinSlashCommand(created, text, slashCommandHost),
			});
		}
		return { api, session: created, manager, started, deployRuns, invoking, commandOutput, statuses };
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

	it("runs a host built-in, reports through the host's hooks, submits nothing and claims no turn", async () => {
		const { api, session, started, commandOutput, invoking } = await start();

		const result = await api.sendUserMessage("/jobs", { expand: true, tag: "msg-5" });
		await session.waitForIdle();

		expect(result.handled).toBe("command");
		expect(result.output).toContain("No background jobs running.");
		// The client hears it where a typed `/jobs` is heard: the host's own output hook.
		expect(commandOutput).toEqual([result.output!]);
		expect(userTurns(started)).toHaveLength(0);
		expect(session.messages.some(message => message.role === "assistant")).toBe(false);
		await expect(invoking[0]).rejects.toThrow("send did not invoke the agent");
	});

	it("sends a built-in's name to the model where the host lends no runner, as print mode and subagents do", async () => {
		const { api, session, started, commandOutput } = await start({ builtins: false });

		expect(await api.sendUserMessage("/jobs", { expand: true })).toEqual({ handled: "prompt" });
		await session.waitForIdle();

		expect(commandOutput).toEqual([]);
		expect(userTurns(started).map(messageText)).toEqual(["/jobs"]);
	});

	it("claims the turn a built-in starts without submitting a message, as /retry does", async () => {
		const { api, session, invoking } = await start({
			responses: [{ throw: "first attempt fails" }, { content: ["Recovered"] }],
		});
		await session.prompt("fail once");
		await session.waitForIdle();

		const result = await api.sendUserMessage("/retry", { expand: true });
		await session.waitForIdle();

		expect(result).toEqual({ handled: "command", agentInvoked: true, output: "Retrying the last failed turn." });
		// RPC waits on this task for the retried turn's agent events, so it must resolve.
		expect(invoking).toHaveLength(1);
		await expect(invoking[0]).resolves.toBeUndefined();
		expect(messageText(session.messages.at(-1)!)).toBe("Recovered");
	});

	it.each(["/new", "/debug"])("answers terminal-only for %s and runs nothing", async text => {
		const { api, session, started, commandOutput, invoking } = await start();
		const { sessionId } = session;

		expect(await api.sendUserMessage(text, { expand: true })).toEqual({ handled: "terminal-only" });
		await session.waitForIdle();

		expect(commandOutput).toEqual([]);
		expect(userTurns(started)).toHaveLength(0);
		expect(session.sessionId).toBe(sessionId);
		await expect(invoking[0]).rejects.toThrow("send did not invoke the agent");
	});

	it("shows a built-in's output on the interactive status line, where a typed one shows it", async () => {
		const { api, statuses } = await start({ host: "interactive" });

		const result = await api.sendUserMessage("/jobs", { expand: true });

		expect(result.handled).toBe("command");
		expect(statuses).toEqual([result.output!]);
		expect(result.output).toContain("No background jobs running.");
	});
});

describe("expanded extension input in RPC mode", () => {
	it("runs a built-in with the hooks RPC gives typed input, so its client hears the output", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-send-user-input-rpc-"));
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures", "send-user-input-rpc-agent.ts")],
			{
				cwd: directory,
				env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stderr = new Response(child.stderr).text();
		const frames: Record<string, unknown>[] = [];
		let reported: Record<string, unknown> | undefined;
		try {
			child.stdin.write(`${JSON.stringify({ type: "prompt", id: "p0", message: "/bridge /jobs" })}\n`);
			await child.stdin.flush();
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (!isRecord(frame)) continue;
				frames.push(frame);
				if (frame.type !== "extension_ui_request" || frame.method !== "notify") continue;
				const parsed: unknown = JSON.parse(String(frame.message));
				if (!isRecord(parsed)) throw new Error(`the bridge reported no object: ${String(frame.message)}`);
				reported = parsed;
				break;
			}
		} finally {
			child.stdin.end();
			await child.exited;
			await removeWithRetries(directory);
		}
		if (reported === undefined) throw new Error(`the RPC bridge ended early: ${await stderr}`);

		expect(reported).toMatchObject({ handled: "command" });
		expect(String(reported.output)).toContain("No background jobs running.");
		// The same line reached the client as the frame a typed `/jobs` produces.
		expect(
			frames.filter(frame => frame.type === "command_output" && String(frame.text).includes("No background jobs")),
		).toHaveLength(1);
	}, 60_000);
});
