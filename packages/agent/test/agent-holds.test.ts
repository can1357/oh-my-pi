import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentHold, type AgentOptions, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

/** Settles after the event loop's next turn, once every microtask queued before it has run. */
function nextEventLoopTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
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

/** Every step that prepares a model request or a tool call, where a host can do something a hold must see. */
const modelRequestSteps = [
	"before-model-call hook",
	"context transform",
	"message conversion",
	"provider context transform",
	"before-model-call gate",
	"added before-model-call gate",
	"another hold letting go",
] as const;
const toolCallSteps = ["before-tool-call hook", "tool argument transform", "earlier tool call in the batch"] as const;
type Step = (typeof modelRequestSteps)[number] | (typeof toolCallSteps)[number];

/** Where the armable hold sits among the agent's holds. */
const arrangements = ["alone", "added before another hold", "added after another hold"] as const;

describe("Agent holds", () => {
	for (const step of [...modelRequestSteps, ...toolCallSteps] as Step[]) {
		const effect = (toolCallSteps as readonly string[]).includes(step) ? "tool call" : "model request";
		// A tool call also runs speculatively, deferred until its before-tool-call
		// hook has run. A speculative run of a later call can start beside an
		// earlier call, so it is already running when that one arms the hold.
		const runs = effect === "tool call" && step !== "earlier tool call in the batch" ? [false, true] : [false];
		for (const speculative of runs) {
			for (const arrangement of arrangements) {
				// Letting go is something another hold does: there is always one.
				if (step === "another hold letting go" && arrangement === "alone") continue;
				const title = `holds the ${effect}${speculative ? ", run speculatively," : ""} for a hold armed by the ${step}, ${arrangement}`;
				it(title, async () => {
					const events: string[] = [];
					const hold = armableHold(events);
					const effectStarted = Promise.withResolvers<void>();
					const armAt = (at: Step): void => {
						if (step !== at || events.includes("armed")) return;
						events.push("armed");
						hold.arm();
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
												step === "earlier tool call in the batch" ? [earlierCall, probeCall] : [probeCall],
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
										host: { authorize: () => ({ allowed: true, deferBeforeToolCall: true }) },
									},
								}
							: {}),
					};
					const agent = new Agent(options);
					let prepared = false;
					agent.addBeforeModelCallHook(() => armAt("before-model-call hook"));
					agent.setBeforeModelCall(() => {
						armAt("before-model-call gate");
						prepared = true;
					});
					agent.addBeforeModelCall(() => armAt("added before-model-call gate"));
					agent.beforeToolCall = async () => {
						armAt("before-tool-call hook");
						return undefined;
					};
					// The other hold: for "letting go", it holds once, at the request's
					// last check, and arms the armable hold as it lets go.
					let letGo = false;
					const other = (): AgentHold => ({
						pending: () => {
							if (step !== "another hold letting go" || letGo || !prepared) return undefined;
							letGo = true;
							return Promise.resolve().then(() => armAt("another hold letting go"));
						},
					});
					if (arrangement === "added after another hold") agent.addHold(other);
					agent.addHold(hold.open);
					if (arrangement === "added before another hold") agent.addHold(other);

					const run = agent.prompt("go");
					try {
						await Promise.race([hold.asked, effectStarted.promise]);
						expect(events.filter(event => event === "held" || event === "effect")[0]).toBe("held");
						// Nothing but the release lets it go: give the loop turns to go wrong.
						for (let turn = 0; turn < 5; turn++) await nextEventLoopTurn();
						expect(events).not.toContain("effect");
					} finally {
						hold.release();
					}
					await run;
					expect(events).toContain(
						effect === "model request" ? "effect" : speculative ? "ran speculatively" : "ran",
					);
				});
			}
		}
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
		// Two model requests and one tool call.
		expect(opened).toBe(3);
		expect(released).toBe(3);
	});
});
