import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction";
import type { Api, AssistantMessage, Context, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { DateCwdReminderInjector, renderDateCwdReminder } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatLocalCalendarDate } from "@oh-my-pi/pi-tui/chrome/local-date";
import { normalizePromptPath } from "@oh-my-pi/pi-coding-agent/utils/prompt-path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { becomesCollectible } from "../../tui/test/gc";
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

		it("keeps a duplicated anchor's controls on their own occurrences after a tail reorder", () => {
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			// One non-user turn object sitting in the input twice, so the control the
			// reminder change appends is anchored to both occurrences.
			const anchor = createAssistantMessage("tool turn");
			const messageSet = () => [firstUser, anchor, anchor];

			injector.transform({ systemPrompt: ["system"], messages: messageSet() }, "2026-08-14", "/old");
			// Warm the replay memo over the unchanged input: the first `/new`
			// build only records the O(1) boundary signature, so an identical
			// repeat is what actually admits the memo the reorder below must
			// survive. Without it `live` is a first build that owns its array
			// outright and the splice mutates nothing the injector holds.
			injector.transform({ systemPrompt: ["system"], messages: messageSet() }, "2026-08-15", "/new");
			const live = injector.transform({ systemPrompt: ["system"], messages: messageSet() }, "2026-08-15", "/new");
			const control = live.messages.at(-1)!;
			expect(control.role).toBe("developer");

			// A downstream consumer reorders the tail it was handed: the anchored
			// control moves ahead of the second occurrence of the anchor.
			const memo = live.messages;
			expect([memo[1], memo[2], memo[3], memo[4]]).toEqual([anchor, control, anchor, control]);
			memo.splice(3, 2, control, anchor);

			// A third identical build serves the admitted memo, so it hands out
			// a copy of the memo's own array. Admitting by returning that array
			// instead of a copy would let the splice above rewrite what every
			// later request is sent.
			const replay = injector.transform({ systemPrompt: ["system"], messages: messageSet() }, "2026-08-15", "/new");

			// The reordered array is not replayed: the reminder control stays where it
			// was appended, after the occurrence it belongs to.
			expect(replay.messages).not.toBe(memo);
			const wire = replay.messages.map(message => {
				if (message === control) return "control";
				if (message === anchor) return "anchor";
				if (message === memo[0]) return "injected";
				return "unexpected";
			});
			expect(wire).toEqual(["injected", "anchor", "control", "anchor", "control"]);
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
	});
});

describe("date-cwd reminder on the provider wire", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	/** Flatten a turn's text so reminder bytes can be matched regardless of part shape. */
	function reminderText(message: Message): string {
		if (typeof message.content === "string") return message.content;
		return message.content.flatMap(part => (part.type === "text" ? part.text : [])).join("\n");
	}

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

	it("keeps the injected reminder bytes when a queue-only edit replaces the queues", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-queue-");
		const api = "test-date-cwd-reminder-queue";
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
			id: "date-cwd-reminder-queue",
			name: "Date cwd reminder queue",
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
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
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
		});
		sessions.push(session);

		const cwd = normalizePromptPath(tempDir.path());
		setSystemTime(new Date(2026, 7, 14, 12, 0));
		try {
			await session.sendUserMessage("first");
			await session.waitForIdle();
			expect(contexts).toHaveLength(1);
			const sent = contexts[0]!.messages[0]!;
			expect(reminderText(sent)).toContain(renderDateCwdReminder("2026-08-14", cwd));

			// Queue a follow-up without delivering it, then pop it: `replaceQueues`
			// replaces the queues under a live transcript, so only the replay memo
			// may be dropped — the injected turns must survive untouched.
			await session.sendUserMessage("queued follow up", { deliverAs: "followUp" });
			expect(session.popLastQueuedMessage()?.text).toBe("queued follow up");
			await session.waitForIdle();
			expect(contexts).toHaveLength(1);

			// The day rolls over after the queue-only edit, so the next request needs a
			// fresh reminder on its own turn while the historical turn keeps its bytes.
			setSystemTime(new Date(2026, 7, 15, 0, 1));
			await session.sendUserMessage("second");
			expect(contexts).toHaveLength(2);

			const resent = contexts[1]!.messages[0]!;
			expect(resent.content).toEqual(sent.content);
			expect(reminderText(resent)).not.toContain(renderDateCwdReminder("2026-08-15", cwd));
			const newTurn = contexts[1]!.messages.at(-1)!;
			expect(reminderText(newTurn)).toContain(renderDateCwdReminder("2026-08-15", cwd));
		} finally {
			setSystemTime();
			authStorage.close();
		}
	});
});

/**
 * Advisor half of the session-scoped reminder contract.
 *
 * The primary `Agent` is built with `onHistoryReplaced` so a committed
 * `/compact` releases the injector's replay memo (sdk.ts). Every advisor is
 * driven through that same session-scoped `transformProviderContext`, so an
 * advisor-history discard — the runtime's `reset()`, or advisor compaction's
 * `agent.replaceMessages([summary, ...retained])` — must release it too. Both
 * sites discard history through `Agent#emitHistoryReplaced`, so the wired
 * callback covers them; without it the admitted memo keeps the discarded
 * advisor transcript (and every provider-normalized clone it holds) reachable
 * for the rest of the session.
 */
describe("date/cwd reminder memo on advisor history discard", () => {
	const REMINDER_DATE = "2026-08-14";
	const REMINDER_CWD = "/work/omp";
	const sessions: AgentSession[] = [];
	let authStorage: AuthStorage;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterAll(() => {
		authStorage.close();
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	/** Flatten a turn's text so reminder bytes can be matched regardless of part shape. */
	function reminderText(message: Message): string {
		if (typeof message.content === "string") return message.content;
		return message.content.flatMap(part => (part.type === "text" ? part.text : [])).join("\n");
	}

	function createAdvisorHarness(
		tempDir: TempDir,
		advisorStreamFn?: StreamFn,
	): {
		session: AgentSession;
		advisor: Agent;
		advisorMock: MockModel;
		injector: DateCwdReminderInjector;
	} {
		const injector = new DateCwdReminderInjector();
		const advisorMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["first advisor review"] }, { content: ["second advisor review"] }],
		});
		const primaryMock = createMockModel({ provider: "anthropic", responses: [{ content: ["primary done"] }] });
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			modelRoles: { advisor: "anthropic/claude-sonnet-4-5" },
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: ["primary"], tools: [] },
			streamFn: primaryMock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorStreamFn ?? advisorMock.stream,
			// The session-scoped provider transform, exactly as the SDK installs
			// it: the advisor's requests ride the same injector the primary uses,
			// and a history swap releases the memo that injector admitted.
			transformProviderContext: context => injector.transform(context, REMINDER_DATE, REMINDER_CWD),
			onHistoryReplaced: () => injector.release(),
		});
		sessions.push(session);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected an advisor agent to be live");
		advisor.setModel(advisorMock);
		return { session, advisor, advisorMock, injector };
	}

	/**
	 * Admit the replay memo over a fixture advisor transcript and hand back a
	 * weak reference to a turn that only the memo can still reach: assistant
	 * turns are never injected, so nothing in the injector's injection/control
	 * state owns them.
	 */
	function pinAdvisorTranscript(advisor: Agent, injector: DateCwdReminderInjector): WeakRef<Message> {
		const firstUpdate: Message = { role: "user", content: "first update", timestamp: 1 };
		const advisorTurn = createAssistantMessage("advisor finding");
		const secondUpdate: Message = { role: "user", content: "second update", timestamp: 2 };
		// The loop leaves the transcript on the advisor agent; the discard below
		// drops that hold, as it does in production.
		advisor.state.messages.push(firstUpdate, advisorTurn, secondUpdate);
		const context: Context = {
			systemPrompt: ["advisor system prompt"],
			messages: [firstUpdate, advisorTurn, secondUpdate],
		};
		// Two-hit admission: the first build only records the O(1) boundary
		// signature, the identical second one admits the memo that snapshots the
		// whole transcript.
		injector.transform(context, REMINDER_DATE, REMINDER_CWD);
		injector.transform({ ...context, messages: [...context.messages] }, REMINDER_DATE, REMINDER_CWD);
		return new WeakRef(advisorTurn);
	}

	/**
	 * Keep the injector alive across the probe and prove it still serves
	 * requests: a target that merely freed with its owner would pass the
	 * collectibility assertion above without exercising the release.
	 */
	function assertInjectorStillServes(injector: DateCwdReminderInjector): void {
		const fresh: Message = { role: "user", content: "fresh update", timestamp: 4 };
		const post = injector.transform(
			{ systemPrompt: ["advisor system prompt"], messages: [fresh] },
			REMINDER_DATE,
			REMINDER_CWD,
		);
		expect(post.messages[0]?.content).toBe(`${renderDateCwdReminder(REMINDER_DATE, REMINDER_CWD)}\n\nfresh update`);
	}

	it("attaches the reminder to the advisor's first user turn and rebuilds it after a discard", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-advisor-");
		const { advisor, advisorMock } = createAdvisorHarness(tempDir);

		await advisor.prompt("review the current update");
		expect(advisorMock.calls).toHaveLength(1);
		const firstUpdate = advisorMock.calls[0]!.context.messages.find(message => message.role === "user");
		if (!firstUpdate) throw new Error("Expected a user turn on the advisor wire");
		// The reminder rides the first user turn, not the system prompt, so the
		// advisor's tool schemas keep their provider prefix cache (#7404).
		expect(advisorMock.calls[0]!.context.systemPrompt?.join("\n") ?? "").not.toContain(
			renderDateCwdReminder(REMINDER_DATE, REMINDER_CWD),
		);
		expect(reminderText(firstUpdate)).toContain(renderDateCwdReminder(REMINDER_DATE, REMINDER_CWD));

		advisor.reset();
		await advisor.prompt("review the next update");
		expect(advisorMock.calls).toHaveLength(2);
		const rebuilt = advisorMock.calls[1]!.context.messages.find(message => message.role === "user");
		if (!rebuilt) throw new Error("Expected a user turn on the rebuilt advisor wire");
		// The discarded transcript is gone from the request: the new first user
		// turn carries the reminder and no discarded turn rides along.
		expect(advisorMock.calls[1]!.context.messages).toHaveLength(1);
		expect(reminderText(rebuilt)).toContain(renderDateCwdReminder(REMINDER_DATE, REMINDER_CWD));
	});

	it("releases the memo when the advisor runtime resets its history", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-advisor-");
		const { advisor, injector } = createAdvisorHarness(tempDir);
		const ref = pinAdvisorTranscript(advisor, injector);

		// `AdvisorRuntime.reset` discards the advisor's history; the memo must
		// not outlive it. Collection runs through the shared probe, which
		// forces GC from a fresh timer callback (JSC scans stale async frames
		// conservatively) well inside Bun's 5s per-test default.
		advisor.reset();

		expect(await becomesCollectible(ref, 2_000)).toBe(true);
		assertInjectorStillServes(injector);
	});

	it("releases the memo when advisor compaction replaces the history", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-advisor-");
		const { advisor, injector } = createAdvisorHarness(tempDir);
		const ref = pinAdvisorTranscript(advisor, injector);

		// The advisor compaction path commits
		// `agent.replaceMessages([summaryMessage, ...recentMessages])`; the memo
		// must not outlive the transcript it snapshots.
		advisor.replaceMessages([
			createCompactionSummaryMessage("bounded advisor summary", 42, new Date().toISOString()),
		]);

		expect(await becomesCollectible(ref, 2_000)).toBe(true);
		assertInjectorStillServes(injector);
	});

	it("releases the injector's layout when a failed advisor turn is rolled back", async () => {
		// Contract: `AdvisorRuntime` discards a failed advisor turn through this
		// session's own `rollbackTo` facade, which truncates the advisor's
		// `state.messages` in place rather than calling `Agent.reset()` — so it
		// never reaches `Agent#emitHistoryReplaced`. The injector's pending
		// layout records the last entry of the build it just ran, so without a
		// release there the rolled-back batch's tail stays pinned. The terminal
		// non-retriable failure below is the sharpest case: the batch is
		// abandoned outright, so the next build is the next primary update's
		// review rather than this turn's retry.
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-advisor-");
		const terminalError = "Codex error event: Request blocked. (code=invalid_prompt)";
		let tailRef: WeakRef<Message> | undefined;
		const advisorMock = createMockModel({
			provider: "anthropic",
			responses: [{ stopReason: "error", errorMessage: terminalError }],
		});
		const {
			session: live,
			advisor,
			injector,
		} = createAdvisorHarness(tempDir, (model, context, options) => {
			// The wire context of the failing build is the last place the batch
			// tail is observable; taking the reference here (and dropping the
			// driver's own record below) leaves the injector as the only holder.
			tailRef ??= new WeakRef(context.messages.at(-1)!);
			return advisorMock.stream(model, context, options);
		});

		await live.prompt("first primary update");
		expect(await live.waitForAdvisorCatchup(5_000)).toBe(true);
		// One attempt, one rollback: the failure is terminal, so the runtime
		// drops the batch instead of retrying it (the rollback itself clears
		// `state.error`, which is why the transcript is empty rather than
		// carrying the synthetic error turn).
		expect(advisorMock.calls).toHaveLength(1);
		expect(advisor.state.messages).toHaveLength(0);
		// The mock records the context it was handed per call, so it still holds
		// the batch tail through its own log; drop it to leave the injector the
		// only possible holder.
		advisorMock.reset();

		expect(await becomesCollectible(tailRef!, 2_000)).toBe(true);
		assertInjectorStillServes(injector);
	});
});
