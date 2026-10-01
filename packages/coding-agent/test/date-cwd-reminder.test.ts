import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction/message-cache";
import type { Api, Context, Message, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { DateCwdReminderInjector, renderDateCwdReminder } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { convertToLlm, stripImagesFromMessage, wrapSteeringForModel } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatLocalCalendarDate } from "@oh-my-pi/pi-tui/chrome/local-date";
import { normalizePromptPath } from "@oh-my-pi/pi-coding-agent/utils/prompt-path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("date-cwd-reminder", () => {
	afterEach(() => {
		clearCustomApis();
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
});

function steeringMessage(kind: "user" | "collab", content: UserMessage["content"], timestamp = 1) {
	return kind === "user"
		? { role: "user" as const, content, steering: true, timestamp }
		: {
				role: "custom" as const,
				customType: COLLAB_PROMPT_MESSAGE_TYPE,
				content,
				display: true,
				attribution: "user" as const,
				timestamp,
			};
}

function steeringRequest(
	injector: DateCwdReminderInjector,
	messages: AgentMessage[],
	date: string,
	cwd: string,
): Message[] {
	return injector.transform(
		{ systemPrompt: ["system"], messages: convertToLlm(wrapSteeringForModel(messages)) },
		date,
		cwd,
	).messages;
}

function reminderText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	const text: string[] = [];
	for (const part of message.content) {
		if (part.type === "text" && "text" in part && typeof part.text === "string") text.push(part.text);
	}
	return text.join("\n");
}

describe("steering date/cwd cache stability", () => {
	for (const kind of ["user", "collab"] as const) {
		describe(kind, () => {
			it("preserves historical bytes across new turns, date/cwd changes, and A-B-A replay", () => {
				const injector = new DateCwdReminderInjector();
				const root = steeringMessage(kind, "first steer");
				const history: AgentMessage[] = [root];
				const first = steeringRequest(injector, history, "2026-08-14", "/old");
				const firstBytes = JSON.stringify(first);
				expect(reminderText(first[0]!)).toContain(renderDateCwdReminder("2026-08-14", "/old"));
				expect(steeringRequest(injector, history, "2026-08-14", "/old")[0]).toBe(first[0]);

				history.push(createAssistantMessage("done"), steeringMessage(kind, "same-day steer", 2));
				const sameDay = steeringRequest(injector, history, "2026-08-14", "/old");
				expect(sameDay[0]).toBe(first[0]);
				expect(reminderText(sameDay[2]!)).not.toContain("<system-reminder>");
				const sameDayBytes = JSON.stringify(sameDay);

				history.push(steeringMessage(kind, "next-day steer", 3));
				const nextDay = steeringRequest(injector, history, "2026-08-15", "/new");
				expect(JSON.stringify(nextDay.slice(0, 3))).toBe(sameDayBytes);
				expect(reminderText(nextDay[3]!)).toContain(renderDateCwdReminder("2026-08-15", "/new"));
				const nextDayBytes = JSON.stringify(nextDay);

				const cwdChange = steeringRequest(injector, history, "2026-08-15", "/elsewhere");
				expect(JSON.stringify(cwdChange.slice(0, 4))).toBe(nextDayBytes);
				expect(cwdChange[4]).toMatchObject({
					role: "developer",
					content: renderDateCwdReminder("2026-08-15", "/elsewhere"),
				});
				const back = steeringRequest(injector, history, "2026-08-14", "/old");
				expect(back.slice(0, 5)).toEqual(cwdChange);
				expect(back[5]).toMatchObject({ role: "developer", content: renderDateCwdReminder("2026-08-14", "/old") });
				expect(JSON.stringify(back.slice(0, 1))).toBe(firstBytes);
				expect(steeringRequest(injector, history, "2026-08-14", "/old")).toEqual(back);
				expect(root.content).toBe("first steer");
			});

			it("refreshes owner edits and image removal on first and later reminder carriers", () => {
				const injector = new DateCwdReminderInjector();
				const text = { type: "text" as const, text: "first steer" };
				const image = { type: "image" as const, data: "aW1n", mimeType: "image/png" };
				const root = steeringMessage(kind, [text, image]);
				const history: AgentMessage[] = [root];
				steeringRequest(injector, history, "2026-08-14", "/old");
				text.text = "edited first steer";
				invalidateMessageCache(root);
				const editedRoot = steeringRequest(injector, history, "2026-08-14", "/old");
				expect(reminderText(editedRoot[0]!)).toContain("edited first steer");
				expect(reminderText(editedRoot[0]!)).toContain(renderDateCwdReminder("2026-08-14", "/old"));
				expect(editedRoot[0]!.content).toContainEqual(image);
				expect(stripImagesFromMessage(root)).toBe(1);
				const strippedRoot = steeringRequest(injector, history, "2026-08-14", "/old");
				expect(strippedRoot[0]!.content).not.toContainEqual(image);
				expect(reminderText(strippedRoot[0]!)).toContain("edited first steer");
				expect(reminderText(strippedRoot[0]!)).toContain(renderDateCwdReminder("2026-08-14", "/old"));
				const rootBytes = JSON.stringify(strippedRoot);

				const later = steeringMessage(kind, "later steer", 2);
				history.push(later);
				steeringRequest(injector, history, "2026-08-15", "/new");
				later.content = "edited later steer";
				invalidateMessageCache(later);
				const editedLater = steeringRequest(injector, history, "2026-08-15", "/new");
				expect(JSON.stringify(editedLater.slice(0, 1))).toBe(rootBytes);
				expect(reminderText(editedLater[1]!)).toContain("edited later steer");
				expect(reminderText(editedLater[1]!)).toContain(renderDateCwdReminder("2026-08-15", "/new"));

				later.content = [{ type: "text", text: "later image" }, image];
				invalidateMessageCache(later);
				const withImage = steeringRequest(injector, history, "2026-08-15", "/new");
				expect(withImage[1]!.content).toContainEqual(image);
				expect(stripImagesFromMessage(later)).toBe(1);
				const strippedLater = steeringRequest(injector, history, "2026-08-15", "/new");
				expect(JSON.stringify(strippedLater.slice(0, 1))).toBe(rootBytes);
				expect(strippedLater[1]!.content).not.toContainEqual(image);
				expect(reminderText(strippedLater[1]!)).toContain("later image");
				expect(reminderText(strippedLater[1]!)).toContain(renderDateCwdReminder("2026-08-15", "/new"));
				expect(steeringRequest(injector, history, "2026-08-15", "/new")).toEqual(strippedLater);
			});

			it("restores reminders after side requests and tail trimming without growing on replay", () => {
				const injector = new DateCwdReminderInjector();
				const root = steeringMessage(kind, "main history");
				const history: AgentMessage[] = [root, createAssistantMessage("done")];
				const first = steeringRequest(injector, history, "2026-08-14", "/old");
				const firstBytes = JSON.stringify(first);
				const sideHistory: AgentMessage[] = [...history, { role: "user", content: "temporary", timestamp: 2 }];
				const side = steeringRequest(injector, sideHistory, "2026-08-15", "/new");
				expect(JSON.stringify(side.slice(0, 2))).toBe(firstBytes);
				expect(reminderText(side[2]!)).toBe(`${renderDateCwdReminder("2026-08-15", "/new")}\n\ntemporary`);
				const main = steeringRequest(injector, history, "2026-08-15", "/new");
				expect(JSON.stringify(main.slice(0, 2))).toBe(firstBytes);
				expect(main[2]).toMatchObject({ role: "developer", content: renderDateCwdReminder("2026-08-15", "/new") });
				for (let replay = 0; replay < 3; replay++) {
					expect(steeringRequest(injector, sideHistory, "2026-08-15", "/new")).toEqual([...main, side[2]!]);
					expect(steeringRequest(injector, history, "2026-08-15", "/new")).toEqual(main);
				}

				// Removing the developer control's anchor must recover too, not just
				// removing an injected user carrier as the side request did above.
				const trimmed = steeringRequest(injector, [root], "2026-08-15", "/new");
				expect(trimmed[0]).toBe(first[0]);
				expect(trimmed[1]).toMatchObject({
					role: "developer",
					content: renderDateCwdReminder("2026-08-15", "/new"),
				});
				expect(steeringRequest(injector, [root], "2026-08-15", "/new")).toEqual(trimmed);
				expect(steeringRequest(injector, history, "2026-08-15", "/new")).toEqual([...trimmed, first[1]!, main[2]!]);
			});
		});
	}

	it("isolates injectors and resets when an equal-content root is replaced", () => {
		const one = new DateCwdReminderInjector();
		const two = new DateCwdReminderInjector();
		const root = steeringMessage("user", "same content");
		const first = steeringRequest(one, [root], "2026-08-14", "/one");
		const other = steeringRequest(two, [root], "2026-08-15", "/two");
		expect(reminderText(other[0]!)).toContain(renderDateCwdReminder("2026-08-15", "/two"));
		expect(reminderText(other[0]!)).not.toContain(renderDateCwdReminder("2026-08-14", "/one"));
		expect(steeringRequest(one, [root], "2026-08-14", "/one")[0]).toBe(first[0]);
		const replacement = steeringMessage("user", "same content");
		const replaced = steeringRequest(one, [replacement], "2026-08-15", "/new");
		expect(replaced).toHaveLength(1);
		expect(reminderText(replaced[0]!)).toContain(renderDateCwdReminder("2026-08-15", "/new"));
		expect(reminderText(replaced[0]!)).not.toContain(renderDateCwdReminder("2026-08-14", "/one"));
		expect(steeringRequest(one, [replacement], "2026-08-15", "/new")[0]).toBe(replaced[0]);
		expect(steeringRequest(two, [root], "2026-08-15", "/two")[0]).toBe(other[0]);
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
		authStorage.keys.setRuntime(model.provider, "test-key");
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

describe("date/cwd reminders with native replay", () => {
	const date = "2026-08-14";
	const cwd = "/work/native-replay";
	const reminder = renderDateCwdReminder(date, cwd);

	for (const provider of ["codex", "anthropic"] as const) {
		for (const hasLaterUser of [false, true]) {
			it(`${provider} preserves native history and delivers the initial reminder${hasLaterUser ? " with an existing follow-up" : " without a plain user carrier"}`, async () => {
				const injector = new DateCwdReminderInjector();
				const nativeItems = [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserved user" }] },
					{ type: "compaction", encrypted_content: "enc_123" },
				];
				const summary = "## Goal\nAudit the handlers.\n\n## Next Steps\nContinue with chunk 11.";
				const native: UserMessage = {
					role: "user",
					content: `<summary>${summary}</summary>`,
					providerPayload:
						provider === "codex"
							? createOpenAIResponsesHistoryPayload("openai-codex", nativeItems, false)
							: {
									type: "anthropicCompaction",
									provider: "anthropic",
									content: summary,
									signature: "sig_opaque_on_demand",
									filesText: "<files>handlers.ts (Read)</files>",
								},
					timestamp: 1,
				};
				const codex = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.5");
				const anthropic = getBundledModel<"anthropic-messages">("anthropic", "claude-fable-5");
				const history: Message[] = [native];
				if (provider === "anthropic") {
					history.push(
						{
							...createAssistantMessage("Retained answer."),
							model: anthropic.id,
							content: [
								{ type: "thinking", thinking: "Keep this reasoning.", thinkingSignature: "sig_kept" },
								{ type: "text", text: "Retained answer." },
								{ type: "toolCall", id: "read_1", name: "read", arguments: { path: "handlers.ts" } },
							],
							stopReason: "toolUse",
							timestamp: 2,
						},
						{
							role: "toolResult",
							toolCallId: "read_1",
							toolName: "read",
							content: [{ type: "text", text: "retained file contents" }],
							isError: false,
							timestamp: 3,
						},
					);
				}
				if (hasLaterUser) history.push({ role: "user", content: "Existing follow-up", timestamp: 4 });

				async function request() {
					const before = JSON.stringify(history);
					const context = injector.transform({ systemPrompt: ["system"], messages: history }, date, cwd);
					let wire: unknown;
					if (provider === "codex") {
						const body = await buildTransformedCodexRequestBody(codex, context, { responsesLite: false });
						wire = JSON.parse(JSON.stringify(body.input));
					} else {
						await streamAnthropic(anthropic, context, {
							apiKey: "sk-ant-test",
							thinkingEnabled: true,
							client: {
								...(anthropic.baseUrl ? { baseURL: anthropic.baseUrl } : {}),
								messages: {
									create: value => {
										wire = JSON.parse(JSON.stringify(value.messages));
										throw new Error("request captured");
									},
								},
							},
						}).result();
					}
					expect(JSON.stringify(history)).toBe(before);
					if (!Array.isArray(wire)) throw new Error("Expected serialized provider messages");
					expect(JSON.stringify(wire).split(JSON.stringify(reminder).slice(1, -1))).toHaveLength(2);
					if (provider === "codex") {
						expect(wire.slice(0, nativeItems.length)).toEqual(nativeItems);
					} else {
						expect(wire[0]).toMatchObject({
							role: "assistant",
							content: [
								{ type: "compaction", content: summary, signature: "sig_opaque_on_demand" },
								{ type: "thinking", thinking: "Keep this reasoning.", signature: "sig_kept" },
								{ type: "text", text: "Retained answer." },
								{ type: "tool_use", id: "read_1", name: "read", input: { path: "handlers.ts" } },
							],
						});
						expect(wire[1].role).toBe("user");
						const toolResults = wire[1].content as Array<{ type: string; tool_use_id?: string }>;
						expect(
							toolResults.some(block => block.type === "tool_result" && block.tool_use_id === "read_1"),
						).toBe(true);
						expect(JSON.stringify(wire[1])).toContain("retained file contents");
						expect(JSON.stringify(wire)).toContain("<files>handlers.ts (Read)</files>");
					}
					return wire;
				}

				const first = await request();
				expect(await request()).toEqual(first);
				history.push({ role: "user", content: "Appended follow-up", timestamp: 5 });
				const appended = await request();
				expect(JSON.stringify(appended)).toContain("Appended follow-up");
				expect(await request()).toEqual(appended);
			});
		}
	}
});

describe("SDK date/cwd history through image normalization", () => {
	for (const anchor of ["first WebP", "later WebP", "toolResult WebP", "text control"] as const) {
		it(`preserves the serialized A-B-A prefix for ${anchor}`, async () => {
			using tempDir = TempDir.createSync("@pi-date-cwd-images-");
			const model = buildModel({
				id: "reminder-vision",
				name: "Reminder vision",
				api: "ollama-chat",
				provider: "ollama-cloud",
				baseUrl: "https://ollama.com",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 1024,
			});
			// Same valid image seed as image-webp-exclusion.test.ts.
			const seed = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
				"base64",
			);
			const image = {
				type: "image" as const,
				data: Buffer.from(await new Bun.Image(seed).resize(200, 200).webp({ quality: 90 }).bytes()).toBase64(),
				mimeType: "image/webp",
			};
			const root: UserMessage = {
				role: "user",
				content: anchor === "first WebP" ? [{ type: "text", text: "first" }, image] : "first",
				timestamp: 1,
			};
			const history: Message[] = [root];
			if (anchor === "toolResult WebP") {
				history.push(
					{
						...createAssistantMessage(""),
						api: model.api,
						provider: model.provider,
						model: model.id,
						content: [{ type: "toolCall", id: "read_1", name: "read", arguments: { path: "image.webp" } }],
						stopReason: "toolUse",
						timestamp: 2,
					},
					{
						role: "toolResult",
						toolCallId: "read_1",
						toolName: "read",
						content: [image],
						isError: false,
						timestamp: 3,
					},
				);
			}
			const authStorage = createInMemoryAuthStorage();
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
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
			try {
				async function request(cwd: string, requestHistory: Message[] = history) {
					sessionManager.setCwdWithoutRelocation(cwd);
					const sourceBytes = JSON.stringify(requestHistory);
					// Exercise the SDK-installed chain, not a hand-written ordering of transforms.
					const context = await session.buildSideRequestContext(requestHistory, ["system"]);
					for (const message of context.messages) {
						if (typeof message.content === "string") continue;
						for (const part of message.content) {
							if (part.type === "image") expect(part.mimeType).not.toBe("image/webp");
						}
					}
					let wire: Array<{ role: string; content: string; images?: string[] }> | undefined;
					await streamOllama(model, context, {
						apiKey: "test-key",
						fetch: async (_input, init) => {
							wire = JSON.parse(String(init?.body)).messages;
							return new Response(
								'{"message":{"content":"ok"},"done":true,"prompt_eval_count":1,"eval_count":1}\n',
							);
						},
					}).result();
					expect(JSON.stringify(requestHistory)).toBe(sourceBytes);
					if (!wire) throw new Error("Expected Ollama request");
					return wire;
				}

				const cwdA = tempDir.path();
				const cwdB = tempDir.join("moved");
				const first = await request(cwdA);
				const firstBytes = JSON.stringify(first);
				expect(first.find(message => message.role === "user")?.content).toContain(normalizePromptPath(cwdA));
				expect(await request(cwdA)).toEqual(first);
				let detached: { history: Message[]; bytes: string } | undefined;
				if (anchor === "text control") {
					// A public side request may use a distinct root with identical content.
					// It must neither inherit A nor discard the main history's ownership.
					const sideHistory: Message[] = [structuredClone(root)];
					const side = await request(cwdB, sideHistory);
					const sideUser = side.find(message => message.role === "user");
					expect(sideUser?.content).toContain(`current working directory: '${normalizePromptPath(cwdB)}'`);
					expect(sideUser?.content).not.toContain(`current working directory: '${normalizePromptPath(cwdA)}'`);
					detached = { history: sideHistory, bytes: JSON.stringify(side) };
				}
				if (anchor === "later WebP") {
					history.push({ role: "user", content: [{ type: "text", text: "later" }, image], timestamp: 4 });
				}
				const changed = await request(cwdB);
				expect(JSON.stringify(changed.slice(0, first.length))).toBe(firstBytes);
				expect(changed.at(-1)?.content).toContain(normalizePromptPath(cwdB));
				const changedBytes = JSON.stringify(changed);
				expect(await request(cwdB)).toEqual(changed);
				if (detached) {
					expect(JSON.stringify(await request(cwdB, detached.history))).toBe(detached.bytes);
				}
				const back = await request(cwdA);
				expect(JSON.stringify(back.slice(0, changed.length))).toBe(changedBytes);
				expect(back.at(-1)?.content).toContain(normalizePromptPath(cwdA));
				expect(await request(cwdA)).toEqual(back);
				if (anchor !== "text control") {
					const images = back.flatMap(message => message.images ?? []);
					expect(images).toHaveLength(1);
					expect(Buffer.from(images[0]!, "base64").subarray(8, 12).toString()).not.toBe("WEBP");
				}
			} finally {
				await session.dispose();
				authStorage.close();
			}
		});
	}
});

describe("SDK reminder stability with secret redaction", () => {
	for (const consumer of ["side", "advisor"] as const) {
		it(`keeps ${consumer} requests redacted without rewriting the historical reminder`, async () => {
			using tempDir = TempDir.createSync("@pi-date-cwd-secrets-");
			const secret = "REMINDER_PRIVATE_TOKEN_12345";
			await Bun.write(tempDir.join(".omp/secrets.yml"), `- type: plain\n  content: ${secret}\n`);
			const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					requests.push((await request.json()) as (typeof requests)[number]);
					return new Response('{"message":{"content":"ok"},"done":true,"prompt_eval_count":1,"eval_count":1}\n');
				},
			});
			const authStorage = createInMemoryAuthStorage();
			const model = buildModel({
				id: "reminder-secrets",
				name: "Reminder secrets",
				api: "ollama-chat",
				provider: "ollama-cloud",
				baseUrl: server.url.href,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 1024,
			});
			authStorage.keys.setRuntime(model.provider, "test-key");
			authStorage.keys.setRuntime("anthropic", "test-key");
			const sessionManager = SessionManager.inMemory(tempDir.path());
			let session: AgentSession | undefined;
			try {
				({ session } = await createAgentSession({
					cwd: tempDir.path(),
					agentDir: tempDir.join("agent"),
					sessionManager,
					authStorage,
					modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
					settings: Settings.isolated({ "compaction.enabled": false, "secrets.enabled": true }),
					model,
					toolNames: [],
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
				}));
				const cwdA = normalizePromptPath(tempDir.path());
				const cwdB = normalizePromptPath(tempDir.join("moved"));
				let agent = session.agent;
				if (consumer === "advisor") {
					session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
					expect(session.setAdvisorEnabled(true)).toBe(true);
					const advisor = session.getAdvisorAgent();
					if (!advisor) throw new Error("Expected live advisor");
					advisor.setModel(model);
					agent = advisor;
				}
				await agent.prompt(`Historical question ${secret}`);
				expect(requests).toHaveLength(1);
				const first = requests[0]!.messages;
				const firstBytes = JSON.stringify(first);
				expect(first.find(message => message.role === "user")?.content).toContain(cwdA);
				sessionManager.setCwdWithoutRelocation(tempDir.join("moved"));
				if (consumer === "side") {
					const messageCountBeforeSide = session.messages.length;
					await session.runEphemeralTurn({ promptText: `Temporary side question ${secret}` });
					expect(session.messages).toHaveLength(messageCountBeforeSide);
					expect(JSON.stringify(session.messages)).not.toContain("Temporary side question");
					expect(requests).toHaveLength(2);
					expect(JSON.stringify(requests[1]!.messages.slice(0, first.length))).toBe(firstBytes);
					expect(requests[1]!.messages.at(-1)?.content).toContain(cwdB);
				}
				await agent.prompt(`Follow-up question ${secret}`);
				expect(requests).toHaveLength(consumer === "side" ? 3 : 2);
				const resumed = requests.at(-1)!.messages;
				expect(JSON.stringify(resumed.slice(0, first.length))).toBe(firstBytes);
				expect(resumed.at(-1)?.content).toContain(cwdB);
				expect(JSON.stringify(resumed)).not.toContain("Temporary side question");
				const placeholder = session.obfuscator?.obfuscate(secret);
				if (!placeholder || placeholder === secret) throw new Error("Expected configured secret obfuscation");
				for (const request of requests) {
					expect(JSON.stringify(request)).not.toContain(secret);
					expect(JSON.stringify(request.messages)).toContain(placeholder);
				}
				expect(JSON.stringify(agent.state.messages)).toContain(secret);
			} finally {
				await session?.dispose();
				authStorage.close();
				await server.stop(true);
			}
		});
	}
});
