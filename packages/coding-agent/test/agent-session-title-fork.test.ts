import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as titleDriftClassifier from "@oh-my-pi/pi-coding-agent/session/title-drift-classifier";
import { TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createAssistantMessage } from "./helpers/agent-session-setup";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
// Full-suite files that boot main() in ACP/RPC mode leave PI_NO_TITLE=1 behind,
// which gates titling off.
let previousNoTitle: string | undefined;

beforeEach(() => {
	previousNoTitle = Bun.env.PI_NO_TITLE;
	delete Bun.env.PI_NO_TITLE;
});

afterEach(async () => {
	if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
	else Bun.env.PI_NO_TITLE = previousNoTitle;
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	session = undefined;
	authStorage = undefined;
});

const FIRST_MESSAGE = "fix the flaky park tests";
const CARD_REPLY = '<title nf="nf-md-flask" emoji="🧪" code="FLAKY">Fix flaky park tests</title>';

/**
 * A session whose main turns answer from `main` and whose side turns (the title fork) from `side`;
 * `todo` gives the agent the todo tool, whose replans refresh the title.
 */
async function createSession(
	main: MockModel,
	side: MockModel,
	settings: Record<string, unknown> = {},
	{ autoTitle = true, todo = false }: { autoTitle?: boolean; todo?: boolean } = {},
): Promise<AgentSession> {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const sessionManager = SessionManager.inMemory();
	const sessionSettings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		modelRoles: { tiny: `${model.provider}/${model.id}` },
		// The default `nf+emoji` follows the global theme's symbol preset, which an
		// earlier file in the suite can leave on nerd glyphs; the card under test is emoji.
		"title.icons": "emoji",
		...settings,
	});
	const tools: AgentTool[] = [];
	if (todo) {
		const toolSession: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings: sessionSettings,
			setTodoPhases: phases => session?.setTodoPhases(phases),
		};
		tools.push(new TodoTool(toolSession) as unknown as AgentTool);
	}
	session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			streamFn: main.stream,
		}),
		sessionManager,
		settings: sessionSettings,
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		sideStreamFn: side.stream,
		autoTitle,
	});
	return session;
}

/** The text of a title-model request: the title prompt's input, or the title a card request heads. */
function titleRequestInput(context: ai.Context): string {
	const content = context.messages[0]?.content;
	return typeof content === "string" ? content : "";
}

/** Resolves on the session's next title change. */
function nextTitle(target: AgentSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = target.sessionManager.onSessionNameChanged(() => {
		unsubscribe();
		resolve();
	});
	return promise;
}

describe("AgentSession title fork", () => {
	it("titles the session from a fork of the first reply, sharing the main request's prefix and cache key", async () => {
		const main = createMockModel({ responses: [{ content: ["Reading the park tests first."] }] });
		const side = createMockModel({ handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side);
		const titleModel = vi.spyOn(ai, "completeSimple");
		const titled = nextTitle(target);

		await target.prompt(FIRST_MESSAGE);
		await titled;

		expect(target.sessionName).toBe("🧪 FLAKY: Fix flaky park tests");
		expect(titleModel).not.toHaveBeenCalled();
		const mainCall = main.calls[0]!;
		const sideCall = side.calls[0]!;
		expect(sideCall.context.systemPrompt).toEqual(mainCall.context.systemPrompt);
		expect(sideCall.context.tools).toEqual(mainCall.context.tools);
		expect(sideCall.context.messages.slice(0, mainCall.context.messages.length)).toEqual(mainCall.context.messages);
		// Providers key the prompt cache on `promptCacheKey`, else the session id.
		expect(sideCall.options?.promptCacheKey).toBe(mainCall.options?.promptCacheKey ?? mainCall.options?.sessionId);
		// The fork runs beside the main turn, which finishes on its own.
		expect(target.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it.each<[string, MockResponse, MockResponse]>([
		["the fork declines", { content: ["Reading the park tests first."] }, { content: ["<title/>"] }],
		["the fork request fails", { content: ["Reading the park tests first."] }, { throw: "overloaded" }],
	])("falls back to the title model, then cards its title, when %s", async (_case, mainResponse, sideResponse) => {
		const main = createMockModel({ responses: [mainResponse] });
		const side = createMockModel({ handler: sideResponse });
		const target = await createSession(main, side);
		const titleInputs: string[] = [];
		const replies = ["<title>Fix flaky park tests</title>", "<title>🧪 FLAKY</title>"];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			titleInputs.push(titleRequestInput(context));
			return createAssistantMessage(replies[titleInputs.length - 1] ?? "<title/>");
		});
		const titled = nextTitle(target);

		await target.prompt(FIRST_MESSAGE);
		await titled;

		expect(target.sessionName).toBe("🧪 FLAKY: Fix flaky park tests");
		expect(titleInputs).toHaveLength(2);
		expect(titleInputs[0]).toContain(FIRST_MESSAGE);
		expect(titleInputs[1]).toContain("Fix flaky park tests");
	});

	it.each([
		["omits the code", '<title nf="nf-md-flask" emoji="🧪">Fix flaky park tests</title>'],
		[
			"names a code over 6 letters",
			'<title nf="nf-md-flask" emoji="🧪" code="FLAKIEST">Fix flaky park tests</title>',
		],
	])("cards the title of a fork reply that %s", async (_case, reply) => {
		const main = createMockModel({ responses: [{ content: ["Reading the park tests first."] }] });
		const side = createMockModel({ handler: { content: [reply] } });
		const target = await createSession(main, side);
		const titleInputs: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			titleInputs.push(titleRequestInput(context));
			return createAssistantMessage("<title>🅿️ PARK</title>");
		});
		const titled = nextTitle(target);

		await target.prompt(FIRST_MESSAGE);
		await titled;

		expect(target.sessionName).toBe("🅿️ PARK: Fix flaky park tests");
		expect(titleInputs).toEqual([expect.stringContaining("Fix flaky park tests")]);
	});

	it("keeps the fork's card when a todo replan lands while the fork is still naming the session", async () => {
		// The first reply opens with a todo init; its replan refresh ran on the fast title
		// model, named the session first, and made the fork drop its card reply.
		const main = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "todo",
							arguments: { op: "init", list: [{ phase: "Park", items: ["Stabilize park test timing"] }] },
						},
					],
				},
				{ content: ["Planned the park fixes."] },
			],
		});
		const turnEnded = Promise.withResolvers<void>();
		const side = createMockModel({
			handler: async () => {
				await turnEnded.promise;
				return { content: [CARD_REPLY] };
			},
		});
		const target = await createSession(main, side, {}, { todo: true });
		const titleModel = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage("<title>Stabilize park test timing</title>"));
		const titled = nextTitle(target);

		await target.prompt(FIRST_MESSAGE);
		turnEnded.resolve();
		await titled;

		expect(target.getTodoPhases()).toHaveLength(1);
		expect(target.sessionName).toBe("🧪 FLAKY: Fix flaky park tests");
		expect(titleModel).not.toHaveBeenCalled();
	});

	it("forks a title for a message that arrived while a declining title request still ran", async () => {
		const main = createMockModel({ handler: { content: ["Reading the park tests first."] } });
		const side = createMockModel({ responses: [{ content: ["<title/>"] }], handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side);
		const titleModelStarted = Promise.withResolvers<void>();
		const titleModelReply = Promise.withResolvers<ai.AssistantMessage>();
		const titleModel = vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			titleModelStarted.resolve();
			return titleModelReply.promise;
		});

		// The first message's fork declines, so the title model takes over and is still running...
		await target.prompt("look at the park tests");
		await titleModelStarted.promise;
		// ...when the second message's reply begins; the title model then declines too.
		await target.prompt(FIRST_MESSAGE);
		const titled = nextTitle(target);
		titleModelReply.resolve(createAssistantMessage("<title/>"));
		await titled;

		expect(target.sessionName).toBe("🧪 FLAKY: Fix flaky park tests");
		expect(side.calls).toHaveLength(2);
		expect(titleModel).toHaveBeenCalledTimes(1);
	});

	it("titles with the title model alone under title.generator tiny", async () => {
		const main = createMockModel({ responses: [{ content: ["Reading the park tests first."] }] });
		const side = createMockModel({ handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side, { "title.generator": "tiny" });
		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("<title>Fix flaky park tests</title>"));
		const titled = nextTitle(target);

		await target.prompt(FIRST_MESSAGE);
		await titled;

		expect(target.sessionName).toBe("Fix flaky park tests");
		expect(side.calls).toHaveLength(0);
	});

	it("retitles from the steer an interrupt flushes after it cancelled the first message's fork", async () => {
		const steer = "move the park fixture into a helper";
		const main = createMockModel({
			// The reply starts (forking the title), then a tool call keeps the run going...
			responses: [{ content: ["Reading the park tests first.", { type: "toolCall", name: "read", arguments: {} }] }],
			// ...streaming until the interrupt delivers the steer, which gets a prompt reply.
			handler: context => {
				const last = context.messages.at(-1);
				const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
				return last?.role === "user" && text.includes(steer)
					? { content: ["Moving the park fixture into a helper."] }
					: { content: ["Still reading."], delayMs: 60_000 };
			},
		});
		const firstForkStarted = Promise.withResolvers<void>();
		const side = createMockModel({
			responses: [
				() => {
					firstForkStarted.resolve();
					return { content: [CARD_REPLY], delayMs: 60_000 };
				},
			],
			handler: { content: [CARD_REPLY] },
		});
		const target = await createSession(main, side);
		const titleModel = vi.spyOn(ai, "completeSimple");
		const titled = nextTitle(target);

		const run = target.prompt(FIRST_MESSAGE);
		await firstForkStarted.promise;
		await target.prompt(steer, { streamingBehavior: "steer" });
		// Empty Enter with a queued steer: interrupt the turn and deliver the steer.
		await target.abort({ reason: USER_INTERRUPT_LABEL });
		await titled;
		await run;

		expect(target.sessionName).toBe("🧪 FLAKY: Fix flaky park tests");
		expect(side.calls).toHaveLength(2);
		expect(titleModel).not.toHaveBeenCalled();
	});

	it("leaves sessions without autoTitle unnamed", async () => {
		const main = createMockModel({ responses: [{ content: ["Reading the park tests first."] }] });
		const side = createMockModel({ handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side, {}, { autoTitle: false });
		const titleModel = vi.spyOn(ai, "completeSimple");

		await target.prompt(FIRST_MESSAGE);

		expect(target.sessionName).toBeUndefined();
		expect(side.calls).toHaveLength(0);
		expect(titleModel).not.toHaveBeenCalled();
	});

	describe("with a plan written while the fork title is open", () => {
		const todoInit = (task: string): MockResponse => ({
			content: [
				{ type: "toolCall", name: "todo", arguments: { op: "init", list: [{ phase: "Work", items: [task] }] } },
			],
		});
		const planWritten: MockResponse = { content: ["Plan saved."] };

		/** A fork that answers a plain title once `release` resolves. */
		function heldFork(release: Promise<void>): MockModel {
			return createMockModel({
				handler: async () => {
					await release;
					return { content: ["<title>Initial parser title</title>"] };
				},
			});
		}

		/** The title model names the plan a request carries; `hold` makes the first request wait for `release()`. */
		function titleModel(hold: boolean) {
			const requests: string[] = [];
			const firstRequested = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
				const input = titleRequestInput(context);
				requests.push(input);
				if (requests.length === 1) {
					firstRequested.resolve();
					if (hold) await release.promise;
				}
				const task = input.match(/<plan>\s*Work: ([^<\n]+)/)?.[1];
				return createAssistantMessage(`<title>${task ?? "Initial parser title"}</title>`);
			});
			return { requests, firstRequested: firstRequested.promise, release: () => release.resolve() };
		}

		async function settleTitles(): Promise<void> {
			for (let i = 0; i < 100; i++) {
				const tick = Promise.withResolvers<void>();
				setImmediate(tick.resolve);
				await tick.promise;
			}
		}

		it("titles only the newest plan when a plan is written while the fork title is being saved", async () => {
			const forkReply = Promise.withResolvers<void>();
			const main = createMockModel({
				responses: [todoInit("Prepare migration"), planWritten, todoInit("Prove eta rule"), planWritten],
				handler: planWritten,
			});
			const target = await createSession(
				main,
				heldFork(forkReply.promise),
				{ "title.generator": "fork", "title.icons": "boring", "title.refreshOnReplan": true, "todo.enabled": true },
				{ todo: true },
			);
			const model = titleModel(false);
			const names: string[] = [];
			target.sessionManager.onSessionNameChanged(() => names.push(target.sessionName ?? ""));

			// The first plan is written while the fork names the session, so it waits.
			await target.prompt("continue the parser project");
			const saving = Promise.withResolvers<void>();
			const saved = Promise.withResolvers<void>();
			const setSessionName = target.sessionManager.setSessionName.bind(target.sessionManager);
			vi.spyOn(target.sessionManager, "setSessionName").mockImplementation(async (name, source) => {
				if (name === "Initial parser title") {
					saving.resolve();
					await saved.promise;
				}
				return setSessionName(name, source);
			});
			forkReply.resolve();
			await saving.promise;
			// A newer plan is written while the fork's title is being saved.
			await target.prompt("now prove the eta rule");
			saved.resolve();
			await settleTitles();

			expect(names).toEqual(["Initial parser title", "Prove eta rule"]);
			expect(model.requests).toHaveLength(1);
			expect(model.requests[0]).toContain("Work: Prove eta rule");
		});

		it("drops the fork title and the waiting plan when an interrupt lands during the card request", async () => {
			const forkReply = Promise.withResolvers<void>();
			const main = createMockModel({ responses: [todoInit("Prove eta rule"), planWritten], handler: planWritten });
			const target = await createSession(
				main,
				heldFork(forkReply.promise),
				{ "title.generator": "fork", "title.icons": "emoji", "title.refreshOnReplan": true, "todo.enabled": true },
				{ todo: true },
			);
			const model = titleModel(true);

			await target.prompt("continue the parser project");
			forkReply.resolve();
			// The first title-model request is the fork title's card request.
			await model.firstRequested;
			await target.abort({ reason: USER_INTERRUPT_LABEL });
			model.release();
			await settleTitles();

			expect(target.sessionName).toBeUndefined();
			expect(model.requests).toHaveLength(1);
			expect(model.requests[0]).not.toContain("<plan>");
		});

		/** The title model answers `replies` in order; the request at `holdAt` (0-based) waits for `release()`. */
		function heldTitleModel(replies: string[], holdAt: number) {
			const requests: string[] = [];
			const held = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
				const index = requests.push(titleRequestInput(context)) - 1;
				if (index === holdAt) {
					held.resolve();
					await release.promise;
				}
				return createAssistantMessage(replies[index] ?? "<title/>");
			});
			return { requests, held: held.promise, release: () => release.resolve() };
		}

		it("drops the title-model title when an interrupt lands during its card request", async () => {
			// The fork declines, so the title model names the session and a card request follows.
			const main = createMockModel({ responses: [{ content: ["Reading the park tests first."] }] });
			const target = await createSession(main, createMockModel({ handler: { content: ["<title/>"] } }));
			const model = heldTitleModel(["<title>Fix flaky park tests</title>", "<title>🧪 FLAKY</title>"], 1);

			await target.prompt(FIRST_MESSAGE);
			await model.held;
			await target.abort({ reason: USER_INTERRUPT_LABEL });
			model.release();
			await settleTitles();

			expect(target.sessionName).toBeUndefined();
			expect(model.requests).toHaveLength(2);
		});

		it("keeps the title when an interrupt lands during a replan retitle's card request", async () => {
			const main = createMockModel({ responses: [todoInit("Prove eta rule"), planWritten], handler: planWritten });
			const target = await createSession(
				main,
				createMockModel({ handler: { content: [CARD_REPLY] } }),
				{ "title.generator": "fork", "title.refreshOnReplan": true, "todo.enabled": true },
				{ todo: true },
			);
			await target.setSessionName("Fix flaky park tests", "auto");
			// The retitle names the plan plainly, so a card request follows it.
			const model = heldTitleModel(["<title>Prove eta rule</title>", "<title>🧪 ETA</title>"], 1);

			await target.prompt("now prove the eta rule");
			await model.held;
			await target.abort({ reason: USER_INTERRUPT_LABEL });
			model.release();
			await settleTitles();

			expect(target.sessionName).toBe("Fix flaky park tests");
			expect(model.requests).toHaveLength(2);
		});

		it("titles a plan written after an interrupt while the cancelled fork title is still being saved", async () => {
			const forkReply = Promise.withResolvers<void>();
			const main = createMockModel({
				responses: [planWritten, todoInit("Prove eta rule"), planWritten],
				handler: planWritten,
			});
			const target = await createSession(
				main,
				heldFork(forkReply.promise),
				{ "title.generator": "fork", "title.icons": "boring", "title.refreshOnReplan": true, "todo.enabled": true },
				{ todo: true },
			);
			const model = titleModel(false);
			await target.prompt("continue the parser project");
			const saving = Promise.withResolvers<void>();
			const saved = Promise.withResolvers<void>();
			const setSessionName = target.sessionManager.setSessionName.bind(target.sessionManager);
			vi.spyOn(target.sessionManager, "setSessionName").mockImplementation(async (name, source) => {
				if (name === "Initial parser title") {
					saving.resolve();
					await saved.promise;
				}
				return setSessionName(name, source);
			});
			forkReply.resolve();
			await saving.promise;

			// The interrupt lands while the fork's name is written; the next turn writes a plan.
			await target.abort({ reason: USER_INTERRUPT_LABEL });
			await target.prompt("now prove the eta rule");
			saved.resolve();
			await settleTitles();

			expect(target.sessionName).toBe("Prove eta rule");
			expect(model.requests).toHaveLength(1);
		});

		it("starts no request for the plans that waited for a replan retitle an interrupt cancelled", async () => {
			const main = createMockModel({
				responses: [
					todoInit("Prepare migration"),
					planWritten,
					todoInit("Fix tokenizer"),
					todoInit("Prove eta rule"),
					planWritten,
				],
				handler: planWritten,
			});
			const target = await createSession(
				main,
				createMockModel({ handler: { content: [CARD_REPLY] } }),
				{ "title.refreshOnReplan": true, "title.icons": "boring", "todo.enabled": true },
				{ todo: true },
			);
			await target.setSessionName("Original auto title", "auto");
			const model = titleModel(true);

			await target.prompt("continue the parser project");
			await model.firstRequested;
			// Two newer plans wait for the open retitle.
			await target.prompt("now prove the eta rule");
			await target.abort({ reason: USER_INTERRUPT_LABEL });
			model.release();
			await settleTitles();

			expect(target.sessionName).toBe("Original auto title");
			expect(model.requests).toHaveLength(1);
		});

		it.each([
			["tiny", { "title.generator": "tiny" }],
			["fork", { "title.generator": "fork", "title.icons": "boring" }],
		])(
			"titles a message sent after an interrupt once the cancelled %s title request settles",
			async (_route, config) => {
				const firstTitle = Promise.withResolvers<void>();
				const main = createMockModel({ handler: { content: ["Reading the code first."] } });
				// Under `fork` the first title request is the fork itself; it waits until released.
				const side = createMockModel({
					responses: [
						async () => {
							await firstTitle.promise;
							return { content: ["<title>Fix the parser</title>"] };
						},
					],
					handler: { content: ["<title>Verify the kernel checker</title>"] },
				});
				const target = await createSession(main, side, config);
				const requests: string[] = [];
				vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
					const input = titleRequestInput(context);
					requests.push(input);
					if (input.includes("fix the parser")) await firstTitle.promise;
					return createAssistantMessage(
						`<title>${input.includes("kernel checker") ? "Verify the kernel checker" : "Fix the parser"}</title>`,
					);
				});

				await target.prompt("fix the parser");
				await target.abort({ reason: USER_INTERRUPT_LABEL });
				// The next message's reply finishes while the cancelled request is still open.
				await target.prompt("verify the kernel checker");
				firstTitle.resolve();
				await settleTitles();

				expect(target.sessionName).toBe("Verify the kernel checker");
			},
		);

		it("starts no title request for a drift check an interrupt cancelled while the judge decided", async () => {
			const main = createMockModel({ handler: { content: ["Reading the code first."] } });
			const target = await createSession(main, createMockModel({ handler: { content: [CARD_REPLY] } }), {
				"title.generator": "tiny",
				"title.refreshAfterPrompts": 1,
			});
			await target.setSessionName("Original auto title", "auto");
			const judging = Promise.withResolvers<void>();
			const verdict = Promise.withResolvers<void>();
			vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockImplementation(async () => {
				judging.resolve();
				await verdict.promise;
				return true;
			});
			const titleModel = vi
				.spyOn(ai, "completeSimple")
				.mockResolvedValue(createAssistantMessage("<title>Obsolete parser title</title>"));

			await target.prompt("continue the parser project");
			await judging.promise;
			await target.abort({ reason: USER_INTERRUPT_LABEL });
			verdict.resolve();
			await settleTitles();

			expect(titleModel).not.toHaveBeenCalled();
			expect(target.sessionName).toBe("Original auto title");
		});

		it("drops a title retry deferred before an idle interrupt", async () => {
			const longReply = "Reading the parser and its tests before changing anything. ".repeat(20);
			const main = createMockModel({
				responses: [{ content: ["Reading the code first."] }, { content: [longReply] }],
				handler: { content: ["done"] },
			});
			const target = await createSession(main, createMockModel({ handler: { content: [CARD_REPLY] } }), {
				"title.generator": "tiny",
			});
			const requests: string[] = [];
			vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
				requests.push(titleRequestInput(context));
				// The first message is declined, so a retry from the conversation waits for its reply.
				return createAssistantMessage(requests.length === 1 ? "<title/>" : "<title>Obsolete parser title</title>");
			});

			await target.prompt("continue the parser project");
			await settleTitles();
			expect(requests).toHaveLength(1);
			await target.abort({ reason: USER_INTERRUPT_LABEL });
			// A low-signal message names nothing itself; only the deferred retry could.
			await target.prompt("hi");
			await settleTitles();

			expect(requests).toHaveLength(1);
			expect(target.sessionName).toBeUndefined();
		});
	});
});
