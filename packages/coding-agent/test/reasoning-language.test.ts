import { afterEach, describe, expect, it } from "bun:test";
import type { Api, Context, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	ReasoningLanguageInjector,
	inferReasoningLanguage,
	renderReasoningLanguageBlock,
} from "@oh-my-pi/pi-coding-agent/session/reasoning-language";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("reasoning-language", () => {
	describe("inferReasoningLanguage", () => {
		it("detects clear Chinese turns", () => {
			expect(inferReasoningLanguage("帮我看看这个报错")).toBe("zh");
			expect(inferReasoningLanguage("解释一下 readFileSync 的异常行为")).toBe("zh");
		});

		it("lets CJK punctuation or a cue word lower the bar for short turns", () => {
			expect(inferReasoningLanguage("OK，继续")).toBe("zh");
			expect(inferReasoningLanguage("看下")).toBe("zh");
			expect(inferReasoningLanguage("好的")).toBeUndefined();
		});

		it("leaves English, code, and pasted logs alone", () => {
			expect(inferReasoningLanguage("explain this failure mode")).toBeUndefined();
			expect(inferReasoningLanguage("TypeError: x is not a function\n\tat foo (bar.ts:1:1)")).toBeUndefined();
			expect(inferReasoningLanguage("")).toBeUndefined();
		});
	});

	describe("renderReasoningLanguageBlock", () => {
		it("wraps the Chinese instruction in its own tag and keeps code untranslated", () => {
			const block = renderReasoningLanguageBlock("zh");

			expect(block.startsWith("<reasoning-language>")).toBe(true);
			expect(block.endsWith("</reasoning-language>")).toBe(true);
			expect(block).toContain("必须使用简体中文");
			expect(block).toContain("代码");
		});

		it("renders an English variant for en", () => {
			const block = renderReasoningLanguageBlock("en");

			expect(block.startsWith("<reasoning-language>")).toBe(true);
			expect(block).toContain("use English");
		});
	});

	describe("ReasoningLanguageInjector", () => {
		it("prepends the detected block to the newest user turn only", () => {
			const injector = new ReasoningLanguageInjector();
			const first: Message = { role: "user", content: "hello", timestamp: 1 };
			const assistant = createAssistantMessage("hi");
			const newest: Message = { role: "user", content: "帮我看看这个报错", timestamp: 2 };
			const context: Context = { systemPrompt: ["system"], messages: [first, assistant, newest] };

			const out = injector.transform(context, "auto");

			expect(out).not.toBe(context);
			expect(out.messages[0]).toBe(first);
			expect(out.messages[1]).toBe(assistant);
			expect(out.messages[2]?.content).toBe(`${renderReasoningLanguageBlock("zh")}\n\n帮我看看这个报错`);
		});

		it("keeps image parts after the block", () => {
			const context: Context = {
				systemPrompt: ["system"],
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", data: "img", mimeType: "image/png" },
							{ type: "text", text: "这个截图里的错误怎么修" },
						],
						timestamp: 1,
					},
				],
			};

			const out = new ReasoningLanguageInjector().transform(context, "zh");

			expect(out.messages[0]?.content).toEqual([
				{ type: "text", text: renderReasoningLanguageBlock("zh") },
				{ type: "image", data: "img", mimeType: "image/png" },
				{ type: "text", text: "这个截图里的错误怎么修" },
			]);
		});

		it("returns the same context when nothing is injected", () => {
			const injector = new ReasoningLanguageInjector();
			const english: Context = {
				systemPrompt: ["system"],
				messages: [{ role: "user", content: "explain this", timestamp: 1 }],
			};
			const chinese: Context = {
				systemPrompt: ["system"],
				messages: [{ role: "user", content: "解释一下", timestamp: 1 }],
			};

			expect(injector.transform(english, "auto")).toBe(english);
			expect(injector.transform(chinese, "off")).toBe(chinese);
		});

		it("leaves synthetic turns alone", () => {
			const context: Context = {
				systemPrompt: ["system"],
				messages: [{ role: "user", content: "继续", timestamp: 1, synthetic: true }],
			};

			expect(new ReasoningLanguageInjector().transform(context, "auto")).toBe(context);
		});

		it("replays an injected turn byte-identically while later turns grow the conversation", () => {
			const injector = new ReasoningLanguageInjector();
			const first: Message = { role: "user", content: "这个报错是什么原因", timestamp: 1 };
			const assistant = createAssistantMessage("ok");
			const base: Context = { systemPrompt: ["system"], messages: [first, assistant] };
			const initial = injector.transform(base, "auto");

			// Same turn, next provider call: identical user bytes.
			const replay = injector.transform(base, "auto");
			expect(replay.messages[0]).toBe(initial.messages[0]);

			// New turn: the earlier turn keeps the block it was sent with, the new
			// English turn is left for the provider default.
			const next: Message = { role: "user", content: "what about the second one?", timestamp: 2 };
			const grown = injector.transform({ ...base, messages: [first, assistant, next] }, "auto");
			expect(grown.messages[0]).toBe(initial.messages[0]);
			expect(grown.messages[2]?.content).toBe("what about the second one?");
		});

		it("applies an explicit language to turns auto would skip", () => {
			const context: Context = {
				systemPrompt: ["system"],
				messages: [{ role: "user", content: "explain this failure mode", timestamp: 1 }],
			};

			const out = new ReasoningLanguageInjector().transform(context, "zh");

			expect(out.messages[0]?.content).toBe(`${renderReasoningLanguageBlock("zh")}\n\nexplain this failure mode`);
		});
	});
});

describe("reasoning language on the provider wire", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	afterEach(async () => {
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	async function startSession(
		tempDir: TempDir,
		language: "auto" | "off" | "zh",
		contexts: Context[],
	): Promise<AgentSession> {
		const api = `test-reasoning-language-${language}`;
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: `reasoning-language-${language}`,
			name: "Reasoning language",
			api,
			provider: `managed-${language}`,
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${language}.db`));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ reasoningLanguage: language, "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		sessions.push(session);
		authStorage.close();
		return session;
	}

	it("injects the block on Chinese turns, leaves English turns alone, and keeps earlier turns byte-stable", async () => {
		using tempDir = TempDir.createSync("@pi-reasoning-language-");
		const contexts: Context[] = [];
		const session = await startSession(tempDir, "auto", contexts);

		await session.sendUserMessage("帮我看看这个报错");
		await session.sendUserMessage("what about the second one?");

		expect(contexts).toHaveLength(2);
		const firstTurn = contexts[0]!.messages[0]!;
		expect(firstTurn.role).toBe("user");
		// The date/cwd reminder and the reasoning-language block share this turn,
		// and later requests replay both byte-identically.
		const firstSerialized = JSON.stringify(firstTurn.content);
		expect(firstSerialized).toContain("<system-reminder>");
		expect(firstSerialized).toContain("<reasoning-language>");
		expect(firstSerialized).toContain("必须使用简体中文");

		// The second (English) turn stays on the provider default…
		const secondTurn = contexts[1]!.messages[2]!;
		expect(secondTurn.role).toBe("user");
		const secondSerialized = JSON.stringify(secondTurn.content);
		expect(secondSerialized).not.toContain("<reasoning-language>");
		expect(secondSerialized).toContain("what about the second one?");
		// …while the first turn's bytes are unchanged, so its cached prefix holds.
		expect(contexts[1]!.messages[0]!.content).toEqual(firstTurn.content);
	});

	it("keeps the system prompt and session history free of the block", async () => {
		using tempDir = TempDir.createSync("@pi-reasoning-language-");
		const contexts: Context[] = [];
		const session = await startSession(tempDir, "auto", contexts);

		await session.sendUserMessage("解释一下闭包");
		await session.sendUserMessage("继续");

		expect(contexts).toHaveLength(2);

		const systemPrompt = contexts[1]!.systemPrompt?.join("\n") ?? "";
		expect(systemPrompt).not.toContain("<reasoning-language>");
		expect(JSON.stringify(contexts[1]!.messages[0]!.content)).toContain("<reasoning-language>");
		// The second Chinese turn carries its own block.
		expect(JSON.stringify(contexts[1]!.messages[2]!.content)).toContain("<reasoning-language>");
	});

	it("sends nothing when the setting is off", async () => {
		using tempDir = TempDir.createSync("@pi-reasoning-language-");
		const contexts: Context[] = [];
		const session = await startSession(tempDir, "off", contexts);

		await session.sendUserMessage("解释一下闭包");

		expect(contexts).toHaveLength(1);
		const serialized = JSON.stringify(contexts[0]!.messages[0]!.content);
		expect(serialized).not.toContain("<reasoning-language>");
		expect(serialized).toContain("解释一下闭包");
	});
});
