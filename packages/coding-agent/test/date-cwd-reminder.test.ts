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
	applyNowStamp,
	DateCwdReminderInjector,
	injectNowStamp,
	renderDateCwdReminder,
	renderNowStamp,
} from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatLocalCalendarDate } from "@oh-my-pi/pi-coding-agent/utils/local-date";
import { normalizePromptPath } from "@oh-my-pi/pi-coding-agent/utils/prompt-path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

/** The wire text of a message: string content as-is, array content JSON-serialized. */
function textOf(message: Message): string {
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

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

	describe("DateCwdReminderInjector", () => {
		it("injects the first reminder without mutating the context", () => {
			const systemPrompt = ["PROJECT\n<critical>\n- Must act.\n</critical>"];
			const messages: Message[] = [{ role: "user", content: "hello", timestamp: 1 }, createAssistantMessage("hi")];
			const context: Context = { systemPrompt, messages };
			const injector = new DateCwdReminderInjector();

			const out = injector.transform(context, "2026-08-14", "/work/omp");

			expect(out).not.toBe(context);
			expect(out.systemPrompt).toBe(systemPrompt);
			expect(out.messages).not.toBe(messages);
			expect(out.messages[0]).toEqual({
				role: "user",
				content: `${renderDateCwdReminder("2026-08-14", "/work/omp")}\n\nhello`,
				timestamp: 1,
			});
			expect(out.messages[1]).toBe(messages[1]);
			expect(context.messages).toBe(messages);
		});

		it("prepends a text part before image parts", () => {
			const context: Context = {
				systemPrompt: ["system"],
				messages: [
					{
						role: "user",
						content: [{ type: "image", data: "img", mimeType: "image/png" }],
						timestamp: 1,
					},
				],
			};

			const out = new DateCwdReminderInjector().transform(context, "2026-08-14", "/work/omp");

			expect(out.messages[0]?.content).toEqual([
				{ type: "text", text: renderDateCwdReminder("2026-08-14", "/work/omp") },
				{ type: "image", data: "img", mimeType: "image/png" },
			]);
		});

		it("leaves contexts without a system prompt or user message untouched", () => {
			const injector = new DateCwdReminderInjector();
			const noSystem: Context = {
				systemPrompt: [],
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			};
			const noUser: Context = { systemPrompt: ["system"], messages: [createAssistantMessage("hi")] };

			expect(injector.transform(noSystem, "2026-08-14", "/cwd")).toBe(noSystem);
			expect(injector.transform(noUser, "2026-08-14", "/cwd")).toBe(noUser);
		});

		it("keeps prior reminder bytes and moves a changed reminder to the next user turn", () => {
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			const firstContext: Context = { systemPrompt: ["system"], messages: [firstUser] };

			const first = injector.transform(firstContext, "2026-08-14", "/old");
			const firstInjected = first.messages[0]!;
			const secondUser: Message = { role: "user", content: "second", timestamp: 2 };
			const second = injector.transform(
				{
					systemPrompt: firstContext.systemPrompt,
					messages: [firstUser, createAssistantMessage("done"), secondUser],
				},
				"2026-08-15",
				"/new",
			);

			expect(second.messages[0]).toBe(firstInjected);
			expect(second.messages[0]?.content).toBe(firstInjected.content);
			expect(second.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/new")}\n\nsecond`);
			expect(firstUser.content).toBe("first");
			expect(secondUser.content).toBe("second");
		});

		it("reuses injected message objects on provider request replay", () => {
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			const context: Context = { systemPrompt: ["system"], messages: [firstUser] };

			const first = injector.transform(context, "2026-08-14", "/work/omp");
			const replay = injector.transform({ ...context, messages: [...context.messages] }, "2026-08-14", "/work/omp");

			expect(replay.messages[0]).toBe(first.messages[0]);
		});
	});
	describe("renderNowStamp", () => {
		it("renders a system-reminder block with a UTC instant, local clock, timezone name, and numeric offset", () => {
			const stamp = renderNowStamp(new Date("2026-08-30T02:51:16Z"));

			expect(stamp).toMatch(
				/^<system-reminder>\nNow: 2026-08-30T02:51:16Z \(\d{2}:\d{2} [A-Za-z]{2,5}, UTC[+-]\d{2}:\d{2}\)\n<\/system-reminder>$/,
			);
		});
	});

	describe("injectNowStamp", () => {
		it("appends the stamp to the last user message with string content without mutating the input", () => {
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const assistant = createAssistantMessage("hi");
			const last: Message = { role: "user", content: "last", timestamp: 2 };
			const messages = [first, assistant, last];

			const out = injectNowStamp(messages, new Date("2026-08-30T02:51:16Z"));

			expect(out).not.toBe(messages);
			// Earlier messages keep their identity; only the last user message is stamped.
			expect(out[0]).toBe(first);
			expect(out[1]).toBe(assistant);
			expect(out[2]).not.toBe(last);
			expect(typeof out[2]?.content).toBe("string");
			expect(textOf(out[2]!)).toMatch(
				/^last\n\n<system-reminder>\nNow: 2026-08-30T02:51:16Z \(.+\)\n<\/system-reminder>$/,
			);
			// The input array and its elements are untouched.
			expect(messages).toEqual([first, assistant, last]);
			expect(messages[0]).toBe(first);
			expect(messages[2]).toBe(last);
			expect(messages[2]!.content).toBe("last");
		});

		it("appends a trailing text part when the last user message has array content", () => {
			const messages: Message[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: "with image" },
						{ type: "image", data: "img", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			];

			const out = injectNowStamp(messages, new Date("2026-08-30T02:51:16Z"));

			const content = out[0]?.content;
			if (!Array.isArray(content)) throw new Error("expected array content");
			expect(content).toHaveLength(3);
			expect(content[0]).toEqual({ type: "text", text: "with image" });
			expect(content[1]).toEqual({ type: "image", data: "img", mimeType: "image/png" });
			const lastPart = content[2];
			expect(lastPart?.type).toBe("text");
			if (lastPart?.type === "text") {
				expect(lastPart.text).toMatch(/^<system-reminder>\nNow: 2026-08-30T02:51:16Z \(.+\)\n<\/system-reminder>$/);
			}
		});

		it("leaves a last user message already carrying a Now stamp unchanged", () => {
			const stamped: Message = {
				role: "user",
				content: "hi\n\n<system-reminder>\nNow: 2026-01-02T03:04:05Z (04:04 XYZ, UTC+01:00)\n</system-reminder>",
				timestamp: 1,
			};
			const messages = [stamped];

			const out = injectNowStamp(messages, new Date("2026-08-30T02:51:16Z"));

			expect(out).toBe(messages);
			expect(textOf(out[0]!).match(/Now: /g)).toHaveLength(1);
		});

		it("re-stamps the same pristine message with the same stamped object even at a later timestamp", () => {
			const pristine: Message = { role: "user", content: "hi", timestamp: 1 };

			const first = injectNowStamp([pristine], new Date("2026-08-30T02:51:16Z"))[0]!;
			expect(first).not.toBe(pristine);
			const second = injectNowStamp([pristine], new Date("2026-08-30T03:00:00Z"))[0]!;
			expect(second).toBe(first);
		});

		it("re-applies the cached stamp to a previously-stamped user message that is no longer last", () => {
			// The append-only log re-hands the pristine messages each request; a
			// user message stamped in an earlier request must keep its exact wire
			// bytes once it slides out of the last-user position.
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const assistant = createAssistantMessage("hi");
			const second: Message = { role: "user", content: "second", timestamp: 2 };

			const firstStamped = injectNowStamp([first], new Date("2026-08-30T02:51:16Z"))[0]!;

			const out = injectNowStamp([first, assistant, second], new Date("2026-08-30T03:00:00Z"));

			expect(out[0]).toBe(firstStamped);
			expect(out[1]).toBe(assistant);
			expect(out[2]).not.toBe(second);
			expect(textOf(out[2]!)).toContain("Now: 2026-08-30T03:00:00Z");
		});

		it("returns the input unchanged when there is no user message or no messages", () => {
			const assistantOnly = [createAssistantMessage("hi")];
			expect(injectNowStamp(assistantOnly, new Date("2026-08-30T02:51:16Z"))).toBe(assistantOnly);
			const empty: Message[] = [];
			expect(injectNowStamp(empty, new Date("2026-08-30T02:51:16Z"))).toBe(empty);
		});

		it("re-applies the same stamp to a recreated copy of a previously stamped message", () => {
			// Per-request transforms (steer envelopes, secret obfuscation) may
			// hand back a fresh object with identical wire bytes; the stamp must
			// not change with it.
			const pristine: Message = { role: "user", content: "steer-alpha", timestamp: 101 };
			const first = injectNowStamp([pristine], new Date("2026-08-30T02:51:16Z"))[0]!;

			const recreated: Message = { role: "user", content: "steer-alpha", timestamp: 101 };
			const out = injectNowStamp([recreated], new Date("2026-08-30T03:00:00Z"));

			expect(out[0]).not.toBe(recreated);
			expect(textOf(out[0]!)).toBe(textOf(first));
		});

		it("keeps the stamp when a recreated copy slides out of last-user position", () => {
			const first: Message = { role: "user", content: "steer-beta", timestamp: 102 };
			const assistant = createAssistantMessage("hi");
			const second: Message = { role: "user", content: "steer-gamma", timestamp: 103 };

			const firstStamped = injectNowStamp([first], new Date("2026-08-30T02:51:16Z"))[0]!;

			const firstRecreated: Message = { role: "user", content: "steer-beta", timestamp: 102 };
			const out = injectNowStamp([firstRecreated, assistant, second], new Date("2026-08-30T03:00:00Z"));

			expect(textOf(out[0]!)).toBe(textOf(firstStamped));
			expect(out[1]).toBe(assistant);
			expect(textOf(out[2]!)).toContain("Now: 2026-08-30T03:00:00Z");
		});
	});

	describe("applyNowStamp", () => {
		it("leaves NULL_PROMPT-style contexts (empty system prompt) untouched", () => {
			const context: Context = { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 1 }] };
			expect(applyNowStamp(context, new Date("2026-08-30T02:51:16Z"))).toBe(context);
		});

		it("leaves no-message contexts untouched", () => {
			const context: Context = { systemPrompt: ["system"], messages: [] };
			expect(applyNowStamp(context, new Date("2026-08-30T02:51:16Z"))).toBe(context);
		});

		it("stamps the last user message and keeps the system prompt bytes", () => {
			const systemPrompt = ["PROJECT\n<critical>\n- Must act.\n</critical>"];
			const context: Context = {
				systemPrompt,
				messages: [
					{ role: "user", content: "first-apply", timestamp: 201 },
					createAssistantMessage("hi"),
					{ role: "user", content: "last-apply", timestamp: 202 },
				],
			};

			const out = applyNowStamp(context, new Date("2026-08-30T02:51:16Z"));

			expect(out).not.toBe(context);
			expect(out.systemPrompt).toBe(systemPrompt);
			expect(out.messages[0]).toBe(context.messages[0]);
			expect(out.messages[2]?.content).toMatch(/Now: 2026-08-30T02:51:16Z \(/);
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
	it("stamps the last user turn with Now and keeps stamped user turns byte-identical across requests", async () => {
		using tempDir = TempDir.createSync("@pi-now-reminder-");
		const api = "test-now-reminder";
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
			id: "now-reminder",
			name: "Now reminder",
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
			const systemPrompt = contexts[0]!.systemPrompt?.join("\n") ?? "";
			expect(systemPrompt).not.toContain("Now:");

			const req1Last = contexts[0]!.messages[contexts[0]!.messages.length - 1]!;
			expect(req1Last.role).toBe("user");
			const req1LastText =
				typeof req1Last.content === "string" ? req1Last.content : JSON.stringify(req1Last.content);
			expect(req1LastText.match(/Now: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \(/g)).toHaveLength(1);
			expect(req1LastText).toContain("first");

			await session.sendUserMessage("second");
			expect(contexts).toHaveLength(2);

			// Prefix-cache contract: request 2 re-sends request 1's stamped first
			// user message byte-identical — the stamped bytes must survive the
			// move from last-user to earlier position.
			const req2First = contexts[1]!.messages[0]!;
			expect(req2First.role).toBe("user");
			expect(req2First.content).toEqual(req1Last.content);

			// The new last user message carries exactly one Now stamp; Today stays
			// pinned to the first user message.
			const req2Last = contexts[1]!.messages[contexts[1]!.messages.length - 1]!;
			expect(req2Last.role).toBe("user");
			const req2LastText =
				typeof req2Last.content === "string" ? req2Last.content : JSON.stringify(req2Last.content);
			expect(req2LastText.match(/Now: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \(/g)).toHaveLength(1);
			expect(req2LastText).toContain("second");
			expect(req2LastText).not.toContain("Today:");
		} finally {
			authStorage.close();
		}
	});
	it("omits the Now stamp entirely when prompt.nowStamp is disabled", async () => {
		using tempDir = TempDir.createSync("@pi-now-reminder-off-");
		const api = "test-now-reminder-off";
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
			id: "now-reminder-off",
			name: "Now reminder off",
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
			settings: Settings.isolated({ "compaction.enabled": false, "prompt.nowStamp": false }),
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
			await session.sendUserMessage("hello");

			expect(contexts).toHaveLength(1);
			const wireText = JSON.stringify(contexts[0]!.messages);
			expect(wireText).not.toContain("Now:");
			// The date/cwd reminder still rides on the first user turn (#7404).
			const firstUser = contexts[0]!.messages.find(message => message.role === "user")!;
			const firstUserText =
				typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content);
			expect(firstUserText).toContain("Today:");
			expect(firstUserText).toContain("hello");
		} finally {
			authStorage.close();
		}
	});
});
