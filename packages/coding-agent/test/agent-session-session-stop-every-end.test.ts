import { afterAll, afterEach, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { AgentEndEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTracker } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/transcript/messages";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { flush } from "@oh-my-pi/pi-utils/logger";
import * as compaction from "../../agent/src/compaction";
import { Agent, type AgentMessage, type AgentTool } from "../../agent/src/index";
import { activateTodoTool, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Import this type from the session once it exports the route inventory.
type StopRoute =
	| "normal"
	| "no-assistant-message"
	| "skip-post-turn-maintenance"
	| "skip-superseded-speculative-maintenance"
	| "successful-yield"
	| "active-goal-compaction-blocked"
	| "aborted"
	| "trailing-tool-call"
	| "compaction-blocked"
	| "maintenance-failed";

type Answer = "observe" | "continue" | "block";
type Family = "openai-responses" | "anthropic-messages";
type Settle = { kind: "end"; text: string; willContinue: boolean; awaitingAsyncWork: boolean };
type Observation = Settle | { kind: "stop" | "second handler"; text: string };
interface Fixture {
	session: AgentSession;
	mock: MockModel;
	events: Observation[];
	sessionEvents: AgentSessionEvent[];
	cwd: string;
	arm(text: string): void;
}
interface Options {
	family?: Family;
	settings?: Parameters<typeof Settings.isolated>[0];
	tools?: AgentTool[];
	kind?: "main" | "sub";
	jobs?: AsyncJobManager;
}
interface Case {
	name: string;
	continuation: "allowed" | "refused";
	drive(answer: Answer): Promise<void>;
}

const SEED = "Earlier answer.";
const TARGET = "Answer to the first request.";
const NEXT = "Answer to the next user request.";
const FOLLOW_UP = "Answer to the hidden continuation.";
const HIDDEN = "Context requested only by the stop handler.";
const SUMMARY = "## Goal\nContinue from the earlier answer.";
const WINDOW = 128_000;
const BAND = 96_000;
const GRACE_BAND = 112_000;
const auth = createInMemoryAuthStorage();
for (const provider of ["mock", "gateway-openai", "anthropic"]) auth.keys.setRuntime(provider, "test-key");
const modelRegistry = new ModelRegistry(auth);
let fixture: Fixture | undefined;
let tempDir: TempDir | undefined;
const cleanups: Array<() => void | Promise<void>> = [];

function assistantText(message: AgentMessage | undefined): string {
	if (message?.role !== "assistant") return "";
	return message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
}

function end(text: string, willContinue = false, awaitingAsyncWork = false): Settle {
	return { kind: "end", text, willContinue, awaitingAsyncWork };
}

function stop(text: string): Observation {
	return { kind: "stop", text };
}

async function setup(responses: MockHandler[], answer: Answer, options: Options = {}): Promise<Fixture> {
	tempDir = TempDir.createSync("@pi-stop-every-end-");
	const cwd = tempDir.path();
	const family = options.family;
	const provider =
		family === "openai-responses" ? "gateway-openai" : family === "anthropic-messages" ? "anthropic" : "mock";
	const id =
		family === "openai-responses" ? "gpt-5" : family === "anthropic-messages" ? "claude-sonnet-4-5" : "mock-model";
	const mock = createMockModel({ id, provider, contextWindow: WINDOW, responses });
	const model: Model = family
		? {
				id,
				name: id,
				api: family,
				provider,
				input: ["text"],
				contextWindow: WINDOW,
				maxTokens: 16_384,
				baseUrl: "https://example.invalid",
				reasoning: false,
				cost: mock.cost,
				identity: mock.identity,
				compat:
					family === "anthropic-messages"
						? getBundledModel<"anthropic-messages">("anthropic", id).compat
						: undefined,
			}
		: mock;
	const settings = Settings.isolated({
		"compaction.enabled": !!family,
		"compaction.asyncEnabled": !!family,
		"compaction.keepRecentTokens": 1,
		"compaction.autoContinue": false,
		"contextPromotion.enabled": false,
		"compaction.handoffSaveToDisk": false,
		"retry.enabled": false,
		"retry.modelFallback": false,
		"todo.enabled": false,
		"todo.reminders": false,
		...(family === "anthropic-messages" ? { "compaction.methodOrder": ["handoff"] } : {}),
		...options.settings,
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const tools = options.tools ?? [];
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools },
		getApiKey: () => "test-key",
		convertToLlm,
		streamFn: mock.stream,
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const events: Observation[] = [];
	const sessionEvents: AgentSessionEvent[] = [];
	let target: string | undefined = TARGET;
	const runtime = new ExtensionRuntime();
	const eventBus = new EventBus();
	const first = await loadExtensionFromFactory(
		pi => {
			pi.on("session_stop", async event => {
				// Record completion so the order assertion checks that the host awaits the handler.
				await scheduler.yield();
				const text = assistantText(event.last_assistant_message);
				events.push(stop(text));
				if (target === undefined || text !== target) return;
				target = undefined;
				if (answer === "continue") return { continue: true, additionalContext: HIDDEN };
				if (answer === "block") return { decision: "block", reason: HIDDEN };
			});
			pi.on("agent_end", (event: AgentEndEvent) => {
				const message = event.messages.findLast(message => message.role === "assistant");
				events.push(end(assistantText(message), event.willContinue === true, event.awaitingAsyncWork === true));
			});
		},
		cwd,
		eventBus,
		runtime,
		"stop-observer",
	);
	const extensions = [first];
	if (answer === "block") {
		extensions.push(
			await loadExtensionFromFactory(
				pi => {
					pi.on("session_stop", event => {
						events.push({ kind: "second handler", text: assistantText(event.last_assistant_message) });
					});
				},
				cwd,
				eventBus,
				runtime,
				"second-stop-observer",
			),
		);
	}
	const session = new AgentSession({
		agent,
		settings,
		modelRegistry,
		sessionManager,
		extensionRunner: new ExtensionRunner(extensions, runtime, cwd, sessionManager, modelRegistry),
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		agentKind: options.kind,
		agentId: options.jobs ? "Main" : undefined,
		asyncJobManager: options.jobs,
	});
	session.subscribe(event => {
		sessionEvents.push(event);
	});
	fixture = {
		session,
		mock,
		events,
		sessionEvents,
		cwd,
		arm: text => {
			target = text;
		},
	};
	return fixture;
}

afterEach(async () => {
	try {
		for (const cleanup of cleanups.reverse()) await cleanup();
		await fixture?.session.dispose();
	} finally {
		cleanups.length = 0;
		fixture = undefined;
		vi.restoreAllMocks();
		await tempDir?.remove();
		tempDir = undefined;
	}
});
afterAll(() => {
	flush();
	auth.close();
});

function reply(text: string, tokens = 40): MockResponse {
	return { content: [text], stopReason: "stop", usage: { input: tokens - 10, output: 10, totalTokens: tokens } };
}

function gate<T>(cleanupValue: T): PromiseWithResolvers<T> {
	const deferred = Promise.withResolvers<T>();
	cleanups.push(() => deferred.resolve(cleanupValue));
	return deferred;
}

function reached<T>(promise: Promise<T>, label: string): Promise<T> {
	return withTimeout(promise, 2_000, new Error(`Did not reach ${label}`));
}

async function idle(f: Fixture): Promise<void> {
	await f.session.waitForIdle();
	// The run check sends extension notifications without awaiting them.
	await scheduler.yield();
}

async function prompt(f: Fixture, text = "Answer this request."): Promise<void> {
	await f.session.prompt(text);
	await idle(f);
}

function passCount(f: Fixture): number {
	return f.events.filter(event => event.kind === "stop").length;
}

function requestContains(f: Fixture, index: number, text: string): boolean {
	const call = f.mock.calls[index];
	if (!call) throw new Error(`Missing model request ${index + 1}`);
	return JSON.stringify(call.context.messages).includes(text);
}

function expectedPass(text: string, answer: Answer): Observation[] {
	return answer === "block" ? [stop(text), { kind: "second handler", text }] : [stop(text)];
}

function verifyAllowed(f: Fixture, answer: Answer, calls: number): void {
	const continued = answer === "continue";
	expect(passCount(f)).toBe(continued ? 2 : 1);
	expect(f.events).toEqual([
		stop(TARGET),
		end(TARGET, continued),
		...(continued ? [stop(FOLLOW_UP), end(FOLLOW_UP)] : []),
	]);
	expect(f.mock.calls).toHaveLength(calls + Number(continued));
	if (continued) expect(requestContains(f, calls, HIDDEN)).toBe(true);
}

async function verifyRefused(
	f: Fixture,
	answer: Answer,
	calls: number,
	text = TARGET,
	prior: Observation[] = [],
): Promise<void> {
	const ended = [...f.events];
	const callsAtEnd = f.mock.calls.length;
	// Take the next request even on the red base to check for leaked continuation context.
	if (answer !== "observe") {
		await f.session.prompt("Answer a new user request.", { skipCompactionCheck: true });
		await idle(f);
		expect(requestContains(f, callsAtEnd, "Answer a new user request.")).toBe(true);
		expect(requestContains(f, callsAtEnd, HIDDEN)).toBe(false);
	}
	expect(ended.filter(event => event.kind === "stop")).toHaveLength(1);
	expect(ended).toEqual([...prior, ...expectedPass(text, answer), end(text)]);
	expect(callsAtEnd).toBe(calls);
}

function holdHandoff() {
	const started = Promise.withResolvers<AbortSignal>();
	const finish = gate(SUMMARY);
	const spy = vi
		.spyOn(compaction, "generateHandoffFromContext")
		.mockImplementationOnce((_context, _model, options) => {
			started.resolve(options.streamOptions.signal!);
			return finish.promise;
		})
		.mockResolvedValue(SUMMARY);
	const start = SessionMaintenance.prototype.maybeStartSpeculativeCompaction;
	let maintenance: SessionMaintenance | undefined;
	vi.spyOn(SessionMaintenance.prototype, "maybeStartSpeculativeCompaction").mockImplementation(function (
		this: SessionMaintenance,
		...args
	) {
		maintenance = this;
		return start.apply(this, args);
	});
	return { started, finish, spy, completion: (method?: "handoff") => maintenance?.speculationCompletion(method) };
}

async function startSpeculation(
	f: Fixture,
	held: HeldSpeculation,
	seedPrompt = "Establish earlier context.",
): Promise<void> {
	await prompt(f, seedPrompt);
	const signal = await reached(held.started.promise, "the speculative handoff");
	expect(signal.aborted).toBe(false);
	expect(held.completion("handoff")).toBeDefined();
	expect(f.session.isCompacting).toBe(false);
	expect(f.events.filter(event => event.kind !== "second handler")).toEqual([stop(SEED), end(SEED)]);
	f.events.length = 0;
}

interface HeldSpeculation {
	started: PromiseWithResolvers<AbortSignal>;
	completion(method?: "handoff"): Promise<void> | undefined;
}

async function runningSpeculation(family: Family, answer: Answer, tokens = BAND): Promise<void> {
	const f = await setup([reply(SEED, BAND), reply(TARGET, tokens), reply(FOLLOW_UP)], answer, { family });
	const held = holdHandoff();
	await startSpeculation(f, held);
	await prompt(f);
	expect(held.spy).toHaveBeenCalledTimes(1);
	expect(held.completion("handoff")).toBeDefined();
	expect((await held.started.promise).aborted).toBe(false);
	verifyAllowed(f, answer, 2);
}

async function withLengthStop(answer: Answer, supersede: boolean): Promise<void> {
	const f = await setup([reply(SEED, BAND), { ...reply(TARGET, BAND), stopReason: "length" }, reply(NEXT)], answer, {
		family: "openai-responses",
	});
	const held = holdHandoff();
	await startSpeculation(f, held);
	const coreEnd = Promise.withResolvers<void>();
	const unsubscribe = f.session.agent.subscribe(event => {
		if (event.type === "agent_end") coreEnd.resolve();
	});
	// A core-driven length turn leaves session prompt admission free for the next request.
	const turn = supersede ? f.session.agent.prompt("Answer this request.") : f.session.prompt("Answer this request.");
	let next: Promise<boolean> | undefined;
	try {
		await reached(coreEnd.promise, "the core length stop");
		await scheduler.yield();
		expect(f.events).toEqual([]);
		if (supersede) {
			const admitted = Promise.withResolvers<void>();
			next = f.session.prompt("Supersede the waiting turn.", {
				onPromptAdmitted: admitted.resolve,
				skipCompactionCheck: true,
			});
			await reached(
				Promise.race([
					admitted.promise,
					next.then(() => {
						throw new Error("The new prompt did not supersede the waiting turn");
					}),
				]),
				"the superseding prompt",
			);
		}
	} finally {
		unsubscribe();
		held.finish.resolve(SUMMARY);
		await Promise.all([turn, next]);
	}
	await idle(f);
	if (!supersede) {
		verifyAllowed(f, answer, 2);
		return;
	}
	expect(f.mock.calls).toHaveLength(3);
	expect(requestContains(f, 2, "Supersede the waiting turn.")).toBe(true);
	expect(requestContains(f, 2, HIDDEN)).toBe(false);
	expect(f.events.filter(event => event.kind === "stop" && event.text === TARGET)).toHaveLength(1);
	const pass = expectedPass(TARGET, answer);
	const targetEnd = f.events.findIndex(event => event.kind === "end" && event.text === TARGET);
	expect(f.events.slice(targetEnd - pass.length, targetEnd + 1)).toEqual([...pass, end(TARGET)]);
}

const yieldTool: AgentTool = {
	name: "yield",
	label: "Submit Result",
	description: "Finish this run.",
	parameters: type({}),
	async execute() {
		return { content: [{ type: "text", text: "Result submitted." }], details: {} };
	},
};
const toolCall = { type: "toolCall", id: "pending-call", name: "yield", arguments: {} } as const;

async function withCompactionResult(answer: Answer, mode: "active goal" | "bottom" | "failure"): Promise<void> {
	const f = await setup([reply(TARGET), reply(NEXT)], answer);
	if (mode === "active goal") {
		const now = Date.now();
		f.session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "active-goal",
				objective: "Finish the work.",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
	}
	const check = vi.spyOn(SessionMaintenance.prototype, "checkCompaction");
	if (mode === "failure") check.mockRejectedValueOnce(new Error("Compaction check failed"));
	else check.mockResolvedValueOnce({ continuationScheduled: false, automaticContinuationBlocked: true });
	await prompt(f);
	expect(check).toHaveBeenCalledTimes(1);
	await verifyRefused(f, answer, 1);
}

async function withProviderAbort(answer: Answer, withToolCall: boolean): Promise<void> {
	const f = await setup(
		[
			{
				...reply(TARGET),
				stopReason: "aborted",
				errorMessage: "Provider cancelled the request.",
				content: withToolCall ? [TARGET, toolCall] : [TARGET],
			},
			reply(NEXT),
		],
		answer,
	);
	await prompt(f);
	expect(f.session.getLastAssistantMessage()).toMatchObject({ stopReason: "aborted" });
	const last = f.session.getLastAssistantMessage();
	expect(last?.role === "assistant" && last.content.some(part => part.type === "toolCall")).toBe(withToolCall);
	await verifyRefused(f, answer, 1);
}

const routes: Record<StopRoute, Case> = {
	normal: {
		name: "C1 normal stop notifies once before agent_end",
		continuation: "allowed",
		async drive(answer) {
			const f = await setup([reply(TARGET)], answer);
			await prompt(f);
			verifyAllowed(f, answer, 1);
		},
	},
	"no-assistant-message": {
		name: "C13 interrupt during a pre-stream stop runs no stop handler",
		continuation: "refused",
		async drive(answer) {
			const f = await setup([reply(TARGET)], answer);
			const { agent } = f.session;
			let endedMessages: AgentMessage[] | undefined;
			let aborted: Promise<void> | undefined;
			// Upstream normally records a synthetic assistant reply when interrupted.
			// Stop at the first-call gate and interrupt before the empty end finishes routing.
			cleanups.push(
				agent.addBeforeModelCall(() => ({ stop: true, reason: "Stop before the first request" })),
				agent.subscribe(event => {
					if (event.type !== "agent_end") return;
					endedMessages = event.messages;
					aborted = f.session.abort({ reason: USER_INTERRUPT_LABEL });
				}),
			);
			agent.appendMessage({ role: "user", content: "Continue from this request.", timestamp: Date.now() });
			await agent.continue();
			expect(aborted).toBeDefined();
			await aborted;
			await idle(f);
			expect(f.mock.calls).toHaveLength(0);
			expect(endedMessages).toEqual([]);
			expect(f.events).toEqual([end("")]);
			expect(passCount(f)).toBe(0);
		},
	},
	"skip-post-turn-maintenance": {
		name: "C2 openai-responses notifies while speculative handoff is pending",
		continuation: "allowed",
		drive: answer => runningSpeculation("openai-responses", answer),
	},
	"skip-superseded-speculative-maintenance": {
		name: "C4 superseded length stop refuses continuation but notifies",
		continuation: "refused",
		drive: answer => withLengthStop(answer, true),
	},
	"successful-yield": {
		name: "C5 main-session yield refuses continuation but notifies",
		continuation: "refused",
		async drive(answer) {
			const f = await setup([{ content: [TARGET, toolCall], stopReason: "toolUse" }, reply(NEXT)], answer, {
				tools: [yieldTool],
			});
			await prompt(f);
			expect(f.session.agent.state.messages).toContainEqual(
				expect.objectContaining({ role: "toolResult", toolName: "yield", isError: false }),
			);
			await verifyRefused(f, answer, 1);
		},
	},
	"active-goal-compaction-blocked": {
		name: "C6 active goal blocked by compaction refuses continuation but notifies",
		continuation: "refused",
		drive: answer => withCompactionResult(answer, "active goal"),
	},
	aborted: {
		name: "C7 provider abort without tool call refuses continuation but notifies",
		continuation: "refused",
		drive: answer => withProviderAbort(answer, false),
	},
	"trailing-tool-call": {
		name: "C8 trailing tool call on error refuses continuation but notifies",
		continuation: "refused",
		async drive(answer) {
			const f = await setup(
				[
					{ ...reply(TARGET), stopReason: "error", errorMessage: "Request rejected", content: [TARGET, toolCall] },
					reply(NEXT),
				],
				answer,
			);
			await prompt(f);
			expect(f.session.getLastAssistantMessage()).toMatchObject({
				stopReason: "error",
				content: expect.arrayContaining([expect.objectContaining({ type: "toolCall" })]),
			});
			await verifyRefused(f, answer, 1);
		},
	},
	"compaction-blocked": {
		name: "C9 bottom compaction block refuses continuation but notifies",
		continuation: "refused",
		drive: answer => withCompactionResult(answer, "bottom"),
	},
	"maintenance-failed": {
		name: "C10 maintenance failure refuses continuation and notifies once",
		continuation: "refused",
		drive: answer => withCompactionResult(answer, "failure"),
	},
};

const asyncWait: Case = {
	name: "C11 suppressed job delivery notifies only after the wait ends",
	continuation: "allowed",
	async drive(answer) {
		const jobs = new AsyncJobManager({});
		cleanups.push(() => jobs.dispose().then(() => undefined));
		const f = await setup([reply(TARGET), reply(FOLLOW_UP)], answer, { jobs });
		const result = gate("Background result");
		const id = jobs.register(
			"bash",
			"Held background job",
			async () => {
				const value = await result.promise;
				// Suppress the delivery as the job returns, so it can hold the run open until then.
				jobs.acknowledgeDeliveries([id]);
				return value;
			},
			{ ownerId: "Main" },
		);
		const job = jobs.getJob(id);
		if (!job) throw new Error("Expected the background job to be registered");
		await prompt(f);
		const waiting = end(TARGET, true, true);
		expect(f.events).toEqual([waiting]);
		expect(f.session.isRunActive).toBe(true);
		result.resolve("Background result");
		await job.promise;
		await idle(f);
		expect(jobs.isDeliverySuppressed(id)).toBe(true);
		expect(f.session.isRunActive).toBe(false);
		const continued = answer === "continue";
		expect(passCount(f)).toBe(continued ? 2 : 1);
		expect(f.events).toEqual([
			waiting,
			stop(TARGET),
			...(continued ? [stop(FOLLOW_UP), end(FOLLOW_UP)] : [end(TARGET)]),
		]);
		expect(f.mock.calls).toHaveLength(continued ? 2 : 1);
		if (continued) expect(requestContains(f, 1, HIDDEN)).toBe(true);
	},
};

function holdSoftCompaction() {
	const started = Promise.withResolvers<void>();
	const finish = gate<void>(undefined);
	vi.spyOn(compaction, "compact").mockImplementationOnce(async preparation => {
		started.resolve();
		await finish.promise;
		return {
			summary: SUMMARY,
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		};
	});
	return { started, finish };
}

const dropped: Case = {
	name: "C12 todo continuation dropped during compaction notifies",
	continuation: "refused",
	async drive(answer) {
		const target = "The review is finished.";
		const f = await setup([reply(SEED), reply(target), reply(NEXT)], answer, {
			family: "anthropic-messages",
			settings: {
				"todo.enabled": true,
				"todo.reminders": true,
				"todo.remindersMax": 1,
				"compaction.methodOrder": ["soft"],
			},
		});
		await prompt(f, "Earlier context to summarize. ".repeat(100));
		f.events.length = 0;
		activateTodoTool(f.session, f.cwd);
		f.session.setTodoPhases([{ name: "Review", tasks: [{ content: "Finish the review", status: "pending" }] }]);
		const compact = holdSoftCompaction();
		const check = SessionMaintenance.prototype.checkCompaction;
		let maintenance: SessionMaintenance | undefined;
		vi.spyOn(SessionMaintenance.prototype, "checkCompaction").mockImplementationOnce(function (
			this: SessionMaintenance,
			...args
		) {
			maintenance = this;
			return check.apply(this, args);
		});
		let work: Promise<unknown> | undefined;
		const checkTodo = TodoTracker.prototype.checkCompletion;
		vi.spyOn(TodoTracker.prototype, "checkCompletion").mockImplementationOnce(async function (
			this: TodoTracker,
			message,
		) {
			if (!maintenance) throw new Error("Expected the settle's compaction check first");
			work = maintenance.runAutoCompaction("threshold", false, { autoContinue: false });
			await reached(compact.started.promise, "compaction during the todo check");
			return checkTodo.call(this, message);
		});
		f.arm(target);
		try {
			await prompt(f);
			expect(f.sessionEvents.filter(event => event.type === "todo_reminder")).toHaveLength(1);
			expect(f.sessionEvents.filter(event => event.type === "agent_pause")).toHaveLength(1);
			expect(f.session.isCompacting).toBe(true);
			expect(f.mock.calls).toHaveLength(2);
		} finally {
			compact.finish.resolve();
			await work;
		}
		// The third scripted reply belongs to the new user request, not the dropped reminder.
		await idle(f);
		await verifyRefused(f, answer, 2, target, [end(target, true)]);
	},
};

function register(row: Case, control = false): void {
	const answers: Answer[] = control
		? ["observe"]
		: row.continuation === "allowed"
			? ["observe", "continue"]
			: ["observe", "continue", "block"];
	for (const answer of answers) it(`${row.name} (${answer})`, () => row.drive(answer));
}

for (const [route, row] of Object.entries(routes))
	register(row, route === "normal" || route === "no-assistant-message");
register({
	name: "C2 anthropic-messages notifies while speculative handoff is pending",
	continuation: "allowed",
	drive: answer => runningSpeculation("anthropic-messages", answer),
});
register({
	name: "C7 provider abort with tool call refuses continuation but notifies",
	continuation: "refused",
	drive: answer => withProviderAbort(answer, true),
});
register(asyncWait);
register(dropped);

it("C14 user interrupt during the reply runs no stop handler", async () => {
	const entered = Promise.withResolvers<void>();
	const f = await setup(
		[
			() => {
				entered.resolve();
				return { ...reply(TARGET), delayMs: 30_000 };
			},
		],
		"observe",
	);
	const turn = f.session.prompt("Interrupt the reply.");
	await reached(entered.promise, "the model request");
	await f.session.abort({ reason: USER_INTERRUPT_LABEL });
	await turn;
	await idle(f);
	expect(f.mock.calls).toHaveLength(1);
	expect(f.session.getLastAssistantMessage()).toMatchObject({ stopReason: "aborted" });
	expect(passCount(f)).toBe(0);
});

it("C14 disposal during settle runs no stop handler", async () => {
	const f = await setup([reply(TARGET)], "observe");
	const entered = Promise.withResolvers<void>();
	const release = gate<void>(undefined);
	vi.spyOn(SessionMaintenance.prototype, "checkCompaction").mockImplementationOnce(async () => {
		entered.resolve();
		await release.promise;
		return { continuationScheduled: false };
	});
	const turn = f.session.prompt("Dispose during settle.");
	await reached(entered.promise, "the settle's compaction check");
	const disposed = f.session.dispose();
	release.resolve();
	await Promise.all([turn, disposed]);
	await idle(f);
	expect(f.mock.calls).toHaveLength(1);
	expect(passCount(f)).toBe(0);
});

for (const autoContinue of [false, true]) {
	it(`C14 manual compaction during the reply runs no stop handler before ${autoContinue ? "the resume" : "going idle"}`, async () => {
		const entered = Promise.withResolvers<void>();
		const f = await setup(
			[
				reply(SEED),
				() => {
					entered.resolve();
					return { ...reply(TARGET), delayMs: 30_000 };
				},
				reply(FOLLOW_UP),
			],
			"observe",
			{
				family: "anthropic-messages",
				settings: { "compaction.methodOrder": ["soft"], "compaction.autoContinue": autoContinue },
			},
		);
		await prompt(f, "Establish earlier context.");
		f.events.length = 0;
		const held = holdSoftCompaction();
		const turn = f.session.prompt("Compact during the reply.");
		await reached(entered.promise, "the model request to interrupt");
		const compacting = f.session.compact();
		try {
			await reached(held.started.promise, "the manual summary request");
			expect(passCount(f)).toBe(0);
		} finally {
			held.finish.resolve();
			await Promise.all([compacting, turn]);
		}
		await idle(f);
		expect(f.mock.calls).toHaveLength(autoContinue ? 3 : 2);
		expect(f.events.filter(event => event.kind === "stop")).toEqual(autoContinue ? [stop(FOLLOW_UP)] : []);
	});
}

it("C14 subagent terminal reply emits agent_end but not session_stop", async () => {
	const f = await setup([reply(TARGET)], "observe", { kind: "sub" });
	await prompt(f);
	expect(f.mock.calls).toHaveLength(1);
	expect(f.events).toEqual([end(TARGET)]);
});

it("speculative states: no speculation at stop notifies normally", async () => {
	const f = await setup([reply(TARGET)], "observe", { family: "openai-responses" });
	const held = holdHandoff();
	await prompt(f);
	expect(held.spy).not.toHaveBeenCalled();
	verifyAllowed(f, "observe", 1);
});

it("speculative states: armed handoff at stop notifies normally", async () => {
	const f = await setup([reply(SEED, BAND), reply(TARGET, BAND)], "observe", { family: "openai-responses" });
	const held = holdHandoff();
	await startSpeculation(f, held, "Stored context to summarize. ".repeat(100));
	const speculation = held.completion("handoff");
	if (!speculation) throw new Error("Expected the speculation to be running");
	held.finish.resolve(SUMMARY);
	await speculation;
	expect(held.completion("handoff")).toBeUndefined();
	expect(held.completion()).toBe(speculation);
	await prompt(f);
	expect(held.spy).toHaveBeenCalledTimes(1);
	verifyAllowed(f, "observe", 2);
});

// C2 covers a running handoff at stop. C4 covers the superseded length stop.
it("speculative states: a length stop waits for the handoff and then notifies", () => withLengthStop("observe", false));

it("speculative states: retryable error retries before any stop notification", async () => {
	const f = await setup(
		[reply(SEED, BAND), { stopReason: "error", errorMessage: "503 Service Unavailable" }, reply(TARGET)],
		"observe",
		{
			family: "openai-responses",
			settings: { "retry.enabled": true, "retry.baseDelayMs": 1, "retry.maxRetries": 1 },
		},
	);
	const held = holdHandoff();
	await startSpeculation(f, held);
	await prompt(f);
	expect(held.spy).toHaveBeenCalledTimes(1);
	expect(held.completion("handoff")).toBeDefined();
	expect(passCount(f)).toBe(1);
	expect(f.mock.calls).toHaveLength(3);
	expect(f.events.map(event => event.kind)).toEqual(["end", "stop", "end"]);
	expect(f.events[0]).toMatchObject({ kind: "end", willContinue: true });
	expect(f.events.slice(1)).toEqual([stop(TARGET), end(TARGET)]);
});

it("speculative states: grace-band stop notifies without starting a threshold handoff", () =>
	runningSpeculation("openai-responses", "observe", GRACE_BAND));
