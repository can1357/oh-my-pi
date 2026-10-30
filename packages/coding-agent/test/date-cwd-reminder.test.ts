import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { Api, AssistantMessage, Context, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	DateCwdReminderInjector,
	isDateCwdReminderControl,
	renderDateCwdReminder,
} from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatLocalCalendarDate } from "@oh-my-pi/pi-tui/chrome/local-date";
import { normalizePromptPath } from "@oh-my-pi/pi-coding-agent/utils/prompt-path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

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

		it("keeps the reminders of turns a compaction retains when the first user turn changes", () => {
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const kept: Message = { role: "user", content: "kept", timestamp: 2 };
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
			const summary: Message = { role: "user", content: "summary", timestamp: 3 };
			const after = injector.transform(
				{ systemPrompt: ["system"], messages: [summary, kept, toolTurn] },
				"2026-08-14",
				"/new",
			);

			// The retained tail is sent exactly as before; only the new summary gets the current reminder.
			expect(after.messages.slice(1)).toEqual([kept, toolTurn, control]);
			expect(after.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-14", "/new")}\n\nsummary`);
		});

		it("appends a changed reminder when each request carries new copies of the earlier turns", () => {
			// Context hooks and secret obfuscation hand over equal but newly allocated messages per request.
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			const first = injector.transform({ systemPrompt: ["system"], messages: [firstUser] }, "2026-08-14", "/work");

			const secondUser: Message = { role: "user", content: "second", timestamp: 2 };
			const second = injector.transform(
				{
					systemPrompt: ["system"],
					messages: [structuredClone(firstUser), createAssistantMessage("done"), secondUser],
				},
				"2026-08-15",
				"/work",
			);

			expect(second.messages[0]?.content).toBe(first.messages[0]!.content);
			expect(second.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work")}\n\nsecond`);
		});

		it("keeps a mid-loop reminder behind its anchor when the turns are copied again", () => {
			const injector = new DateCwdReminderInjector();
			const user: Message = { role: "user", content: "first", timestamp: 1 };
			const toolResult = (id: string, timestamp: number): Message => ({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: id }],
				isError: false,
				timestamp,
			});
			const history: Message[] = [user, createAssistantMessage("call 1"), toolResult("call-1", 2)];
			injector.transform({ systemPrompt: ["system"], messages: [user] }, "2026-08-14", "/work");
			// The date rolls over between tool continuations: no new user turn exists, so a control follows the tail.
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: structuredClone(history) },
				"2026-08-15",
				"/work",
			);
			const next = injector.transform(
				{
					systemPrompt: ["system"],
					messages: structuredClone([...history, createAssistantMessage("call 2"), toolResult("call-2", 3)]),
				},
				"2026-08-15",
				"/work",
			);

			const wire = (messages: Message[]) => messages.map(message => JSON.stringify([message.role, message.content]));
			expect(wire(next.messages).slice(0, rolled.messages.length)).toEqual(wire(rolled.messages));
			expect(wire(rolled.messages).at(-1)).toBe(
				JSON.stringify(["developer", renderDateCwdReminder("2026-08-15", "/work")]),
			);
			expect(next.messages).toHaveLength(rolled.messages.length + 2);
		});

		it("gives the newest of two identical same-millisecond turns the changed reminder", () => {
			// Programmatic steering can append a user turn byte-identical to an earlier one
			// within the same millisecond; the two must not share one reminder.
			const injector = new DateCwdReminderInjector();
			const user: Message = { role: "user", content: "ok", timestamp: 1 };
			const assistant = createAssistantMessage("a");
			injector.transform({ systemPrompt: ["system"], messages: [user] }, "2026-08-14", "/work");
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: structuredClone([user, assistant, user]) },
				"2026-08-15",
				"/work",
			);

			expect(rolled.messages.map(message => message.content)).toEqual([
				`${renderDateCwdReminder("2026-08-14", "/work")}\n\nok`,
				assistant.content,
				`${renderDateCwdReminder("2026-08-15", "/work")}\n\nok`,
			]);
		});

		it("keeps the first reminder when the first turn's content is rewritten in place", () => {
			// Secret obfuscation re-renders an earlier turn once it learns a new secret.
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "token abc", timestamp: 1 };
			injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/work");
			const redacted: Message = { role: "user", content: "token [redacted]", timestamp: 1 };
			const next: Message = { role: "user", content: "second", timestamp: 4 };
			const out = injector.transform(
				{ systemPrompt: ["system"], messages: [redacted, createAssistantMessage("a"), next] },
				"2026-08-15",
				"/work",
			);

			expect(out.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-14", "/work")}\n\ntoken [redacted]`);
			expect(out.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work")}\n\nsecond`);
		});

		it("keeps a mid-loop reminder when its anchoring tool result is re-rendered", () => {
			// Image clamps and inline-snapshot transforms rewrite a tool result's content
			// between requests; the reminder already sent must stay where it was.
			const injector = new DateCwdReminderInjector();
			const user: Message = { role: "user", content: "first", timestamp: 1 };
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "FULL OUTPUT" }],
				isError: false,
				timestamp: 2,
			};
			injector.transform({ systemPrompt: ["system"], messages: [user] }, "2026-08-14", "/work");
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: [user, createAssistantMessage("call"), toolResult] },
				"2026-08-15",
				"/work",
			);
			const truncated: Message = { ...toolResult, content: [{ type: "text", text: "TRUNCATED" }] };
			const next = injector.transform(
				{
					systemPrompt: ["system"],
					messages: [user, createAssistantMessage("call"), truncated, createAssistantMessage("call 2")],
				},
				"2026-08-15",
				"/work",
			);

			const sent = rolled.messages.at(-1)!;
			expect([sent.role, sent.content]).toEqual(["developer", renderDateCwdReminder("2026-08-15", "/work")]);
			expect([next.messages[3]?.role, next.messages[3]?.content]).toEqual([sent.role, sent.content]);
			expect(isDateCwdReminderControl(next.messages[3]!)).toBe(true);
		});

		it("keeps a later turn's reminder when that turn's content is rewritten", () => {
			// Secret obfuscation re-renders any earlier turn once it learns a new secret.
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const second: Message = { role: "user", content: "token abc", timestamp: 2 };
			injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/work");
			injector.transform(
				{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), second] },
				"2026-08-15",
				"/work",
			);
			const redacted: Message = { ...second, content: "token [redacted]" };
			const out = injector.transform(
				{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), redacted] },
				"2026-08-15",
				"/work",
			);

			expect(out.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work")}\n\ntoken [redacted]`);
		});

		it("keeps a retained turn's reminder when a compaction drops an identical same-millisecond turn", () => {
			const injector = new DateCwdReminderInjector();
			const user: Message = { role: "user", content: "ok", timestamp: 1 };
			const assistant = createAssistantMessage("a");
			injector.transform({ systemPrompt: ["system"], messages: [user] }, "2026-08-14", "/work");
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: structuredClone([user, assistant, user]) },
				"2026-08-15",
				"/work",
			);
			// A compaction replaces the first turn and the assistant reply with a summary.
			const summary: Message = { role: "user", content: "summary", timestamp: 3 };
			const after = injector.transform(
				{ systemPrompt: ["system"], messages: [summary, structuredClone(user)] },
				"2026-08-15",
				"/work",
			);

			expect(after.messages[1]?.content).toBe(rolled.messages[2]!.content);
			expect(after.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work")}\n\nsummary`);
		});

		it("drops a mid-loop reminder when a compaction drops the turn it was anchored to", () => {
			const injector = new DateCwdReminderInjector();
			const toolResult = (text: string): Message => ({
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 2,
			});
			const user: Message = { role: "user", content: "first", timestamp: 1 };
			const second = createAssistantMessage("b");
			injector.transform({ systemPrompt: ["system"], messages: [user] }, "2026-08-14", "/work");
			// The date rolls over mid tool loop: the reminder follows the first result.
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: [user, createAssistantMessage("a"), toolResult("one")] },
				"2026-08-15",
				"/work",
			);
			expect(rolled.messages.at(-1)?.role).toBe("developer");
			injector.transform(
				{
					systemPrompt: ["system"],
					messages: [user, createAssistantMessage("a"), toolResult("one"), second, toolResult("two")],
				},
				"2026-08-15",
				"/work",
			);
			// A compaction drops everything up to the second result, which never had
			// the reminder behind it; it must not inherit it from the dropped result.
			const summary: Message = { role: "user", content: "summary", timestamp: 3 };
			const after = injector.transform(
				{ systemPrompt: ["system"], messages: [summary, second, toolResult("two")] },
				"2026-08-15",
				"/work",
			);

			expect(after.messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult"]);
		});

		it("keeps a turn's reminder when a later same-millisecond turn is not resent", () => {
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const steer: Message = { role: "user", content: "go", timestamp: 5 };
			injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/work");
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), steer] },
				"2026-08-15",
				"/work",
			);
			injector.transform(
				{
					systemPrompt: ["system"],
					messages: [
						first,
						createAssistantMessage("a"),
						steer,
						createAssistantMessage("b"),
						structuredClone(steer),
					],
				},
				"2026-08-15",
				"/work",
			);
			// The last turn is aborted and never resent; the earlier one keeps its bytes.
			const after = injector.transform(
				{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), steer] },
				"2026-08-15",
				"/work",
			);

			expect(after.messages[2]?.content).toBe(rolled.messages[2]!.content);
			expect(after.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work")}\n\ngo`);
		});

		it("keeps the main conversation's bytes when another conversation's request runs between two of its own", () => {
			// A side request can send a history of its own through the main loop's transform.
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const main = injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/work");
			// The clock crosses midnight, and the advisor asks its own question.
			const advisorTurn: Message = { role: "user", content: "review the turn", timestamp: 10 };
			const advisor = injector.transform(
				{ systemPrompt: ["advisor"], messages: [advisorTurn] },
				"2026-08-15",
				"/work",
			);
			const next: Message = { role: "user", content: "second", timestamp: 20 };
			const after = injector.transform(
				{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), next] },
				"2026-08-15",
				"/work",
			);

			expect(advisor.messages[0]?.content).toBe(
				`${renderDateCwdReminder("2026-08-15", "/work")}\n\nreview the turn`,
			);
			expect(after.messages[0]?.content).toBe(main.messages[0]!.content);
			expect(after.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-14", "/work")}\n\nfirst`);
			expect(after.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work")}\n\nsecond`);
		});

		it("keeps a compaction's retained turns when another conversation's request came in between", () => {
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const kept: Message = { role: "user", content: "kept", timestamp: 2 };
			injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/work");
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), kept] },
				"2026-08-15",
				"/work",
			);
			// A side request with a history of its own runs before the compaction's first request.
			injector.transform(
				{ systemPrompt: ["advisor"], messages: [{ role: "user", content: "review", timestamp: 10 }] },
				"2026-08-15",
				"/work",
			);
			const summary: Message = { role: "user", content: "summary", timestamp: 20 };
			const after = injector.transform(
				{ systemPrompt: ["system"], messages: [summary, kept, createAssistantMessage("b")] },
				"2026-08-15",
				"/work",
			);

			expect(after.messages[1]?.content).toBe(rolled.messages[2]!.content);
			expect(after.messages[1]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work")}\n\nkept`);
		});

		// A context hook (superpowers' bootstrap) inserts its own first message, built afresh and
		// stamped `Date.now()`, on every request until the run ends.
		for (const { advisor: advisorRequests, label } of [
			{ advisor: "none", label: "" },
			// The side request's state sits between the main conversation's: the predecessor is not the newest state.
			{ advisor: "every", label: " with a side request before each request" },
			// The side request's state ages behind ten main requests, more than the injector keeps conversations for.
			{ advisor: "once", label: " with one side request ten requests back" },
		] as const) {
			it(`keeps a first turn a context hook re-creates under a new timestamp${label}`, () => {
				const injector = new DateCwdReminderInjector();
				const wire = (messages: Message[]) =>
					messages.map(message => JSON.stringify([message.role, message.content]));
				let stamp = 1000;
				const task: Message = { role: "user", content: "task", timestamp: 1 };
				const advisorTurn: Message = { role: "user", content: "review the turn", timestamp: 2 };
				const history: Message[] = [task];
				const main = (date: string) =>
					injector.transform(
						{
							systemPrompt: ["system"],
							messages: [{ role: "user", content: "BOOTSTRAP", timestamp: stamp++ }, ...history],
						},
						date,
						"/work",
					);
				const advisor = (date: string) =>
					injector.transform({ systemPrompt: ["advisor"], messages: [advisorTurn] }, date, "/work");
				const sent: string[][] = [];
				let firstAdvisor: Context | undefined;
				for (let request = 0; request < 10; request++) {
					if (advisorRequests === "every" || (advisorRequests === "once" && request === 0)) {
						const out = advisor("2026-08-14");
						firstAdvisor ??= out;
					}
					sent.push(wire(main("2026-08-14").messages));
					history.push(createAssistantMessage(`call ${request}`), {
						role: "toolResult",
						toolCallId: `call-${request}`,
						toolName: "read",
						content: [{ type: "text", text: `result ${request}` }],
						isError: false,
						timestamp: 10 + request,
					});
				}
				const rolledAdvisor = advisorRequests === "none" ? undefined : advisor("2026-08-15");
				sent.push(wire(main("2026-08-15").messages));
				history.push(createAssistantMessage("call last"));
				sent.push(wire(main("2026-08-15").messages));

				for (let request = 1; request < sent.length; request++) {
					expect(sent[request]!.slice(0, sent[request - 1]!.length)).toEqual(sent[request - 1]!);
				}
				expect(sent[0]![0]).toBe(
					JSON.stringify(["user", `${renderDateCwdReminder("2026-08-14", "/work")}\n\nBOOTSTRAP`]),
				);
				const control = JSON.stringify(["developer", renderDateCwdReminder("2026-08-15", "/work")]);
				expect(sent.at(-2)!.at(-1)).toBe(control);
				expect(sent.at(-1)!.filter(message => message === control)).toHaveLength(1);
				if (rolledAdvisor) expect(rolledAdvisor.messages[0]?.content).toBe(firstAdvisor!.messages[0]!.content);
			});
		}

		for (const recreated of [false, true]) {
			it(`tells the model the new date again when a request leaves out the turn that carried it${recreated ? " under a re-created first turn" : ""}`, () => {
				// A side request (/btw) appends its own question to the history; the question takes the new
				// date, and the next main request does not resend it.
				const injector = new DateCwdReminderInjector();
				let stamp = 1000;
				const head = (): Message[] =>
					recreated ? [{ role: "user", content: "BOOTSTRAP", timestamp: stamp++ }] : [];
				const task: Message = { role: "user", content: "task", timestamp: 1 };
				const assistant = createAssistantMessage("call 1");
				const toolResult: Message = {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "result" }],
					isError: false,
					timestamp: 3,
				};
				const question: Message = { role: "user", content: "side question", timestamp: 50 };
				injector.transform({ systemPrompt: ["system"], messages: [...head(), task] }, "2026-08-14", "/work");
				const side = injector.transform(
					{ systemPrompt: ["system"], messages: [...head(), task, assistant, toolResult, question] },
					"2026-08-15",
					"/work",
				);
				const main = injector.transform(
					{ systemPrompt: ["system"], messages: [...head(), task, assistant, toolResult] },
					"2026-08-15",
					"/work",
				);

				const newDate = renderDateCwdReminder("2026-08-15", "/work");
				expect(side.messages.at(-1)?.content).toBe(`${newDate}\n\nside question`);
				expect(JSON.stringify([main.messages.at(-1)?.role, main.messages.at(-1)?.content])).toBe(
					JSON.stringify(["developer", newDate]),
				);
			});
		}

		it("leaves a re-created turn after a compaction summary unchanged when the date rolls over", () => {
			// The same hook inserts its bootstrap behind the summary, ahead of the turns that follow it,
			// so it is not the first user turn.
			const injector = new DateCwdReminderInjector();
			const wire = (messages: Message[]) => messages.map(message => JSON.stringify([message.role, message.content]));
			const summary: Message = { role: "user", content: "summary", timestamp: 5 };
			const prompt: Message = { role: "user", content: "next step", timestamp: 6 };
			const bootstrap = (timestamp: number): Message => ({ role: "user", content: "BOOTSTRAP", timestamp });
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 7,
			};
			const assistant = createAssistantMessage("call 1");
			const first = injector.transform(
				{ systemPrompt: ["system"], messages: [summary, bootstrap(1000), prompt] },
				"2026-08-14",
				"/work",
			);
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: [summary, bootstrap(1001), prompt, assistant, toolResult] },
				"2026-08-15",
				"/work",
			);

			expect(wire(rolled.messages).slice(0, first.messages.length)).toEqual(wire(first.messages));
			expect(rolled.messages[1]?.content).toBe("BOOTSTRAP");
			expect(wire(rolled.messages).at(-1)).toBe(
				JSON.stringify(["developer", renderDateCwdReminder("2026-08-15", "/work")]),
			);
		});

		it("tells the model the date again after a branch back to before the turn that carried it", () => {
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const assistant = createAssistantMessage("a");
			injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/work");
			const carrier: Message = { role: "user", content: "second", timestamp: 20 };
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: [first, assistant, carrier] },
				"2026-08-15",
				"/work",
			);
			// `/branch` back to before `second`: the new turn replaces it.
			const replacement: Message = { role: "user", content: "instead", timestamp: 30 };
			const branched = injector.transform(
				{ systemPrompt: ["system"], messages: [first, assistant, replacement] },
				"2026-08-15",
				"/work",
			);

			const newDate = renderDateCwdReminder("2026-08-15", "/work");
			expect(rolled.messages[2]?.content).toBe(`${newDate}\n\nsecond`);
			expect(branched.messages[0]?.content).toBe(rolled.messages[0]!.content);
			expect(branched.messages[2]?.content).toBe(`${newDate}\n\ninstead`);
		});

		it("continues a compacted fork from its own state, not from the fork used last", () => {
			// Two forks share the turns before their branch point. Each is compacted, and the
			// user returns to the first fork and compacts it again before its next request.
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const shared: Message = { role: "user", content: "shared", timestamp: 3 };
			const forkTurn: Message = { role: "user", content: "fork turn", timestamp: 5 };
			const assistant = createAssistantMessage("a");
			const forkAssistant = createAssistantMessage("b");
			injector.transform({ systemPrompt: ["system"], messages: [first, assistant, shared] }, "2026-08-14", "/work");
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: [first, assistant, shared, forkAssistant, forkTurn] },
				"2026-08-15",
				"/work",
			);
			const compacted = (summary: string, timestamp: number, tail: Message[]) =>
				injector.transform(
					{ systemPrompt: ["system"], messages: [{ role: "user", content: summary, timestamp }, ...tail] },
					"2026-08-15",
					"/work",
				);
			compacted("fork one summary", 10, [shared, forkAssistant, forkTurn]);
			// The other fork, branched after `shared`, is compacted and used.
			compacted("fork two summary", 11, [shared, { role: "user", content: "other fork", timestamp: 7 }]);
			const again = compacted("fork one summary again", 20, [shared, forkAssistant, forkTurn]);

			expect(rolled.messages[4]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work")}\n\nfork turn`);
			expect(again.messages[3]?.content).toBe(rolled.messages[4]!.content);
		});
	});
});

describe("date-cwd reminder on the provider wire", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	afterEach(async () => {
		// Restore the clock here, not only in each test's `finally`: an aborted test would
		// otherwise leave every later test file running at the faked date.
		setSystemTime();
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
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			toolNames: ["read"],
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

	// Both producers hand the reminder injector new copies of every earlier turn on each request.
	for (const { producer, change } of [
		{ producer: "a context hook", change: "date" },
		{ producer: "a context hook", change: "cwd" },
		{ producer: "secret obfuscation", change: "date" },
	] as const) {
		it(`keeps the first user turn byte-identical when the ${change} changes under ${producer}`, async () => {
			using tempDir = TempDir.createSync("@pi-date-cwd-reminder-");
			const secret = "s3cret-rollover-token";
			await Bun.write(
				tempDir.join("secrets.yml"),
				`- type: plain\n  content: ${secret}\n  mode: replace\n  replacement: "[redacted]"\n`,
			);
			const api = "test-date-cwd-reminder-copies";
			const contexts: Context[] = [];
			registerCustomApi(api, (_model, context) => {
				contexts.push(context);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			});
			const model = buildModel({
				id: "date-cwd-reminder-copies",
				name: "Date cwd reminder copies",
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
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const contextHook: ExtensionFactory = pi => {
				pi.on("context", () => undefined);
			};
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"secrets.enabled": producer === "secret obfuscation",
				}),
				model,
				disableExtensionDiscovery: true,
				extensions: producer === "a context hook" ? [contextHook] : [],
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

			setSystemTime(new Date(2026, 7, 14, 23, 59));
			try {
				await session.sendUserMessage(`first ${secret}`);
				let cwd = tempDir.path();
				if (change === "date") {
					setSystemTime(new Date(2026, 7, 15, 0, 1));
				} else {
					cwd = tempDir.join("moved");
					sessionManager.setCwdWithoutRelocation(cwd);
				}
				await session.sendUserMessage("second");

				expect(contexts).toHaveLength(2);
				const wire = contexts.map(context =>
					context.messages.map(message => JSON.stringify([message.role, message.content])),
				);
				if (producer === "secret obfuscation") expect(wire[0]![0]).not.toContain(secret);
				// The turns the provider already saw are resent byte-for-byte; the new value rides on the new turn.
				expect(wire[1]!.slice(0, wire[0]!.length)).toEqual(wire[0]!);
				const date = change === "date" ? "2026-08-15" : "2026-08-14";
				expect(contexts[1]!.messages.at(-1)?.content).toEqual([
					{ type: "text", text: renderDateCwdReminder(date, normalizePromptPath(cwd)) },
					{ type: "text", text: "second" },
				]);
			} finally {
				setSystemTime();
				authStorage.close();
			}
		});
	}

	it("keeps a first message a context hook re-creates on every request byte-identical when the date rolls over mid-run", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-");
		await Bun.write(tempDir.join("notes.txt"), "notes");
		const api = "test-date-cwd-reminder-recreated";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			const request = contexts.length;
			queueMicrotask(() => {
				if (request < 4) {
					// The run crosses midnight between tool continuations.
					if (request === 2) setSystemTime(new Date(2026, 7, 15, 0, 1));
					const toolCall = {
						type: "toolCall" as const,
						id: `read-${request}`,
						name: "read",
						arguments: { path: "notes.txt" },
					};
					const message: AssistantMessage = {
						...createAssistantMessage(""),
						content: [toolCall],
						stopReason: "toolUse",
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				}
			});
			return stream;
		});
		const model = buildModel({
			id: "date-cwd-reminder-recreated",
			name: "Date cwd reminder recreated",
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
		// superpowers' pi extension: its bootstrap goes first, built afresh and stamped per request.
		let stamp = 1_000_000;
		const bootstrapHook: ExtensionFactory = pi => {
			pi.on("context", event => ({
				messages: [
					{ role: "user", content: [{ type: "text", text: "BOOTSTRAP" }], timestamp: stamp++ },
					...event.messages,
				],
			}));
		};
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			extensions: [bootstrapHook],
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

		setSystemTime(new Date(2026, 7, 14, 23, 59));
		try {
			await session.sendUserMessage("first");
			await session.waitForIdle();

			expect(contexts).toHaveLength(4);
			const wire = contexts.map(context =>
				context.messages.map(message => JSON.stringify([message.role, message.content])),
			);
			expect(wire[0]![0]).toContain("BOOTSTRAP");
			// Bytes the provider already saw stay put on every later request; the new date is appended once.
			for (let request = 1; request < wire.length; request++) {
				expect(wire[request]!.slice(0, wire[request - 1]!.length)).toEqual(wire[request - 1]!);
			}
			const reminder = JSON.stringify([
				"developer",
				renderDateCwdReminder("2026-08-15", normalizePromptPath(tempDir.path())),
			]);
			expect(wire[2]!.at(-1)).toBe(reminder);
			expect(wire[3]!.filter(message => message === reminder)).toHaveLength(1);
		} finally {
			setSystemTime();
			authStorage.close();
		}
	});
});
