/**
 * Contract: a message a person types while an `ask` dialog is open closes the
 * dialog and reaches the agent first, even when an agent card or another
 * non-user steer already spent the tool batch's cooperative steering signal.
 * Agent-authored steering alone leaves the dialog open, and `interruptMode:
 * "wait"` keeps it open (the message is read after the dialog).
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
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { Settings } from "../src/config/settings";
import type { ExtensionUIDialogOptions } from "../src/extensibility/extensions";
import { AgentSession } from "../src/session/agent-session";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";
import { AskTool } from "../src/tools/ask";

const QUESTION = { questions: [{ id: "q", question: "Which one?", options: [{ label: "Yes" }, { label: "No" }] }] };

interface OpenDialog {
	signal: AbortSignal | undefined;
	/** The tool batch's cooperative steering signal, as the loop handed it to `ask`. */
	loopSignal: AbortSignal | undefined;
	answer(label: string | undefined): void;
}

interface AskHarness {
	session: AgentSession;
	mock: MockModel;
	/** Resolves when the next ask dialog is on screen. */
	nextDialog(): Promise<OpenDialog>;
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

function createHarness(options: { interruptMode?: "immediate" | "wait"; asks?: number } = {}): AskHarness {
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"ask.timeout": 0,
		"ask.notify": "off",
		"speech.enabled": false,
	});
	const waiting: Array<(dialog: OpenDialog) => void> = [];
	const opened: OpenDialog[] = [];
	const sessionRef: { current?: AgentSession } = {};
	const toolSession = {
		hasUI: true,
		settings,
		getPlanModeState: () => ({ enabled: false }),
		superviseUserSteering: (signal: AbortSignal | undefined) => sessionRef.current?.superviseUserSteering(signal),
	} as unknown as ToolSession;
	const askTool = new AskTool(toolSession);
	const toolCalls = Array.from({ length: options.asks ?? 1 }, (_, i) => ({
		type: "toolCall" as const,
		id: `ask-${i + 1}`,
		name: "ask",
		arguments: QUESTION,
	}));
	const mock = createMockModel({ responses: [{ content: toolCalls }], handler: { content: ["read"] } });
	const askResults: AgentToolResult<unknown>[] = [];
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
					select: (_title: string, _items: unknown[], dialog?: ExtensionUIDialogOptions) => {
						const { promise, resolve } = Promise.withResolvers<string | undefined>();
						dialog?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
						const open: OpenDialog = {
							signal: dialog?.signal,
							loopSignal: call?.steeringSignal,
							answer: resolve,
						};
						const waiter = waiting.shift();
						if (waiter) waiter(open);
						else opened.push(open);
						return promise;
					},
					editor: () => Promise.resolve(undefined),
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
		nextDialog: () => {
			const ready = opened.shift();
			if (ready) return Promise.resolve(ready);
			const { promise, resolve } = Promise.withResolvers<OpenDialog>();
			waiting.push(resolve);
			return promise;
		},
		askResults,
	};
}

/** An agent card as an extension hands it over: `pi.sendMessage(..., { deliverAs: "steer" })`. */
async function sendCard(target: AgentSession, dialog: OpenDialog): Promise<void> {
	await target.sendCustomMessage(
		{ customType: "envoy-message", content: "agent card", display: true },
		{ deliverAs: "steer", triggerTurn: true },
	);
	await settle();
	// The card spends the batch's cooperative signal, unless interruptMode is "wait".
	expect(dialog.loopSignal?.reason).toBe(dialog.loopSignal?.aborted ? "system" : undefined);
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

describe("ask dialog and a person's later steer", () => {
	it("closes the dialog for a person's steer queued after an agent card", async () => {
		const { session, nextDialog, askResults } = createHarness();
		const run = session.prompt("start");
		const dialog = await nextDialog();

		await sendCard(session, dialog);
		expect(dialog.loopSignal?.aborted).toBe(true);
		expect(dialog.signal?.aborted).toBe(false);
		await session.prompt("please stop asking", { streamingBehavior: "steer" });

		expect(dialog.signal?.aborted).toBe(true);
		await run;
		await session.waitForIdle();
		expect(resultText(askResults[0])).toContain("Ask interrupted by message");
	});

	it("delivers the person's message that closed the dialog before the earlier card", async () => {
		const { session, mock, nextDialog } = createHarness();
		const run = session.prompt("start");
		const dialog = await nextDialog();

		await sendCard(session, dialog);
		await session.prompt("please stop asking", { streamingBehavior: "steer" });
		await run;
		await session.waitForIdle();
		// The first request after the batch reads the person's message; the card follows a boundary later.
		expect(requestHas(mock.calls[1], "please stop asking")).toBe(true);
		expect(requestHas(mock.calls[1], "agent card")).toBe(false);
		expect(mock.calls.slice(2).some(call => requestHas(call, "agent card"))).toBe(true);
	});

	it("leaves the dialog open for an agent card alone", async () => {
		const { session, nextDialog, askResults } = createHarness();
		const run = session.prompt("start");
		const dialog = await nextDialog();

		await sendCard(session, dialog);
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

		await sendCard(session, dialog);
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

		await sendCard(session, dialog);
		expect(dialog.loopSignal?.aborted).toBe(false);
		await session.prompt("please stop asking", { streamingBehavior: "steer" });
		await settle();
		expect(dialog.signal?.aborted).toBe(false);
		dialog.answer("Yes");
		await run;
		await session.waitForIdle();
		expect(resultText(askResults[0])).toContain("Yes");
		expect(mock.calls.some(call => requestHas(call, "please stop asking"))).toBe(true);
	});

	it("does not close a second dialog in the same batch for the message that closed the first", async () => {
		const { session, nextDialog, askResults } = createHarness({ asks: 2 });
		const run = session.prompt("start");
		const first = await nextDialog();

		await sendCard(session, first);
		await session.prompt("please stop asking", { streamingBehavior: "steer" });
		expect(first.signal?.aborted).toBe(true);
		const second = await nextDialog();
		await settle();
		expect(second.signal?.aborted).toBe(false);
		second.answer("No");
		await run;
		await session.waitForIdle();
		expect(askResults.map(resultText)).toEqual([
			expect.stringContaining("Ask interrupted by message"),
			expect.stringContaining("No"),
		]);
	});
});
