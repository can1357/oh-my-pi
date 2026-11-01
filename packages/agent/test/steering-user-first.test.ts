import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING,
	steeringQueueState,
	steeringRangeState,
} from "@oh-my-pi/pi-agent-core";
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { CodexSteerPump } from "@oh-my-pi/pi-ai/providers/openai-codex/live-steering";

/** An agent-authored card, as an extension's `sendMessage(..., { deliverAs: "steer" })` queues it. */
function card(n: number): AgentMessage {
	return { role: "custom", customType: "card", content: `card ${n}`, display: true, timestamp: n };
}

function person(text: string): AgentMessage {
	return { role: "user", content: text, attribution: "user", timestamp: Date.now() };
}

/** Hidden companion the session queues just ahead of the prompt it belongs to. */
function companion(text: string): AgentMessage {
	return {
		role: "custom",
		customType: "image-attachment-description",
		content: text,
		display: false,
		attribution: "user",
		timestamp: Date.now(),
	};
}

/** Show custom records to the model as user text, as the coding agent's conversion does. */
function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.flatMap((message): Message[] => {
		if (message.role === "custom") {
			const content = typeof message.content === "string" ? message.content : "";
			return [{ role: "user", content, timestamp: message.timestamp }];
		}
		return message.role === "user" || message.role === "assistant" || message.role === "toolResult" ? [message] : [];
	});
}

function texts(context: Context): string[] {
	return context.messages.map(message =>
		typeof message.content === "string"
			? message.content
			: message.content.map(part => ("text" in part ? part.text : `[${part.type}]`)).join(""),
	);
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string"
		? message.content
		: message.content.map(part => ("text" in part ? part.text : "")).join("");
}

function transcriptTexts(agent: Agent): string[] {
	return agent.state.messages.filter(message => message.role === "user" || message.role === "custom").map(messageText);
}

/**
 * A run whose first model call queues `queued` mid-batch from a tool, then answers in text
 * until the steering queue drains; each later model call reads one steering unit. `arrivals`
 * runs inside model call `call` (1 for the first boundary), after that call's unit was taken,
 * so what it queues is first eligible at call `call + 1`.
 */
async function runWithQueued(
	queued: AgentMessage[],
	options: {
		steeringMode?: "all" | "one-at-a-time";
		grouping?: boolean;
		priority?: (message: AgentMessage) => boolean;
		arrivals?: (call: number, agent: Agent) => void;
	} = {},
): Promise<{ agent: Agent; calls: Context[] }> {
	const agentRef = {} as { current: Agent };
	const schema = type({});
	const tool: AgentTool<typeof schema> = {
		name: "step",
		label: "Step",
		description: "Step tool",
		parameters: schema,
		async execute() {
			for (const message of queued) agentRef.current.steer(message);
			return { content: [{ type: "text", text: "stepped" }] };
		},
	};
	let call = 0;
	const mock = createMockModel({
		handler: context => {
			const current = call++;
			if (current >= 1) options.arrivals?.(current, agentRef.current);
			return context.messages.length === 1
				? { content: [{ type: "toolCall", id: "step-1", name: "step", arguments: {} }] }
				: { content: [`read ${context.messages.length}`] };
		},
	});
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [tool], messages: [] },
		streamFn: mock.stream,
		convertToLlm,
		steeringMode: options.steeringMode ?? "one-at-a-time",
	});
	if (options.grouping) {
		agent.setQueuedMessageGrouping(
			(previous, next) =>
				previous.role === "custom" &&
				previous.display === false &&
				(next.role === "user" || next.role === "custom"),
		);
	}
	if (options.priority) agent.setSteeringPriority(options.priority);
	agentRef.current = agent;
	await agent.prompt("start");
	return { agent, calls: mock.calls.map(call => call.context) };
}

describe("one-at-a-time steering: a person's message before agent steering", () => {
	it("reads a person's steer at the next model call, ahead of agent steers queued before it", async () => {
		const { agent, calls } = await runWithQueued([card(1), card(2), card(3), person("read me now")]);

		// Call 0 starts the run and asks for the tool; call 1 is the first boundary after the steer.
		expect(texts(calls[1]).at(-1)).toBe("read me now");
		for (const n of [1, 2, 3]) expect(texts(calls[1])).not.toContain(`card ${n}`);
		// The agent steers still arrive, one per boundary, in the order they were queued.
		expect(texts(calls[2]).at(-1)).toBe("card 1");
		expect(texts(calls[3]).at(-1)).toBe("card 2");
		expect(texts(calls[4]).at(-1)).toBe("card 3");
		expect(calls).toHaveLength(5);
		expect(transcriptTexts(agent)).toEqual(["start", "read me now", "card 1", "card 2", "card 3"]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("keeps a person's messages in the order typed and a companion with its prompt", async () => {
		const { agent, calls } = await runWithQueued(
			[card(1), companion("diagram description"), person("first"), card(2), person("second")],
			{ grouping: true },
		);

		expect(texts(calls[1]).slice(-2)).toEqual(["diagram description", "first"]);
		expect(texts(calls[2]).at(-1)).toBe("second");
		expect(texts(calls[3]).at(-1)).toBe("card 1");
		expect(texts(calls[4]).at(-1)).toBe("card 2");
		expect(transcriptTexts(agent)).toEqual(["start", "diagram description", "first", "second", "card 1", "card 2"]);
	});

	it("treats an agent-attributed user message as agent steering, kept in queue order behind a person's", async () => {
		const parent: AgentMessage = { role: "user", content: "parent", attribution: "agent", timestamp: 1 };
		const { agent } = await runWithQueued([card(1), parent, person("typed"), card(2)]);

		expect(transcriptTexts(agent)).toEqual(["start", "typed", "card 1", "parent", "card 2"]);
	});

	it("lets the host's priority rule decide which steering goes first", async () => {
		const hidden: AgentMessage = {
			role: "custom",
			customType: "hidden-note",
			content: "hidden note",
			display: false,
			attribution: "user",
			timestamp: 1,
		};
		const byDefault = await runWithQueued([card(1), hidden, person("typed")]);
		expect(transcriptTexts(byDefault.agent)).toEqual(["start", "hidden note", "typed", "card 1"]);

		const visibleOnly = (message: AgentMessage) => message.role === "user";
		const byHost = await runWithQueued([card(1), hidden, person("typed")], { priority: visibleOnly });
		expect(transcriptTexts(byHost.agent)).toEqual(["start", "typed", "card 1", "hidden note"]);
	});

	it("reads the head agent steer after every bound's worth of user steers, so sustained input starves nothing", async () => {
		const bound = MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING;
		const cards = 32;
		const people = cards * bound + 3;
		const queued: AgentMessage[] = [];
		for (let n = 1; n <= cards; n++) queued.push(card(n));
		for (let n = 1; n <= people; n++) queued.push(person(`person ${n}`));
		const { agent } = await runWithQueued(queued);

		const expected = ["start"];
		let nextPerson = 1;
		for (let n = 1; n <= cards; n++) {
			for (let i = 0; i < bound; i++) expected.push(`person ${nextPerson++}`);
			expected.push(`card ${n}`);
		}
		while (nextPerson <= people) expected.push(`person ${nextPerson++}`);
		expect(transcriptTexts(agent)).toEqual(expected);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("lets a burst of up to the bound in user steers go first, then the passed agent steer", async () => {
		const bound = MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING;
		const burst = Array.from({ length: bound + 1 }, (_, i) => person(`typed ${i + 1}`));
		const { agent } = await runWithQueued([card(1), card(2), ...burst]);

		const typed = burst.map((_, i) => `typed ${i + 1}`);
		expect(transcriptTexts(agent)).toEqual(["start", ...typed.slice(0, bound), "card 1", typed[bound], "card 2"]);
	});

	it("reads a burst of 20 typed behind 20 agent steers after floor((i - 1) / 4) agent steers each", async () => {
		const queued: AgentMessage[] = [];
		for (let n = 1; n <= 20; n++) queued.push(card(n));
		for (let n = 1; n <= 20; n++) queued.push(person(`typed ${n}`));
		const { agent } = await runWithQueued(queued);

		const transcript = transcriptTexts(agent).slice(1);
		const agentsBefore = (i: number) =>
			transcript.slice(0, transcript.indexOf(`typed ${i}`)).filter(text => text.startsWith("card")).length;
		const waits = Array.from({ length: 20 }, (_, index) => agentsBefore(index + 1));
		expect(waits).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
	});

	it("counts user steers queued before the agent steer toward its allowance", async () => {
		// One older user message, then one new user message per model call.
		const { agent } = await runWithQueued([person("U_old"), card(0)], {
			arrivals: (call, target) => {
				if (call <= 5) target.steer(person(`U${call - 1}`));
			},
		});

		// card 0 had no agent steer ahead of it, so it is read within 5 deliveries: the 5th.
		expect(transcriptTexts(agent)).toEqual(["start", "U_old", "U0", "U1", "U2", "card 0", "U3", "U4"]);
	});

	it("delivers every agent steer within 5 × (k + 1) deliveries of being queued, under random arrivals", async () => {
		const bound = MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING + 1;
		let checked = 0;
		for (let seed = 1; seed <= 32; seed++) {
			let state = seed * 7919;
			const random = (): number => {
				state = (state * 1103515245 + 12345) % 2147483648;
				return state / 2147483648;
			};
			const userRate = 0.3 + (seed % 7) * 0.1;
			// Call each message was queued in (0 = the tool, before the first delivery).
			const queuedIn = new Map<string, number>();
			let next = 0;
			const message = (call: number, agent: boolean): AgentMessage => {
				const id = `${agent ? "agent" : "user"} ${next++}`;
				queuedIn.set(id, call);
				return agent
					? { role: "custom", customType: "card", content: id, display: true, timestamp: next }
					: person(id);
			};
			const initial = Array.from({ length: 4 }, () => message(0, random() < 0.5));
			const { agent } = await runWithQueued(initial, {
				arrivals: (call, target) => {
					if (call > 60) return;
					let queued = 0;
					while (random() < userRate && queued < 3) {
						target.steer(message(call, false));
						queued++;
					}
					if (random() < 0.5) target.steer(message(call, true));
					else if (queued === 0) target.steer(message(call, false));
				},
			});
			// One unit per boundary: the nth transcript entry after "start" was delivered at call n.
			const transcript = transcriptTexts(agent).slice(1);
			const deliveredAt = new Map(transcript.map((id, index) => [id, index + 1]));
			// Nothing lost or delivered twice, and each class keeps its order.
			expect([...transcript].sort()).toEqual([...queuedIn.keys()].sort());
			for (const prefix of ["agent", "user"]) {
				const ids = transcript.filter(id => id.startsWith(prefix)).map(id => Number(id.split(" ")[1]));
				expect(ids).toEqual([...ids].sort((a, b) => a - b));
			}
			for (const [id, queued] of queuedIn) {
				if (!id.startsWith("agent")) continue;
				// Agent steers queued earlier and still waiting when this one was queued.
				const ahead = [...queuedIn].filter(
					([other]) =>
						other.startsWith("agent") &&
						Number(other.split(" ")[1]) < Number(id.split(" ")[1]) &&
						deliveredAt.get(other)! > queued,
				).length;
				expect(deliveredAt.get(id)! - queued).toBeLessThanOrEqual(bound * (ahead + 1));
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(200);
	});

	for (const [name, empty] of [
		["clearSteeringQueue", (target: Agent) => target.clearSteeringQueue()],
		["clearAllQueues", (target: Agent) => target.clearAllQueues()],
		["replaceQueue", (target: Agent) => target.replaceQueue("steering", [])],
		["replaceQueues", (target: Agent) => target.replaceQueues([], [])],
	] as const) {
		it(`starts a fresh allowance for an agent steer queued again after ${name} emptied the queue`, async () => {
			const reused = card(1);
			const { agent } = await runWithQueued([reused, person("U1"), person("U2"), person("U3"), person("U4")], {
				arrivals: (call, target) => {
					if (call !== 4) return;
					// Four user steers went ahead of `reused`; it leaves the queue, then comes back. The
					// fourth is taken but not yet recorded, and it belongs to the wait that ended.
					empty(target);
					target.steer(reused);
					for (let n = 1; n <= 4; n++) target.steer(person(`new ${n}`));
				},
			});

			expect(transcriptTexts(agent)).toEqual([
				"start",
				"U1",
				"U2",
				"U3",
				"U4",
				"new 1",
				"new 2",
				"new 3",
				"new 4",
				"card 1",
			]);
		});
	}

	it("keeps the allowance of an agent steer a queue replacement keeps", async () => {
		const kept = card(1);
		const { agent } = await runWithQueued([kept, person("U1"), person("U2"), person("U3"), person("U4")], {
			arrivals: (call, target) => {
				if (call === 4) target.replaceQueue("steering", [kept, person("new")]);
			},
		});

		expect(transcriptTexts(agent)).toEqual(["start", "U1", "U2", "U3", "U4", "card 1", "new"]);
	});

	it("starts a fresh allowance for an agent steer queued after the waiting one was withdrawn ahead of an abort", async () => {
		const people = ["U1", "U2", "U3", "U4", "U5"].map(person);
		const { agent } = await runWithQueued([card(1), ...people], {
			arrivals: (call, target) => {
				// Call 5 took card 1, the allowance being spent; Esc takes it back before the transcript records it.
				if (call !== 5) return;
				target.withdrawUndeliveredQueuedMessages();
				target.abort();
			},
		});
		expect(transcriptTexts(agent)).toEqual(["start", "U1", "U2", "U3", "U4"]);
		expect(agent.peekSteeringQueue()).toEqual([people[4]]);

		agent.steer(card(2));
		agent.steer(person("new"));
		await agent.continue();
		// Card 2 waits from nothing: no agent steering was pending once card 1 was withdrawn.
		expect(transcriptTexts(agent).slice(5)).toEqual(["U5", "new", "card 2"]);
	});

	it("keeps the allowance of an agent steer when a second queued occurrence of it is popped", async () => {
		const waiting = card(1);
		let popped: AgentMessage | undefined;
		let stillQueued = false;
		const { agent } = await runWithQueued([waiting, person("U1"), person("U2"), person("U3"), person("U4")], {
			arrivals: (call, target) => {
				if (call !== 4) return;
				// The same object queued twice is two entries: popping the second leaves the first waiting.
				target.steer(waiting);
				popped = target.popLastSteer();
				stillQueued = target.peekSteeringQueue().includes(waiting);
				target.steer(person("new"));
			},
		});

		expect(popped).toBe(waiting);
		expect(stillQueued).toBe(true);
		expect(transcriptTexts(agent)).toEqual(["start", "U1", "U2", "U3", "U4", "card 1", "new"]);
	});

	for (const [name, failure] of [
		["throws", "throw"],
		["aborts the run", "abort"],
		["cancels its commit", "cancel"],
	] as const) {
		it(`does not count a person's steer toward the allowance when its preparation ${name}`, async () => {
			const mock = createMockModel({ handler: () => ({ content: ["ack"] }) });
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
				convertToLlm,
				steeringMode: "one-at-a-time",
			});
			const typed = person("typed");
			const waiting = card(1);
			// The card is queued first, so only the person-first rule takes `typed` ahead of it.
			agent.steer(waiting);
			agent.steer(typed);
			agent.prepareQueuedMessages = () => {
				if (failure === "throw") throw new Error("preparation failed");
				if (failure === "abort") {
					agent.abort();
					return undefined;
				}
				return { commit: () => undefined };
			};
			// As many failed attempts as the allowance holds; each puts the person's steer back at the front.
			for (let attempt = 0; attempt < MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING; attempt++) {
				await agent.continue().catch(() => undefined);
				expect(agent.peekSteeringQueue()).toEqual([typed, waiting]);
			}
			expect(mock.calls).toHaveLength(0);
			expect(transcriptTexts(agent)).toEqual([]);

			agent.prepareQueuedMessages = undefined;
			await agent.continue();
			// Nothing reached the transcript, so the person's steer still goes first.
			expect(transcriptTexts(agent)).toEqual(["typed", "card 1"]);
		});
	}

	it("does not count a person's steer a queue replacement withdraws while it is being prepared", async () => {
		const mock = createMockModel({ handler: () => ({ content: ["ack"] }) });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			convertToLlm,
			steeringMode: "one-at-a-time",
		});
		const withdrawn = person("withdrawn");
		for (const text of ["U1", "U2", "U3"]) agent.steer(person(text));
		agent.steer(withdrawn);
		agent.steer(card(1));
		let replaced = 0;
		agent.prepareQueuedMessages = messages => {
			if (!messages.includes(withdrawn)) return undefined;
			replaced++;
			agent.replaceQueue(
				"steering",
				agent.peekSteeringQueue().filter(message => message !== withdrawn),
			);
			agent.steer(person("U4"));
			return undefined;
		};
		await agent.continue();
		if (agent.hasQueuedMessages()) await agent.continue();

		expect(replaced).toBe(1);
		// Three steers reached the transcript before the withdrawn one, so U4 is the fourth.
		expect(transcriptTexts(agent)).toEqual(["U1", "U2", "U3", "U4", "card 1"]);
	});

	it("delivers the whole queue in order at the next boundary in all mode", async () => {
		const { agent, calls } = await runWithQueued([card(1), person("mine"), card(2)], { steeringMode: "all" });

		expect(texts(calls[1]).slice(-3)).toEqual(["card 1", "mine", "card 2"]);
		expect(calls).toHaveLength(2);
		expect(transcriptTexts(agent)).toEqual(["start", "card 1", "mine", "card 2"]);
	});

	it("keeps steeringQueueState's published results and classifies a range without copying it", () => {
		const queue = [card(1), person("typed")];
		expect(steeringQueueState(queue)).toEqual({ queued: true, source: "user" });
		expect(steeringQueueState(queue, 1)).toEqual({ queued: true, source: "system" });
		expect(steeringQueueState(queue, 0)).toEqual({ queued: false });
		expect(steeringRangeState(queue, 1, 2)).toEqual({ queued: true, source: "user" });
		expect(steeringRangeState(queue, 0, 1)).toEqual({ queued: true, source: "system" });
		expect(steeringRangeState(queue, 2, 2)).toEqual({ queued: false });
	});

	it("classifies the batch interrupt by a person's steer queued behind agent steering, and reads it next", async () => {
		const agentRef = {} as { current: Agent };
		const schema = type({ value: type("string") });
		const executed: string[] = [];
		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: schema,
			concurrency: "exclusive",
			interruptible: true,
			async execute(_id, params) {
				executed.push(params.value);
				if (params.value === "first") {
					agentRef.current.steer(card(1));
					agentRef.current.steer(person("stop and read this"));
				}
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
					],
				},
				{ content: ["read"] },
				{ content: ["read card"] },
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: mock.stream,
			convertToLlm,
			steeringMode: "one-at-a-time",
			interruptMode: "immediate",
		});
		agentRef.current = agent;
		const events: AgentEvent[] = [];
		agent.subscribe(event => events.push(event));

		await agent.prompt("start");

		expect(executed).toEqual(["first"]);
		const skipped = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolCallId === "tool-2",
		);
		const skippedText = skipped?.result.content[0];
		expect(skippedText?.type === "text" ? skippedText.text : "").toContain("Skipped due to queued user message");
		expect(texts(mock.calls[1].context).at(-1)).toBe("stop and read this");
	});

	it("counts a unit live steering claims for the streaming response before the transcript records it", async () => {
		const sent: string[] = [];
		let typed = 1;
		let pumped = false;
		const mock = createMockModel({ handler: { content: ["ack"] } });
		const agent: Agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			steeringMode: "one-at-a-time",
			streamFn: async (model, context, options) => {
				if (!pumped && options?.liveSteering) {
					pumped = true;
					agent.steer(card(1));
					agent.steer(card(2));
					agent.steer(person(`P${typed++}`));
					// The real Codex pump claims while the response streams; the transcript records what it
					// sent only when the response ends. A person types one more message per accepted steer.
					const enough = Promise.withResolvers<void>();
					const pump = new CodexSteerPump(
						options.liveSteering,
						{
							steer: async (_responseId, items) => {
								sent.push(String(items[0]?.content));
								if (sent.length < 12) agent.steer(person(`P${typed++}`));
								else enough.resolve();
								return { accepted: true, id: `steer-${sent.length}` };
							},
						},
						messages => messages.map(message => ({ role: "user", content: message.content })),
					);
					pump.start("response-1");
					await enough.promise;
					await pump.finish();
				}
				return mock.stream(model, context, options);
			},
		});

		await agent.prompt("start");

		// Four person units, then the oldest card; the count starts again after it, so the second card
		// waits for four more, not for the transcript.
		expect(sent).toEqual(["P1", "P2", "P3", "P4", "card 1", "P5", "P6", "P7", "P8", "card 2", "P9", "P10"]);
		expect(transcriptTexts(agent)).toEqual(["start", ...sent, "P11", "P12"]);
	});

	// Each row ends the run through a different `agent_end`: the loop's own event when the abort cancels
	// the response, the catch path's visible error when the provider throws, and the catch path's abort
	// branch when the provider throws after the abort.
	for (const [ending, stop] of [
		["the abort cancels the response", "abort"],
		["the provider throws", "throw"],
		["the provider throws after an abort", "abort-then-throw"],
	] as const) {
		it(`gives a run's unrecorded places back before an agent_end subscriber can start the next run when ${ending}`, async () => {
			let first = true;
			const mock = createMockModel({
				// The first response waits until the abort cancels it; later ones answer at once.
				handler: () => ({ content: ["ack"], delayMs: first ? 60_000 : 0 }),
			});
			const agent: Agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				steeringMode: "one-at-a-time",
				streamFn: async (model, context, options) => {
					if (first && options?.liveSteering) {
						agent.steer(card(1));
						agent.steer(person("P1"));
						// Live steering claims P1-P4 for the streaming response, so card 1 is due next; P5
						// arrives behind it. Then the run ends, so none of the four is recorded.
						let sent = 0;
						const enough = Promise.withResolvers<void>();
						const pump = new CodexSteerPump(
							options.liveSteering,
							{
								steer: async () => {
									sent++;
									agent.steer(person(`P${sent + 1}`));
									if (sent === 4) enough.resolve();
									return { accepted: true, id: `steer-${sent}` };
								},
							},
							messages => messages.map(message => ({ role: "user", content: message.content })),
						);
						pump.start("response-1");
						await enough.promise;
						await pump.finish();
						if (stop !== "throw") agent.abort();
						if (stop !== "abort") throw new Error("provider failed");
					}
					return mock.stream(model, context, options);
				},
			});
			let atEnd: { undelivered: string[]; next: string[] } | undefined;
			let continued: Promise<string> | undefined;
			agent.subscribe(event => {
				if (event.type !== "agent_end" || continued) return;
				atEnd = {
					undelivered: agent.peekUndeliveredQueuedMessages().map(messageText),
					next: agent.peekNextSteering().map(messageText),
				};
				first = false;
				continued = agent.continue().then(
					() => "continued",
					(error: unknown) => String(error),
				);
			});

			await agent.prompt("start");

			// At agent_end the four claims are back in the queue, oldest first, and nothing holds their places.
			expect(atEnd).toEqual({ undelivered: [], next: ["P1"] });
			expect(await continued).toBe("continued");
			// So the run the subscriber started reads them first again, and card 1 waits for them.
			expect(transcriptTexts(agent)).toEqual(["start", "P1", "P2", "P3", "P4", "card 1", "P5"]);
		});
	}

	it("lets a due agent steer whose preparation fails go next once it is put back", async () => {
		const mock = createMockModel({ handler: () => ({ content: ["ack"] }) });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			convertToLlm,
			steeringMode: "one-at-a-time",
		});
		const waiting = card(1);
		agent.steer(waiting);
		for (const text of ["U1", "U2", "U3", "U4", "U5"]) agent.steer(person(text));
		let failed = false;
		agent.prepareQueuedMessages = messages => {
			if (failed || !messages.includes(waiting)) return undefined;
			failed = true;
			throw new Error("preparation failed");
		};
		await agent.continue().catch(() => undefined);
		expect(failed).toBe(true);
		expect(transcriptTexts(agent)).toEqual(["U1", "U2", "U3", "U4"]);

		// The failed take gave its place back without starting a fresh allowance, so the card is still due.
		await agent.continue();
		expect(transcriptTexts(agent)).toEqual(["U1", "U2", "U3", "U4", "card 1", "U5"]);
	});

	it("delivers a prioritized steer next even when the allowance makes an agent steer due", async () => {
		const urgent = person("URGENT");
		const { agent } = await runWithQueued([card(1), person("U1"), person("U2"), person("U3"), person("U4")], {
			arrivals: (call, target) => {
				if (call !== 4) return;
				// U4 was just taken: four user units went ahead of card 1, so it is due next. A host
				// promotes the message that denied a tool call; it must land right after the denial.
				target.steer(urgent);
				target.prioritizeSteering([urgent]);
			},
		});

		expect(transcriptTexts(agent)).toEqual(["start", "U1", "U2", "U3", "U4", "URGENT", "card 1"]);
	});

	it("keeps a prioritized steer first when its preparation fails and puts it back", async () => {
		const mock = createMockModel({ handler: () => ({ content: ["ack"] }) });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			convertToLlm,
			steeringMode: "one-at-a-time",
		});
		const urgent = person("URGENT");
		const people = ["U1", "U2", "U3", "U4"].map(person);
		agent.steer(card(1));
		for (const message of people) agent.steer(message);
		let failed = false;
		agent.prepareQueuedMessages = messages => {
			// Four user units went ahead of card 1; the denial arrives while the fourth is prepared.
			if (messages.includes(people[3])) {
				agent.steer(urgent);
				agent.prioritizeSteering([urgent]);
			}
			if (failed || !messages.includes(urgent)) return undefined;
			failed = true;
			throw new Error("preparation failed");
		};
		await agent.continue().catch(() => undefined);
		expect(failed).toBe(true);
		expect(transcriptTexts(agent)).toEqual(["U1", "U2", "U3", "U4"]);

		await agent.continue();
		expect(transcriptTexts(agent)).toEqual(["U1", "U2", "U3", "U4", "URGENT", "card 1"]);
	});

	it("names the next steering delivery, which is the unit the next delivery records", async () => {
		const names = ["card 1", "U1", "U2", "U3", "U4", "U5"];
		const queued = [card(1), ...names.slice(1).map(person)];
		const seen: number[][] = [];
		const { agent } = await runWithQueued(queued, {
			arrivals: (call, target) => {
				if (call <= 5) seen.push(target.peekNextSteering().map(message => queued.indexOf(message)));
			},
		});

		// Indexes into `queued`: U2, U3, U4, then card 1 once four user units were taken, then U5.
		expect(seen).toEqual([[2], [3], [4], [0], [5]]);
		// Each call's peek is the unit the following call took: transcript entries after "start" and U1.
		expect(transcriptTexts(agent).slice(2)).toEqual(seen.map(([index]) => names[index]));
	});

	it("ends a run whose host priority rule throws, and runs again once the host removes the rule", async () => {
		const agentRef = {} as { current: Agent };
		let calls = 0;
		const mock = createMockModel({
			handler: () => {
				// The second model call installs a rule that throws at the next steering selection.
				if (++calls === 2) {
					agentRef.current.setSteeringPriority(() => {
						throw new Error("host rule failed");
					});
				}
				return { content: ["ack"] };
			},
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			convertToLlm,
			steeringMode: "one-at-a-time",
		});
		agentRef.current = agent;
		agent.steer(card(1));
		for (const text of ["U1", "U2", "U3", "U4", "U5"]) agent.steer(person(text));

		await agent.continue().catch(() => undefined);

		// The run reports the host's error and stops; what it did not deliver stays queued in order.
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.error).toContain("host rule failed");
		expect(transcriptTexts(agent)).toEqual(["U1", "U2"]);
		expect(agent.peekSteeringQueue().map(messageText)).toEqual(["card 1", "U3", "U4", "U5"]);

		agent.setSteeringPriority(undefined);
		await agent.continue();
		// The two units delivered before the failure kept their places, so card 1 is due after two more.
		expect(transcriptTexts(agent)).toEqual(["U1", "U2", "U3", "U4", "card 1", "U5"]);
	});

	it("refuses a host priority rule that does not return a boolean instead of reading it as true", async () => {
		const mock = createMockModel({ handler: () => ({ content: ["ack"] }) });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			convertToLlm,
			steeringMode: "one-at-a-time",
		});
		// An async rule returns a Promise, which is truthy whatever it resolves to.
		const asyncRule = (async () => false) as unknown as (message: AgentMessage) => boolean;
		agent.setSteeringPriority(asyncRule);
		agent.steer(card(1));
		agent.steer(person("typed"));

		const outcome = await agent.continue().then(
			() => "delivered",
			(error: unknown) => String(error),
		);

		expect(outcome).toContain("TypeError");
		expect(outcome).toContain("setSteeringPriority");
		expect(mock.calls).toHaveLength(0);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.peekSteeringQueue().map(messageText)).toEqual(["card 1", "typed"]);
	});

	it("keeps each queued occurrence of a promoted message ahead until the transcript records it", async () => {
		const mock = createMockModel({ handler: () => ({ content: ["ack"] }) });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			convertToLlm,
			steeringMode: "one-at-a-time",
		});
		const repeated = card(1);
		agent.steer(repeated);
		agent.steer(repeated);
		agent.steer(person("U1"));
		agent.prioritizeSteering([repeated]);

		await agent.continue();

		expect(transcriptTexts(agent)).toEqual(["card 1", "card 1", "U1"]);
	});

	for (const [setter, change, next] of [
		["setSteeringMode", (agent: Agent) => agent.setSteeringMode("all"), ["card 1", "typed"]],
		["setSteeringPriority", (agent: Agent) => agent.setSteeringPriority(() => false), ["card 1"]],
		["setQueuedMessageGrouping", (agent: Agent) => agent.setQueuedMessageGrouping(() => true), ["card 1", "typed"]],
	] as const) {
		it(`tells queue observers when ${setter} changes what the next steering delivery takes`, () => {
			const agent = new Agent({ convertToLlm, steeringMode: "one-at-a-time" });
			agent.steer(card(1));
			agent.steer(person("typed"));
			expect(agent.peekNextSteering().map(messageText)).toEqual(["typed"]);
			const observed: string[][] = [];
			agent.onQueueChange(() => observed.push(agent.peekNextSteering().map(messageText)));

			change(agent);

			// An observer that re-reads the queue when told it changed shows what the next delivery takes now.
			expect(observed.at(-1)).toEqual([...next]);
		});
	}
});
