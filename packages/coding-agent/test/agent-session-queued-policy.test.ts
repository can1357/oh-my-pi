import { afterEach, describe, expect, it, vi } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Context, ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { BeforeAgentStartEvent, Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	getMnemopiSessionState,
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionProviderBoundary } from "@oh-my-pi/pi-coding-agent/session/session-provider-boundary";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const BASE = ["base identity", "base tools"];

function extension(name: string, handler: (event: BeforeAgentStartEvent) => Promise<unknown>): Extension {
	return {
		path: name,
		resolvedPath: name,
		handlers: new Map([
			["before_agent_start", [async (...args: unknown[]) => handler(args[0] as BeforeAgentStartEvent)]],
		]),
		tools: new Map(),
		assistantThinkingRenderers: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

describe("queued user delivery policy", () => {
	let session: AgentSession;
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		await session?.dispose();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
		vi.restoreAllMocks();
	});

	function setup(
		responses: MockResponseSource = Array.from({ length: 8 }, () => ({ content: ["done"] })),
		rebuildSystemPrompt?: AgentSessionConfig["rebuildSystemPrompt"],
		options: { settings?: Settings; tools?: AgentTool[]; policy?: boolean } = {},
	) {
		const mock = createMockModel({ responses });
		const requests: Context[] = [];
		const events: BeforeAgentStartEvent[] = [];
		const delivered: AgentMessage[] = [];
		const manager = SessionManager.inMemory();
		// Only credential lookup is needed; requests use the local scripted provider.
		const registry = { getApiKey: async () => "test-key" } as unknown as ModelRegistry;
		let beforePrepare: (() => Promise<void>) | undefined;
		const extensions = [
			extension("policy", async event => {
				events.push(structuredClone(event));
				await beforePrepare?.();
				if (options.policy === false) return undefined;
				const mode = manager
					.getBranch()
					.findLast(entry => entry.type === "custom" && entry.customType === "policy-mode");
				const data = mode?.type === "custom" ? mode.data : undefined;
				const enabled = !data || typeof data !== "object" || !("enabled" in data) || data.enabled !== false;
				return {
					systemPrompt: enabled ? [...event.systemPrompt, `policy:${event.prompt}`] : event.systemPrompt,
					message: { customType: "prepared-context", content: `context:${event.prompt}`, display: false },
				};
			}),
			extension("independent", async event =>
				options.policy === false ? undefined : { systemPrompt: [...event.systemPrompt, "independent policy"] },
			),
		];
		const runner = new ExtensionRunner(extensions, new ExtensionRuntime(), manager.getCwd(), manager, registry);
		const model = buildModel({
			id: "mock",
			name: "mock",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		const agent = new Agent({
			initialState: { model, systemPrompt: BASE, tools: options.tools ?? [], messages: [] },
			getApiKey: () => "test-key",
			convertToLlm,
			streamFn: (model, context, options) => {
				requests.push({
					systemPrompt: [...(context.systemPrompt ?? [])],
					messages: structuredClone(context.messages),
					tools: context.tools ? [...context.tools] : undefined,
				});
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			modelRegistry: registry,
			extensionRunner: runner,
			settings: options.settings ?? Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			toolRegistry: new Map(options.tools?.map(tool => [tool.name, tool])),
			builtInToolNames: options.tools?.map(tool => tool.name),
			rebuildSystemPrompt,
		});
		session.subscribe(event => {
			if (event.type === "message_end") delivered.push(event.message);
		});
		return {
			agent,
			requests,
			events,
			delivered,
			manager,
			extensions,
			pausePreparation: (fn: () => Promise<void>) => {
				beforePrepare = fn;
			},
		};
	}

	async function setupMemory(
		backendId: "mnemopi" | "hindsight",
		recall: (query: string) => Promise<string | undefined>,
		policy = false,
	) {
		const dir = TempDir.createSync("@pi-queued-memory-");
		tempDirs.push(dir);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"tools.xdev": false,
			"memory.backend": backendId,
			"mnemopi.dbPath": dir.join("memory.db"),
			"mnemopi.scoping": "global",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.autoRetain": false,
			"mnemopi.autoRecall": true,
			"hindsight.apiUrl": "http://unused.invalid",
			"hindsight.autoRetain": false,
			"hindsight.autoRecall": true,
			"hindsight.mentalModelsEnabled": false,
		});
		const backend = await memoryBackend.resolveMemoryBackend(settings);
		const tools: AgentTool[] = ["old_tool", "new_tool"].map(name => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		}));
		const fixture = setup(
			undefined,
			async toolNames => ({
				systemPrompt: [
					...BASE,
					`tools:${toolNames.join(",")}`,
					(await backend.buildDeveloperInstructions(dir.path(), settings, session)) ?? "",
				],
			}),
			{ settings, tools, policy },
		);
		if (backendId === "mnemopi") {
			await Promise.all([loadMnemopi(), loadMnemopiCore()]);
			const state = new MnemopiSessionState({
				sessionId: session.sessionId,
				session,
				config: loadMnemopiConfig(settings, dir.path()),
			});
			setMnemopiSessionState(session, state);
			state.attachSessionListeners();
			vi.spyOn(state.memory, "recallEnhanced").mockImplementation(async query => {
				const content = await recall(query);
				return content ? [{ id: "recalled", content, source: null, timestamp: null, score: 1 }] : [];
			});
		} else {
			const client = new HindsightApi({ baseUrl: "http://unused.invalid" });
			const state = new HindsightSessionState({
				sessionId: session.sessionId,
				session,
				config: loadHindsightConfig(settings, {}),
				client,
				bankId: "test-bank",
				banksSet: new Set(["test-bank"]),
			});
			session.setHindsightSessionState(state);
			vi.spyOn(client, "recall").mockImplementation(async (_bank, query) => {
				const text = await recall(query);
				return { results: text ? [{ id: "recalled", text }] : [] };
			});
		}
		await session.setActiveToolsByName(["old_tool"]);
		return fixture;
	}

	it.each(["mnemopi", "hindsight"] as const)(
		"retries cancelled real %s recall and keeps one committed copy on later turns",
		async backendId => {
			let recalls = 0;
			const { requests, pausePreparation } = await setupMemory(backendId, async () => `recall-${++recalls}`);
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			pausePreparation(async () => {
				started.resolve();
				await release.promise;
			});
			await session.steer("remember the project");
			await started.promise;
			const abort = session.abort();
			release.resolve();
			await abort;
			expect(requests).toEqual([]);
			expect(session.systemPrompt.join("\n")).not.toContain("recall-1");

			pausePreparation(async () => {});
			await session.prompt("resume");
			await session.waitForIdle();
			expect(recalls).toBe(2);
			expect(requests[0].systemPrompt?.join("\n")).toContain("recall-2");
			expect(requests[0].systemPrompt?.join("\n")).not.toContain("recall-1");
			await session.prompt("continue");
			expect(recalls).toBe(2);
			expect(
				requests
					.at(-1)
					?.systemPrompt?.join("\n")
					.match(/recall-2/g),
			).toHaveLength(1);
			await session.refreshBaseSystemPrompt();
			await session.prompt("after canonical rebuild");
			expect(recalls).toBe(2);
			expect(
				requests
					.at(-1)
					?.systemPrompt?.join("\n")
					.match(/recall-2/g),
			).toHaveLength(1);
		},
	);

	it.each(["mnemopi", "hindsight"] as const)(
		"consumes an empty successful real %s recall only when delivery commits",
		async backendId => {
			let recalls = 0;
			const { requests, pausePreparation } = await setupMemory(backendId, async () => {
				recalls++;
				return undefined;
			});
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			pausePreparation(async () => {
				started.resolve();
				await release.promise;
			});
			await session.steer("empty recall");
			await started.promise;
			const abort = session.abort();
			release.resolve();
			await abort;
			expect(requests).toEqual([]);
			pausePreparation(async () => {});
			await session.prompt("resume empty recall");
			await session.waitForIdle();
			expect(recalls).toBe(2);
			await session.prompt("already recalled");
			expect(recalls).toBe(2);
		},
	);

	it.each(["mnemopi", "hindsight"] as const)(
		"retries failed real %s recall on the next committed turn",
		async backendId => {
			let recalls = 0;
			const { requests } = await setupMemory(backendId, async () => {
				if (++recalls === 1) throw new Error("recall unavailable");
				return "recovered recall";
			});
			await session.prompt("lookup unavailable");
			expect(requests[0].systemPrompt?.join("\n")).not.toContain("recovered recall");
			await session.prompt("lookup recovered");
			expect(requests[1].systemPrompt?.join("\n")).toContain("recovered recall");
			await session.prompt("already recalled");
			expect(recalls).toBe(2);
		},
	);

	it.each(["mnemopi", "hindsight"] as const)(
		"delivers real %s recall with the winning tool policy in the same request",
		async backendId => {
			let recalls = 0;
			const { requests, pausePreparation } = await setupMemory(backendId, async () => {
				recalls++;
				return "staged memory";
			});
			pausePreparation(async () => {
				await session.setActiveToolsByName(["new_tool"]);
			});
			await session.steer("refresh tools during policy preparation");
			await session.waitForIdle();
			expect(requests[0].tools?.map(tool => tool.name)).toEqual(["new_tool"]);
			const prompt = requests[0].systemPrompt?.join("\n");
			expect(prompt).toContain("tools:new_tool");
			expect(prompt).not.toContain("tools:old_tool");
			expect(prompt?.match(/staged memory/g)).toHaveLength(1);
			await session.prompt("next turn");
			expect(recalls).toBe(1);
			expect(requests[1].systemPrompt?.join("\n").match(/staged memory/g)).toHaveLength(1);
		},
	);

	it.each(["mnemopi", "hindsight"] as const)(
		"discards late real %s recall after the queue is replaced",
		async backendId => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let recalls = 0;
			const { agent, requests } = await setupMemory(backendId, async () => {
				if (++recalls === 1) {
					started.resolve();
					await release.promise;
					return "discarded recall";
				}
				return "current recall";
			});
			await session.steer("discarded task");
			await started.promise;
			agent.replaceQueues([], []);
			release.resolve();
			await session.waitForIdle();
			expect(requests).toEqual([]);
			await session.prompt("replacement task");
			expect(recalls).toBe(2);
			expect(requests[0].systemPrompt?.join("\n")).toContain("current recall");
			expect(requests[0].systemPrompt?.join("\n")).not.toContain("discarded recall");
		},
	);

	it.each(["mnemopi", "hindsight"] as const)(
		"does not carry pending real %s recall into a replacement session",
		async backendId => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let recalls = 0;
			const { requests, pausePreparation } = await setupMemory(backendId, async () => `session-recall-${++recalls}`);
			pausePreparation(async () => {
				started.resolve();
				await release.promise;
			});
			await session.steer("old session task");
			await started.promise;
			const transition = session.newSession();
			release.resolve();
			await transition;
			expect(requests).toEqual([]);
			pausePreparation(async () => {});
			await session.prompt("new session task");
			expect(requests[0].systemPrompt?.join("\n")).toContain("session-recall-2");
			expect(requests[0].systemPrompt?.join("\n")).not.toContain("session-recall-1");
		},
	);

	it.each([
		["mnemopi", "reset"],
		["mnemopi", "rekey"],
		["hindsight", "reset"],
		["hindsight", "rekey"],
	] as const)(
		"declines real %s delivery when its memory state is invalidated by %s in the hook",
		async (backendId, change) => {
			let recalls = 0;
			const { agent, requests, delivered, pausePreparation } = await setupMemory(
				backendId,
				async () => `owned-recall-${++recalls}`,
				true,
			);
			const state = backendId === "mnemopi" ? getMnemopiSessionState(session) : session.getHindsightSessionState();
			if (!state) throw new Error("Real memory state was not installed");
			const basePrompt = session.systemPrompt;
			pausePreparation(async () => {
				if (change === "reset") state.resetConversationTracking();
				else state.setSessionId("rekeyed-memory-session");
			});
			await session.steer("retain rejected delivery");
			await session.waitForIdle();
			expect(requests).toEqual([]);
			expect(delivered).toEqual([]);
			expect(session.systemPrompt).toEqual(basePrompt);
			expect(agent.peekSteeringQueue()).toMatchObject([
				{ content: [{ type: "text", text: "retain rejected delivery" }] },
			]);

			pausePreparation(async () => {});
			await session.prompt("resume valid delivery");
			await session.waitForIdle();
			expect(recalls).toBe(2);
			expect(requests[0].systemPrompt?.join("\n")).toContain("owned-recall-2");
			expect(requests[0].systemPrompt?.join("\n")).not.toContain("owned-recall-1");
		},
	);

	it("discards older real mnemopi background recall when a tool-tail user preparation takes ownership", async () => {
		const backgroundStarted = Promise.withResolvers<void>();
		const releaseBackground = Promise.withResolvers<void>();
		let recalls = 0;
		const { agent, manager, requests, pausePreparation } = await setupMemory("mnemopi", async () => {
			const attempt = ++recalls;
			if (attempt === 1) {
				backgroundStarted.resolve();
				await releaseBackground.promise;
			}
			return `overlap-recall-${attempt}`;
		});
		const previousUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "previous unfinished task" }],
			timestamp: 1,
		};
		const toolTail = createAssistantMessage("");
		toolTail.content = [{ type: "toolCall", id: "unfinished", name: "old_tool", arguments: {} }];
		toolTail.stopReason = "toolUse";
		manager.appendMessage(previousUser);
		manager.appendMessage(toolTail);
		agent.replaceMessages([previousUser, toolTail]);

		const removeDequeueGate = agent.addBeforeQueuedMessageDequeueHook(() => backgroundStarted.promise);
		const prepared = Promise.withResolvers<void>();
		const releasePolicy = Promise.withResolvers<void>();
		pausePreparation(async () => {
			prepared.resolve();
			await releasePolicy.promise;
		});
		await session.steer("new task supersedes background recall");
		await prepared.promise;
		expect(recalls).toBe(2);
		releaseBackground.resolve();
		// Drain the fulfilled lookup's promise chain without waiting for elapsed wall-clock time.
		await setImmediate();
		session.clearQueue({ forInterrupt: true });
		const abort = session.abort();
		releasePolicy.resolve();
		await abort;
		removeDequeueGate();
		expect(requests).toEqual([]);
		pausePreparation(async () => {});
		await session.prompt("resume user delivery");
		await session.waitForIdle();
		expect(recalls).toBe(3);
		const prompt = requests[0].systemPrompt?.join("\n");
		expect(prompt).toContain("overlap-recall-3");
		expect(prompt).not.toContain("overlap-recall-1");
		expect(prompt).not.toContain("overlap-recall-2");
	});

	it.each([64, 512])("bounds real mnemopi staged recall at an injection limit of %s", async limit => {
		let recalls = 0;
		const { requests } = await setupMemory("mnemopi", async () => {
			recalls++;
			return `recall prefix ${"memory detail ".repeat(500)}recall overflow`;
		});
		session.settings.set("mnemopi.injectionTokenLimit", limit);
		await session.refreshBaseSystemPrompt();
		await session.prompt("bounded first recall");
		// The fixture's base/tool blocks precede the backend-owned instruction blocks.
		const memoryPrompt = requests[0].systemPrompt?.slice(BASE.length + 1).join("\n\n") ?? "";
		expect(memoryPrompt.length).toBeLessThanOrEqual(limit * 4);
		expect(memoryPrompt).not.toContain("recall overflow");
		if (limit === 64) {
			expect(memoryPrompt).not.toContain("recall prefix");
		} else {
			expect(memoryPrompt).toContain("recall prefix");
		}

		session.settings.set("mnemopi.injectionTokenLimit", 6000);
		await session.refreshBaseSystemPrompt();
		await session.prompt("use the committed full recall");
		expect(recalls).toBe(1);
		expect(requests[1].systemPrompt?.join("\n")).toContain("recall overflow");
	});

	it("bootstraps a fresh steer and delivers returned context once with separate policy blocks", async () => {
		const { requests, delivered } = setup();
		await session.steer("first queued task");
		await session.waitForIdle();
		expect(requests.map(request => request.systemPrompt)).toEqual([
			[...BASE, "policy:first queued task", "independent policy"],
		]);
		expect(
			delivered.filter(message => message.role === "custom" && message.customType === "prepared-context"),
		).toMatchObject([{ content: "context:first queued task", attribution: "user" }]);
	});

	it("uses saved policy changes on idle steer and follow-up instead of the prior override", async () => {
		const { requests, manager, events } = setup();
		await session.prompt("original");
		manager.appendCustomEntry("policy-mode", { enabled: false });
		await session.steer("off steer");
		await session.waitForIdle();
		manager.appendCustomEntry("policy-mode", { enabled: true });
		await session.followUp("on follow-up");
		await session.waitForIdle();
		expect(requests.map(request => request.systemPrompt)).toEqual([
			[...BASE, "policy:original", "independent policy"],
			[...BASE, "independent policy"],
			[...BASE, "policy:on follow-up", "independent policy"],
		]);
		expect(events.map(event => event.prompt)).toEqual(["original", "off steer", "on follow-up"]);
	});

	it("refreshes policy for live queued work without preparing tool-free iterations again", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { requests, manager, events } = setup([
			async () => {
				started.resolve();
				await release.promise;
				return { content: ["first response"] };
			},
			{ content: ["queued response"] },
		]);
		const prompt = session.prompt("running");
		await started.promise;
		manager.appendCustomEntry("policy-mode", { enabled: false });
		await session.steer("live steer");
		release.resolve();
		await prompt;
		await session.waitForIdle();
		expect(requests.map(request => request.systemPrompt)).toEqual([
			[...BASE, "policy:running", "independent policy"],
			[...BASE, "independent policy"],
		]);
		expect(events.map(event => event.prompt)).toEqual(["running", "live steer"]);
	});

	it("prepares all actual user bodies in a batch and preserves skill identity and companions", async () => {
		const { agent, requests, delivered, events } = setup();
		agent.setSteeringMode("all");
		const companion: AgentMessage = {
			role: "custom",
			customType: "workflow-notice",
			content: "hidden notice",
			display: false,
			attribution: "user",
			timestamp: 1,
		};
		const image: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD3sAAAAASUVORK5CYII=",
		};
		const skill: AgentMessage = {
			role: "custom",
			customType: "skill-prompt",
			content: [{ type: "text", text: "expanded " }, { type: "text", text: "skill body" }, image],
			display: true,
			attribution: "user",
			details: { name: "review", args: "focus", __queueChipText: "/skill:review focus" },
			timestamp: 2,
		};
		agent.steer(companion);
		agent.steer(skill);
		await session.steer("second task");
		await session.waitForIdle();
		expect(events.map(event => event.prompt)).toEqual(["expanded skill body\n\nsecond task"]);
		expect(events[0].images).toEqual([image]);
		expect(requests[0].systemPrompt).toEqual([
			...BASE,
			"policy:expanded skill body\n\nsecond task",
			"independent policy",
		]);
		expect(delivered.filter(message => message.role === "custom" && message.customType === "skill-prompt")).toEqual([
			skill,
		]);
		expect(
			delivered.filter(message => message.role === "custom" && message.customType === "workflow-notice"),
		).toEqual([companion]);
	});

	it("discards policy and returned context on abort while preserving the undelivered steer", async () => {
		const { agent, requests, delivered, pausePreparation } = setup();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		pausePreparation(async () => {
			started.resolve();
			await release.promise;
		});
		await session.steer("abort before delivery");
		await started.promise;
		const abort = session.abort();
		release.resolve();
		await abort;
		expect(requests).toEqual([]);
		expect(delivered.filter(message => message.role === "user" || message.role === "custom")).toEqual([]);
		expect(session.systemPrompt).toEqual(BASE);
		expect(agent.peekSteeringQueue()).toMatchObject([{ content: [{ type: "text", text: "abort before delivery" }] }]);
	});

	it("uses a handler's refreshed base in the same request without an extension override", async () => {
		const { requests, pausePreparation } = setup(
			undefined,
			async () => ({ systemPrompt: [...BASE, "updated tool policy"] }),
			{ policy: false },
		);
		pausePreparation(async () => {
			await session.refreshBaseSystemPrompt();
		});
		await session.steer("first");
		await session.waitForIdle();
		expect(requests[0].systemPrompt).toEqual([...BASE, "updated tool policy"]);
	});

	it.each(["ordinary", "queued"] as const)(
		"rederives %s overrides from current tools and publishes only the successful context and recall",
		async delivery => {
			let recalls = 0;
			const { requests, delivered, extensions, pausePreparation } = await setupMemory(
				"hindsight",
				async () => `override-memory-${++recalls}`,
				true,
			);
			let attempts = 0;
			extensions.push(
				extension("attempt-context", async () => ({
					message: { customType: "attempt-context", content: `attempt-context-${++attempts}`, display: false },
				})),
			);
			// Repeating the same tool selection on retry must converge, not invalidate it again.
			pausePreparation(async () => {
				await session.setActiveToolsByName(["new_tool"]);
			});
			if (delivery === "ordinary") await session.prompt("first");
			else await session.steer("first");
			await session.waitForIdle();
			expect(requests).toHaveLength(1);
			expect(requests[0].tools?.map(tool => tool.name)).toEqual(["new_tool"]);
			const prompt = requests[0].systemPrompt?.join("\n");
			expect(prompt).toContain("policy:first");
			expect(prompt).toContain("independent policy");
			expect(prompt).toContain("tools:new_tool");
			expect(prompt).not.toContain("tools:old_tool");
			expect(prompt?.match(/override-memory-2/g)).toHaveLength(1);
			expect(prompt).not.toContain("override-memory-1");
			const context = JSON.stringify(requests[0].messages);
			expect(context.match(/attempt-context-2/g)).toHaveLength(1);
			expect(context).not.toContain("attempt-context-1");
			expect(context.match(/context:first/g)).toHaveLength(1);
			expect(delivered.filter(message => message.role === "user")).toMatchObject([
				{ content: [{ type: "text", text: "first" }] },
			]);

			await session.prompt("next turn");
			expect(recalls).toBe(2);
			expect(requests[1].systemPrompt?.join("\n")).toContain("override-memory-2");
			expect(requests[1].systemPrompt?.join("\n")).not.toContain("override-memory-1");
		},
	);

	it("does not re-enter handlers for a semantic no-op base refresh", async () => {
		const { requests, events, pausePreparation } = setup(undefined, async () => ({ systemPrompt: [...BASE] }));
		pausePreparation(async () => {
			await session.refreshBaseSystemPrompt();
		});
		await session.prompt("stable policy");
		expect(events).toHaveLength(1);
		expect(requests.map(request => request.systemPrompt)).toEqual([
			[...BASE, "policy:stable policy", "independent policy"],
		]);
	});

	it("preserves absolute overrides and their downstream chain after a source-base retry", async () => {
		const { requests, extensions, pausePreparation } = await setupMemory(
			"hindsight",
			async () => "hidden memory",
			true,
		);
		// An absolute policy can intentionally mention old/base text. Never infer a patch from it.
		const absolute = "tools:old_tool is a historical example; use only this absolute policy";
		extensions.push(
			extension("absolute", async () => ({ systemPrompt: absolute })),
			extension("after-absolute", async event => ({ systemPrompt: [...event.systemPrompt, "absolute follower"] })),
		);
		pausePreparation(async () => {
			await session.setActiveToolsByName(["new_tool"]);
		});
		await session.steer("absolute policy");
		await session.waitForIdle();
		expect(requests[0].tools?.map(tool => tool.name)).toEqual(["new_tool"]);
		expect(requests[0].systemPrompt).toEqual([absolute, "absolute follower"]);
	});

	it("retries a base change during returned-image normalization before publishing the request", async () => {
		const { requests, extensions } = await setupMemory("hindsight", async () => "image memory", true);
		const image: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD3sAAAAASUVORK5CYII=",
		};
		extensions.push(
			extension("image-context", async () => ({
				message: { customType: "image-context", content: [image], display: false },
			})),
		);
		const normalizeImages = SessionProviderBoundary.prototype.normalizeImagesForModel;
		let changed = false;
		vi.spyOn(SessionProviderBoundary.prototype, "normalizeImagesForModel").mockImplementation(
			async function (this: SessionProviderBoundary, images) {
				const normalized = await normalizeImages.call(this, images);
				if (!changed) {
					changed = true;
					await session.setActiveToolsByName(["new_tool"]);
				}
				return normalized;
			},
		);
		await session.steer("image policy");
		await session.waitForIdle();
		expect(requests).toHaveLength(1);
		expect(requests[0].tools?.map(tool => tool.name)).toEqual(["new_tool"]);
		const prompt = requests[0].systemPrompt?.join("\n");
		expect(prompt).toContain("tools:new_tool");
		expect(prompt).not.toContain("tools:old_tool");
		expect(prompt).toContain("policy:image policy");
		expect(
			requests[0].messages.flatMap(message =>
				Array.isArray(message.content) ? message.content.filter(part => part.type === "image") : [],
			),
		).toHaveLength(1);
	});

	it.each(["ordinary", "queued"] as const)(
		"bounds repeated %s source-base churn and retains the original without publishing staged work",
		async delivery => {
			let recalls = 0;
			const { agent, requests, delivered, events, pausePreparation } = await setupMemory(
				"hindsight",
				async () => `churn-memory-${++recalls}`,
				true,
			);
			const dropped: string[] = [];
			session.setPromptDropped(prompt => dropped.push(prompt.text));
			let attempts = 0;
			pausePreparation(async () => {
				await session.setActiveToolsByName([++attempts % 2 === 1 ? "new_tool" : "old_tool"]);
			});
			if (delivery === "ordinary") {
				await expect(session.prompt("retain original")).rejects.toThrow("System prompt changed");
				expect(dropped).toEqual(["retain original"]);
			} else {
				// Use the real queue transaction without the session's idle scheduler swallowing its error.
				agent.steer({ role: "user", content: [{ type: "text", text: "retain original" }], timestamp: 1 });
				await expect(agent.continue()).rejects.toThrow("System prompt changed");
				expect(agent.peekSteeringQueue()).toMatchObject([{ content: [{ type: "text", text: "retain original" }] }]);
			}
			expect(events).toHaveLength(3);
			expect(requests).toEqual([]);
			expect(delivered.filter(message => message.role === "user" || message.role === "custom")).toEqual([]);
			expect(session.systemPrompt.join("\n")).not.toContain("churn-memory-");
			expect(session.systemPrompt.join("\n")).not.toContain("policy:retain original");

			pausePreparation(async () => {});
			await session.prompt("resumed original");
			await session.waitForIdle();
			expect(requests[0].systemPrompt?.join("\n")).toContain("churn-memory-4");
			expect(requests[0].systemPrompt?.join("\n")).not.toMatch(/churn-memory-[123]/);
		},
	);

	it("lets cancellation during retry retain the queued original without consuming recall", async () => {
		let recalls = 0;
		const { agent, requests, delivered, pausePreparation } = await setupMemory(
			"hindsight",
			async () => `retry-memory-${++recalls}`,
			true,
		);
		const retryStarted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let attempts = 0;
		pausePreparation(async () => {
			await session.setActiveToolsByName(["new_tool"]);
			if (++attempts === 2) {
				retryStarted.resolve();
				await release.promise;
			}
		});
		await session.steer("cancel retry");
		// A broken implementation must fail rather than hang waiting for a retry it never starts.
		await Promise.race([
			retryStarted.promise,
			session.waitForIdle().then(() => {
				throw new Error("Delivery finished before retry");
			}),
		]);
		const abort = session.abort();
		release.resolve();
		await abort;
		expect(requests).toEqual([]);
		expect(delivered.filter(message => message.role === "user" || message.role === "custom")).toEqual([]);
		expect(session.systemPrompt.join("\n")).not.toContain("retry-memory-");
		expect(agent.peekSteeringQueue()).toMatchObject([{ content: [{ type: "text", text: "cancel retry" }] }]);

		pausePreparation(async () => {});
		await session.prompt("resume cancelled retry");
		await session.waitForIdle();
		expect(requests[0].systemPrompt?.join("\n")).toContain("retry-memory-3");
		expect(requests[0].systemPrompt?.join("\n")).not.toMatch(/retry-memory-[12]/);
	});

	it("declines a source-base change after preparation without partially committing memory or context", async () => {
		let recalls = 0;
		const { agent, requests, delivered } = await setupMemory(
			"hindsight",
			async () => `commit-memory-${++recalls}`,
			true,
		);
		const prepare = agent.prepareQueuedMessages;
		if (!prepare) throw new Error("Session queue preparation was not installed");
		agent.prepareQueuedMessages = async (messages, signal) => {
			const preparation = await prepare(messages, signal);
			await session.setActiveToolsByName(["new_tool"]);
			return preparation;
		};
		await session.steer("changed before commit");
		await session.waitForIdle();
		expect(requests).toEqual([]);
		expect(delivered.filter(message => message.role === "user" || message.role === "custom")).toEqual([]);
		expect(session.systemPrompt.join("\n")).not.toContain("commit-memory-");
		expect(session.systemPrompt.join("\n")).not.toContain("policy:changed before commit");
		expect(agent.peekSteeringQueue()).toMatchObject([{ content: [{ type: "text", text: "changed before commit" }] }]);

		agent.prepareQueuedMessages = prepare;
		await session.prompt("resume commit");
		await session.waitForIdle();
		expect(requests[0].tools?.map(tool => tool.name)).toEqual(["new_tool"]);
		expect(requests[0].systemPrompt?.join("\n")).toContain("commit-memory-2");
		expect(requests[0].systemPrompt?.join("\n")).not.toContain("commit-memory-1");
	});

	it.each(["memory lookup", "prompt rebuild", "extension hook", "extension hook after rebuild"] as const)(
		"does not apply late policy after abort during %s",
		async phase => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const pause = async () => {
				started.resolve();
				await release.promise;
			};
			const { agent, requests, pausePreparation } = setup(
				undefined,
				phase === "prompt rebuild" || phase === "extension hook after rebuild"
					? async () => {
							if (phase === "prompt rebuild") await pause();
							return { systemPrompt: [...BASE, "rebuilt cancelled memory"] };
						}
					: undefined,
			);
			if (phase === "extension hook" || phase === "extension hook after rebuild") pausePreparation(pause);
			const backend: MemoryBackend = {
				id: "mnemopi",
				async start() {},
				async buildDeveloperInstructions() {
					return "";
				},
				async clear() {},
				async enqueue() {},
				async beforeAgentStartPrompt() {
					if (phase === "memory lookup") await pause();
					return { context: "memory from cancelled work", commit: () => true };
				},
			};
			vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);
			await session.steer("cancel memory preparation");
			await started.promise;
			const abort = session.abort();
			release.resolve();
			await abort;
			expect(requests).toEqual([]);
			expect(session.systemPrompt).toEqual(BASE);
			expect(agent.peekSteeringQueue()).toMatchObject([
				{ content: [{ type: "text", text: "cancel memory preparation" }] },
			]);
		},
	);

	it("does not commit an ordinary prompt's stale policy after abort during preparation", async () => {
		const { requests, pausePreparation } = setup();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		pausePreparation(async () => {
			started.resolve();
			await release.promise;
		});
		const prompt = session.prompt("cancel ordinary");
		await started.promise;
		const abort = session.abort();
		release.resolve();
		await Promise.all([prompt, abort]);
		expect(requests).toEqual([]);
		expect(session.systemPrompt).toEqual(BASE);
	});

	it("does not leak a pending queue preparation into a new session", async () => {
		const { agent, requests, pausePreparation } = setup();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		pausePreparation(async () => {
			started.resolve();
			await release.promise;
		});
		await session.steer("old session");
		await started.promise;
		const transition = session.newSession();
		release.resolve();
		await transition;
		expect(requests).toEqual([]);
		expect(agent.peekSteeringQueue()).toEqual([]);
		expect(session.systemPrompt).toEqual(BASE);
		pausePreparation(async () => {});
		await session.prompt("new session");
		expect(requests.map(request => request.systemPrompt)).toEqual([
			[...BASE, "policy:new session", "independent policy"],
		]);
	});

	it("prepares a steer after a running tool settles, not on subsequent tool iterations", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { agent, requests, events, delivered } = setup([
			{ content: [{ type: "toolCall", name: "work", arguments: {} }] },
			{ content: [{ type: "toolCall", name: "work", arguments: {} }] },
			{ content: ["finished"] },
		]);
		let calls = 0;
		agent.setTools([
			{
				name: "work",
				label: "work",
				description: "Do local work",
				parameters: Type.Object({}),
				execute: async () => {
					if (calls++ === 0) {
						started.resolve();
						await release.promise;
					}
					return { content: [{ type: "text", text: "work completed" }], details: {} };
				},
			},
		]);
		const prompt = session.prompt("initial work");
		await Promise.race([
			started.promise,
			prompt.then(() => {
				throw new Error("Run ended before the tool boundary");
			}),
		]);
		await session.steer("changed work");
		release.resolve();
		await prompt;
		await session.waitForIdle();
		expect(events.map(event => event.prompt)).toEqual(["initial work", "changed work"]);
		expect(requests.map(request => request.systemPrompt)).toEqual([
			[...BASE, "policy:initial work", "independent policy"],
			[...BASE, "policy:changed work", "independent policy"],
			[...BASE, "policy:changed work", "independent policy"],
		]);
		expect(
			delivered.filter(message => message.role === "custom" && message.customType === "prepared-context"),
		).toMatchObject([{ content: "context:initial work" }, { content: "context:changed work" }]);
	});

	it("does not add policy preparation to synthetic-only queue continuations", async () => {
		const { requests, events } = setup();
		await session.prompt("user task");
		await session.followUp("internal continuation", undefined, { synthetic: true });
		await session.waitForIdle();
		expect(events.map(event => event.prompt)).toEqual(["user task"]);
		expect(requests).toHaveLength(2);
		expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
	});
});
