import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { extensionEventFromSessionEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/lifecycle-mirror";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionError } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import fallbackShake from "../examples/extensions/fallback-shake";

const usage: AssistantMessage["usage"] = {
	input: 20_000,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20_001,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function bundled(provider: "anthropic" | "openai", id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Missing fixture model ${provider}/${id}`);
	return model;
}

function entryBytes(entries: SessionEntry[]): Map<string, string> {
	return new Map(entries.map(entry => [entry.id, JSON.stringify(entry)]));
}

function expectUnchanged(entries: SessionEntry[], before: Map<string, string>): void {
	for (const [id, bytes] of before) {
		expect(JSON.stringify(entries.find(entry => entry.id === id))).toBe(bytes);
	}
}

describe("automatic fallback shake", () => {
	let temp: TempDir;
	let auth: AuthStorage;
	let manager: SessionManager;
	let session: AgentSession;
	let runner: ExtensionRunner;
	let primary: Model;
	let fallback: Model;
	let requests: Array<{ model: string; context: Context }>;
	let runtimeErrors: ExtensionError[];

	beforeAll(() => initTheme());
	beforeEach(async () => {
		runtimeErrors = [];
		temp = TempDir.createSync("@pi-fallback-shake-");
		auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
		auth.keys.setRuntime("anthropic", "test-key");
		auth.keys.setRuntime("openai", "test-key");
		await Bun.write(
			path.join(temp.path(), "models.yml"),
			Bun.YAML.stringify({
				providers: {
					literal: {
						baseUrl: "http://127.0.0.1:1/v1",
						auth: "none",
						api: "openai-completions",
						models: [{ id: "model@default", name: "Literal model", reasoning: false }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
		manager = SessionManager.create(temp.path(), temp.path());
		primary = bundled("anthropic", "claude-sonnet-4-5");
		fallback = bundled("openai", "gpt-4o-mini");
		requests = [];
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			getApiKey: () => "test-key",
			streamFn: (model, context, options) => {
				requests.push({ model: `${model.provider}/${model.id}`, context: structuredClone(context) });
				mock.push(
					model.provider === primary.provider
						? { throw: "overloaded_error: provider returned error 503" }
						: { content: ["fallback completed"] },
				);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			// Exercise shake, not the independent post-response stale-result reducer.
			"compaction.dropUseless": false,
			"compaction.supersedeReads": false,
			"retry.enabled": true,
			"retry.modelFallback": true,
			"retry.fallbackOn": "any",
			"retry.baseDelayMs": 1,
			"retry.fallbackChains": { default: [`${fallback.provider}/${fallback.id}`] },
		});
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			fallbackShake,
			temp.path(),
			new EventBus(),
			runtime,
			"fallback-shake",
		);
		runner = new ExtensionRunner([extension], runtime, temp.path(), manager, registry, undefined, settings);
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			extensionRunner: runner,
		});
		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				runtimeErrors.push(error);
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		auth?.close();
		await temp?.remove();
		expect(runtimeErrors).toEqual([]);
	});

	function seed(count: number): void {
		for (let i = 0; i < count; i++) {
			const content = `exchange-${i} payload\n${"alpha beta gamma delta epsilon\n".repeat(180)}`;
			manager.appendMessage({ role: "user", content: `turn ${i}\n\`\`\`text\n${content}\`\`\``, timestamp: i * 4 });
			manager.appendMessage({
				role: "assistant",
				api: primary.api,
				provider: primary.provider,
				model: primary.id,
				content: [
					{ type: "thinking", thinking: `reason ${i}`, thinkingSignature: `signature-${i}` },
					{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `/fixture/${i}` } },
				],
				usage,
				stopReason: "toolUse",
				timestamp: i * 4 + 1,
			});
			manager.appendMessage({
				role: "toolResult",
				toolCallId: `call-${i}`,
				toolName: "read",
				content: [{ type: "text", text: content }],
				isError: false,
				useless: true,
				timestamp: i * 4 + 2,
			});
			manager.appendMessage({
				role: "assistant",
				api: primary.api,
				provider: primary.provider,
				model: primary.id,
				content: [{ type: "text", text: `answer ${i}` }],
				usage,
				stopReason: "stop",
				timestamp: i * 4 + 3,
			});
		}
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	}

	it("replacement request receives shaken prefix and byte-identical six-exchange suffix, persisted with recovery", async () => {
		seed(8);
		// The new prompt is exchange nine. Its six-exchange suffix begins at seeded exchange four.
		const before = entryBytes(manager.getBranch().slice(3 * 4));
		await session.prompt("continue as exchange nine");
		await session.waitForIdle();
		expect(requests.map(request => request.model)).toEqual([
			`${primary.provider}/${primary.id}`,
			`${fallback.provider}/${fallback.id}`,
		]);
		const outgoing = requests[1].context.messages;
		const oldResult = outgoing.find(message => message.role === "toolResult" && message.toolCallId === "call-0");
		expect(oldResult?.content).toEqual([{ type: "text", text: expect.stringContaining("artifact://") }]);
		for (let i = 3; i < 8; i++) {
			const original = requests[0].context.messages.find(
				message => message.role === "toolResult" && message.toolCallId === `call-${i}`,
			);
			expect(outgoing.find(message => message.role === "toolResult" && message.toolCallId === `call-${i}`)).toEqual(
				original,
			);
		}
		expectUnchanged(manager.getBranch(), before);
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected persisted session");
		const reopened = await SessionManager.open(file, temp.path());
		try {
			expectUnchanged(reopened.getBranch(), before);
		} finally {
			await reopened.close();
		}
		const text = JSON.stringify(oldResult?.content);
		const id = /artifact:\/\/([^\s)"\\]+)/.exec(text)?.[1];
		if (!id) throw new Error(`Missing recovery link: ${text}`);
		const artifact = await manager.getArtifactPath(id);
		if (!artifact) throw new Error(`Missing recovery artifact ${id}`);
		expect(await Bun.file(artifact).text()).toContain("exchange-0 payload");
	});

	it.each([0, 5, 6])("keeps all entries when only %i user-started exchanges exist", async count => {
		seed(count);
		const before = entryBytes(manager.getBranch());
		const result = await session.shake("elide", { protectTurns: 6, requireArtifact: true });
		expect(result.toolResultsDropped).toBe(0);
		expect(result.blocksDropped).toBe(0);
		expectUnchanged(manager.getBranch(), before);
	});

	it("does not rewrite compacted-away entries or the protected usage anchor", async () => {
		seed(8);
		const entries = manager.getBranch();
		const compacted = entryBytes(entries.slice(0, 4));
		const suffix = entryBytes(entries.slice(2 * 4));
		manager.appendCompaction("summary", undefined, entries[4].id, 20_000);
		const result = await session.shake("elide", { protectTurns: 6, requireArtifact: true });
		expect(result.toolResultsDropped).toBe(1);
		expectUnchanged(manager.getBranch(), compacted);
		expectUnchanged(manager.getBranch(), suffix);
	});

	it("ignores manual model changes, advisor fallbacks and effort-only transitions", async () => {
		seed(8);
		const before = entryBytes(manager.getBranch());
		await session.setModel(fallback);
		const advisorFallback = extensionEventFromSessionEvent(
			{
				type: "retry_fallback_applied",
				from: `${primary.provider}/${primary.id}`,
				to: `${fallback.provider}/${fallback.id}`,
				role: "default",
			},
			0,
			"advisor",
		);
		if (!advisorFallback) throw new Error("Advisor fallback event was dropped");
		await runner.emit(advisorFallback);
		await runner.emit({
			type: "retry_fallback_applied",
			from: `${fallback.provider}/${fallback.id}:high`,
			to: `${fallback.provider}/${fallback.id}:low`,
			role: "default",
		});
		expectUnchanged(manager.getBranch(), before);
	});

	it("does not mistake a literal @default model id for an upstream routing change", async () => {
		seed(8);
		const before = entryBytes(manager.getBranch());
		const literal = session.modelRegistry.find("literal", "model@default");
		if (!literal) throw new Error("Expected deterministic literal-id fixture");
		await session.setModelTemporary(literal);
		await runner.emit({
			type: "retry_fallback_applied",
			from: "literal/model@default:high",
			to: "literal/model@default:low",
			role: "default",
		});
		expectUnchanged(manager.getBranch(), before);
	});

	it("counts user-invoked skills as exchanges but not agent-injected reminders", async () => {
		seed(8);
		const protectedEntries = manager.getBranch().slice(3 * 4);
		manager.appendCustomMessageEntry(SKILL_PROMPT_MESSAGE_TYPE, "user skill", true, {}, "user");
		manager.appendCustomMessageEntry("reminder", "agent reminder", false, {}, "agent");
		const before = entryBytes([...protectedEntries, ...manager.getBranch().slice(8 * 4)]);
		const result = await runner.createContext().shake({ protectTurns: 6 });
		expect(result.toolResultsDropped).toBe(3);
		expectUnchanged(manager.getBranch(), before);
	});

	it.each([{ attribution: "agent" as const, steering: true }, { synthetic: true }])(
		"does not count injected role:user messages as human exchanges: %j",
		async injection => {
			seed(8);
			const before = entryBytes(manager.getBranch().slice(2 * 4));
			manager.appendMessage({ role: "user", content: "injected continuation", timestamp: 100, ...injection });
			const result = await runner.createContext().shake({ protectTurns: 6 });
			expect(result.toolResultsDropped).toBe(2);
			expectUnchanged(manager.getBranch(), before);
		},
	);

	it("evicts a Codex provider session that cached the rewritten history", async () => {
		seed(8);
		const codex = session.modelRegistry.getAll().find(model => model.api === "openai-codex-responses");
		if (!codex) throw new Error("Expected bundled Codex model");
		auth.keys.setRuntime(codex.provider, "test-key");
		await session.setModelTemporary(codex);
		const close = vi.fn();
		session.providerSessionState.set("openai-codex-responses", { close });
		const result = await runner.createContext().shake({ protectTurns: 6 });
		expect(result.toolResultsDropped).toBe(2);
		expect(close).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("openai-codex-responses")).toBe(false);
	});

	it("leaves all history intact when the recovery artifact cannot be saved", async () => {
		seed(8);
		const before = entryBytes(manager.getBranch());
		vi.spyOn(manager, "allocateArtifactPath").mockRejectedValue(new Error("disk unavailable"));
		await expect(runner.createContext().shake({ protectTurns: 6 })).rejects.toThrow("recovery artifact");
		expectUnchanged(manager.getBranch(), before);
	});

	it("rejects a stale rewrite when another user turn arrives during artifact allocation", async () => {
		seed(8);
		const before = entryBytes(manager.getBranch());
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const allocate = manager.allocateArtifactPath.bind(manager);
		vi.spyOn(manager, "allocateArtifactPath").mockImplementation(async type => {
			started.resolve();
			await gate.promise;
			return allocate(type);
		});
		const pending = runner.createContext().shake({ protectTurns: 6 });
		await started.promise;
		manager.appendMessage({ role: "user", content: "arrived during shake", timestamp: 100 });
		gate.resolve();
		await expect(pending).rejects.toThrow();
		expectUnchanged(manager.getBranch(), before);
	});

	it("holds the fallback request behind cancelled handler-owned shake work", async () => {
		seed(8);
		const before = entryBytes(manager.getBranch());
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		const allocate = manager.allocateArtifactPath.bind(manager);
		vi.spyOn(manager, "allocateArtifactPath").mockImplementation(async type => {
			started.resolve();
			await gate.promise;
			return allocate(type);
		});
		const shake = session.shake.bind(session);
		vi.spyOn(session, "shake").mockImplementation((mode, options) => {
			options?.signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
			return shake(mode, options);
		});
		testSetExtensionHandlerTimeoutMs(1000);
		const prompt = session.prompt("continue after a delayed shake");
		try {
			await started.promise;
			await cancelled.promise;
			// Flush the race's zero-delay abort-cleanup turn, not a wall-clock delay.
			// The abort event itself precedes that race settling.
			await scheduler.yield();
			await scheduler.wait(0);
			expect(runtimeErrors).toEqual([]);
			expect(requests.map(request => request.model)).toEqual([`${primary.provider}/${primary.id}`]);
		} finally {
			gate.resolve();
			try {
				await prompt;
				await session.waitForIdle();
			} finally {
				testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
			}
		}
		expect(requests.map(request => request.model)).toEqual([
			`${primary.provider}/${primary.id}`,
			`${fallback.provider}/${fallback.id}`,
		]);
		expectUnchanged(manager.getBranch(), before);
		expect(runtimeErrors.splice(0).map(error => error.event)).toEqual(["retry_fallback_applied"]);
	});

	it("drains a persistence already in flight before fallback can use the rewritten history", async () => {
		seed(8);
		const before = entryBytes(manager.getBranch().slice(3 * 4));
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		let shaking = false;
		const rewrite = manager.rewriteEntries.bind(manager);
		vi.spyOn(manager, "rewriteEntries").mockImplementation(async () => {
			if (!shaking) return rewrite();
			started.resolve();
			await gate.promise;
			return rewrite();
		});
		const shake = session.shake.bind(session);
		vi.spyOn(session, "shake").mockImplementation((mode, options) => {
			shaking = true;
			options?.signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
			return shake(mode, options).finally(() => {
				shaking = false;
			});
		});
		testSetExtensionHandlerTimeoutMs(1000);
		const prompt = session.prompt("continue after persistence completes");
		try {
			await started.promise;
			await cancelled.promise;
			await scheduler.yield();
			await scheduler.wait(0);
			expect(runtimeErrors).toEqual([]);
			expect(requests.map(request => request.model)).toEqual([`${primary.provider}/${primary.id}`]);
		} finally {
			gate.resolve();
			try {
				await prompt;
				await session.waitForIdle();
			} finally {
				testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
			}
		}
		expect(requests.map(request => request.model)).toEqual([
			`${primary.provider}/${primary.id}`,
			`${fallback.provider}/${fallback.id}`,
		]);
		expect(JSON.stringify(requests[1].context.messages)).toContain("artifact://");
		expectUnchanged(manager.getBranch(), before);
		expect(runtimeErrors.splice(0).map(error => error.event)).toEqual(["retry_fallback_applied"]);
	});

	it("coalesces concurrent duplicate notifications into one recoverable rewrite", async () => {
		seed(8);
		await session.setModel(fallback);
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const allocate = manager.allocateArtifactPath.bind(manager);
		const allocation = vi.spyOn(manager, "allocateArtifactPath").mockImplementation(async type => {
			started.resolve();
			await gate.promise;
			return allocate(type);
		});
		const event = {
			type: "retry_fallback_applied",
			from: `${primary.provider}/${primary.id}`,
			to: `${fallback.provider}/${fallback.id}`,
			role: "default",
		} as const;
		const first = runner.emit(event);
		await started.promise;
		const second = runner.emit(event);
		gate.resolve();
		await Promise.all([first, second]);
		expect(allocation).toHaveBeenCalledTimes(1);
		const old = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "toolResult");
		expect(JSON.stringify(old)).toContain("artifact://");
		await runner.emit(event);
		expect(allocation).toHaveBeenCalledTimes(1);
	});
});
