import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { Api, AssistantMessage, Context, Message, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { DateCwdReminderInjector, renderDateCwdReminder } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { normalizePromptPath } from "@oh-my-pi/pi-coding-agent/utils/prompt-path";
import { formatLocalCalendarDate } from "@oh-my-pi/pi-tui/chrome/local-date";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const T1 = new Date(2026, 7, 14, 10).getTime();
const T2 = new Date(2026, 7, 14, 10, 5).getTime();
const T3 = new Date(2026, 7, 14, 10, 10).getTime();
const DAY2_T = new Date(2026, 7, 15, 10).getTime();

const textOf = (content: UserMessage["content"]): string => {
	if (typeof content === "string") return content;
	return content.map(p => (p.type === "text" ? p.text : "")).join("\n\n");
};

async function createTestSession(options: {
	tempDir: TempDir;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model<Api>;
	toolNames?: string[];
}) {
	return await createAgentSession({
		cwd: options.tempDir.path(),
		agentDir: options.tempDir.path(),
		sessionManager: options.sessionManager,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		settings: Settings.isolated({ "compaction.enabled": false }),
		model: options.model,
		toolNames: options.toolNames,
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
}

async function setupWireTest(tempDir: TempDir, api: string, baseUrl = "http://127.0.0.1:8080/v1") {
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
		id: api,
		name: api,
		api,
		provider: "managed-primary",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.keys.setRuntime(model.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const sessionDir = tempDir.join("sessions");
	const createSession = async (sessionManager: SessionManager) => {
		const { session } = await createTestSession({ tempDir, sessionManager, authStorage, modelRegistry, model });
		return session;
	};
	return { contexts, model, authStorage, modelRegistry, sessionDir, createSession };
}

describe("date-cwd-reminder", () => {
	afterEach(() => {
		clearCustomApis();
	});

	describe("DateCwdReminderInjector", () => {
		it("injects the first reminder without mutating the context", () => {
			const systemPrompt = ["PROJECT\n<critical>\n- Must act.\n</critical>"];
			const messages: Message[] = [{ role: "user", content: "hello", timestamp: T1 }, createAssistantMessage("hi")];
			const context: Context = { systemPrompt, messages };
			const injector = new DateCwdReminderInjector();

			const out = injector.transform(context, "2026-08-14", "/work/omp");

			expect(out).not.toBe(context);
			expect(out.systemPrompt).toBe(systemPrompt);
			expect(out.messages).not.toBe(messages);
			expect(out.messages[0]).toEqual({
				role: "user",
				content: `${renderDateCwdReminder("2026-08-14", "/work/omp")}\n\nhello`,
				timestamp: T1,
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
						timestamp: T1,
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
				messages: [{ role: "user", content: "hi", timestamp: T1 }],
			};
			const noUser: Context = { systemPrompt: ["system"], messages: [createAssistantMessage("hi")] };

			expect(injector.transform(noSystem, "2026-08-14", "/cwd")).toBe(noSystem);
			expect(injector.transform(noUser, "2026-08-14", "/cwd")).toBe(noUser);
		});

		it("keeps prior reminder bytes and moves a changed reminder to the next user turn", () => {
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: T1 };
			const firstContext: Context = { systemPrompt: ["system"], messages: [firstUser] };

			const first = injector.transform(firstContext, "2026-08-14", "/old");
			const firstInjected = first.messages[0]!;
			const secondUser: Message = { role: "user", content: "second", timestamp: DAY2_T };
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
			const firstUser: Message = { role: "user", content: "first", timestamp: T1 };
			const context: Context = { systemPrompt: ["system"], messages: [firstUser] };

			const first = injector.transform(context, "2026-08-14", "/work/omp");
			const replay = injector.transform({ ...context, messages: [...context.messages] }, "2026-08-14", "/work/omp");

			expect(replay.messages[0]).toBe(first.messages[0]);
		});

		it("keeps the reminders of turns a compaction retains when the first user turn changes", () => {
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "first", timestamp: T1 };
			const kept: Message = { role: "user", content: "kept", timestamp: T2 };
			const toolTurn = createAssistantMessage("calling a tool");
			// The cwd moves mid tool loop: the continuation carries the reminder as a control.
			injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/old");
			injector.transform(
				{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), kept, toolTurn] },
				"2026-08-14",
				"/old",
			);
			const live = injector.transform(
				{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), kept, toolTurn] },
				"2026-08-14",
				"/new",
			);
			const control = live.messages.at(-1)!;
			expect(control.role).toBe("developer");

			// A compaction replaces everything before `kept` with a new summary turn.
			const summary: Message = { role: "user", content: "summary", timestamp: T3 };
			const after = injector.transform(
				{ systemPrompt: ["system"], messages: [summary, kept, toolTurn] },
				"2026-08-14",
				"/new",
			);

			// The retained tail is sent exactly as before; only the new summary gets the current reminder.
			expect(after.messages.slice(1)).toEqual([kept, toolTurn, control]);
			expect(after.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-14", "/new")}\n\nsummary`);
		});

		it("ensures live compaction keeps retained bare turns bare and gives summary today's reminder", () => {
			const injector = new DateCwdReminderInjector();
			const t1: Message = { role: "user", content: "t1", timestamp: new Date(2026, 7, 13, 10).getTime() };
			const a1 = createAssistantMessage("a1");
			const t2: Message = { role: "user", content: "t2", timestamp: new Date(2026, 7, 13, 11).getTime() };
			const a2 = createAssistantMessage("a2");

			// Turn 1 on Aug 13
			injector.transform({ systemPrompt: ["system"], messages: [t1] }, "2026-08-13", "/w");
			// Turn 2 on Aug 13 (same day, t2 is bare)
			const live2 = injector.transform({ systemPrompt: ["system"], messages: [t1, a1, t2] }, "2026-08-13", "/w");
			expect(live2.messages[2]?.content).toBe("t2");

			// Turn 3 on Aug 14 (date rolls over)
			const t3: Message = { role: "user", content: "t3", timestamp: new Date(2026, 7, 14, 10).getTime() };
			const a3 = createAssistantMessage("a3");
			injector.transform({ systemPrompt: ["system"], messages: [t1, a1, t2, a2, t3] }, "2026-08-14", "/w");

			// Live compaction replaces t1, a1 with summary: [summary, t2, a2, t3, a3]
			const summary: Message = { role: "user", content: "summary", timestamp: new Date(2026, 7, 14, 11).getTime() };
			const afterCompact = injector.transform(
				{ systemPrompt: ["system"], messages: [summary, t2, a2, t3, a3] },
				"2026-08-14",
				"/w",
			);

			// Summary gets today's reminder
			expect(afterCompact.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-14", "/w")}\n\nsummary`);
			// Retained t2 MUST STAY BARE (not mutated to have a reminder)
			expect(afterCompact.messages[1]?.content).toBe("t2");
			// Retained t3 keeps its turn 3 reminder
			expect(afterCompact.messages[3]?.content).toBe(`${renderDateCwdReminder("2026-08-14", "/w")}\n\nt3`);
		});

		it("preserves historical first turn when injector initializes on a resumed context across days", () => {
			const historicalUser: Message = {
				role: "user",
				content: "historical prompt",
				timestamp: T1,
			};
			const assistantReply = createAssistantMessage("done");
			const newUser: Message = { role: "user", content: "new prompt", timestamp: DAY2_T };
			const context: Context = {
				systemPrompt: ["system"],
				messages: [historicalUser, assistantReply, newUser],
			};

			const injector = new DateCwdReminderInjector();
			const out = injector.transform(context, "2026-08-15", "/work/omp");

			expect(out.messages[0]?.content).toBe(
				`${renderDateCwdReminder("2026-08-14", "/work/omp")}\n\nhistorical prompt`,
			);
			expect(out.messages[1]).toBe(assistantReply);
			expect(out.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work/omp")}\n\nnew prompt`);
		});

		it("preserves historical first turn when resumed on the same day without duplicating reminder on new turn", () => {
			const historicalUser: Message = {
				role: "user",
				content: "historical prompt",
				timestamp: T1,
			};
			const assistantReply = createAssistantMessage("done");
			const newUser: Message = { role: "user", content: "new prompt", timestamp: T2 };
			const context: Context = {
				systemPrompt: ["system"],
				messages: [historicalUser, assistantReply, newUser],
			};

			const injector = new DateCwdReminderInjector();
			const out = injector.transform(context, "2026-08-14", "/work/omp");

			expect(out.messages[0]?.content).toBe(
				`${renderDateCwdReminder("2026-08-14", "/work/omp")}\n\nhistorical prompt`,
			);
			expect(out.messages[1]).toBe(assistantReply);
			// Since date and cwd did not change, newUser does not get an extra reminder:
			expect(out.messages[2]?.content).toBe("new prompt");
		});

		it("preserves multi-turn historical conversation from day 1 without injecting duplicate reminders on older turns", () => {
			const day1User1: Message = {
				role: "user",
				content: "turn 1",
				timestamp: T1,
			};
			const day1Asst1 = createAssistantMessage("reply 1");
			const day1User2: Message = {
				role: "user",
				content: "turn 2",
				timestamp: T2,
			};
			const day1Asst2 = createAssistantMessage("reply 2");
			const day2User3: Message = { role: "user", content: "turn 3", timestamp: DAY2_T };
			const context: Context = {
				systemPrompt: ["system"],
				messages: [day1User1, day1Asst1, day1User2, day1Asst2, day2User3],
			};

			const injector = new DateCwdReminderInjector();
			const out = injector.transform(context, "2026-08-15", "/work/omp");

			expect(out.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-14", "/work/omp")}\n\nturn 1`);
			expect(out.messages[1]).toBe(day1Asst1);
			expect(out.messages[2]?.content).toBe("turn 2");
			expect(out.messages[3]).toBe(day1Asst2);
			expect(out.messages[4]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work/omp")}\n\nturn 3`);
		});

		it("preserves historical turns with multi-part content on resume across days", () => {
			const historicalUser: Message = {
				role: "user",
				content: [
					{ type: "image", data: "historical-img", mimeType: "image/png" },
					{ type: "text", text: "query" },
				],
				timestamp: T1,
			};
			const assistantReply = createAssistantMessage("done");
			const newUser: Message = {
				role: "user",
				content: [{ type: "text", text: "follow up" }],
				timestamp: DAY2_T,
			};
			const context: Context = {
				systemPrompt: ["system"],
				messages: [historicalUser, assistantReply, newUser],
			};

			const injector = new DateCwdReminderInjector();
			const out = injector.transform(context, "2026-08-15", "/work/omp");

			expect(out.messages[0]?.content).toEqual([
				{ type: "text", text: renderDateCwdReminder("2026-08-14", "/work/omp") },
				{ type: "image", data: "historical-img", mimeType: "image/png" },
				{ type: "text", text: "query" },
			]);
			expect(out.messages[1]).toBe(assistantReply);
			expect(out.messages[2]?.content).toEqual([
				{ type: "text", text: renderDateCwdReminder("2026-08-15", "/work/omp") },
				{ type: "text", text: "follow up" },
			]);
		});

		it("anchors developer control reminder when resumed with pending tool continuation across day boundary", () => {
			const historicalUser: Message = {
				role: "user",
				content: "run tool",
				timestamp: T1,
			};
			const toolCallMsg = createAssistantMessage("calling tool");
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "run",
				content: [{ type: "text", text: "output" }],
				isError: false,
				timestamp: T2,
			};
			const context: Context = {
				systemPrompt: ["system"],
				messages: [historicalUser, toolCallMsg, toolResult],
			};

			const injector = new DateCwdReminderInjector();
			const out = injector.transform(context, "2026-08-15", "/work/omp");

			expect(out.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-14", "/work/omp")}\n\nrun tool`);
			expect(out.messages[1]).toBe(toolCallMsg);
			expect(out.messages[2]).toBe(toolResult);
			const control = out.messages[3]!;
			expect(control.role).toBe("developer");
			expect(control.content).toBe(renderDateCwdReminder("2026-08-15", "/work/omp"));
		});

		it("ensures live compaction root gets the current date rather than initial date", () => {
			const initialUser: Message = {
				role: "user",
				content: "first prompt",
				timestamp: new Date(2026, 7, 13, 10).getTime(),
			};
			const assistantReply = createAssistantMessage("done");
			const kept = createAssistantMessage("kept");
			const toolTurn = createAssistantMessage("calling a tool");

			const injector = new DateCwdReminderInjector();

			// Live turn 1 on 2026-08-13
			const before = injector.transform(
				{ systemPrompt: ["system"], messages: [initialUser, assistantReply] },
				"2026-08-13",
				"/w",
			);
			expect(before.messages[0]?.content).toBe(renderDateCwdReminder("2026-08-13", "/w") + "\n\nfirst prompt");

			// Live compaction occurs on 2026-08-14
			const summary: Message = {
				role: "user",
				content: "summary",
				timestamp: new Date(2026, 7, 14, 10).getTime(),
			};
			const after = injector.transform(
				{ systemPrompt: ["system"], messages: [summary, kept, toolTurn] },
				"2026-08-14",
				"/w",
			);

			// The summary turn must carry today's date (2026-08-14), not the previous date (2026-08-13)
			expect(after.messages[0]?.content).toBe(renderDateCwdReminder("2026-08-14", "/w") + "\n\nsummary");
			expect(after.messages.slice(1)).toEqual([kept, toolTurn]);
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
		const { contexts, authStorage, createSession } = await setupWireTest(tempDir, "test-date-cwd-reminder");
		const session = await createSession(SessionManager.inMemory(tempDir.path()));
		sessions.push(session);

		try {
			await session.sendUserMessage("first");

			expect(contexts).toHaveLength(1);
			// The volatile line must no longer live in the system prompt: open-weight
			// chat templates render tool schemas *after* the system content, so any
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

	it("keeps an earlier steering message byte-identical when the date rolls over mid-turn", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-");
		await Bun.write(tempDir.join("notes.txt"), "notes");
		const api = "test-date-cwd-reminder-steer";
		const contexts: Context[] = [];
		const pushReadCall = (stream: AssistantMessageEventStream, id: string) => {
			const toolCall = { type: "toolCall" as const, id, name: "read", arguments: { path: "notes.txt" } };
			const message: AssistantMessage = {
				...createAssistantMessage(""),
				content: [toolCall],
				stopReason: "toolUse",
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
			stream.push({ type: "done", reason: "toolUse", message });
		};
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			const request = contexts.length;
			queueMicrotask(() => {
				if (request === 1) {
					void session.steer("steered");
					pushReadCall(stream, "read-1");
				} else if (request === 2) {
					// The next requests are tool continuations with no new user turn.
					setSystemTime(new Date(2026, 7, 15, 0, 1));
					pushReadCall(stream, "read-2");
				} else if (request < 5) {
					pushReadCall(stream, `read-${request}`);
				} else {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				}
			});
			return stream;
		});
		const model = buildModel({
			id: "date-cwd-reminder-steer",
			name: "Date cwd reminder steer",
			api,
			provider: "managed-primary",
			// Remote endpoint: a loopback URL would turn on append-only context, which pins message identity.
			baseUrl: "https://api.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createTestSession({
			tempDir,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			model,
			toolNames: ["read"],
		});
		sessions.push(session);

		setSystemTime(new Date(2026, 7, 14, 23, 59));
		try {
			await session.sendUserMessage("first");
			await session.waitForIdle();

			expect(contexts).toHaveLength(5);
			const wire = contexts.map(context =>
				context.messages.map(message => JSON.stringify([message.role, message.content])),
			);
			const steerIndex = contexts[1]!.messages.findLastIndex(message => message.role === "user");
			expect(wire[1]![steerIndex]).toContain("steered");
			// Bytes the provider already saw stay put on every later request; the new date is appended once.
			for (let request = 2; request < wire.length; request++) {
				expect(wire[request]!.slice(0, wire[request - 1]!.length)).toEqual(wire[request - 1]!);
			}
			const reminder = JSON.stringify([
				"developer",
				renderDateCwdReminder("2026-08-15", normalizePromptPath(tempDir.path())),
			]);
			expect(wire[2]!.at(-1)).toBe(reminder);
			expect(wire[4]!.filter(message => message === reminder)).toHaveLength(1);
		} finally {
			setSystemTime();
			authStorage.close();
		}
	});

	it("preserves historical turn reminder bytes across persisted session reopen on a later day (#15343)", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-persisted-");
		// Remote endpoint: verifies append-only date preservation across reopen without loopback pinning.
		const { contexts, authStorage, sessionDir, createSession } = await setupWireTest(
			tempDir,
			"test-date-cwd-reminder-persisted",
			"https://api.example.com/v1",
		);

		// Day 1: 2026-08-14
		setSystemTime(new Date(2026, 7, 14, 12, 0));
		const sessionManager1 = SessionManager.create(tempDir.path(), sessionDir);
		const sessionFile = sessionManager1.getSessionFile()!;

		const session1 = await createSession(sessionManager1);
		sessions.push(session1);

		try {
			await session1.sendUserMessage("first on day 1");
			expect(contexts).toHaveLength(1);
			const day1FirstUser = contexts[0]!.messages[0]! as UserMessage;
			expect(day1FirstUser.role).toBe("user");
			expect(textOf(day1FirstUser.content)).toContain("2026-08-14");
			expect(textOf(day1FirstUser.content)).not.toContain("2026-08-15");

			await session1.dispose();

			// Day 2: 2026-08-15
			setSystemTime(new Date(2026, 7, 15, 12, 0));
			const sessionManager2 = await SessionManager.open(sessionFile, sessionDir);

			const session2 = await createSession(sessionManager2);
			sessions.push(session2);

			await session2.sendUserMessage("second on day 2");
			expect(contexts).toHaveLength(2);

			const day2HistoricalFirstUser = contexts[1]!.messages[0]! as UserMessage;
			expect(day2HistoricalFirstUser.role).toBe("user");
			expect(day2HistoricalFirstUser.content).toEqual(day1FirstUser.content);
			expect(textOf(day2HistoricalFirstUser.content)).toContain("2026-08-14");
			expect(textOf(day2HistoricalFirstUser.content)).not.toContain("2026-08-15");

			const day2NewUser = contexts[1]!.messages[2]! as UserMessage;
			expect(day2NewUser.role).toBe("user");
			expect(textOf(day2NewUser.content)).toContain("2026-08-15");
			expect(textOf(day2NewUser.content)).toContain("second on day 2");

			await session2.dispose();

			// Day 3: 2026-08-16
			setSystemTime(new Date(2026, 7, 16, 12, 0));
			const sessionManager3 = await SessionManager.open(sessionFile, sessionDir);

			const session3 = await createSession(sessionManager3);
			sessions.push(session3);

			await session3.sendUserMessage("third on day 3");
			expect(contexts).toHaveLength(3);

			const day3HistoricalTurn1 = contexts[2]!.messages[0]! as UserMessage;
			expect(day3HistoricalTurn1.role).toBe("user");
			expect(day3HistoricalTurn1.content).toEqual(day1FirstUser.content);
			expect(textOf(day3HistoricalTurn1.content)).toContain("2026-08-14");

			const day3HistoricalTurn2 = contexts[2]!.messages[2]! as UserMessage;
			expect(day3HistoricalTurn2.role).toBe("user");
			expect(day3HistoricalTurn2.content).toEqual(day2NewUser.content);
			expect(textOf(day3HistoricalTurn2.content)).toContain("2026-08-15");

			const day3NewTurn3 = contexts[2]!.messages[4]! as UserMessage;
			expect(day3NewTurn3.role).toBe("user");
			expect(textOf(day3NewTurn3.content)).toContain("2026-08-16");
			expect(textOf(day3NewTurn3.content)).toContain("third on day 3");
		} finally {
			setSystemTime();
			authStorage.close();
		}
	});

	it("preserves historical date when switching sessions via session.switchSession", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-switch-");
		const { contexts, authStorage, sessionDir, createSession } = await setupWireTest(
			tempDir,
			"test-date-cwd-reminder-switch",
		);

		// Day 1: Session 1 created and saved
		setSystemTime(new Date(2026, 7, 14, 12, 0));
		const sessionManager1 = SessionManager.create(tempDir.path(), sessionDir);
		const session1File = sessionManager1.getSessionFile()!;

		const session1 = await createSession(sessionManager1);
		sessions.push(session1);

		try {
			await session1.sendUserMessage("turn 1 in session 1");
			expect(contexts).toHaveLength(1);
			const day1FirstUser = contexts[0]!.messages[0]! as UserMessage;
			expect(textOf(day1FirstUser.content)).toContain("2026-08-14");

			// Day 2: Session 2 created
			setSystemTime(new Date(2026, 7, 15, 12, 0));
			const sessionManager2 = SessionManager.create(tempDir.path(), sessionDir);
			const session2 = await createSession(sessionManager2);
			sessions.push(session2);

			const switched = await session2.switchSession(session1File, { keepModel: true });
			expect(switched).toBe(true);

			await session2.sendUserMessage("turn 2 resumed on day 2");
			expect(contexts).toHaveLength(2);

			const resumedTurn1 = contexts[1]!.messages[0]! as UserMessage;
			expect(resumedTurn1.role).toBe("user");
			expect(resumedTurn1.content).toEqual(day1FirstUser.content);
			expect(textOf(resumedTurn1.content)).toContain("2026-08-14");
			expect(textOf(resumedTurn1.content)).not.toContain("2026-08-15");

			const resumedTurn2 = contexts[1]!.messages[2]! as UserMessage;
			expect(resumedTurn2.role).toBe("user");
			expect(textOf(resumedTurn2.content)).toContain("2026-08-15");
			expect(textOf(resumedTurn2.content)).toContain("turn 2 resumed on day 2");
		} finally {
			setSystemTime();
			authStorage.close();
		}
	});

	it("preserves historical turn reminder bytes across session fork", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-fork-");
		const { contexts, authStorage, sessionDir, createSession } = await setupWireTest(
			tempDir,
			"test-date-cwd-reminder-fork",
		);

		setSystemTime(new Date(2026, 7, 14, 12, 0));
		const sessionManager = SessionManager.create(tempDir.path(), sessionDir);
		const session = await createSession(sessionManager);
		sessions.push(session);

		try {
			await session.sendUserMessage("turn 1 before fork");
			expect(contexts).toHaveLength(1);
			const turn1FirstUser = contexts[0]!.messages[0]! as UserMessage;
			expect(textOf(turn1FirstUser.content)).toContain("2026-08-14");

			// Fork the session
			const forked = await session.fork();
			expect(forked).toBe(true);

			// Send turn 2 in the forked session
			await session.sendUserMessage("turn 2 after fork");
			expect(contexts).toHaveLength(2);

			const forkedTurn1 = contexts[1]!.messages[0]! as UserMessage;
			expect(forkedTurn1.role).toBe("user");
			// Turn 1 reminder bytes must be completely preserved across fork
			expect(forkedTurn1.content).toEqual(turn1FirstUser.content);
			expect(textOf(forkedTurn1.content)).toContain("2026-08-14");

			const forkedTurn2 = contexts[1]!.messages[2]! as UserMessage;
			expect(forkedTurn2.role).toBe("user");
			expect(textOf(forkedTurn2.content)).toContain("turn 2 after fork");
		} finally {
			setSystemTime();
			authStorage.close();
		}
	});
});
