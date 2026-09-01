import { afterEach, describe, expect, it } from "bun:test";
import type { Api, Context, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	injectDateCwdReminder,
	renderDateCwdReminder,
	withDateCwdReminder,
} from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatLocalCalendarDate } from "@oh-my-pi/pi-coding-agent/utils/local-date";
import { normalizePromptPath } from "@oh-my-pi/pi-coding-agent/utils/prompt-path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("date-cwd-reminder", () => {
	afterEach(() => {
		clearCustomApis();
	});

	describe("renderDateCwdReminder", () => {
		it("renders a system-reminder block carrying the date and cwd with a do-not-repeat instruction", () => {
			const reminder = renderDateCwdReminder("2026-08-14", "C:/work/omp");

			expect(reminder.startsWith("<system-reminder>")).toBe(true);
			expect(reminder.endsWith("</system-reminder>")).toBe(true);
			expect(reminder).toContain("2026-08-14");
			expect(reminder).toContain("C:/work/omp");
			expect(reminder).toContain("Do not repeat");
		});
	});

	describe("injectDateCwdReminder", () => {
		it("prepends the reminder to the first user message with string content without mutating the input", () => {
			const messages: Message[] = [{ role: "user", content: "hello", timestamp: 1 }, createAssistantMessage("hi")];
			const original = [...messages];

			const out = injectDateCwdReminder(messages, "<system-reminder>x</system-reminder>");

			expect(out).not.toBe(messages);
			expect(out[0]).toEqual({
				role: "user",
				content: "<system-reminder>x</system-reminder>\n\nhello",
				timestamp: 1,
			});
			expect(out[1]).toBe(messages[1]);
			expect(messages).toEqual(original);
		});

		it("prepends a text part before image parts when the first user message has array content", () => {
			const messages: Message[] = [
				{
					role: "user",
					content: [{ type: "image", data: "img", mimeType: "image/png" }],
					timestamp: 1,
				},
			];

			const out = injectDateCwdReminder(messages, "<system-reminder>x</system-reminder>");

			expect(out[0]?.content).toEqual([
				{ type: "text", text: "<system-reminder>x</system-reminder>" },
				{ type: "image", data: "img", mimeType: "image/png" },
			]);
		});

		it("returns the input unchanged when there is no user message", () => {
			const messages: Message[] = [createAssistantMessage("hi")];

			expect(injectDateCwdReminder(messages, "<system-reminder>x</system-reminder>")).toBe(messages);
			expect(injectDateCwdReminder([], "<system-reminder>x</system-reminder>")).toEqual([]);
		});

		it("reuses the same injected message object for the same pristine first user message and reminder", () => {
			// The append-only context path hands back fresh array copies every turn
			// but reuses the same message objects; the injected first-turn message
			// must keep its identity so the stable prefix is preserved (and the
			// provider prompt cache is not churned by fresh clones).
			const pristine: Message = { role: "user", content: "first", timestamp: 1 };
			const reminder = "<system-reminder>x</system-reminder>";

			const first = injectDateCwdReminder([pristine], reminder)[0]!;
			const second = injectDateCwdReminder([pristine], reminder)[0]!;
			expect(second).toBe(first);

			// A changed reminder (e.g. midnight rollover) must re-inject fresh.
			const refreshed = injectDateCwdReminder([pristine], "<system-reminder>y</system-reminder>")[0]!;
			expect(refreshed).not.toBe(first);
			expect(refreshed.content).toContain("y");
		});

		it("does not double-wrap when the first user message already carries the reminder", () => {
			const reminder = "<system-reminder>x</system-reminder>";
			const messages: Message[] = [{ role: "user", content: `${reminder}\n\nfirst`, timestamp: 1 }];

			expect(injectDateCwdReminder(messages, reminder)).toBe(messages);
		});
	});

	describe("withDateCwdReminder", () => {
		it("leaves NULL_PROMPT-style contexts (empty system prompt) untouched", () => {
			const context: Context = { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 1 }] };
			expect(withDateCwdReminder(context, "2026-08-14", "/cwd")).toBe(context);
		});

		it("injects the reminder into the first user message and keeps the system prompt bytes", () => {
			const systemPrompt = ["PROJECT\n<critical>\n- Must act.\n</critical>"];
			const context: Context = {
				systemPrompt,
				messages: [{ role: "user", content: "do the thing", timestamp: 1 }],
			};

			const out = withDateCwdReminder(context, "2026-08-14", "/work/omp");

			expect(out).not.toBe(context);
			expect(out.systemPrompt).toBe(systemPrompt);
			expect(out.messages[0]).toEqual({
				role: "user",
				content: `${renderDateCwdReminder("2026-08-14", "/work/omp")}\n\ndo the thing`,
				timestamp: 1,
			});
		});
	});
});

describe("date-cwd reminder on the provider wire", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	afterEach(async () => {
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("keeps the date/cwd out of the system prompt and pins the reminder to the first user turn across requests", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-");
		const api = "test-date-cwd-reminder";
		const contexts: Context[] = [];
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
			id: "date-cwd-reminder",
			name: "Date cwd reminder",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
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

		try {
			await session.sendUserMessage("first");

			expect(contexts).toHaveLength(1);
			// The volatile line must no longer live in the system prompt: open-weight
			// chat templates render tool schemas after the system content, so any
			// per-request byte there invalidates the whole tool-schema cache (#7404).
			const systemPrompt = contexts[0]!.systemPrompt?.join("\n") ?? "";
			expect(systemPrompt).not.toContain("Today");
			expect(systemPrompt).not.toContain("current working directory");
			expect(systemPrompt).not.toContain(formatLocalCalendarDate());

			const firstUser = contexts[0]!.messages[0]!;
			expect(firstUser.role).toBe("user");
			const firstText =
				typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content);
			expect(firstText).toContain("<system-reminder>");
			expect(firstText).toContain(formatLocalCalendarDate());
			expect(firstText).toContain(normalizePromptPath(tempDir.path()));

			// A second request must re-emit byte-identical reminder bytes so the
			// conversation prefix (system + tools + first turn) stays cached.
			await session.sendUserMessage("second");
			expect(contexts).toHaveLength(2);
			const secondFirst = contexts[1]!.messages[0]!;
			expect(secondFirst.role).toBe("user");
			expect(typeof secondFirst.content).toBe(typeof firstUser.content);
			expect(secondFirst.content).toEqual(firstUser.content);
		} finally {
			authStorage.close();
		}
	});
});
