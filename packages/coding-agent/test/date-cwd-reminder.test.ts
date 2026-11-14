import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction";
import type { Api, AssistantMessage, Context, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { isPerCallContextMessage, markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	createSessionDateCwdReminderJournal,
	DateCwdReminderInjector,
	type DateCwdReminderJournal,
	type DateCwdReminderPlacement,
	isDateCwdReminderControl,
	renderDateCwdReminder,
} from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatLocalCalendarDate } from "@oh-my-pi/pi-tui/chrome/local-date";
import { normalizePromptPath } from "@oh-my-pi/pi-coding-agent/utils/prompt-path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { becomesCollectible } from "../../tui/test/gc";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** Flatten a turn's text so reminder bytes can be matched regardless of part shape. */
function reminderText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap(part => (part.type === "text" ? part.text : [])).join("\n");
}

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

		it("admits the replay memo on the second identical preparation, not the first", () => {
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			const context: Context = { systemPrompt: ["system"], messages: [firstUser] };

			// The first preparation is a miss: it builds the wire once and hands
			// back the array it allocated, snapshotting nothing.
			const first = injector.transform(context, "2026-08-14", "/work/omp");
			// The identical repeat is what admits the layout, so every later
			// preparation reuses it instead of re-running the per-message work.
			const second = injector.transform(context, "2026-08-14", "/work/omp");
			const third = injector.transform(context, "2026-08-14", "/work/omp");

			// Nothing is re-injected: the injected turn is the same object on
			// every preparation...
			expect(second.messages[0]).toBe(first.messages[0]);
			expect(third.messages[0]).toBe(first.messages[0]);
			// ...while each request still gets an array of its own.
			expect(second.messages).not.toBe(first.messages);
			expect(third.messages).not.toBe(second.messages);
			expect(third.messages).not.toBe(context.messages);
		});

		it("drops the admitted memo when an ordinary turn grows past it instead of pinning it", async () => {
			// Contract: once an ordinary turn appends messages, the admitted memo
			// can never hit again, so the miss must release both O(n) arrays —
			// not keep the old transcript reachable until an identical rebuild
			// happens along. The sentinel below sits mid-transcript and is never
			// injected, so only the memo's `refs` (and the O(1) boundary
			// signature's endpoints, which it is not) pins it; after the growing
			// turn plus a full GC it must be collectable.
			function buildAdmittedSentinel(): {
				ref: WeakRef<Message>;
				injector: DateCwdReminderInjector;
				messages: () => Message[];
			} {
				const injector = new DateCwdReminderInjector();
				const first: Message = { role: "user", content: "first", timestamp: 1 };
				const sentinel: Message = { role: "user", content: "sentinel-mid", timestamp: 2 };
				const last: Message = { role: "user", content: "last", timestamp: 3 };
				const context: Context = { systemPrompt: ["system"], messages: [first, sentinel, last] };
				injector.transform(context, "2026-08-14", "/work/omp");
				injector.transform({ ...context, messages: [...context.messages] }, "2026-08-14", "/work/omp");
				return {
					ref: new WeakRef(sentinel),
					injector,
					// The growing turn keeps the endpoints (the builder's closure
					// holds them) and hands the sentinel to no one: only the memo
					// could still reach it.
					messages: () => [first, last, { role: "user", content: "appended", timestamp: 4 }],
				};
			}
			const { ref, injector, messages } = buildAdmittedSentinel();
			// The next ordinary turn grows the transcript: the memo misses, and
			// the miss must clear it rather than leave it pinning the old arrays.
			const grown = injector.transform(
				{ systemPrompt: ["system"], messages: messages() },
				"2026-08-14",
				"/work/omp",
			);
			expect(grown.messages).toHaveLength(3);
			// Drop the frame's strong hold on the grown wire (its injected root
			// is a fresh object, but the endpoints ride it) so only the memo —
			// were it still admitted — could keep the sentinel alive.
			grown.messages.length = 0;
			expect(await becomesCollectible(ref, 2_000)).toBe(true);
			// Liveness anchor: the injector must stay alive across the probe
			// (otherwise the sentinel frees vacuously with its owner), so it is
			// used again here — and it must still serve fresh transforms after.
			const freshUser: Message = { role: "user", content: "fresh", timestamp: 5 };
			const post = injector.transform(
				{ systemPrompt: ["system"], messages: [freshUser] },
				"2026-08-14",
				"/work/omp",
			);
			expect(post.messages[0]).not.toBe(freshUser);
		});

		it("stops admitting a memo from a wire whose interior is rebuilt on every preparation", async () => {
			// Contract: a provider transform that recreates the interior tool
			// results (snapcompact.toolResults on a vision model) rebuilds the
			// wire on every preparation while the first and last messages keep
			// their identity. The boundary signature cannot see that, so the
			// memo admitted from such a wire is never replayed: the admission
			// only pays the two O(n) copies it costs, on exactly the long
			// transcript path this injector exists to keep clean. The injector
			// must notice the rebuilt interior and stop admitting from it.
			const injector = new DateCwdReminderInjector();
			const root: Message = { role: "user", content: "root", timestamp: 1 };
			const last: Message = { role: "user", content: "last", timestamp: 3 };
			// The interior is a fresh object on every preparation; the boundary
			// messages are the same objects throughout.
			const prepare = (): { ref: WeakRef<Message>; messages: Message[] } => {
				const interior: Message = {
					role: "toolResult",
					toolCallId: "call-rebuilt",
					toolName: "test_tool",
					content: [{ type: "text", text: "rebuilt" }],
					isError: false,
					timestamp: 2,
				};
				return { ref: new WeakRef(interior), messages: [root, interior, last] };
			};
			const build = (wire: Message[]): void => {
				injector.transform({ systemPrompt: ["system"], messages: wire }, "2026-08-14", "/work/omp");
			};
			// The first preparation records the boundary signature, the second
			// admits the memo, the third finds the interior rebuilt.
			build(prepare().messages);
			build(prepare().messages);
			build(prepare().messages);
			// The fourth preparation must not admit again: the memo it would
			// admit is never replayable, so it would only pay its copies.
			const fourth = prepare();
			const out = injector.transform(
				{ systemPrompt: ["system"], messages: fourth.messages },
				"2026-08-14",
				"/work/omp",
			);
			// Drop the frame's strong holds (the wire and the built output) so
			// only an admitted memo could keep the interior alive.
			fourth.messages.length = 0;
			out.messages.length = 0;
			expect(await becomesCollectible(fourth.ref, 2_000)).toBe(true);
			// Liveness anchor: the injector must stay alive across the probe
			// (otherwise the interior frees vacuously with its owner), so it is
			// used again here — and it must still serve fresh transforms after.
			const freshUser: Message = { role: "user", content: "fresh", timestamp: 4 };
			const post = injector.transform(
				{ systemPrompt: ["system"], messages: [freshUser] },
				"2026-08-14",
				"/work/omp",
			);
			expect(post.messages[0]).not.toBe(freshUser);
		});

		it("releases the admitted memo when the agent commits the turn", async () => {
			// Contract: a retry prepares the same request twice and admits the
			// memo, then the turn commits through `Agent.appendMessage()` —
			// which grows the history without replacing it. The memo can never
			// be replayed after that, and it pins the whole provider wire, so
			// the agent must release it when the transcript grows instead of
			// holding it until the next request.
			const injector = new DateCwdReminderInjector();
			const agent = new Agent({ onHistoryChanged: () => injector.release() });
			// The wire holds one turn that is never injected, so only the memo
			// can keep it reachable.
			const buildWire = (): { ref: WeakRef<Message>; messages: Message[] } => {
				const root: Message = { role: "user", content: "root", timestamp: 1 };
				const interior: Message = {
					role: "toolResult",
					toolCallId: "call-interior",
					toolName: "test_tool",
					content: [{ type: "text", text: "interior" }],
					isError: false,
					timestamp: 2,
				};
				return { ref: new WeakRef(interior), messages: [root, interior] };
			};
			const wire = buildWire();
			// Two identical preparations admit the memo over this wire.
			injector.transform({ systemPrompt: ["system"], messages: wire.messages }, "2026-08-14", "/work/omp");
			injector.transform({ systemPrompt: ["system"], messages: [...wire.messages] }, "2026-08-14", "/work/omp");
			// The turn commits: the assistant message is appended to the
			// transcript, which grows the history the memo was pinned to.
			agent.appendMessage(createAssistantMessage("ok"));
			// The memo is released, so nothing pins the wire any more.
			wire.messages.length = 0;
			expect(await becomesCollectible(wire.ref, 2_000)).toBe(true);
			// Liveness anchor: the injector must stay alive across the probe.
			const freshUser: Message = { role: "user", content: "fresh", timestamp: 4 };
			const post = injector.transform(
				{ systemPrompt: ["system"], messages: [freshUser] },
				"2026-08-14",
				"/work/omp",
			);
			expect(post.messages[0]).not.toBe(freshUser);
		});

		it("does not pin a provider-normalized boundary message after the turn commits", async () => {
			// Contract: the O(1) admission signature records the boundary messages
			// of the wire it was handed, and that wire is not the transcript — a
			// provider transform clones a normalized image/tool turn. Once the
			// one-shot turn commits, the session transcript holds the
			// pre-normalization turn and the prepared context is dropped, so that
			// boundary is reachable only through the injector, where it can never
			// match again (the transcript has grown). A strong signature keeps the
			// clone — and every message it transitively owns — alive until the next
			// request or the session is disposed; for a one-shot session that never
			// sends again, that is the rest of the process.
			function prepareCommittedTurn(): { ref: WeakRef<Message>; injector: DateCwdReminderInjector } {
				const injector = new DateCwdReminderInjector();
				const root: Message = { role: "user", content: "root", timestamp: 1 };
				// The wire's last turn is the provider's normalized copy of the sent
				// one, so the session transcript never holds this object.
				const normalized: Message = { role: "user", content: "normalized-image", timestamp: 2 };
				const context: Context = { systemPrompt: ["system"], messages: [root, normalized] };
				// One preparation for the turn: only the O(1) boundary signature is
				// recorded, no memo is admitted, so nothing else holds the
				// normalized turn back.
				injector.transform(context, "2026-08-14", "/work/omp");
				return { ref: new WeakRef(normalized), injector };
			}
			const { ref, injector } = prepareCommittedTurn();
			expect(await becomesCollectible(ref, 2_000)).toBe(true);
			// Liveness anchor: the injector must survive the probe above, or the
			// boundary frees vacuously with its owner. It must also keep injecting
			// on the next turn.
			const freshUser: Message = { role: "user", content: "fresh", timestamp: 3 };
			const post = injector.transform(
				{ systemPrompt: ["system"], messages: [freshUser] },
				"2026-08-14",
				"/work/omp",
			);
			expect(post.messages[0]).not.toBe(freshUser);
		});

		it("rebuilds the wire when the caller edits the input array in place", () => {
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			const secondUser: Message = { role: "user", content: "second", timestamp: 2 };
			const context: Context = { systemPrompt: ["system"], messages: [firstUser, secondUser] };

			const first = injector.transform(context, "2026-08-14", "/work/omp");
			expect(first.messages).toHaveLength(2);
			expect(first.messages[0]).not.toBe(firstUser);
			expect(first.messages[1]).toBe(secondUser);

			// A second identical transform admits the replay memo (two-hit
			// admission: the first only records the O(1) boundary signature),
			// so the in-place edit below must defeat the memo's
			// element-identity check — not merely miss an unadmitted one.
			const admitted = injector.transform(
				{ ...context, messages: [...context.messages] },
				"2026-08-14",
				"/work/omp",
			);
			expect(admitted.messages[0]).toBe(first.messages[0]);

			// The caller replaces an element of its own input array in place: the
			// memo's element-identity check must miss and rebuild, or the replay
			// serves the stale layout with the replaced turn still on the wire.
			const replacement: Message = { role: "user", content: "replaced", timestamp: 3 };
			context.messages[1] = replacement;

			const replay = injector.transform(context, "2026-08-14", "/work/omp");

			expect(replay.messages).toHaveLength(2);
			expect(replay.messages[0]).toBe(first.messages[0]);
			expect(replay.messages[1]).toBe(replacement);
			expect(replay.messages).not.toContain(secondUser);
		});

		it("hands each request its own array so a retained context is never rewritten", () => {
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			const context: Context = { systemPrompt: ["system"], messages: [firstUser] };

			// A provider like `streamMock` records the `Context` it is handed per call, so
			// array identity is part of what it observed.
			const first = injector.transform({ ...context }, "2026-08-14", "/work/omp");
			const replay = injector.transform({ ...context }, "2026-08-14", "/work/omp");
			expect(replay.messages).not.toBe(first.messages);
			expect(replay.messages[0]).toBe(first.messages[0]);

			// A second custom provider appends its own marker to the array it was handed.
			const marker: Message = { role: "developer", content: "provider-only", timestamp: 2 };
			replay.messages.push(marker);
			expect(first.messages).toHaveLength(1);
			expect(first.messages).not.toContain(marker);

			// A late mutation by the first provider must not reach a later request either.
			first.messages.push({ role: "developer", content: "late", timestamp: 3 });
			const third = injector.transform({ ...context }, "2026-08-14", "/work/omp");
			expect(third.messages).toHaveLength(1);
			expect(third.messages).not.toBe(first.messages);
			expect(third.messages[0]).toBe(first.messages[0]);
		});

		it("serves the memo's own layout after a consumer reorders the array it was handed", () => {
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			const anchor = createAssistantMessage("tool turn");
			const messageSet = () => [firstUser, anchor];

			injector.transform({ systemPrompt: ["system"], messages: messageSet() }, "2026-08-14", "/old");
			// The cwd moves mid tool loop: the continuation carries the reminder as
			// a developer control on the tail.
			injector.transform({ systemPrompt: ["system"], messages: messageSet() }, "2026-08-15", "/new");
			// An identical repeat is what admits the memo the reorder below must
			// survive: the first `/new` build only records the O(1) boundary
			// signature, so `live` would otherwise own its array outright.
			const live = injector.transform({ systemPrompt: ["system"], messages: messageSet() }, "2026-08-15", "/new");
			const control = live.messages.at(-1)!;
			expect(control.role).toBe("developer");
			expect(isDateCwdReminderControl(control)).toBe(true);

			// A downstream consumer reorders the tail it was handed: a copy of the
			// turn the control was appended after lands behind it.
			live.messages.push(anchor);
			expect(live.messages.at(-1)).toBe(anchor);

			// A third identical build serves the admitted memo, so it must hand out
			// a copy of the memo's own array. Admitting by returning that array
			// instead of a copy would let the splice above rewrite what every later
			// request is sent.
			const replay = injector.transform({ systemPrompt: ["system"], messages: messageSet() }, "2026-08-15", "/new");

			// The reordered array is not replayed: the reminder control stays where
			// it was appended, after the occurrence it belongs to.
			expect(replay.messages).not.toBe(live.messages);
			expect(replay.messages).toHaveLength(3);
			expect(replay.messages[2]).toBe(control);
		});

		it("frees the discarded transcript on release instead of pinning it in the memo", async () => {
			// Contract: once the owner reports a wholesale history replacement, the
			// injector must hold no reference — memo or otherwise — that keeps a
			// discarded turn alive. The sentinel tail below is never injected, so
			// only the admitted replay memo pins it; after `release()` plus a full
			// GC it must be collectable. Collection runs from a fresh timer
			// callback per the shared `becomesCollectible` probe: JSC scans stale
			// async frames conservatively, so `Bun.gc(true)` issued from this
			// resumed async frame can retain the released tail; a timer callback
			// runs on the event loop's shallow stack, out of reach of those
			// frames. The 2s deadline sits far inside Bun's 5s per-test default,
			// leaving timeout margin.
			function buildPinnedTail(): { ref: WeakRef<Message>; injector: DateCwdReminderInjector } {
				const injector = new DateCwdReminderInjector();
				const tail: Message = { role: "user", content: "sentinel-tail", timestamp: 2 };
				const first: Message = { role: "user", content: "first", timestamp: 1 };
				const context: Context = { systemPrompt: ["system"], messages: [first, tail] };
				// Two-hit admission: the first transform only records the O(1)
				// boundary signature into #pending, so the sentinel must be built
				// twice to land in the admitted memo this test names.
				injector.transform(context, "2026-08-14", "/work/omp");
				injector.transform({ ...context, messages: [...context.messages] }, "2026-08-14", "/work/omp");
				return { ref: new WeakRef(tail), injector };
			}
			const { ref, injector } = buildPinnedTail();
			injector.release();
			expect(await becomesCollectible(ref, 2_000)).toBe(true);
			// Liveness anchor: the injector must stay alive across the loop above
			// (otherwise the tail frees vacuously with its owner), so it is used
			// again here — and it must still serve fresh transforms afterwards.
			const freshUser: Message = { role: "user", content: "fresh", timestamp: 3 };
			const post = injector.transform(
				{ systemPrompt: ["system"], messages: [freshUser] },
				"2026-08-14",
				"/work/omp",
			);
			expect(post.messages[0]).not.toBe(freshUser);
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

		describe("with a journal", () => {
			const wireOf = (context: Context) =>
				context.messages.map(message => JSON.stringify([message.role, message.content]));
			const createJournal = () => {
				const placements: DateCwdReminderPlacement[] = [];
				let loads = 0;
				const journal: DateCwdReminderJournal = {
					load: () => {
						loads++;
						return placements;
					},
					record: placement => {
						placements.push(placement);
					},
				};
				return { placements, journal, loads: () => loads };
			};

			it("sends an earlier injector's turns with the reminders they were sent with", () => {
				const { journal } = createJournal();
				const first: Message = { role: "user", content: "first", timestamp: 1 };
				const toolTurn = createAssistantMessage("calling a tool");
				const toolResult: Message = {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "notes" }],
					isError: false,
					timestamp: 3,
				};
				const earlier = new DateCwdReminderInjector(journal);
				earlier.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/work");
				// The date rolls over mid tool loop: the continuation carries it as a developer turn.
				const sent = earlier.transform(
					{ systemPrompt: ["system"], messages: [first, toolTurn, toolResult] },
					"2026-08-15",
					"/work",
				);
				const reply = createAssistantMessage("done");
				const next: Message = { role: "user", content: "next", timestamp: 5 };

				// A resumed session or a revived subagent: a new process, days later.
				const resumed = new DateCwdReminderInjector(journal).transform(
					{ systemPrompt: ["system"], messages: [first, toolTurn, toolResult, reply, next] },
					"2026-08-17",
					"/work",
				);

				expect(wireOf(resumed).slice(0, sent.messages.length)).toEqual(wireOf(sent));
				expect(isDateCwdReminderControl(resumed.messages[3]!)).toBe(true);
				expect(resumed.messages.at(-1)?.content).toBe(`${renderDateCwdReminder("2026-08-17", "/work")}\n\nnext`);
			});

			it("records each reminder it places once", () => {
				const { placements, journal } = createJournal();
				const injector = new DateCwdReminderInjector(journal);
				const first: Message = { role: "user", content: "first", timestamp: 1 };
				const second: Message = { role: "user", content: "second", timestamp: 3 };
				injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/work");
				injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/work");
				injector.transform(
					{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), second] },
					"2026-08-15",
					"/work",
				);

				expect(placements).toEqual([
					{
						conversation: "user:1:",
						turn: "user:1:",
						reminder: renderDateCwdReminder("2026-08-14", "/work"),
						placement: "prefix",
						firstTurn: expect.any(String),
					},
					{
						conversation: "user:1:",
						turn: "user:3:",
						reminder: renderDateCwdReminder("2026-08-15", "/work"),
						placement: "prefix",
					},
				]);
			});

			it("moves an earlier injector's control off a per-call message, so today's reminder stays last and is placed once", () => {
				const { placements, journal } = createJournal();
				const first: Message = { role: "user", content: "task", timestamp: 1 };
				const call = createAssistantMessage("calling a tool");
				const result: Message = {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "notes" }],
					isError: false,
					timestamp: 3,
				};
				const history = [first, call, result];
				// A context hook's status message, rebuilt for every request with a fixed timestamp.
				const status = (): Message => ({ role: "user", content: "STATUS", timestamp: 0 });
				// An injector from before per-call messages were excluded saw it as a sent turn and
				// anchored the day-two control on it: the journal such a session carries.
				const earlier = new DateCwdReminderInjector(journal);
				earlier.transform({ systemPrompt: ["system"], messages: [...history, status()] }, "2026-08-14", "/work");
				earlier.transform({ systemPrompt: ["system"], messages: [...history, status()] }, "2026-08-15", "/work");
				expect(placements.at(-1)).toMatchObject({ turn: "user:0:", placement: "control" });

				const resumed = new DateCwdReminderInjector(journal);
				const reminderDates: string[][] = [];
				const journalSizes: number[] = [];
				for (let request = 0; request < 3; request++) {
					const tail = status();
					markPerCallContextMessage(tail);
					const out = resumed.transform(
						{ systemPrompt: ["system"], messages: [...history, tail] },
						"2026-08-16",
						"/work",
					);
					reminderDates.push(
						out.messages.flatMap(message => {
							const match = JSON.stringify(message.content).match(/2026-08-1\d/);
							return match ? [match[0]] : [];
						}),
					);
					journalSizes.push(placements.length);
				}

				for (const dates of reminderDates) expect(dates).toEqual(["2026-08-14", "2026-08-15", "2026-08-16"]);
				expect(new Set(journalSizes).size).toBe(1);

				// Reopen after the conversation grew: the move was journaled, so the day-two control stays
				// right after the turn it was moved to instead of re-deriving from the new request shape.
				const later: Message[] = [
					...history,
					createAssistantMessage("calling another tool"),
					{ ...result, toolCallId: "call-2", timestamp: 5 },
				];
				const sizeBeforeReopen = placements.length;
				const reopened = new DateCwdReminderInjector(journal);
				for (let request = 0; request < 2; request++) {
					const tail = status();
					markPerCallContextMessage(tail);
					const out = reopened.transform(
						{ systemPrompt: ["system"], messages: [...later, tail] },
						"2026-08-16",
						"/work",
					);
					const dated = out.messages.flatMap((message, index) => {
						const match = JSON.stringify(message.content).match(/2026-08-1\d/);
						return match ? [{ date: match[0], index }] : [];
					});
					expect(dated.map(entry => entry.date)).toEqual(["2026-08-14", "2026-08-15", "2026-08-16"]);
					// The day-two control follows the first tool result, before the later turns.
					expect(out.messages[dated[1]!.index - 1]).toBe(result);
				}
				expect(placements.length).toBe(sizeBeforeReopen);
			});

			it("keeps a moved control ahead of a newer control already at its new turn when the session reopens", () => {
				const { placements, journal } = createJournal();
				const first: Message = { role: "user", content: "task", timestamp: 1 };
				const result: Message = {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "notes" }],
					isError: false,
					timestamp: 3,
				};
				const history = [first, createAssistantMessage("calling a tool"), result];
				const status = (): Message => ({ role: "user", content: "STATUS", timestamp: 0 });
				// An earlier injector anchored the day-two control on the hook's status message...
				const earlier = new DateCwdReminderInjector(journal);
				earlier.transform({ systemPrompt: ["system"], messages: [...history, status()] }, "2026-08-14", "/work");
				earlier.transform({ systemPrompt: ["system"], messages: [...history, status()] }, "2026-08-15", "/work");
				// ...and the day-three control already sits after the tool result.
				journal.record({
					conversation: "user:1:",
					turn: "toolResult:3",
					reminder: renderDateCwdReminder("2026-08-16", "/work"),
					placement: "control",
				});
				const datesOf = (injector: DateCwdReminderInjector, withStatus = true) => {
					const tail = status();
					markPerCallContextMessage(tail);
					const out = injector.transform(
						{ systemPrompt: ["system"], messages: withStatus ? [...history, tail] : history },
						"2026-08-16",
						"/work",
					);
					return out.messages.flatMap(message => {
						const match = JSON.stringify(message.content).match(/2026-08-1\d/);
						return match ? [match[0]] : [];
					});
				};
				// The resume moves day two after the tool result, ahead of day three, and journals the move.
				expect(datesOf(new DateCwdReminderInjector(journal))).toEqual(["2026-08-14", "2026-08-15", "2026-08-16"]);
				const sizeAfterMove = placements.length;
				// A reopen replays the journal, the move last: day two keeps its place, with or without the
				// per-call message the old control was anchored on.
				expect(datesOf(new DateCwdReminderInjector(journal))).toEqual(["2026-08-14", "2026-08-15", "2026-08-16"]);
				expect(datesOf(new DateCwdReminderInjector(journal), false)).toEqual([
					"2026-08-14",
					"2026-08-15",
					"2026-08-16",
				]);
				expect(placements.length).toBe(sizeAfterMove);
			});

			it("dates the first turn today when the journal has no reminder for it", () => {
				const { journal } = createJournal();
				const out = new DateCwdReminderInjector(journal).transform(
					{
						systemPrompt: ["system"],
						messages: [{ role: "user", content: "old", timestamp: 1 }, createAssistantMessage("a")],
					},
					"2026-08-17",
					"/work",
				);

				expect(out.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-17", "/work")}\n\nold`);
			});

			it("keeps the date of a turn whose request was interrupted before any reply", () => {
				const { journal } = createJournal();
				const first: Message = { role: "user", content: "first", timestamp: 1 };
				const sent = new DateCwdReminderInjector(journal).transform(
					{ systemPrompt: ["system"], messages: [first] },
					"2026-08-14",
					"/work",
				);

				const resumed = new DateCwdReminderInjector(journal).transform(
					{ systemPrompt: ["system"], messages: [first] },
					"2026-08-16",
					"/work",
				);

				expect(wireOf(resumed).slice(0, 1)).toEqual(wireOf(sent));
				expect(resumed.messages.at(-1)).toMatchObject({
					role: "developer",
					content: renderDateCwdReminder("2026-08-16", "/work"),
				});
			});

			it("sends a switched-in transcript's turns with the reminders that transcript recorded", () => {
				// Two forks of one session share their first turn; only the second fork sent `branch`.
				const first: Message = { role: "user", content: "first", timestamp: 1 };
				const branch: Message = { role: "user", content: "branch", timestamp: 7 };
				const forks: Record<string, DateCwdReminderPlacement[]> = {
					one: [],
					two: [
						{
							conversation: "user:1:",
							turn: "user:1:",
							reminder: renderDateCwdReminder("2026-08-14", "/work"),
							placement: "prefix",
						},
						{
							conversation: "user:1:",
							turn: "user:7:",
							reminder: renderDateCwdReminder("2026-08-15", "/work"),
							placement: "prefix",
						},
					],
				};
				let current = "one";
				const journal: DateCwdReminderJournal = {
					load: () => forks[current]!,
					record: placement => {
						forks[current]!.push(placement);
					},
					scope: () => current,
				};
				const injector = new DateCwdReminderInjector(journal);
				injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/work");

				current = "two";
				const switched = injector.transform(
					{
						systemPrompt: ["system"],
						messages: [
							first,
							createAssistantMessage("a"),
							branch,
							createAssistantMessage("b"),
							{ role: "user", content: "next", timestamp: 9 },
						],
					},
					"2026-08-16",
					"/work",
				);

				expect(switched.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work")}\n\nbranch`);
				expect(switched.messages[4]?.content).toBe(`${renderDateCwdReminder("2026-08-16", "/work")}\n\nnext`);
			});

			it("sends a sibling branch's turns with their own reminders after a tree move", () => {
				using tempDir = TempDir.createSync("@pi-date-cwd-tree-");
				const sessionManager = SessionManager.inMemory(tempDir.path());
				const journal = () => createSessionDateCwdReminderJournal(sessionManager);
				const send = (injector: DateCwdReminderInjector, messages: Message[], date: string) =>
					injector.transform({ systemPrompt: ["system"], messages }, date, "/work");
				const first: Message = { role: "user", content: "first", timestamp: 1 };
				const reply = createAssistantMessage("a");
				const sideB: Message = { role: "user", content: "side b", timestamp: 7 };
				const replyB = createAssistantMessage("b");
				const sideA: Message = { role: "user", content: "side a", timestamp: 8 };
				const earlier = new DateCwdReminderInjector(journal());
				sessionManager.appendMessage(first);
				send(earlier, [first], "2026-08-14");
				const forkPoint = sessionManager.appendMessage(reply);
				sessionManager.appendMessage(sideB);
				const sentB = send(earlier, [first, reply, sideB], "2026-08-15");
				const leafB = sessionManager.appendMessage(replyB);
				sessionManager.branch(forkPoint);
				sessionManager.appendMessage(sideA);

				// Reopened later: the new process serves branch A, then the tree moves to branch B.
				const resumed = new DateCwdReminderInjector(journal());
				send(resumed, [first, reply, sideA], "2026-08-16");
				sessionManager.branch(leafB);
				const next: Message = { role: "user", content: "next", timestamp: 9 };
				sessionManager.appendMessage(next);
				const moved = send(resumed, [first, reply, sideB, replyB, next], "2026-08-16");

				expect(wireOf(moved).slice(0, 3)).toEqual(wireOf(sentB));
				expect(moved.messages[4]?.content).toBe(`${renderDateCwdReminder("2026-08-16", "/work")}\n\nnext`);
			});

			it("sends turns another process appended with that process's reminders after a reload", () => {
				using tempDir = TempDir.createSync("@pi-date-cwd-reload-");
				const sessionManager = SessionManager.inMemory(tempDir.path());
				const send = (injector: DateCwdReminderInjector, messages: Message[], date: string) =>
					injector.transform({ systemPrompt: ["system"], messages }, date, "/work");
				const first: Message = { role: "user", content: "first", timestamp: 1 };
				const reply = createAssistantMessage("a");
				const second: Message = { role: "user", content: "second", timestamp: 5 };
				const secondReply = createAssistantMessage("b");
				const here = new DateCwdReminderInjector(createSessionDateCwdReminderJournal(sessionManager));
				sessionManager.appendMessage(first);
				send(here, [first], "2026-08-14");
				sessionManager.appendMessage(reply);

				// Another process continues the same session the next day; this one then reloads it.
				const elsewhere = new DateCwdReminderInjector(createSessionDateCwdReminderJournal(sessionManager));
				sessionManager.appendMessage(second);
				const sentElsewhere = send(elsewhere, [first, reply, second], "2026-08-15");
				sessionManager.appendMessage(secondReply);
				const third: Message = { role: "user", content: "third", timestamp: 9 };
				sessionManager.appendMessage(third);
				const reloaded = send(here, [first, reply, second, secondReply, third], "2026-08-15");

				expect(wireOf(reloaded).slice(0, 3)).toEqual(wireOf(sentElsewhere));
				expect(reloaded.messages[4]?.content).toBe("third");
			});

			it("starts the history after /clear afresh even when its first turn repeats an earlier one", () => {
				using tempDir = TempDir.createSync("@pi-date-cwd-clear-");
				const sessionManager = SessionManager.inMemory(tempDir.path());
				const injector = new DateCwdReminderInjector(createSessionDateCwdReminderJournal(sessionManager));
				// A context hook's static bootstrap message opens both histories.
				const before: Message = { role: "user", content: "BOOTSTRAP", timestamp: 1 };
				sessionManager.appendMessage(before);
				injector.transform({ systemPrompt: ["system"], messages: [before] }, "2026-08-14", "/work");
				sessionManager.appendMessage(createAssistantMessage("a"));
				sessionManager.appendResetBoundary();

				const after = injector.transform(
					{ systemPrompt: ["system"], messages: [{ role: "user", content: "BOOTSTRAP", timestamp: 50 }] },
					"2026-08-16",
					"/work",
				);

				expect(after.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-16", "/work")}\n\nBOOTSTRAP`);
			});

			it("resends a retained turn with its own reminder after a compaction renumbered it", () => {
				const { journal } = createJournal();
				const earlier = new DateCwdReminderInjector(journal);
				const user: Message = { role: "user", content: "ok", timestamp: 1 };
				earlier.transform({ systemPrompt: ["system"], messages: [user] }, "2026-08-14", "/work");
				// Two same-millisecond turns: the second is `user:1:#1` and takes the new date.
				earlier.transform(
					{ systemPrompt: ["system"], messages: structuredClone([user, createAssistantMessage("a"), user]) },
					"2026-08-15",
					"/work",
				);
				// The compaction drops the first, so the survivor is `user:1:` now.
				const summary: Message = { role: "user", content: "summary", timestamp: 3 };
				const compacted = earlier.transform(
					{ systemPrompt: ["system"], messages: [summary, structuredClone(user)] },
					"2026-08-15",
					"/work",
				);
				const reply = createAssistantMessage("b");

				const resumed = new DateCwdReminderInjector(journal).transform(
					{
						systemPrompt: ["system"],
						messages: [summary, structuredClone(user), reply, { role: "user", content: "next", timestamp: 5 }],
					},
					"2026-08-16",
					"/work",
				);

				expect(wireOf(resumed).slice(0, 2)).toEqual(wireOf(compacted));
				expect(compacted.messages[1]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work")}\n\nok`);
			});

			it("leaves out a dropped turn's developer reminder after a compaction renumbered its twin", () => {
				const { journal } = createJournal();
				const earlier = new DateCwdReminderInjector(journal);
				const user: Message = { role: "user", content: "first", timestamp: 1 };
				const result: Message = {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "same" }],
					isError: false,
					timestamp: 2,
				};
				const call = createAssistantMessage("a");
				earlier.transform({ systemPrompt: ["system"], messages: [user] }, "2026-08-14", "/work");
				// The date rolls over mid tool loop: the reminder follows the first of two identical results.
				earlier.transform(
					{ systemPrompt: ["system"], messages: structuredClone([user, call, result]) },
					"2026-08-15",
					"/work",
				);
				earlier.transform(
					{ systemPrompt: ["system"], messages: structuredClone([user, call, result, call, result]) },
					"2026-08-15",
					"/work",
				);
				// The compaction drops the first result; its twin now holds the key it had.
				const summary: Message = { role: "user", content: "summary", timestamp: 3 };
				const compacted = earlier.transform(
					{ systemPrompt: ["system"], messages: structuredClone([summary, call, result]) },
					"2026-08-15",
					"/work",
				);

				const resumed = new DateCwdReminderInjector(journal).transform(
					{
						systemPrompt: ["system"],
						messages: structuredClone([summary, call, result, createAssistantMessage("b")]),
					},
					"2026-08-15",
					"/work",
				);

				expect(compacted.messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult"]);
				expect(wireOf(resumed).slice(0, 3)).toEqual(wireOf(compacted));
				expect(resumed.messages.map(message => message.role)).toEqual([
					"user",
					"assistant",
					"toolResult",
					"assistant",
				]);
			});

			it("finds a first turn a context hook re-creates on every request, without reading the journal each time", () => {
				const { journal, loads } = createJournal();
				let stamp = 1000;
				const history: Message[] = [{ role: "user", content: "task", timestamp: 1 }];
				const send = (injector: DateCwdReminderInjector, date: string) =>
					injector.transform(
						{
							systemPrompt: ["system"],
							messages: [{ role: "user", content: "BOOTSTRAP", timestamp: stamp++ }, ...history],
						},
						date,
						"/work",
					);
				const earlier = new DateCwdReminderInjector(journal);
				let sent = send(earlier, "2026-08-14");
				for (let request = 0; request < 5; request++) {
					history.push(createAssistantMessage(`call ${request}`));
					sent = send(earlier, "2026-08-14");
				}
				expect(loads()).toBe(1);
				history.push(createAssistantMessage("done"), { role: "user", content: "next", timestamp: 50 });

				const resumed = send(new DateCwdReminderInjector(journal), "2026-08-16");

				expect(wireOf(resumed).slice(0, sent.messages.length)).toEqual(wireOf(sent));
				expect(resumed.messages.at(-1)?.content).toBe(`${renderDateCwdReminder("2026-08-16", "/work")}\n\nnext`);
			});
		});
	});
});

describe("date/cwd reminder on the provider wire", () => {
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

	it("keeps the Anthropic cache on the history when the date rolls over under per-call messages a context hook adds", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-");
		await Bun.write(tempDir.join("notes.txt"), "notes");
		const api = "test-date-cwd-reminder-per-call";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			const request = contexts.length;
			queueMicrotask(() => {
				if (request < 5) {
					// The run crosses midnight between tool continuations: request 3 is the first of the new day.
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
			id: "date-cwd-reminder-per-call",
			name: "Date cwd reminder per-call",
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
		// A hook that pins a note after the first turn and appends a status block, both built
		// afresh on every request with a fixed timestamp, so their keys repeat request to request.
		const perCallHook: ExtensionFactory = pi => {
			pi.on("context", event => ({
				messages: [
					event.messages[0]!,
					{ role: "user", content: [{ type: "text", text: "PINNED NOTE" }], timestamp: 0 },
					...event.messages.slice(1),
					{ role: "user", content: [{ type: "text", text: "STATUS BLOCK" }], timestamp: 0 },
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
			extensions: [perCallHook],
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
			setSystemTime();

			expect(contexts).toHaveLength(5);
			expect(contexts[0]!.messages.filter(message => isPerCallContextMessage(message))).toHaveLength(2);

			// The same requests as Anthropic bodies: each must cache its history where the next request reads it.
			const anthropicModel = buildModel({
				id: "claude-opus-5-5",
				name: "Claude Opus 5.5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 64_000,
			} satisfies ModelSpec<"anthropic-messages">);
			const bodies: MessageCreateParams[] = [];
			for (const context of contexts) {
				let body: MessageCreateParams | undefined;
				const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
					body = JSON.parse(requestBodyText(init) ?? "{}") as MessageCreateParams;
					return new Response(
						JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}) as typeof fetch;
				await streamAnthropic(anthropicModel, context, { apiKey: "sk-ant-api-test", fetch: fetchMock })
					.result()
					.catch(() => undefined);
				if (!body) throw new Error("wire body was not captured");
				bodies.push(body);
			}
			const withoutBreakpoints = (message: MessageCreateParams["messages"][number]) =>
				JSON.stringify(message, (key, value) => (key === "cache_control" ? undefined : value));
			for (let request = 1; request < bodies.length; request++) {
				const previous = bodies[request - 1]!.messages;
				const next = bodies[request]!.messages;
				let repeated = 0;
				while (
					repeated < Math.min(previous.length, next.length) &&
					withoutBreakpoints(previous[repeated]!) === withoutBreakpoints(next[repeated]!)
				) {
					repeated++;
				}
				const breakpoints = previous.flatMap((message, index) =>
					Array.isArray(message.content) &&
					message.content.some(block => "cache_control" in block && block.cache_control != null)
						? [index]
						: [],
				);
				const reusable = breakpoints.filter(index => index < repeated).at(-1) ?? -1;
				const newestToolResult = previous.findLastIndex(
					message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_result"),
				);
				// The next request reads the earlier request's cache at least through its newest tool result.
				expect({ request, readsThroughNewestToolResult: reusable >= newestToolResult }).toEqual({
					request,
					readsThroughNewestToolResult: true,
				});
			}

			// What each request sends as conversation history: everything but the hook's per-call messages.
			const history = contexts.map(context =>
				context.messages
					.filter(message => !isPerCallContextMessage(message))
					.map(message => JSON.stringify([message.role, message.content])),
			);
			for (let request = 1; request < history.length; request++) {
				expect(history[request]!.slice(0, history[request - 1]!.length)).toEqual(history[request - 1]!);
			}
			const reminder = JSON.stringify([
				"developer",
				renderDateCwdReminder("2026-08-15", normalizePromptPath(tempDir.path())),
			]);
			expect(history[4]!.filter(message => message === reminder)).toHaveLength(1);
		} finally {
			setSystemTime();
			authStorage.close();
		}
	});

	it("resends the first user turn with its own date when the session is reopened on a later day", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-");
		const api = "test-date-cwd-reminder-reopen";
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
			id: "date-cwd-reminder-reopen",
			name: "Date cwd reminder reopen",
			api,
			provider: "managed-primary",
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
		// A resumed session and a revived subagent both build a new session over the transcript.
		const open = (sessionManager: SessionManager) =>
			createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager,
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

		try {
			setSystemTime(new Date(2026, 7, 14, 10));
			const { session: first } = await open(SessionManager.create(tempDir.path(), tempDir.join("sessions")));
			const sessionFile = first.sessionManager.getSessionFile()!;
			await first.sendUserMessage("first");
			await first.dispose();

			setSystemTime(new Date(2026, 7, 16, 10));
			const { session: reopened } = await open(await SessionManager.open(sessionFile));
			sessions.push(reopened);
			await reopened.sendUserMessage("second");

			expect(contexts).toHaveLength(2);
			const wire = contexts.map(context =>
				context.messages.map(message => JSON.stringify([message.role, message.content])),
			);
			expect(wire[1]!.slice(0, wire[0]!.length)).toEqual(wire[0]!);
			expect(contexts[1]!.messages.at(-1)?.content).toEqual([
				{ type: "text", text: renderDateCwdReminder("2026-08-16", normalizePromptPath(tempDir.path())) },
				{ type: "text", text: "second" },
			]);
		} finally {
			setSystemTime();
			authStorage.close();
		}
	});

});
