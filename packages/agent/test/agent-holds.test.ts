import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentHold, type AgentOptions, type AgentTool, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

/** Settles after the event loop's next turn, once every microtask queued before it has run. */
function nextEventLoopTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Settles after `count` turns of the event loop. */
async function eventLoopTurns(count: number): Promise<void> {
	for (let turn = 0; turn < count; turn++) await nextEventLoopTurn();
}

/** Settles once `condition` holds, checked after each event-loop turn; fails if it never does. */
async function eventually(condition: () => boolean, what: string): Promise<void> {
	for (let turn = 0; turn < 200; turn++) {
		if (condition()) return;
		await nextEventLoopTurn();
	}
	throw new Error(`never ${what}`);
}

/**
 * A hold that holds nothing until `arm()`, then holds until `release()`.
 * `asked` settles the first time the loop asks it while it is armed.
 */
function armableHold(events: string[]) {
	let armed: PromiseWithResolvers<void> | undefined;
	const asked = Promise.withResolvers<void>();
	return {
		asked: asked.promise,
		arm(): void {
			armed ??= Promise.withResolvers<void>();
		},
		release(): void {
			const wait = armed;
			armed = undefined;
			wait?.resolve();
		},
		open: (): AgentHold => ({
			pending: () => {
				if (!armed) return undefined;
				events.push("held");
				asked.resolve();
				return armed.promise;
			},
		}),
	};
}

const schema = type({});

/**
 * Every step at which a host can do something a hold must see, for the
 * effect it prepares. A "pause" step engages the process pause gate there,
 * and the hold is armed or registered while the loop is parked on it.
 */
const cases = [
	{ effect: "model request", step: "before-model-call hook" },
	{ effect: "model request", step: "context transform" },
	{ effect: "model request", step: "message conversion" },
	{ effect: "model request", step: "provider context transform" },
	{ effect: "model request", step: "before-model-call gate" },
	{ effect: "model request", step: "added before-model-call gate" },
	{ effect: "model request", step: "credential lookup" },
	{ effect: "model request", step: "another hold letting go" },
	{ effect: "model request", step: "pause from the before-model-call gate" },
	{ effect: "model request", step: "pause from the credential lookup" },
	{ effect: "tool call", step: "before-tool-call hook" },
	{ effect: "tool call", step: "tool argument transform" },
	{ effect: "tool call", step: "earlier tool call in the batch" },
	{ effect: "tool call", step: "pause from the before-tool-call hook" },
	{ effect: "tool call", step: "speculative evidence capture" },
] as const;
type Step = (typeof cases)[number]["step"];
const pauseSteps: readonly Step[] = [
	"pause from the before-model-call gate",
	"pause from the credential lookup",
	"pause from the before-tool-call hook",
];

/**
 * How the hold comes to hold: added before the run and armed at the step, or
 * added — already armed — at the step itself, while the request or call is
 * being prepared or held.
 */
const modes = ["armed", "registered"] as const;

/** Where the hold sits among the agent's holds. One registered during a request comes after every hold already there. */
const arrangements = ["alone", "added before another hold", "added after another hold"] as const;

describe("Agent holds", () => {
	// A failed test must not leave the process-wide gate engaged for the next one.
	afterEach(() => {
		agentPauseGate.resume();
	});

	for (const { effect, step } of cases) {
		// A tool call also runs speculatively, deferred until its before-tool-call
		// hook has run. A speculative run of a later call can start beside an
		// earlier call, so it is already running when that one arms the hold;
		// the pause gate parks only ordinary calls; evidence is captured only
		// for a speculative run.
		const runs =
			step === "speculative evidence capture"
				? [true]
				: effect === "tool call" && step !== "earlier tool call in the batch" && !pauseSteps.includes(step)
					? [false, true]
					: [false];
		for (const speculative of runs) {
			for (const mode of modes) {
				for (const arrangement of arrangements) {
					// Letting go is something another hold does: there is always one.
					if (step === "another hold letting go" && arrangement === "alone") continue;
					if (mode === "registered" && arrangement === "added before another hold") continue;
					const how = mode === "armed" ? "armed by" : "registered during";
					const title = `holds the ${effect}${speculative ? ", run speculatively," : ""} for a hold ${how} the ${step}, ${arrangement}`;
					it(title, async () => {
						const events: string[] = [];
						const hold = armableHold(events);
						const effectStarted = Promise.withResolvers<void>();
						const armAt = (at: Step): void => {
							if (step !== at || events.includes("armed")) return;
							events.push("armed");
							hold.arm();
							if (mode === "registered") agent.addHold(hold.open);
						};
						const pauseAt = (at: Step): void => {
							if (step === at && !events.includes("paused")) {
								events.push("paused");
								agentPauseGate.pause();
							}
						};
						const ran = (how: "ran" | "ran speculatively"): void => {
							events.push("effect", how);
							effectStarted.resolve();
						};
						const probe: AgentTool<typeof schema> = {
							name: "probe",
							label: "Probe",
							description: "Records when it runs",
							parameters: schema,
							// An exclusive tool never runs speculatively.
							concurrency: speculative ? "shared" : "exclusive",
							speculation: {
								finalized: {
									assess: () => ({
										eligible: true,
										effect: {
											kind: "local_read",
											resources: [{ scheme: "file", path: "/probe", access: "read" }],
										},
									}),
									async execute() {
										ran("ran speculatively");
										return {
											kind: "result",
											result: { content: [{ type: "text", text: "ok" }] },
											isError: false,
										};
									},
								},
							},
							async execute() {
								ran("ran");
								return { content: [{ type: "text", text: "ok" }], details: {} };
							},
						};
						const earlier: AgentTool<typeof schema> = {
							name: "earlier",
							label: "Earlier",
							description: "Arms the hold while it runs",
							parameters: schema,
							concurrency: "exclusive",
							async execute() {
								armAt("earlier tool call in the batch");
								return { content: [{ type: "text", text: "ok" }], details: {} };
							},
						};
						// The earlier call is in the batch only where it arms the hold: an
						// exclusive call ahead of it keeps the probe from running speculatively.
						const earlierCall = { type: "toolCall" as const, id: "earlier-1", name: "earlier", arguments: {} };
						const probeCall = { type: "toolCall" as const, id: "probe-1", name: "probe", arguments: {} };
						const mock = createMockModel({
							responses:
								effect === "tool call"
									? [
											{
												content:
													step === "earlier tool call in the batch"
														? [earlierCall, probeCall]
														: [probeCall],
											},
											{ content: ["done"] },
										]
									: [{ content: ["done"] }],
						});
						let requests = 0;
						const options: AgentOptions = {
							initialState: { model: mock.model, systemPrompt: ["Test"], tools: [earlier, probe], messages: [] },
							streamFn: (...args) => {
								if (effect === "model request" && ++requests === 1) {
									events.push("effect");
									effectStarted.resolve();
								}
								return mock.stream(...args);
							},
							getApiKey: () => {
								armAt("credential lookup");
								pauseAt("pause from the credential lookup");
								return "test-key";
							},
							transformContext: async messages => {
								armAt("context transform");
								return messages;
							},
							convertToLlm: messages => {
								armAt("message conversion");
								return messages.filter(
									message =>
										message.role === "user" || message.role === "assistant" || message.role === "toolResult",
								) as Message[];
							},
							transformProviderContext: context => {
								armAt("provider context transform");
								return context;
							},
							transformToolCallArguments: args => {
								armAt("tool argument transform");
								return args;
							},
							...(speculative
								? {
										speculativeToolExecution: {
											enabled: true,
											host: {
												authorize: () => ({ allowed: true, deferBeforeToolCall: true }),
												captureEvidence: async () => {
													armAt("speculative evidence capture");
													return true;
												},
											},
										},
									}
								: {}),
						};
						const agent = new Agent(options);
						let prepared = false;
						agent.addBeforeModelCallHook(() => armAt("before-model-call hook"));
						agent.setBeforeModelCall(() => {
							armAt("before-model-call gate");
							pauseAt("pause from the before-model-call gate");
							prepared = true;
						});
						agent.addBeforeModelCall(() => armAt("added before-model-call gate"));
						agent.beforeToolCall = async () => {
							armAt("before-tool-call hook");
							pauseAt("pause from the before-tool-call hook");
							return undefined;
						};
						// The other hold: for "letting go", it holds once, at the request's
						// last check, and arms (or registers) the armable hold as it lets go.
						let letGo = false;
						const other = (): AgentHold => ({
							pending: () => {
								if (step !== "another hold letting go" || letGo || !prepared) return undefined;
								letGo = true;
								return Promise.resolve().then(() => armAt("another hold letting go"));
							},
						});
						if (arrangement === "added after another hold") agent.addHold(other);
						if (mode === "armed") agent.addHold(hold.open);
						if (arrangement === "added before another hold") agent.addHold(other);

						const run = agent.prompt("go");
						try {
							if (pauseSteps.includes(step)) {
								// Armed or registered while the loop is parked on the pause, then resumed.
								await eventually(() => agent.isPaused || events.includes("effect"), "parked on the pause gate");
								const parked = agent.isPaused;
								// Not the step a host runs: the test arms it here, while parked.
								events.push("armed");
								hold.arm();
								if (mode === "registered") agent.addHold(hold.open);
								agentPauseGate.resume();
								expect(parked).toBe(true);
							}
							await Promise.race([hold.asked, effectStarted.promise]);
							expect(events.filter(event => event === "held" || event === "effect")[0]).toBe("held");
							// Nothing but the release lets it go: give the loop turns to go wrong.
							await eventLoopTurns(5);
							expect(events).not.toContain("effect");
						} finally {
							hold.release();
							agentPauseGate.resume();
						}
						await run;
						expect(events).toContain(
							effect === "model request" ? "effect" : speculative ? "ran speculatively" : "ran",
						);
					});
				}
			}
		}
	}

	/**
	 * Where a request or call can be waiting on a hold when that hold is
	 * removed: removal must wake it, release the view it waited on, and let
	 * it go on.
	 */
	const removals = [
		{ effect: "model request", waitsAt: "before it is prepared" },
		{ effect: "model request", waitsAt: "at its send" },
		{ effect: "tool call", waitsAt: "before it executes" },
		{ effect: "tool call", waitsAt: "before its speculative run" },
	] as const;
	for (const { effect, waitsAt } of removals) {
		it(`lets the ${effect} go once the hold it waits on ${waitsAt} is removed, releasing every view once`, async () => {
			const events: string[] = [];
			const effectStarted = Promise.withResolvers<void>();
			const asked = Promise.withResolvers<void>();
			const forever = Promise.withResolvers<void>();
			const speculative = waitsAt === "before its speculative run";
			let armed = waitsAt === "before it is prepared";
			const ran = (): void => {
				events.push("effect");
				effectStarted.resolve();
			};
			const probe: AgentTool<typeof schema> = {
				name: "probe",
				label: "Probe",
				description: "Records when it runs",
				parameters: schema,
				concurrency: speculative ? "shared" : "exclusive",
				speculation: {
					finalized: {
						assess: () => ({
							eligible: true,
							effect: { kind: "local_read", resources: [{ scheme: "file", path: "/probe", access: "read" }] },
						}),
						async execute() {
							ran();
							return { kind: "result", result: { content: [{ type: "text", text: "ok" }] }, isError: false };
						},
					},
				},
				async execute() {
					ran();
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			};
			const mock = createMockModel({
				responses:
					effect === "tool call"
						? [
								{ content: [{ type: "toolCall", id: "probe-1", name: "probe", arguments: {} }] },
								{ content: ["done"] },
							]
						: [{ content: ["done"] }],
			});
			let requests = 0;
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [probe], messages: [] },
				streamFn: (...args) => {
					if (effect === "model request" && ++requests === 1) ran();
					return mock.stream(...args);
				},
				...(speculative
					? {
							speculativeToolExecution: {
								enabled: true,
								host: { authorize: () => ({ allowed: true, deferBeforeToolCall: true }) },
							},
						}
					: {}),
			});
			agent.setBeforeModelCall(() => {
				if (waitsAt === "at its send") armed = true;
			});
			agent.beforeToolCall = async () => {
				if (effect === "tool call") armed = true;
				return undefined;
			};
			const opened: number[] = [];
			const released: number[] = [];
			let waiting: number | undefined;
			const remove = agent.addHold(() => {
				const view = opened.length;
				opened.push(view);
				return {
					pending: () => {
						if (!armed) return undefined;
						waiting = view;
						asked.resolve();
						return forever.promise;
					},
					release: () => {
						if (view === waiting) events.push("released the waiting view");
						released.push(view);
					},
				};
			});
			const run = agent.prompt("go");
			try {
				await Promise.race([asked.promise, effectStarted.promise]);
				expect(events).toEqual([]);
				remove();
				await Promise.race([effectStarted.promise, eventLoopTurns(20)]);
				expect(events.slice(0, 2)).toEqual(["released the waiting view", "effect"]);
			} finally {
				armed = false;
				forever.resolve();
			}
			await run;
			expect([...released].sort((a, b) => a - b)).toEqual(opened);
		});
	}

	it("gives each model request and each tool call its own view of a hold, and releases every one", async () => {
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "probe-1", name: "probe", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const probe: AgentTool<typeof schema> = {
			name: "probe",
			label: "Probe",
			description: "Does nothing",
			parameters: schema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [probe], messages: [] },
			streamFn: mock.stream,
		});
		agent.beforeToolCall = async () => undefined;
		let opened = 0;
		let released = 0;
		agent.addHold(() => {
			opened++;
			return { pending: () => undefined, release: () => released++ };
		});
		await agent.prompt("go");
		// Two model requests and one tool call, each checked twice: one view each.
		expect(opened).toBe(3);
		expect(released).toBe(3);
	});
});
