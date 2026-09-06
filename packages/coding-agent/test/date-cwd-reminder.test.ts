import { afterEach, describe, expect, it } from "bun:test";
import type { Api, Context, Message, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai";
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

			// The short timezone name is whatever Intl emits for the host's
			// zone — alphabetic (e.g. `CST`) or numeric (e.g. `GMT+5:30` under
			// TZ=Asia/Kolkata) — so assert the semantic structure, not a charset.
			expect(stamp).toMatch(
				/^<system-reminder>\nNow: 2026-08-30T02:51:16Z \(\d{2}:\d{2} [^(,]+, UTC[+-]\d{2}:\d{2}\)\n<\/system-reminder>$/,
			);
		});
	});

	describe("injectNowStamp", () => {
		it("stamps every user message from its own turn timestamp without mutating the input", () => {
			const t1 = Date.parse("2026-08-30T02:51:16Z");
			const t2 = Date.parse("2026-08-30T02:55:00Z");
			const first: Message = { role: "user", content: "first", timestamp: t1 };
			const assistant = createAssistantMessage("hi");
			const last: Message = { role: "user", content: "last", timestamp: t2 };
			const messages = [first, assistant, last];

			const out = injectNowStamp(messages);

			expect(out).not.toBe(messages);
			// Every user message carries the stamp of its own turn; assistant
			// messages keep their identity.
			expect(out[0]).not.toBe(first);
			expect(out[1]).toBe(assistant);
			expect(out[2]).not.toBe(last);
			expect(textOf(out[0]!)).toBe(`first\n\n${renderNowStamp(new Date(t1))}`);
			expect(textOf(out[2]!)).toBe(`last\n\n${renderNowStamp(new Date(t2))}`);
			// The input array and its elements are untouched.
			expect(messages[0]).toBe(first);
			expect(messages[2]).toBe(last);
			expect(messages[2]!.content).toBe("last");
		});

		it("stamps user-initiated developer continuation turns from their own turn timestamp", () => {
			// The `.`, `c` continue shortcuts submit a synthetic developer
			// message (userInitiated: true) with a fresh turn timestamp; the
			// model must see a stamp for this turn, not only the previous
			// user turn's potentially stale one.
			const t = Date.parse("2026-08-30T04:12:00Z");
			const continuation: Message = {
				role: "developer",
				content: "Continue the task.",
				synthetic: true,
				userInitiated: true,
				timestamp: t,
			};

			const out = injectNowStamp([continuation])[0]!;

			expect(out).not.toBe(continuation);
			expect(textOf(out)).toBe(`Continue the task.\n\n${renderNowStamp(new Date(t))}`);
		});

		it("leaves agent-initiated developer turns unstamped", () => {
			const t = Date.parse("2026-08-30T04:12:00Z");
			const autoContinue: Message = { role: "developer", content: "Continue.", synthetic: true, timestamp: t };
			const turns: Message[] = [createAssistantMessage("hi"), autoContinue];

			expect(injectNowStamp(turns)).toBe(turns);
		});

		it("appends a trailing text part when a user message has array content", () => {
			const t = Date.parse("2026-08-30T02:51:16Z");
			const messages: Message[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: "with image" },
						{ type: "image", data: "img", mimeType: "image/png" },
					],
					timestamp: t,
				},
			];

			const out = injectNowStamp(messages);

			const content = out[0]?.content;
			if (!Array.isArray(content)) throw new Error("expected array content");
			expect(content).toHaveLength(3);
			expect(content[0]).toEqual({ type: "text", text: "with image" });
			expect(content[1]).toEqual({ type: "image", data: "img", mimeType: "image/png" });
			expect(content[2]!).toEqual({ type: "text", text: renderNowStamp(new Date(t)) });
		});

		it("keeps a prompt byte-identical when its trailing Now block equals its derived stamp", () => {
			// A prompt whose tail is exactly the stamp derived from its own
			// timestamp (e.g. a transcript echo) is already stamped: passthrough.
			const t = Date.parse("2026-08-30T02:51:16Z");
			const derived = renderNowStamp(new Date(t));
			const stamped: Message = { role: "user", content: `hi\n\n${derived}`, timestamp: t };
			const messages = [stamped];

			const out = injectNowStamp(messages);

			expect(textOf(out[0]!)).toBe(textOf(stamped));
			expect(textOf(out[0]!).match(/Now: /g)).toHaveLength(1);
		});

		it("re-stamps a prompt ending in a pasted Now block with a different value", () => {
			// A pasted or previously generated Now block carrying another
			// timestamp must not suppress the real stamp: the derived one is
			// injected alongside it, deterministically.
			const t = Date.parse("2026-08-30T02:51:16Z");
			const derived = renderNowStamp(new Date(t));
			const pasted = `<system-reminder>\nNow: 2025-01-02T03:04:05Z (04:04 XYZ, UTC+01:00)\n</system-reminder>`;
			const message: Message = { role: "user", content: `quote this verbatim\n\n${pasted}`, timestamp: t };

			const out = injectNowStamp([message])[0]!;

			expect(textOf(out)).toBe(`quote this verbatim\n\n${pasted}\n\n${derived}`);
		});

		it("keeps byte-identical wire bytes when a previously-stamped user message slides out of last position", () => {
			// The append-only log re-hands the pristine messages each request; a
			// user message stamped in an earlier request must keep its exact wire
			// bytes once it slides out of the last-user position.
			const t1 = Date.parse("2026-08-30T02:51:16Z");
			const t2 = Date.parse("2026-08-30T02:55:00Z");
			const first: Message = { role: "user", content: "first", timestamp: t1 };
			const assistant = createAssistantMessage("hi");
			const second: Message = { role: "user", content: "second", timestamp: t2 };

			const firstStamped = injectNowStamp([first])[0]!;

			const out = injectNowStamp([first, assistant, second]);

			expect(out[1]).toBe(assistant);
			expect(out[2]).not.toBe(second);
			expect(textOf(out[0]!)).toBe(textOf(firstStamped));
			expect(textOf(out[2]!)).toBe(`second\n\n${renderNowStamp(new Date(t2))}`);
		});

		it("re-derives byte-identical stamps for rehydrated history after a session resume", () => {
			// Resume: a new process rehydrates the persisted session as fresh
			// message objects (same persisted content + timestamp) with empty
			// module state; the previously-stamped turn must keep its exact
			// wire bytes while only the new last turn adds bytes at the tail.
			const t1 = Date.parse("2026-08-30T02:51:16Z");
			const t2 = Date.parse("2026-08-30T03:12:45Z");
			const original: Message = { role: "user", content: "first turn", timestamp: t1 };
			const originalStamped = injectNowStamp([original])[0]!;

			const rehydrated: Message = { role: "user", content: "first turn", timestamp: t1 };
			const resumedLast: Message = { role: "user", content: "new turn after resume", timestamp: t2 };
			const out = injectNowStamp([rehydrated, createAssistantMessage("hi"), resumedLast]);

			expect(textOf(out[0]!)).toBe(textOf(originalStamped));
			expect(textOf(out[2]!)).toBe(`new turn after resume\n\n${renderNowStamp(new Date(t2))}`);
		});

		it("stamps same-millisecond distinct turns from each turn's own instant, not a shared value", () => {
			// Two turns with the same text in the same millisecond but different
			// image sets are distinct turns: each carries the stamp of its own
			// timestamp — never a value leaked from the other turn's request.
			const t = Date.parse("2026-08-30T02:51:16.412Z");
			const samePrompt = "analyze this image";
			const turnA: Message = {
				role: "user",
				content: [
					{ type: "text", text: samePrompt },
					{ type: "image", data: "imgA", mimeType: "image/png" },
				],
				timestamp: t,
			};
			const turnB: Message = {
				role: "user",
				content: [
					{ type: "text", text: samePrompt },
					{ type: "image", data: "imgB", mimeType: "image/png" },
				],
				timestamp: t,
			};

			const out = injectNowStamp([turnA, createAssistantMessage("hi"), turnB]);
			const expected = renderNowStamp(new Date(t));

			for (const i of [0, 2]) {
				const content = out[i]!.content;
				if (!Array.isArray(content)) throw new Error("expected array content");
				expect(content[content.length - 1]!).toEqual({ type: "text", text: expected });
			}
		});

		it("derives each stamp from its own message's timestamp, independent of other sessions' messages", () => {
			// No process-global content-keyed value cache: identical content with
			// different turn timestamps yields different stamps, and re-creation
			// with the same persisted identity yields identical bytes.
			const tA = Date.parse("2026-08-30T02:51:16Z");
			const tB = Date.parse("2026-08-30T02:52:16Z");
			const sessionA: Message = { role: "user", content: "hi", timestamp: tA };
			const sessionB: Message = { role: "user", content: "hi", timestamp: tB };

			const outA = injectNowStamp([sessionA])[0]!;
			const outB = injectNowStamp([sessionB])[0]!;
			const outARecreated = injectNowStamp([{ ...sessionA }])[0]!;

			expect(textOf(outA)).toBe(`hi\n\n${renderNowStamp(new Date(tA))}`);
			expect(textOf(outA)).not.toBe(textOf(outB));
			expect(textOf(outARecreated)).toBe(textOf(outA));
		});

		it("appends the stamp to the authoritative openaiResponsesHistory replay payload", () => {
			// A user message carrying an openaiResponsesHistory providerPayload —
			// notably the compaction-summary message created after OpenAI remote
			// compaction — is replayed by the Responses serializers from
			// providerPayload.items, which skip the generic content (see
			// convertConversationMessages in openai-shared.ts). The stamp must
			// reach the payload or the provider never sees it.
			const t = Date.parse("2026-08-30T05:30:00Z");
			const stamp = renderNowStamp(new Date(t));
			const content = "<system-reminder>\nCompaction summary: compacted\n</system-reminder>";
			const historyItems: Array<Record<string, unknown>> = [
				{ type: "compaction", encrypted_content: "enc", summary: [{ type: "summary_text", text: "compacted" }] },
			];
			const makeSummary = (): UserMessage => ({
				role: "user",
				content,
				attribution: "agent",
				historyRewriteAt: t,
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: "openai",
					items: [
						{
							type: "compaction",
							encrypted_content: "enc",
							summary: [{ type: "summary_text", text: "compacted" }],
						},
					],
				},
				timestamp: t,
			});

			const out = injectNowStamp([makeSummary()])[0] as UserMessage;

			const payload = out.providerPayload;
			expect(payload?.type).toBe("openaiResponsesHistory");
			if (payload?.type !== "openaiResponsesHistory") throw new Error("expected openaiResponsesHistory payload");
			expect(payload.items).toEqual([
				...historyItems,
				{ type: "message", role: "user", content: [{ type: "input_text", text: stamp }] },
			]);
			// The generic content is still stamped for providers without native
			// replay, and the input payload is never mutated.
			expect(textOf(out)).toBe(`${content}\n\n${stamp}`);
			expect(historyItems).toHaveLength(1);

			// Byte-stable re-derivation: a rehydrated copy (fresh objects, same
			// persisted bytes) yields identical provider-visible wire bytes.
			const rederived = injectNowStamp([makeSummary()])[0] as UserMessage;
			expect(JSON.stringify(rederived.providerPayload)).toBe(JSON.stringify(payload));
			expect(textOf(rederived)).toBe(textOf(out));
		});

		it("returns the input unchanged when there is no user message or no messages", () => {
			const assistantOnly = [createAssistantMessage("hi")];
			expect(injectNowStamp(assistantOnly)).toBe(assistantOnly);
			const empty: Message[] = [];
			expect(injectNowStamp(empty)).toBe(empty);
		});
	});

	describe("applyNowStamp", () => {
		it("leaves NULL_PROMPT-style contexts (empty system prompt) untouched", () => {
			const context: Context = { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 1 }] };
			expect(applyNowStamp(context)).toBe(context);
		});

		it("leaves no-message contexts untouched", () => {
			const context: Context = { systemPrompt: ["system"], messages: [] };
			expect(applyNowStamp(context)).toBe(context);
		});

		it("stamps each user message from its own turn and keeps the system prompt bytes", () => {
			const systemPrompt = ["PROJECT\n<critical>\n- Must act.\n</critical>"];
			const t1 = Date.parse("2026-08-30T02:51:16Z");
			const t2 = Date.parse("2026-08-30T02:55:00Z");
			const context: Context = {
				systemPrompt,
				messages: [
					{ role: "user", content: "first-apply", timestamp: t1 },
					createAssistantMessage("hi"),
					{ role: "user", content: "last-apply", timestamp: t2 },
				],
			};

			const out = applyNowStamp(context);

			expect(out).not.toBe(context);
			expect(out.systemPrompt).toBe(systemPrompt);
			expect(out.messages[0]).not.toBe(context.messages[0]);
			expect(out.messages[1]).toBe(context.messages[1]);
			expect(out.messages[2]?.content).toBe(`last-apply\n\n${renderNowStamp(new Date(t2))}`);
		});
	});
});

describe("now stamp across processes", () => {
	// True regression guard for the resume guarantee (r3909587061): two
	// separate bun processes, each with a cold module cache, exactly like a
	// resumed session. The in-process resume test above cannot cover this:
	// a process-global stamp cache would stay warm inside one test process.
	// The design holds no module-level value state (only a WeakMap), so the
	// second process must re-derive the first process's stamped bytes.
	const CHILD_FIXTURE = `${import.meta.dir}/fixtures/now-stamp-process-child.ts`;
	async function stampInColdProcess(mode: "orig" | "resumed", tz = "America/Chicago"): Promise<string[]> {
		const proc = Bun.spawn([process.execPath, "--no-env-file", "--no-install", CHILD_FIXTURE, mode], {
			cwd: import.meta.dir,
			env: {
				...process.env,
				TZ: tz,
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 30_000,
		});
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(code, `child "${mode}" exited ${code}: ${stdout}`).toBe(0);
		return JSON.parse(stdout.trim().split("\n").at(-1)!);
	}

	async function formatInColdProcess(tz: string): Promise<string> {
		const proc = Bun.spawn([process.execPath, "--no-env-file", "--no-install", CHILD_FIXTURE, "format"], {
			cwd: import.meta.dir,
			env: {
				...process.env,
				TZ: tz,
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 30_000,
		});
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(code, `child "format" exited ${code}: ${stdout}`).toBe(0);
		return JSON.parse(stdout.trim().split("\n").at(-1)!);
	}

	it("re-derives byte-identical stamps in a second cold bun process", async () => {
		const orig = await stampInColdProcess("orig");
		const resumed = await stampInColdProcess("resumed");
		// Resume is a byte no-op: the stamped turn re-derives byte-identically
		// from its own persisted timestamp in the cold process.
		expect(resumed[1]).toBe(orig[1]);
		expect(resumed[1]).toContain("Now: 2026-08-30T02:51:16Z");
		expect(resumed[2]).toBe(orig[2]);
		// The system prompt is never touched.
		expect(resumed[0]).toBe(JSON.stringify(["SYSTEM"]));
		// Only the genuinely-new last turn adds bytes, at the tail, stamped
		// from its own instant.
		expect(resumed).toHaveLength(orig.length + 1);
		expect(resumed[3]).toContain("Now: 2026-08-30T03:12:45Z");
	});

	it("keeps the stamp's semantic structure when the host zone's short label is numeric (TZ=Asia/Kolkata)", async () => {
		// Charset-regression guard: under TZ=Asia/Kolkata, Bun's Intl emits
		// `GMT+5:30` for the short zone name, which the old `[A-Za-z]{2,5}`
		// assertion rejected. With the TZ pinned, the local clock (08:21)
		// and numeric offset (UTC+05:30) are deterministic; the zone name
		// itself is whatever charset Intl emits for that zone.
		const stamp = await formatInColdProcess("Asia/Kolkata");

		expect(stamp).toMatch(
			/^<system-reminder>\nNow: 2026-08-30T02:51:16Z \(\d{2}:\d{2} [^(,]+, UTC[+-]\d{2}:\d{2}\)\n<\/system-reminder>$/,
		);
		expect(stamp).toContain("Now: 2026-08-30T02:51:16Z (08:21 ");
		expect(stamp).toContain(", UTC+05:30)");
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
	it("stamps each user turn with its own Now and keeps stamped turns byte-identical across requests", async () => {
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
