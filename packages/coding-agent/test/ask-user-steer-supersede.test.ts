/**
 * Contract: a message a person types while an `ask` dialog is open closes the
 * dialog and reaches the agent first, even when an agent card or another
 * non-user steer already spent the tool batch's cooperative steering signal.
 * While that message is unread, a later `ask` in the same batch closes without
 * showing. Answers the person already gave are returned, not dropped, and a
 * custom answer being typed is not cut off. Agent-authored steering alone
 * leaves the dialog open, and `interruptMode: "wait"` keeps it open.
 *
 * Real Agent, real AgentSession queue and real AskTool; only the dialog UI and
 * the model are stand-ins.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { setImmediate as tick } from "node:timers/promises";
import {
	Agent,
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	type ToolCallContext,
} from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionAskDialogResult, ExtensionAskDialogResultItem } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { Settings } from "../src/config/settings";
import type { ExtensionUIDialogOptions } from "../src/extensibility/extensions";
import { AgentSession } from "../src/session/agent-session";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";
import { AskTool } from "../src/tools/ask";

// A type alias, not an interface: mock tool-call arguments need an index-signature-compatible type.
type AskArgs = {
	questions: Array<{ id: string; question: string; options: Array<{ label: string }> }>;
};

const ONE_QUESTION: AskArgs = {
	questions: [{ id: "q", question: "Which one?", options: [{ label: "Yes" }, { label: "No" }] }],
};

const THREE_QUESTIONS: AskArgs = {
	questions: ["a", "b", "c"].map(id => ({
		id,
		question: `Question ${id}?`,
		options: [{ label: `${id.toUpperCase()}1` }, { label: `${id.toUpperCase()}2` }],
	})),
};

/** A select or editor dialog on screen. */
interface OpenDialog {
	kind: "select" | "editor";
	signal: AbortSignal | undefined;
	/** The tool batch's cooperative steering signal, as the loop handed it to `ask`. */
	loopSignal: AbortSignal | undefined;
	answer(value: string | undefined): void;
}

/** A rich ask dialog on screen. */
interface OpenRichDialog {
	signal: AbortSignal | undefined;
	interrupt: AbortSignal | undefined;
	answer(result: ExtensionAskDialogResult | undefined): void;
}

interface AskHarness {
	session: AgentSession;
	mock: MockModel;
	/** Resolves when the next select or editor dialog is on screen. */
	nextDialog(): Promise<OpenDialog>;
	/** Resolves when the next rich dialog is on screen. */
	nextRichDialog(): Promise<OpenRichDialog>;
	/** Dialogs shown so far. */
	shown(): number;
	/** Every `ask` tool result, in order. */
	askResults: AgentToolResult<unknown>[];
}

let session: AgentSession | undefined;

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("missing dark theme");
	setThemeInstance(theme);
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
});

/** Lets abort listeners and queued microtasks run; no wall-clock wait. */
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await tick();
}

/** Hands out values in order to whoever waits, or buffers them until someone does. */
function channel<T>(): { push(value: T): void; next(): Promise<T> } {
	const ready: T[] = [];
	const waiting: Array<(value: T) => void> = [];
	return {
		push: value => {
			const waiter = waiting.shift();
			if (waiter) waiter(value);
			else ready.push(value);
		},
		next: () => {
			const value = ready.shift();
			if (value !== undefined) return Promise.resolve(value);
			const { promise, resolve } = Promise.withResolvers<T>();
			waiting.push(resolve);
			return promise;
		},
	};
}

function createHarness(
	options: {
		interruptMode?: "immediate" | "wait";
		asks?: number;
		args?: AskArgs;
		/** Offer the rich ask dialog. */
		rich?: boolean;
	} = {},
): AskHarness {
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"ask.timeout": 0,
		"ask.notify": "off",
		"speech.enabled": false,
	});
	const dialogs = channel<OpenDialog>();
	const richDialogs = channel<OpenRichDialog>();
	let shown = 0;
	const sessionRef: { current?: AgentSession } = {};
	const toolSession = {
		hasUI: true,
		settings,
		getPlanModeState: () => ({ enabled: false }),
		superviseUserSteering: (signal: AbortSignal | undefined, mode?: "arrivals" | "pending") =>
			sessionRef.current?.superviseUserSteering(signal, mode),
	} as unknown as ToolSession;
	const askTool = new AskTool(toolSession);
	const toolCalls = Array.from({ length: options.asks ?? 1 }, (_, i) => ({
		type: "toolCall" as const,
		id: `ask-${i + 1}`,
		name: "ask",
		arguments: options.args ?? ONE_QUESTION,
	}));
	const mock = createMockModel({ responses: [{ content: toolCalls }], handler: { content: ["read"] } });
	const askResults: AgentToolResult<unknown>[] = [];
	const open = (
		kind: OpenDialog["kind"],
		call: ToolCallContext | undefined,
		dialog: { signal?: AbortSignal } | undefined,
	): Promise<string | undefined> => {
		shown++;
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		dialog?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
		dialogs.push({ kind, signal: dialog?.signal, loopSignal: call?.steeringSignal, answer: resolve });
		return promise;
	};
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [askTool], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
		steeringMode: "one-at-a-time",
		interruptMode: options.interruptMode ?? "immediate",
		getToolContext: (call?: ToolCallContext) =>
			({
				toolCall: call,
				hasUI: true,
				abort: () => agent.abort(),
				ui: {
					select: (_title: string, _items: unknown[], dialog?: ExtensionUIDialogOptions) =>
						open("select", call, dialog),
					editor: (_title: string, _prefill?: string, dialog?: ExtensionUIDialogOptions) =>
						open("editor", call, dialog),
					...(options.rich
						? {
								askDialog: (_questions: unknown[], dialog?: ExtensionUIDialogOptions) => {
									shown++;
									const { promise, resolve } = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
									dialog?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
									richDialogs.push({ signal: dialog?.signal, interrupt: dialog?.interrupt, answer: resolve });
									return promise;
								},
							}
						: {}),
				},
			}) as unknown as AgentToolContext,
	});
	agent.subscribe(event => {
		if (event.type === "tool_execution_end" && event.toolName === "ask") askResults.push(event.result);
	});
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: { getApiKey: () => "test-key" } as never,
		// AskTool's typed parameters narrow AgentTool's; the registry only looks tools up by name.
		toolRegistry: new Map([["ask", askTool as unknown as AgentTool]]),
	});
	sessionRef.current = session;
	return {
		session,
		mock,
		nextDialog: dialogs.next,
		nextRichDialog: richDialogs.next,
		shown: () => shown,
		askResults,
	};
}

/** An agent card as an extension hands it over: `pi.sendMessage(..., { deliverAs: "steer" })`. */
async function sendCard(target: AgentSession, loopSignal: AbortSignal | undefined): Promise<void> {
	await target.sendCustomMessage(
		{ customType: "envoy-message", content: "agent card", display: true },
		{ deliverAs: "steer", triggerTurn: true },
	);
	await settle();
	// The card spends the batch's cooperative signal, unless interruptMode is "wait".
	expect(loopSignal?.reason).toBe(loopSignal?.aborted ? "system" : undefined);
}

async function typeMessage(target: AgentSession, text = "please stop asking"): Promise<void> {
	await target.prompt(text, { streamingBehavior: "steer" });
	await settle();
}

function resultText(result: AgentToolResult<unknown> | undefined): string {
	return JSON.stringify(result?.content ?? []);
}

/** Texts of the user and developer messages (cards convert to developer) in a model request, in order. */
function requestTexts(call: MockModel["calls"][number]): string[] {
	return call.context.messages.flatMap(message => {
		if (message.role !== "user" && message.role !== "developer") return [];
		const content = message.content;
		return [
			typeof content === "string" ? content : content.map(part => (part.type === "text" ? part.text : "")).join(""),
		];
	});
}

function requestHas(call: MockModel["calls"][number], needle: string): boolean {
	return requestTexts(call).some(text => text.includes(needle));
}

function richAnswer(id: string, selectedOptions: string[]): ExtensionAskDialogResultItem {
	return { id, question: `Question ${id}?`, options: [], multi: false, selectedOptions };
}

describe("ask dialog and a person's later steer", () => {
	it("closes the dialog for a person's steer queued after an agent card", async () => {
		const { session, nextDialog, askResults } = createHarness();
		const run = session.prompt("start");
		const dialog = await nextDialog();

		await sendCard(session, dialog.loopSignal);
		expect(dialog.loopSignal?.aborted).toBe(true);
		expect(dialog.signal?.aborted).toBe(false);
		await typeMessage(session);

		expect(dialog.signal?.aborted).toBe(true);
		await run;
		await session.waitForIdle();
		expect(resultText(askResults[0])).toContain("Ask interrupted by message");
	});

	it("delivers the person's message that closed the dialog before the earlier card", async () => {
		const { session, mock, nextDialog } = createHarness();
		const run = session.prompt("start");
		const dialog = await nextDialog();

		await sendCard(session, dialog.loopSignal);
		await typeMessage(session);
		await run;
		await session.waitForIdle();
		// The first request after the batch reads the person's message; the card follows a boundary later.
		expect(requestHas(mock.calls[1], "please stop asking")).toBe(true);
		expect(requestHas(mock.calls[1], "agent card")).toBe(false);
		expect(mock.calls.slice(2).some(call => requestHas(call, "agent card"))).toBe(true);
	});

	it("closes the dialog for a person's custom prompt, such as a typed /skill", async () => {
		const { session, nextDialog, askResults } = createHarness();
		const run = session.prompt("start");
		const dialog = await nextDialog();

		await sendCard(session, dialog.loopSignal);
		await session.promptCustomMessage(
			{ customType: "skill-prompt", content: "run the review skill", display: true, attribution: "user" },
			{ streamingBehavior: "steer" },
		);
		await settle();
		expect(dialog.signal?.aborted).toBe(true);
		await run;
		await session.waitForIdle();
		expect(resultText(askResults[0])).toContain("Ask interrupted by message");
	});

	it("moves only the person's message ahead when an agent-attributed steer arrives with it", async () => {
		const { session, mock, nextDialog } = createHarness();
		const run = session.prompt("start");
		const dialog = await nextDialog();

		await session.sendUserMessage("parent notice", { deliverAs: "steer", attribution: "agent" });
		await typeMessage(session);
		expect(dialog.signal?.aborted).toBe(true);
		await run;
		await session.waitForIdle();
		expect(requestHas(mock.calls[1], "please stop asking")).toBe(true);
		expect(requestHas(mock.calls[1], "parent notice")).toBe(false);
	});

	it("leaves the dialog open for an agent card alone", async () => {
		const { session, nextDialog, askResults } = createHarness();
		const run = session.prompt("start");
		const dialog = await nextDialog();

		await sendCard(session, dialog.loopSignal);
		expect(dialog.signal?.aborted).toBe(false);
		dialog.answer("Yes");
		await run;
		await session.waitForIdle();
		expect(resultText(askResults[0])).toContain("Yes");
	});

	it("leaves the dialog open for an agent-attributed steer", async () => {
		const { session, nextDialog, askResults } = createHarness();
		const run = session.prompt("start");
		const dialog = await nextDialog();

		await sendCard(session, dialog.loopSignal);
		await session.sendUserMessage("parent notice", { deliverAs: "steer", attribution: "agent" });
		await settle();
		expect(dialog.signal?.aborted).toBe(false);
		dialog.answer("No");
		await run;
		await session.waitForIdle();
		expect(resultText(askResults[0])).toContain("No");
	});

	it('keeps the dialog open in interruptMode "wait", and reads the message after the dialog', async () => {
		const { session, mock, nextDialog, askResults } = createHarness({ interruptMode: "wait" });
		const run = session.prompt("start");
		const dialog = await nextDialog();

		await sendCard(session, dialog.loopSignal);
		expect(dialog.loopSignal?.aborted).toBe(false);
		await typeMessage(session);
		expect(dialog.signal?.aborted).toBe(false);
		dialog.answer("Yes");
		await run;
		await session.waitForIdle();
		expect(resultText(askResults[0])).toContain("Yes");
		expect(mock.calls.some(call => requestHas(call, "please stop asking"))).toBe(true);
	});

	for (const shape of ["after an agent card", "with no card"] as const) {
		it(`closes a second ask in the same batch without showing it while the person's message is unread (${shape})`, async () => {
			const { session, mock, nextDialog, shown, askResults } = createHarness({ asks: 2 });
			const run = session.prompt("start");
			const first = await nextDialog();

			if (shape === "after an agent card") await sendCard(session, first.loopSignal);
			await typeMessage(session);
			expect(first.signal?.aborted).toBe(true);
			await run;
			await session.waitForIdle();

			expect(shown()).toBe(1);
			expect(askResults.map(resultText)).toEqual([
				expect.stringContaining("Ask interrupted by message"),
				expect.stringContaining("Ask interrupted by message"),
			]);
			expect(requestHas(mock.calls[1], "please stop asking")).toBe(true);
		});
	}
});

describe("ask answers given before a person's message closed the dialog", () => {
	it("returns the answers given to earlier questions with the open ones named", async () => {
		const { session, nextDialog, askResults } = createHarness({ args: THREE_QUESTIONS });
		const run = session.prompt("start");
		(await nextDialog()).answer("A1");
		(await nextDialog()).answer("B2");
		const third = await nextDialog();

		await sendCard(session, third.loopSignal);
		await typeMessage(session);
		expect(third.signal?.aborted).toBe(true);
		await run;
		await session.waitForIdle();

		const text = resultText(askResults[0]);
		expect(text).toContain("a: A1");
		expect(text).toContain("b: B2");
		expect(text).toContain("Not answered: c");
		expect(text).not.toContain("Ask interrupted by message");
	});

	it("does not cut off a custom answer being typed, and returns it", async () => {
		const { session, mock, nextDialog, askResults } = createHarness();
		const run = session.prompt("start");
		(await nextDialog()).answer("Other (type your own)");
		const editor = await nextDialog();
		expect(editor.kind).toBe("editor");

		// A plain steer: the batch's signal aborts with reason "user", which used to cut the editor off.
		await typeMessage(session);
		expect(editor.loopSignal?.reason).toBe("user");
		expect(editor.signal?.aborted ?? false).toBe(false);
		editor.answer("my own answer");
		await run;
		await session.waitForIdle();

		expect(resultText(askResults[0])).toContain("my own answer");
		expect(mock.calls.some(call => requestHas(call, "please stop asking"))).toBe(true);
	});

	it("returns what a rich dialog hands back when interrupted", async () => {
		const { session, nextRichDialog, askResults } = createHarness({ rich: true, args: THREE_QUESTIONS });
		const run = session.prompt("start");
		const dialog = await nextRichDialog();
		dialog.interrupt?.addEventListener(
			"abort",
			() =>
				dialog.answer({
					kind: "submit",
					interrupted: true,
					results: [richAnswer("a", ["A1"]), richAnswer("b", []), richAnswer("c", ["C2"])],
				}),
			{ once: true },
		);

		await typeMessage(session);
		await run;
		await session.waitForIdle();

		const text = resultText(askResults[0]);
		expect(text).toContain("a: A1");
		expect(text).toContain("c: C2");
		expect(text).toContain("Not answered: b");
	});

	it("closes a rich dialog whose host ignores the interrupt", async () => {
		const { session, nextRichDialog, askResults } = createHarness({ rich: true });
		const run = session.prompt("start");
		const dialog = await nextRichDialog();

		await typeMessage(session);
		expect(dialog.interrupt?.aborted).toBe(true);
		await run;
		await session.waitForIdle();

		expect(dialog.signal?.aborted).toBe(true);
		expect(resultText(askResults[0])).toContain("Ask interrupted by message");
	});
});
