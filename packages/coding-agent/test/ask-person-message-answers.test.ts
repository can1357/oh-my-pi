/**
 * Contract: when a person's message closes an `ask`, only what someone submitted is an answer.
 * Text typed but not submitted never is. A finished answer is kept: a guest's over the host's
 * unsubmitted text, and a remote client's answer that omp receives within the reply window
 * (`WITHDRAWN_DIALOG_REPLY_MS`) after the message, even if it was already in transit. A
 * multi-select confirmed empty and a note submitted on an option the person did not pick are kept.
 * An answer received after the window, and a collab guest's answer in transit, are known losses.
 *
 * Real Agent, AgentSession, AskTool, ExtensionUiController and rich ask dialog; a real CollabHost
 * and guest socket over the in-memory relay; a real ACP connection pair; the real RPC request
 * resolver. Only the model is scripted.
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
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { type Component, Container } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import {
	AgentSideConnection,
	ClientSideConnection,
	type CreateElicitationResponse,
	ndJsonStream,
} from "@oh-my-pi/pi-utils/acp";
import { importRoomKey } from "../src/collab/crypto";
import { CollabHost } from "../src/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "../src/collab/protocol";
import { CollabSocket } from "../src/collab/relay-client";
import { Settings } from "../src/config/settings";
import type { ExtensionUIContext } from "../src/extensibility/extensions";
import { createAcpExtensionUiContext } from "../src/modes/acp/acp-agent";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import {
	type PendingExtensionRequest,
	type RpcExtensionUIResponse,
	requestRpcAskDialog,
} from "../src/modes/rpc/rpc-mode";
import type { InteractiveModeContext } from "../src/modes/types";
import { AgentSession } from "../src/session/agent-session";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";
import { AskTool } from "../src/tools/ask";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./collab/helpers/in-memory-relay";

const DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
const SHIFT_TAB = "\x1b[Z";

type AskQuestion = { id: string; question: string; options: Array<{ label: string }>; multi?: boolean };

function question(id: string, text: string, multi = false): AskQuestion {
	return { id, question: text, options: [{ label: "Yes" }, { label: "No" }], ...(multi ? { multi } : {}) };
}

const cleanups: Array<() => unknown> = [];

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("missing dark theme");
	setThemeInstance(theme);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Lets abort listeners, frames and queued microtasks run; no wall-clock wait. */
async function settle(): Promise<void> {
	for (let i = 0; i < 12; i++) await tick();
}

interface Harness {
	session: AgentSession;
	ctx: InteractiveModeContext;
	/** The dialog `ask` opens; a test may replace it with a remote host's. */
	ui: Required<Pick<ExtensionUIContext, "askDialog">>;
	/** Every `ask` result, in order. */
	results: AgentToolResult<unknown>[];
	/** Resolves when `ask` opens its dialog. */
	opened: Promise<void>;
	focused(): Component | null;
	input(data: string): void;
}

function createHarness(questions: AskQuestion[]): Harness {
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"ask.timeout": 0,
		"ask.notify": "off",
		"speech.enabled": false,
	});
	const sessionRef: { current?: AgentSession } = {};
	const toolSession = {
		hasUI: true,
		settings,
		getPlanModeState: () => ({ enabled: false }),
		superviseUserSteering: (signal: AbortSignal | undefined, mode?: "arrivals" | "pending") =>
			sessionRef.current?.superviseUserSteering(signal, mode),
	} as unknown as ToolSession;
	const ask = new AskTool(toolSession);
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	let focused: Component | null = editor;
	const ctx = {
		editor,
		editorContainer,
		settings,
		ui: {
			requestRender() {},
			setFocus(component: Component | null) {
				focused = component;
			},
			getFocused: () => focused,
			terminal: { rows: 40, columns: 120 },
			addInputListener: () => () => {},
		},
		updatePendingMessagesDisplay() {},
		showStatus() {},
		syncComposerShape() {},
		syncExtensionLinks() {},
		statusLine: {
			setCollabStatus() {},
			invalidate() {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
	} as unknown as InteractiveModeContext;
	const controller = new ExtensionUiController(ctx);
	const opened = Promise.withResolvers<void>();
	const ui: Harness["ui"] = {
		askDialog: (dialogQuestions, dialogOptions) => controller.showAskDialog(dialogQuestions, dialogOptions),
	};
	const toolUi: Harness["ui"] = {
		askDialog: (dialogQuestions, dialogOptions) => {
			const dialog = ui.askDialog(dialogQuestions, dialogOptions);
			opened.resolve();
			return dialog;
		},
	};
	const mock = createMockModel({
		responses: [{ content: [{ type: "toolCall", id: "ask-1", name: "ask", arguments: { questions } }] }],
		handler: { content: ["done"] },
	});
	// A plain model descriptor: the collab host serializes session state, and the mock's recorded
	// calls hold the cyclic request contexts.
	const { calls: _calls, ...model } = mock;
	const agent = new Agent({
		initialState: { model, systemPrompt: ["test"], tools: [ask], messages: [] },
		streamFn: mock.stream,
		convertToLlm,
		interruptMode: "immediate",
		steeringMode: "one-at-a-time",
		getToolContext: (call?: ToolCallContext) =>
			({ toolCall: call, hasUI: true, abort: () => agent.abort(), ui: toolUi }) as unknown as AgentToolContext,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: { getApiKey: () => "test-key" } as never,
		toolRegistry: new Map([["ask", ask as unknown as AgentTool]]),
	});
	sessionRef.current = session;
	ctx.session = session;
	ctx.sessionManager = session.sessionManager;
	const results: AgentToolResult<unknown>[] = [];
	agent.subscribe(event => {
		if (event.type === "tool_execution_end" && event.toolName === "ask") results.push(event.result);
	});
	cleanups.push(() => session.dispose());
	return {
		session,
		ctx,
		ui,
		results,
		opened: opened.promise,
		focused: () => focused,
		input(data) {
			if (!focused?.handleInput) throw new Error("Expected a focused input component");
			focused.handleInput(data);
		},
	};
}

/** An agent card as an extension hands it over; it spends the batch's one cooperative steering signal. */
async function sendCard(session: AgentSession): Promise<void> {
	await session.sendCustomMessage(
		{ customType: "envoy-message", content: "agent card", display: true },
		{ deliverAs: "steer", triggerTurn: true },
	);
	await settle();
}

async function sendPersonMessage(session: AgentSession, text: string): Promise<void> {
	await session.prompt(text, { streamingBehavior: "steer" });
	await settle();
}

/**
 * Waits for the run, which ends only once `ask` returns. If the dialog is still open, the run
 * is aborted, so a regression fails on the assertions after it instead of the test timeout.
 */
async function finish(h: Harness, run: Promise<unknown>): Promise<void> {
	if (h.focused() !== h.ctx.editor) await h.session.abort();
	await run;
}

function resultText(h: Harness): string {
	return JSON.stringify(h.results.map(result => result.content));
}

describe("ask closed by a person's message keeps only what was submitted", () => {
	it("does not report custom text the person had not submitted as their answer", async () => {
		const h = createHarness([question("deploy", "Deploy production?")]);
		const run = h.session.prompt("start");
		await h.opened;
		h.input(DOWN);
		h.input(DOWN);
		h.input(ENTER);
		h.input("Yes, deploy");

		await sendCard(h.session);
		await sendPersonMessage(h.session, "wait, I am still composing my answer");
		await finish(h, run);

		expect(resultText(h)).not.toContain("Yes, deploy");
		expect(resultText(h)).toContain("Ask interrupted by message");
	});

	it("keeps a guest's finished refusal over the host's unsubmitted text", async () => {
		const h = createHarness([question("first", "Deploy production?"), question("second", "Notify the team?")]);
		installInMemoryRelay();
		const host = new CollabHost(h.ctx);
		await host.start("ws://localhost:8787");
		h.ctx.collabHost = host;
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
		const frames: CollabFrame[] = [];
		const waiting: Array<() => void> = [];
		guest.onFrame = frame => {
			frames.push(frame);
			waiting.shift()?.();
		};
		const nextFrame = async (kind: CollabFrame["t"]): Promise<CollabFrame> => {
			for (;;) {
				const index = frames.findIndex(frame => frame.t === kind);
				if (index >= 0) return frames.splice(index, 1)[0]!;
				const { promise, resolve } = Promise.withResolvers<void>();
				waiting.push(resolve);
				await promise;
			}
		};
		guest.onOpen = () =>
			guest.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: "guest",
				writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
			});
		guest.connect();
		cleanups.push(async () => {
			guest.close();
			await host.stop("test done");
			uninstallInMemoryRelay();
		});
		await nextFrame("welcome");

		const run = h.session.prompt("start");
		await h.opened;
		const firstRequest = await nextFrame("ui-request");
		if (firstRequest.t !== "ui-request") throw new Error("expected a guest ui-request");
		// The guest answers "No" and moves on to the second question.
		guest.send({ t: "ui-response", reqId: firstRequest.request.reqId, value: "No" });
		await nextFrame("ui-request");
		// The host's person types "Yes, deploy" into the first question's custom answer, without Enter.
		h.input(DOWN);
		h.input(DOWN);
		h.input(ENTER);
		h.input("Yes, deploy");

		await sendCard(h.session);
		await sendPersonMessage(h.session, "status update only");
		await finish(h, run);

		expect(h.results[0]?.details).toMatchObject({
			results: [{ id: "first", selectedOptions: ["No"], customInput: undefined }],
		});
		expect(resultText(h)).not.toContain("Yes, deploy");
	});

	it("keeps a multi-select the person confirmed empty as their answer", async () => {
		const h = createHarness([question("features", "Which features?", true), question("next", "Continue?")]);
		const run = h.session.prompt("start");
		await h.opened;
		// Enter on a multi-select confirms its checks, here none.
		h.input(ENTER);

		await sendCard(h.session);
		await sendPersonMessage(h.session, "stop the remaining questions");
		await finish(h, run);

		expect(h.results[0]?.details).toMatchObject({ results: [{ id: "features", selectedOptions: [] }] });
		expect(resultText(h)).toContain("features: []");
	});

	it("keeps a note the person submitted on an option they had not picked", async () => {
		const h = createHarness([question("first", "Deploy production?"), question("second", "Notify the team?")]);
		const run = h.session.prompt("start");
		await h.opened;
		h.input("n");
		h.input("Never deploy this to production");
		h.input(ENTER);
		await settle();

		await sendCard(h.session);
		await sendPersonMessage(h.session, "please read my note before proceeding");
		await finish(h, run);

		expect(resultText(h)).toContain("note on Yes: Never deploy this to production");
	});

	it("keeps the note confirmed with an answer when the person toggles the check off afterwards", async () => {
		const h = createHarness([question("first", "Deploy production?", true), question("second", "Notify the team?")]);
		const run = h.session.prompt("start");
		await h.opened;
		// Check Yes, submit a note on it, and confirm with Enter.
		h.input(SPACE);
		h.input("n");
		h.input("Only on staging, never production");
		h.input(ENTER);
		await settle();
		h.input(ENTER);
		// Back on the first question, toggle Yes off without confirming.
		h.input(SHIFT_TAB);
		h.input(SPACE);

		await sendCard(h.session);
		await sendPersonMessage(h.session, "go ahead with what I said");
		await finish(h, run);

		expect(h.results[0]?.details).toMatchObject({
			results: [{ id: "first", selectedOptions: ["Yes"], note: "Only on staging, never production" }],
		});
		expect(resultText(h)).toContain("Only on staging, never production");
	});
});

describe("ask on a remote client keeps an answer received within the reply window", () => {
	it("returns an ACP answer whose bytes arrive after the message, within the window", async () => {
		const h = createHarness([question("deploy", "Deploy production?")]);
		const formOpened = Promise.withResolvers<void>();
		const answerHeld = Promise.withResolvers<void>();
		let deliverAnswer = (): void => {
			throw new Error("the client's answer never reached the transport");
		};
		// Holds the client's serialized response between the two connections.
		const toAgent = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				if (new TextDecoder().decode(chunk).includes('"result"')) {
					deliverAnswer = () => controller.enqueue(chunk);
					answerHeld.resolve();
				} else {
					controller.enqueue(chunk);
				}
			},
		});
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const submitted = Promise.withResolvers<CreateElicitationResponse>();
		new ClientSideConnection(
			() => ({
				requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
				sessionUpdate: async () => {},
				unstable_createElicitation: () => {
					formOpened.resolve();
					return submitted.promise;
				},
			}),
			ndJsonStream(toAgent.writable, toClient.readable),
		);
		const connection = new AgentSideConnection(
			() => ({
				initialize: params => ({ protocolVersion: params.protocolVersion }),
				newSession: async () => ({ sessionId: "acp-ask" }),
				prompt: async () => ({ stopReason: "end_turn" }),
				cancel: async () => {},
			}),
			ndJsonStream(toClient.writable, toAgent.readable),
		);
		const acpUi = createAcpExtensionUiContext(connection, () => "acp-ask", { elicitation: { form: {} } });
		h.ui.askDialog = (dialogQuestions, dialogOptions) => acpUi.askDialog!(dialogQuestions, dialogOptions);
		const run = h.session.prompt("start");
		await formOpened.promise;
		await sendCard(h.session);

		// The person submits the form; the answer is on the wire when their message arrives, and
		// reaches omp within the reply window.
		submitted.resolve({ action: "accept", content: { q0__other: "No, do not deploy production" } });
		await answerHeld.promise;
		await sendPersonMessage(h.session, "please also update documentation");
		deliverAnswer();
		await run;

		expect(resultText(h)).toContain("No, do not deploy production");
	});

	it("returns an RPC answer the host sent before the message, read after it within the window", async () => {
		const h = createHarness([question("deploy", "Deploy production?")]);
		const pending = new Map<string, PendingExtensionRequest>();
		const askFrame = Promise.withResolvers<{ id: string }>();
		h.ui.askDialog = (dialogQuestions, dialogOptions) =>
			requestRpcAskDialog(
				pending,
				frame => {
					if ("method" in frame && frame.method === "ask" && typeof frame.id === "string")
						askFrame.resolve({ id: frame.id });
				},
				dialogQuestions,
				dialogOptions,
			);
		const run = h.session.prompt("start");
		const request = await askFrame.promise;
		await sendCard(h.session);

		// The host's answer is on stdin behind the person's message, which arrived another way.
		const answer = {
			type: "extension_ui_response",
			id: request.id,
			answers: [{ id: "deploy", selectedOptions: ["No"] }],
		} as RpcExtensionUIResponse;
		await sendPersonMessage(h.session, "please also update documentation");
		pending.get(request.id)?.resolve(answer);
		await finish(h, run);

		expect(resultText(h)).toContain("User selected: No");
	});

	it("closes an RPC ask at once when the host acknowledges the withdrawal", async () => {
		const h = createHarness([question("deploy", "Deploy production?")]);
		const pending = new Map<string, PendingExtensionRequest>();
		const askFrame = Promise.withResolvers<{ id: string }>();
		h.ui.askDialog = (dialogQuestions, dialogOptions) =>
			requestRpcAskDialog(
				pending,
				frame => {
					if (!("method" in frame)) return;
					if (frame.method === "ask" && typeof frame.id === "string") askFrame.resolve({ id: frame.id });
					// The host closes the unanswered dialog and says so.
					if (frame.method === "cancel" && "targetId" in frame && typeof frame.targetId === "string") {
						pending.get(frame.targetId)?.resolve({
							type: "extension_ui_response",
							id: frame.targetId,
							cancelled: true,
						});
					}
				},
				dialogQuestions,
				dialogOptions,
			);
		const run = h.session.prompt("start");
		await askFrame.promise;
		await sendCard(h.session);
		await sendPersonMessage(h.session, "please also update documentation");
		await run;

		expect(resultText(h)).toContain("Ask interrupted by message");
	});
});
