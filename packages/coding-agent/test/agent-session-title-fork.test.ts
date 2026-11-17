import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { humanizePlanTitle } from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as titleDriftClassifier from "@oh-my-pi/pi-coding-agent/session/title-drift-classifier";
import { TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

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
	it("计划批准后的合成消息也生成带卡片的正常标题", async () => {
		const main = createMockModel({ handler: { content: ["Reading the approved plan."] } });
		const side = createMockModel({ handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side);
		const titled = nextTitle(target);

		target.seedAutoTitle(humanizePlanTitle("fix-flaky-park-tests"));
		await target.prompt("Execute the approved plan.", { synthetic: true });
		await titled;

		expect(target.sessionName).toBe("🧪 FLAKY: Fix flaky park tests");
		expect(side.calls[0]!.context.messages[0]).toEqual(main.calls[0]!.context.messages[0]);
	});

	it("逐条偏离检查通过首次命名的同一请求重新生成标题并复用前缀缓存", async () => {
		const main = createMockModel({ handler: { content: ["Reading the requested files."] } });
		const side = createMockModel({
			responses: [
				{ content: [CARD_REPLY] },
				{ content: ['<title emoji="📝" code="NOTES">Draft release notes</title>'] },
			],
		});
		const target = await createSession(main, side, { "title.refreshOnDrift": true });
		const titleModel = vi.spyOn(ai, "completeSimple");
		const drift = vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(true);
		let titled = nextTitle(target);
		await target.prompt(FIRST_MESSAGE);
		await titled;

		titled = nextTitle(target);
		await target.prompt("now draft the release notes");
		await titled;

		expect(target.sessionName).toBe("📝 NOTES: Draft release notes");
		expect(drift).toHaveBeenCalledTimes(1);
		expect(drift.mock.calls[0]![2].at(-1)).toEqual({ role: "user", text: "now draft the release notes" });
		expect(titleModel).not.toHaveBeenCalled();
		const first = side.calls[0]!;
		const refresh = side.calls[1]!;
		const foreground = main.calls[1]!;
		expect(refresh.context.messages.at(-1)?.content).toEqual(first.context.messages.at(-1)?.content);
		expect(refresh.context.systemPrompt).toEqual(foreground.context.systemPrompt);
		expect(refresh.context.tools).toEqual(foreground.context.tools);
		expect(refresh.context.messages.slice(0, foreground.context.messages.length)).toEqual(
			foreground.context.messages,
		);
		expect(refresh.options?.promptCacheKey).toBe(foreground.options?.promptCacheKey ?? foreground.options?.sessionId);
		expect(refresh.options?.reasoning).toBe(foreground.options?.reasoning);
		expect(refresh.options?.sessionId).not.toBe(foreground.options?.sessionId);
	});

	it("判断进行中收到的短消息仍逐条检查，未偏离时不生成标题", async () => {
		const main = createMockModel({ handler: { content: ["Continuing the park tests."] } });
		const side = createMockModel({ handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side, { "title.refreshOnDrift": true });
		await target.setSessionName("🧪 FLAKY: Fix flaky park tests", "auto");
		const firstStarted = Promise.withResolvers<void>();
		const secondChecked = Promise.withResolvers<void>();
		const verdict = Promise.withResolvers<boolean>();
		const drift = vi
			.spyOn(titleDriftClassifier, "classifyTitleDrift")
			.mockImplementationOnce(() => {
				firstStarted.resolve();
				return verdict.promise;
			})
			.mockImplementationOnce(async () => {
				secondChecked.resolve();
				return false;
			});

		await target.prompt("add a regression test for the park fixture");
		await firstStarted.promise;
		await target.prompt("ok thanks");
		verdict.resolve(false);
		await secondChecked.promise;

		expect(target.sessionName).toBe("🧪 FLAKY: Fix flaky park tests");
		expect(drift.mock.calls.map(call => call[2].at(-1))).toEqual([
			{ role: "user", text: "add a regression test for the park fixture" },
			{ role: "user", text: "ok thanks" },
		]);
		expect(side.calls).toHaveLength(0);
	});

	it("用户在偏离判断期间手动命名后，不再生成或覆盖标题", async () => {
		const main = createMockModel({ handler: { content: ["Reading the release notes."] } });
		const side = createMockModel({ handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side, { "title.refreshOnDrift": true });
		await target.setSessionName("Fix flaky park tests", "auto");
		const started = Promise.withResolvers<void>();
		const verdict = Promise.withResolvers<boolean>();
		vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockImplementation(() => {
			started.resolve();
			return verdict.promise;
		});

		await target.prompt("now draft the release notes");
		await started.promise;
		await target.setSessionName("My release", "user");
		verdict.resolve(true);
		await target.prompt("publish the release notes");

		expect(target.sessionName).toBe("My release");
		expect(side.calls).toHaveLength(0);
	});

	it("judge 立即返回时仍等待主回复开始，避免在主请求预热前分叉", async () => {
		const releaseMain = Promise.withResolvers<void>();
		const judged = Promise.withResolvers<void>();
		const main = createMockModel({
			handler: async () => {
				await releaseMain.promise;
				return { content: ["Reading the release notes."] };
			},
		});
		const side = createMockModel({
			handler: { content: ['<title emoji="📝" code="NOTES">Draft release notes</title>'] },
		});
		const target = await createSession(main, side, { "title.refreshOnDrift": true });
		await target.setSessionName("Fix flaky park tests", "auto");
		vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockImplementation(async () => {
			judged.resolve();
			return true;
		});
		const titled = nextTitle(target);
		const run = target.prompt("now draft the release notes");
		try {
			await judged.promise;
			// 让当前微任务队列耗尽；主回复仍由显式门闩阻塞，不等待墙钟时间。
			await scheduler.yield();
			expect(side.calls).toHaveLength(0);
			expect(target.sessionName).toBe("Fix flaky park tests");
		} finally {
			releaseMain.resolve();
			await run;
		}
		await titled;

		expect(target.sessionName).toBe("📝 NOTES: Draft release notes");
		expect(side.calls).toHaveLength(1);
	});

	it("主回复尚未开始时中断会释放标题刷新等待，不向下一轮遗留分叉", async () => {
		const releaseMain = Promise.withResolvers<void>();
		const judged = Promise.withResolvers<void>();
		const main = createMockModel({
			responses: [
				async () => {
					await releaseMain.promise;
					return { content: ["Reading the release notes."] };
				},
			],
			handler: { content: ["Continuing internally."] },
		});
		const side = createMockModel({ handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side, { "title.refreshOnDrift": true });
		await target.setSessionName("Fix flaky park tests", "auto");
		vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockImplementation(async () => {
			judged.resolve();
			return true;
		});
		const run = target.prompt("now draft the release notes");
		await judged.promise;
		await scheduler.yield();
		const aborted = target.abort();
		releaseMain.resolve();
		await aborted;
		await run;
		await target.prompt("Continue internally.", { synthetic: true });

		expect(target.sessionName).toBe("Fix flaky park tests");
		expect(side.calls).toHaveLength(0);
	});

	it("通过原生 System One 的偏离结果触发标题分叉", async () => {
		const main = createMockModel({ handler: { content: ["Reading the release notes."] } });
		const side = createMockModel({
			handler: { content: ['<title emoji="📝" code="NOTES">Draft release notes</title>'] },
		});
		const target = await createSession(main, side, { "title.refreshOnDrift": true });
		authStorage!.keys.setRuntime("typesafe", "judge-key");
		const judgeModel = target.modelRegistry.getAvailable("all").find(model => model.api === "typesafe");
		if (!judgeModel) throw new Error("Expected a bundled System One model");
		target.settings.setModelRole("judge", `${judgeModel.provider}/${judgeModel.id}`);
		await target.setSessionName("🧪 FLAKY: Fix flaky park tests", "auto");
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async url => {
				urls.push(String(url));
				return Response.json({
					model: judgeModel.id,
					answers: { fits: { type: "noul", noul: 0.1 } },
					usage: { input_tokens: 8, output_tokens: 1 },
				});
			}),
		);
		const titled = nextTitle(target);

		await target.prompt("now draft the release notes");
		await titled;

		expect(target.sessionName).toBe("📝 NOTES: Draft release notes");
		expect(urls).toEqual([expect.stringMatching(/\/v1\/systemone$/)]);
		expect(side.calls).toHaveLength(1);
	});

	it("中断取消偏离后的标题分叉，不覆盖旧标题也不启动 tiny 回退", async () => {
		const main = createMockModel({ handler: { content: ["Reading the release notes."] } });
		const started = Promise.withResolvers<void>();
		const side = createMockModel({
			handler: () => {
				started.resolve();
				return { content: ['<title emoji="📝" code="NOTES">Draft release notes</title>'], delayMs: 60_000 };
			},
		});
		const target = await createSession(main, side, { "title.refreshOnDrift": true });
		await target.setSessionName("Fix flaky park tests", "auto");
		vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(true);
		const titleModel = vi.spyOn(ai, "completeSimple");

		await target.prompt("now draft the release notes");
		await started.promise;
		await target.abort();
		await target.prompt("Continue internally.", { synthetic: true });

		expect(target.sessionName).toBe("Fix flaky park tests");
		expect(side.calls).toHaveLength(1);
		expect(titleModel).not.toHaveBeenCalled();
	});

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
});
