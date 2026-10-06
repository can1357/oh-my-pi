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
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
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
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { isRecord, readJsonl, removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

interface Harness {
	api: ExtensionAPI;
	session: AgentSession;
	manager: SessionManager;
	/** Every message whose `message_start` reached the extension, in order. */
	started: AgentMessage[];
	/** Arguments each `/deploy` extension-command run received. */
	deployRuns: string[];
	/** Status lines the interactive host showed (only with `host: "interactive"`). */
	statuses: string[];
	/** Each turn-ownership task `initializeExtensions` reported for a `sendUserInput` call, in order. */
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
		/**
		 * Which host wires the actions: `initializeExtensions`, as print, RPC and subagent sessions use (default),
		 * the interactive TUI's controller, or a host that leaves `sendUserInput` out.
		 */
		host?: "runtime-init" | "interactive" | "unwired";
		/** An `input` handler the bridge extension registers. */
		onInput?: (event: InputEvent) => InputEventResult | undefined;
		/** The model's scripted replies, one per turn. */
		responses?: MockResponse[];
	}): Promise<Harness> {
		const manager = SessionManager.inMemory();
		const runtime = new ExtensionRuntime();
		const started: AgentMessage[] = [];
		const deployRuns: string[] = [];
		const statuses: string[] = [];
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
				responses: options?.responses ?? [{ content: ["First reply"] }, { content: ["Second reply"] }],
			}).stream,
		});
		const runner = new ExtensionRunner([extension], runtime, manager.getCwd(), manager, modelRegistry);
		const created = new AgentSession({
			agent,
			sessionManager: manager,
			// No automatic retry, so a failed turn stays failed for `/retry`.
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
			extensionRunner: runner,
			skills: options?.skills,
			skillsSettings: { enableSkillCommands: true },
			promptTemplates: options?.promptTemplates,
		});
		session = created;

		if (options?.host === "unwired") {
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
		} else if (options?.host === "interactive") {
			const ctx = {
				session: created,
				sessionManager: manager,
				settings: created.settings,
				showStatus: (text: string) => {
					statuses.push(text);
				},
				setToolUIContext: () => {},
				syncComposerShape: () => {},
			} as unknown as InteractiveModeContext;
			await new ExtensionUiController(ctx).initHooksAndCustomTools();
		} else {
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
		}
		return { api, session: created, manager, started, deployRuns, statuses, invoking };
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

	it("runs extension input handlers first, with source extension, and answers command when one consumes the text", async () => {
		const sources: string[] = [];
		const { api, session, started } = await start({
			onInput: event => {
				sources.push(event.source);
				return event.text.startsWith("secret:") ? { handled: true } : undefined;
			},
		});

		expect(await api.sendUserInput("secret: keep this local")).toEqual({ handled: "command" });
		await session.waitForIdle();

		expect(sources).toEqual(["extension"]);
		expect(userTurns(started)).toHaveLength(0);
		expect(session.messages.some(message => message.role === "assistant")).toBe(false);
	});

	it("dispatches the text an input handler rewrites it to", async () => {
		const { api, session, started, deployRuns } = await start({
			onInput: event => (event.text.startsWith("ship ") ? { text: `/deploy ${event.text.slice(5)}` } : undefined),
		});

		expect(await api.sendUserInput("ship staging")).toEqual({ handled: "command" });
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

	it("reports a built-in that starts a turn, as /retry does, so the host counts the input as invoking the agent", async () => {
		const { api, session, invoking } = await start({
			responses: [{ throw: "first attempt fails" }, { content: ["Recovered"] }],
		});
		await session.prompt("fail once");
		await session.waitForIdle();

		const result = await api.sendUserInput("/retry");
		await session.waitForIdle();

		expect(result).toEqual({ handled: "command", agentInvoked: true, output: "Retrying the last failed turn." });
		expect(invoking).toHaveLength(1);
		await expect(invoking[0]).resolves.toBeUndefined();
		expect(messageText(session.messages.at(-1)!)).toBe("Recovered");
	});

	it("shows a built-in's output in the interactive TUI's status line, as typing it there does", async () => {
		const { api, statuses } = await start({ host: "interactive" });

		const result = await api.sendUserInput("/rename Bridge title");

		expect(result).toEqual({ handled: "command", output: "Session renamed to Bridge title." });
		expect(statuses).toEqual(["Session renamed to Bridge title."]);
	});

	it.each(["/new", "/resume"])("answers terminal-only for %s and sends nothing", async text => {
		const { api, session, started } = await start();
		const sessionId = session.sessionId;

		expect(await api.sendUserInput(text)).toEqual({ handled: "terminal-only" });
		await session.waitForIdle();

		expect(userTurns(started)).toHaveLength(0);
		expect(session.sessionId).toBe(sessionId);
	});

	it("sends slash text that names no command to the model, as typed input does", async () => {
		const { api, session, started } = await start();
		// Both shapes: a bare `/name` word, and prose that starts with an absolute path.
		const inputs = ["/nosuch argument", "/var/log/app.log shows a crash, why?"];

		for (const text of inputs) {
			expect(await api.sendUserInput(text)).toEqual({ handled: "prompt" });
			await session.waitForIdle();
		}

		expect(userTurns(started).map(messageText)).toEqual(inputs);
		expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(2);
	});

	it("answers unavailable when the host mode does not wire sendUserInput", async () => {
		const { api, started } = await start({ host: "unwired" });

		expect(await api.sendUserInput("hello there")).toEqual({ handled: "unavailable" });
		expect(userTurns(started)).toHaveLength(0);
	});
});

/** Frames a real RPC-mode process writes while a bridge extension forwards each input through `sendUserInput`. */
async function runRpcBridge(inputs: string[]): Promise<{ frames: Record<string, unknown>[]; results: unknown[] }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), `omp-send-user-input-rpc-${Snowflake.next()}-`));
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "send-user-input-rpc-agent.ts")], {
		cwd: directory,
		env: { PATH: Bun.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 20_000,
	});
	const stderr = new Response(child.stderr).text();
	const frames: Record<string, unknown>[] = [];
	const results: unknown[] = [];
	const send = async (index: number): Promise<void> => {
		child.stdin.write(
			`${JSON.stringify({ type: "prompt", id: `p${index}`, message: `/bridge ${inputs[index]}` })}\n`,
		);
		await child.stdin.flush();
	};
	try {
		await send(0);
		for await (const frame of readJsonl<unknown>(child.stdout)) {
			if (!isRecord(frame)) continue;
			frames.push(frame);
			if (frame.type !== "extension_ui_request" || frame.method !== "notify") continue;
			results.push(JSON.parse(String(frame.message)));
			if (results.length === inputs.length) break;
			await send(results.length);
		}
	} finally {
		child.stdin.end();
		await child.exited;
		await removeWithRetries(directory);
	}
	if (results.length !== inputs.length) throw new Error(`RPC bridge ended early: ${await stderr}`);
	return { frames, results };
}

describe("pi.sendUserInput in RPC mode", () => {
	it("runs a built-in with the hooks RPC gives typed input, so the client sees its output and the new title", async () => {
		const { frames, results } = await runRpcBridge(["/rename Bridge title"]);

		expect(results).toEqual([{ handled: "command", output: "Session renamed to Bridge title." }]);
		expect(frames).toContainEqual(
			expect.objectContaining({ type: "command_output", text: "Session renamed to Bridge title." }),
		);
		expect(frames).toContainEqual(expect.objectContaining({ type: "session_info_update", title: "Bridge title" }));
	}, 30_000);
});
