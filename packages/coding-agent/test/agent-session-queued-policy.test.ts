import { afterEach, describe, expect, it, vi } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Context, ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { BeforeAgentStartEvent, Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

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

	afterEach(async () => {
		await session?.dispose();
		vi.restoreAllMocks();
	});

	function setup(
		responses: MockResponseSource = Array.from({ length: 8 }, () => ({ content: ["done"] })),
		rebuildSystemPrompt?: () => Promise<{ systemPrompt: string[] }>,
	) {
		const mock = createMockModel({ responses });
		const requests: Context[] = [];
		const events: BeforeAgentStartEvent[] = [];
		const delivered: AgentMessage[] = [];
		const manager = SessionManager.inMemory();
		// Only credential lookup is needed; requests use the local scripted provider.
		const registry = { getApiKey: async () => "test-key" } as unknown as ModelRegistry;
		let beforePrepare: (() => Promise<void>) | undefined;
		const runner = new ExtensionRunner(
			[
				extension("policy", async event => {
					events.push(structuredClone(event));
					await beforePrepare?.();
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
				extension("independent", async event => ({ systemPrompt: [...event.systemPrompt, "independent policy"] })),
			],
			new ExtensionRuntime(),
			manager.getCwd(),
			manager,
			registry,
		);
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
			initialState: { model, systemPrompt: BASE, tools: [], messages: [] },
			getApiKey: () => "test-key",
			convertToLlm,
			streamFn: (model, context, options) => {
				requests.push({
					systemPrompt: [...(context.systemPrompt ?? [])],
					messages: structuredClone(context.messages),
				});
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			modelRegistry: registry,
			extensionRunner: runner,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
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
			pausePreparation: (fn: () => Promise<void>) => {
				beforePrepare = fn;
			},
		};
	}

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

	it("preserves a newer base-prompt refresh performed by a preparation handler", async () => {
		let newer = false;
		let recalled = false;
		const { requests, pausePreparation } = setup(undefined, async () => ({
			systemPrompt: [...BASE, newer ? "updated tool policy" : "recalled memory"],
		}));
		const backend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return "";
			},
			async clear() {},
			async enqueue() {},
			async beforeAgentStartPrompt() {
				if (recalled) return undefined;
				recalled = true;
				return "recalled memory";
			},
		};
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);
		pausePreparation(async () => {
			newer = true;
			await session.refreshBaseSystemPrompt();
		});
		await session.steer("first");
		await session.waitForIdle();
		pausePreparation(async () => {});
		await session.prompt("second");
		expect(requests[1].systemPrompt).toEqual([...BASE, "updated tool policy", "policy:second", "independent policy"]);
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
					return "memory from cancelled work";
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
