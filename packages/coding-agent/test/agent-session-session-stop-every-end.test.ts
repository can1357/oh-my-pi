import { afterAll, afterEach, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compaction from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { AgentEndEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	AgentSession,
	type AgentSessionEvent,
	type StopContinuation,
	type StopRoute,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTracker } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/transcript/messages";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { flush } from "@oh-my-pi/pi-utils/logger";
import { activateTodoTool, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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
	registry?: AgentRegistry;
	skipStopHandler?: boolean;
	onStop?: (messages: AgentMessage[]) => void;
}
interface Case {
	name: string;
	continuation: StopContinuation;
	answers?: Answer[];
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
const FAMILY_MODELS = {
	"openai-responses": { provider: "gateway-openai", id: "gpt-5" },
	"anthropic-messages": { provider: "anthropic", id: "claude-sonnet-4-5" },
} satisfies Record<Family, { provider: string; id: string }>;
const auth = createInMemoryAuthStorage();
for (const provider of ["mock", ...Object.values(FAMILY_MODELS).map(model => model.provider)]) {
	auth.keys.setRuntime(provider, "test-key");
}
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
	const { provider, id } = family ? FAMILY_MODELS[family] : { provider: "mock", id: "mock-model" };
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
			if (!options.skipStopHandler) {
				pi.on("session_stop", async event => {
					// Record completion so the order assertion checks that the host awaits the handler.
					await scheduler.yield();
					const text = assistantText(event.last_assistant_message);
					events.push(stop(text));
					if (target === undefined || text !== target) return;
					target = undefined;
					options.onStop?.(event.messages);
					if (answer === "continue") return { continue: true, additionalContext: HIDDEN };
					if (answer === "block") return { decision: "block", reason: HIDDEN };
				});
			}
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
	if (answer === "block" && !options.skipStopHandler) {
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
		agentId: options.jobs || options.registry ? "Main" : undefined,
		agentRegistry: options.registry,
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
	// A refused continuation must not leave hidden context for the next request.
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
		name: "normal stop notifies once before agent_end",
		continuation: "allowed",
		answers: ["observe"],
		async drive(answer) {
			const f = await setup([reply(TARGET)], answer);
			await prompt(f);
			verifyAllowed(f, answer, 1);
		},
	},
	"no-assistant-message": {
		name: "interrupt during a pre-stream stop runs no stop handler",
		continuation: "refused",
		answers: ["observe"],
		async drive(answer) {
			const f = await setup([reply(TARGET)], answer);
			const { agent } = f.session;
			let endedMessages: AgentMessage[] | undefined;
			let aborted: Promise<void> | undefined;
			// Stop at the first-call gate to avoid a synthetic assistant reply, then interrupt
			// before the empty end finishes routing.
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
		name: "openai-responses notifies while speculative handoff is pending",
		continuation: "allowed",
		drive: answer => runningSpeculation("openai-responses", answer),
	},
	"skip-superseded-speculative-maintenance": {
		name: "superseded length stop refuses continuation but notifies",
		continuation: "refused",
		drive: answer => withLengthStop(answer, true),
	},
	"successful-yield": {
		name: "main-session yield refuses continuation but notifies",
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
		name: "active goal blocked by compaction refuses continuation but notifies",
		continuation: "refused",
		drive: answer => withCompactionResult(answer, "active goal"),
	},
	aborted: {
		name: "provider abort without tool call refuses continuation but notifies",
		continuation: "refused",
		drive: answer => withProviderAbort(answer, false),
	},
	"trailing-tool-call": {
		name: "trailing tool call on error refuses continuation but notifies",
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
		name: "bottom compaction block refuses continuation but notifies",
		continuation: "refused",
		drive: answer => withCompactionResult(answer, "bottom"),
	},
	"maintenance-failed": {
		name: "maintenance failure refuses continuation and notifies once",
		continuation: "refused",
		drive: answer => withCompactionResult(answer, "failure"),
	},
};

function holdOwnedJob(jobs: AsyncJobManager, suppressDelivery: boolean) {
	const result = gate("Background result");
	const id = jobs.register(
		"bash",
		"Held background job",
		async () => {
			const value = await result.promise;
			if (suppressDelivery) jobs.acknowledgeDeliveries([id]);
			return value;
		},
		{ ownerId: "Main" },
	);
	const job = jobs.getJob(id);
	if (!job) throw new Error("Expected the background job to be registered");
	return { job, result };
}

const asyncWait: Case = {
	name: "suppressed job delivery notifies only after the wait ends",
	continuation: "allowed",
	async drive(answer) {
		const jobs = new AsyncJobManager({});
		cleanups.push(() => jobs.dispose().then(() => undefined));
		const f = await setup([reply(TARGET), reply(FOLLOW_UP)], answer, { jobs });
		const { job, result } = holdOwnedJob(jobs, true);
		await prompt(f);
		const waiting = end(TARGET, true, true);
		expect(f.events).toEqual([waiting]);
		expect(f.session.isRunActive).toBe(true);
		result.resolve("Background result");
		await job.promise;
		await idle(f);
		expect(jobs.isDeliverySuppressed(job.id)).toBe(true);
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
	name: "todo continuation dropped during compaction notifies",
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

function register(row: Case): void {
	const answers: Answer[] =
		row.answers ?? (row.continuation === "allowed" ? ["observe", "continue"] : ["observe", "continue", "block"]);
	for (const answer of answers) it(`${row.name} (${answer})`, () => row.drive(answer));
}

for (const row of Object.values(routes)) register(row);
register({
	name: "anthropic-messages notifies while speculative handoff is pending",
	continuation: "allowed",
	drive: answer => runningSpeculation("anthropic-messages", answer),
});
it("trailing tool call with a scheduled compaction continuation settles as continuing", async () => {
	const f = await setup(
		[
			reply(SEED),
			{
				...reply(TARGET),
				stopReason: "error",
				errorMessage: "context_length_exceeded: Your input exceeds the context window of this model.",
				content: [TARGET, toolCall],
			},
			reply(FOLLOW_UP),
		],
		"observe",
		{
			family: "anthropic-messages",
			settings: { "compaction.methodOrder": ["soft"], "compaction.asyncEnabled": false },
		},
	);
	await prompt(f, "Earlier context to summarize. ".repeat(400));
	f.events.length = 0;
	f.sessionEvents.length = 0;
	const compact = holdSoftCompaction();
	const turn = prompt(f);
	try {
		await reached(compact.started.promise, "the overflow compaction request");
	} finally {
		compact.finish.resolve();
		await turn;
	}

	expect(f.sessionEvents.find(event => event.type === "auto_compaction_start")).toMatchObject({ reason: "overflow" });
	const failedReply = f.sessionEvents.find(
		event =>
			event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error",
	);
	expect(failedReply).toMatchObject({ message: { content: expect.arrayContaining([toolCall]) } });
	expect(f.events).toEqual([
		expect.objectContaining({ kind: "end", willContinue: true, awaitingAsyncWork: false }),
		stop(FOLLOW_UP),
		end(FOLLOW_UP),
	]);
	expect(f.mock.calls).toHaveLength(3);
});

it("passes the compacted history to stop handlers when compaction blocks continuation", async () => {
	const messagesAtStop: AgentMessage[][] = [];
	const f = await setup([reply(SEED), reply(TARGET, GRACE_BAND)], "continue", {
		family: "anthropic-messages",
		settings: { "compaction.methodOrder": ["soft"], "compaction.asyncEnabled": false },
		onStop: messages => messagesAtStop.push(messages),
	});
	const removed = "Earlier context to summarize.";
	await prompt(f, `${removed} `.repeat(400));
	f.events.length = 0;

	const compact = holdSoftCompaction();
	const turn = prompt(f);
	try {
		await reached(compact.started.promise, "the threshold compaction request");
		vi.spyOn(f.session, "getContextUsage").mockReturnValue({ tokens: 120_000, contextWindow: WINDOW, percent: 94 });
	} finally {
		compact.finish.resolve();
		await turn;
	}

	const summary = expect.objectContaining({ role: "compactionSummary", summary: SUMMARY });
	expect(f.session.messages).toContainEqual(summary);
	expect(f.events).toEqual([stop(TARGET), end(TARGET)]);
	expect(f.mock.calls).toHaveLength(2);
	expect(messagesAtStop).toHaveLength(1);
	expect(messagesAtStop[0]).toContainEqual(summary);
	expect(JSON.stringify(messagesAtStop[0])).not.toContain(removed);
});

register({
	name: "provider abort with tool call refuses continuation but notifies",
	continuation: "refused",
	drive: answer => withProviderAbort(answer, true),
});
register(asyncWait);
register(dropped);

for (const suppressDelivery of [false, true]) {
	it(`provider-aborted stop with a pending job defers the pass until ${suppressDelivery ? "the wait ends" : "the resumed loop ends"}`, async () => {
		const jobs = new AsyncJobManager({});
		cleanups.push(() => jobs.dispose().then(() => undefined));
		const f = await setup(
			[
				{ ...reply(TARGET), stopReason: "aborted", errorMessage: "Provider cancelled the request." },
				reply(FOLLOW_UP),
			],
			"continue",
			{ jobs },
		);
		const { job, result } = holdOwnedJob(jobs, suppressDelivery);
		await prompt(f);
		const waiting = end(TARGET, true, true);
		expect(f.session.getLastAssistantMessage()).toMatchObject({ stopReason: "aborted" });
		expect(passCount(f)).toBe(0);
		expect(f.events).toEqual([waiting]);
		expect(f.session.isRunActive).toBe(true);

		result.resolve("Background result");
		await job.promise;
		expect(await jobs.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);
		await idle(f);
		expect(f.session.isRunActive).toBe(false);
		expect(passCount(f)).toBe(1);
		if (suppressDelivery) {
			expect(f.events).toEqual([waiting, stop(TARGET), end(TARGET)]);
			expect(f.mock.calls).toHaveLength(1);
		} else {
			expect(f.events).toEqual([waiting, stop(FOLLOW_UP), end(FOLLOW_UP)]);
			expect(f.mock.calls).toHaveLength(2);
			expect(requestContains(f, 1, "Background result")).toBe(true);
			expect(requestContains(f, 1, HIDDEN)).toBe(false);
		}
	});
}

function setupStallRegistry(): AgentRegistry {
	const registry = new AgentRegistry();
	vi.spyOn(IrcBus, "global").mockReturnValue(new IrcBus(registry));
	return registry;
}

function registerWaitingChild(registry: AgentRegistry): void {
	const childSession = { runStartedAt: Date.now() } as unknown as AgentSessionHandle;
	registry.register({
		id: "Child",
		displayName: "Child",
		kind: "sub",
		parentId: "Main",
		session: childSession,
	});
	cleanups.push(registry.awaits.hold("Child", ["Main"], { interruptible: true, message: true }));
}

for (const route of ["normal", "compaction-blocked"] as const) {
	it(`a waiter arriving during the ${route} stop pass does not restart the run`, async () => {
		const registry = setupStallRegistry();
		const jobs = route === "compaction-blocked" ? new AsyncJobManager({}) : undefined;
		if (jobs) cleanups.push(() => jobs.dispose().then(() => undefined));
		const f = await setup([reply(TARGET), reply(FOLLOW_UP)], "observe", {
			registry,
			jobs,
			onStop() {
				registerWaitingChild(registry);
			},
		});
		const waiting = jobs ? [end(TARGET, true, true)] : [];
		const held = jobs ? holdOwnedJob(jobs, true) : undefined;
		if (held) {
			vi.spyOn(SessionMaintenance.prototype, "checkCompaction").mockResolvedValueOnce({
				continuationScheduled: false,
				automaticContinuationBlocked: true,
			});
		}
		await prompt(f);
		if (held) {
			expect(f.events).toEqual(waiting);
			held.result.resolve("Background result");
			await held.job.promise;
			await idle(f);
		}

		expect(f.session.isRunActive).toBe(false);
		expect(passCount(f)).toBe(1);
		expect(f.events).toEqual([...waiting, stop(TARGET), end(TARGET)]);
		expect(f.mock.calls).toHaveLength(1);
	});
}

for (const route of ["compaction-blocked", "maintenance-failed"] as const) {
	for (const skipStopHandler of [false, true]) {
		it(`a waiter already present at ${route} gets a notice ${skipStopHandler ? "without" : "with"} a stop handler`, async () => {
			const registry = setupStallRegistry();
			const f = await setup([reply(TARGET), reply(FOLLOW_UP)], "observe", { registry, skipStopHandler });
			registerWaitingChild(registry);
			const check = vi.spyOn(SessionMaintenance.prototype, "checkCompaction");
			if (route === "maintenance-failed") check.mockRejectedValueOnce(new Error("Maintenance failed"));
			else check.mockResolvedValueOnce({ continuationScheduled: false, automaticContinuationBlocked: true });

			await prompt(f);

			expect(f.session.isRunActive).toBe(false);
			expect(f.mock.calls).toHaveLength(2);
			expect(requestContains(f, 1, "waiting for your next message")).toBe(true);
			expect(f.events).toEqual([end(TARGET, true), ...(skipStopHandler ? [] : [stop(FOLLOW_UP)]), end(FOLLOW_UP)]);
		});
	}
}

it("a waiter arriving during a background pause started by a stop handler gets a notice", async () => {
	const registry = setupStallRegistry();
	const jobs = new AsyncJobManager({});
	cleanups.push(() => jobs.dispose().then(() => undefined));
	let completeJob: (() => Promise<unknown>) | undefined;
	const f = await setup([reply(TARGET), reply(FOLLOW_UP)], "observe", {
		registry,
		jobs,
		onStop() {
			const { job, result } = holdOwnedJob(jobs, true);
			completeJob = () => {
				result.resolve("Background result");
				return job.promise;
			};
		},
	});
	await prompt(f);
	const waiting = end(TARGET, true, true);
	expect(f.events).toEqual([stop(TARGET), waiting]);
	expect(f.session.isRunActive).toBe(true);
	if (!completeJob) throw new Error("Expected the stop handler to register a background job");

	registerWaitingChild(registry);
	await completeJob();
	await idle(f);

	expect(f.session.isRunActive).toBe(false);
	expect(f.mock.calls).toHaveLength(2);
	expect(requestContains(f, 1, "waiting for your next message")).toBe(true);
	expect(f.events).toEqual([stop(TARGET), waiting, stop(FOLLOW_UP), end(FOLLOW_UP)]);
});

it("user interrupt during the reply runs no stop handler", async () => {
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

it("disposal during settle runs no stop handler", async () => {
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
	it(`manual compaction during the reply runs no stop handler before ${autoContinue ? "the resume" : "going idle"}`, async () => {
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

it("subagent terminal reply emits agent_end but not session_stop", async () => {
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
