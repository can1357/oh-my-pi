/**
 * Invariants every steering path keeps, each tested as a property over the orderings the Agent admits
 * rather than as one example per path:
 *
 * 1. Settled end. Every `agent_end` reaches subscribers with the Agent settled: not streaming, and holding
 *    no input it took (claimed for preparation, delivered and not yet recorded, or live-steered), whatever
 *    produced the event. A foreign producer cannot report an end while this Agent's run is in flight.
 * 2. Settled queue. Queue listeners never hear from inside a restoration. Input a run took and put back
 *    is published once the run that put it back has settled: after its `agent_end`, with streaming off.
 *    Every queue notification sees each occurrence in exactly one place.
 * 3. Occurrence-owned promotion. A promotion belongs to the queued occurrence it was given to. It stays
 *    with that occurrence while it is taken and put back, ends when the transcript records that
 *    occurrence or it is removed, and never passes to another occurrence of the same message.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { LiveSteerClaim, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

function card(text: string): AgentMessage {
	return { role: "custom", customType: "card", content: text, display: true, timestamp: 1 };
}

function person(text: string): AgentMessage {
	return { role: "user", content: text, attribution: "user", timestamp: 1 };
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

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string"
		? message.content
		: message.content.map(part => ("text" in part ? part.text : "")).join("");
}

function texts(messages: readonly AgentMessage[]): string[] {
	return messages.map(messageText);
}

function transcriptTexts(agent: Agent): string[] {
	return texts(agent.state.messages.filter(message => message.role === "user" || message.role === "custom"));
}

/** An Agent on a mock model that answers in text; a response started after an abort ends as aborted. */
function createAgent() {
	const mock = createMockModel({
		handler: (_context, options) => ({ content: ["ack"], delayMs: options?.signal?.aborted ? 1 : 0 }),
	});
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: mock.stream,
		convertToLlm,
		steeringMode: "one-at-a-time",
	});
	return { agent, mock };
}

/**
 * Each steered occurrence must be in exactly one place: queued or claimed (`peekSteeringQueue`), taken
 * and not yet recorded (`peekUndeliveredQueuedMessages`), recorded, or removed by the test.
 */
function misplaced(agent: Agent, steered: readonly AgentMessage[], removed: readonly AgentMessage[]): string[] {
	const count = new Map<AgentMessage, number>();
	for (const message of steered) count.set(message, (count.get(message) ?? 0) + 1);
	const placed = [
		...agent.peekSteeringQueue(),
		...agent.peekUndeliveredQueuedMessages(),
		...agent.state.messages,
		...removed,
	];
	for (const message of placed) {
		const left = count.get(message);
		if (left !== undefined) count.set(message, left - 1);
	}
	return [...count]
		.filter(([, left]) => left !== 0)
		.map(([message, left]) => `${messageText(message)} ${left > 0 ? "in no place" : "in two places"}`);
}

/** Deterministic pseudo-random numbers in [0, 1) for one seed. */
function seededRandom(seed: number): () => number {
	let state = (seed * 7919 + 17) % 2147483648;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

describe("steering invariants: the round-seven reproductions", () => {
	it("refuses a foreign agent_end while the run holds live-steered input, so no subscriber sees the run end", async () => {
		const { agent, mock } = createAgent();
		const claimed = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let first = true;
		agent.streamFn = async (model, context, options) => {
			if (first && options?.liveSteering && options.signal) {
				first = false;
				agent.steer(person("P1"));
				await options.liveSteering.claim(options.signal);
				claimed.resolve();
				await release.promise;
			}
			return mock.stream(model, context, options);
		};
		const ends: Array<{ source: string | undefined; streaming: boolean; held: string[] }> = [];
		agent.subscribe(event => {
			if (event.type !== "agent_end") return;
			ends.push({
				source: event.source,
				streaming: agent.state.isStreaming,
				held: texts(agent.peekUndeliveredQueuedMessages()),
			});
		});

		const running = agent.prompt("start");
		await claimed.promise;
		let refusal: unknown;
		try {
			agent.emitExternalAgentEnd({ type: "agent_end", messages: [] }, "other-producer");
		} catch (error) {
			refusal = error;
		}

		expect(ends).toEqual([]);
		expect(String(refusal)).toContain("Agent.emitExternalAgentEnd cannot report an end while this Agent");
		release.resolve();
		await running;
		// The run's own end finds its live-steered input back in the queue, and the next run reads it.
		expect(ends).toEqual([{ source: undefined, streaming: false, held: [] }]);
		await agent.continue();
		expect(transcriptTexts(agent)).toEqual(["start", "P1"]);
	});

	it("publishes input an aborted preparation put back only after agent_end, with streaming off", async () => {
		const { agent } = createAgent();
		let steered = false;
		let restoring = false;
		agent.addBeforeModelCallHook(() => {
			if (steered) return;
			steered = true;
			agent.steer(person("P1"));
		});
		agent.prepareQueuedMessages = () => {
			restoring = true;
			agent.abort();
			throw new Error("cancel preparation");
		};
		const events: Array<{ event: "agent_end" | "queue"; streaming: boolean; queue: string[] }> = [];
		agent.subscribe(event => {
			if (!restoring || event.type !== "agent_end") return;
			events.push({
				event: "agent_end",
				streaming: agent.state.isStreaming,
				queue: texts(agent.peekSteeringQueue()),
			});
		});
		agent.onQueueChange(() => {
			if (!restoring) return;
			events.push({ event: "queue", streaming: agent.state.isStreaming, queue: texts(agent.peekSteeringQueue()) });
		});

		await agent.prompt("start");

		expect(events).toEqual([
			{ event: "agent_end", streaming: false, queue: ["P1"] },
			{ event: "queue", streaming: false, queue: ["P1"] },
		]);
	});

	it("lets a queue listener resume a continuation whose preparation failed, because it hears once that settled", async () => {
		const { agent } = createAgent();
		agent.steer(person("P1"));
		let failed = false;
		agent.prepareQueuedMessages = () => {
			if (failed) return undefined;
			failed = true;
			throw new Error("preparation failed");
		};
		const streamingWhenHeard: boolean[] = [];
		let resumed: Promise<string> | undefined;
		agent.onQueueChange(() => {
			if (!failed || resumed || agent.peekSteeringQueue().length === 0) return;
			streamingWhenHeard.push(agent.state.isStreaming);
			resumed = agent.continue().then(
				() => "resumed",
				(error: unknown) => String(error),
			);
		});

		await expect(agent.continue()).rejects.toThrow("preparation failed");

		expect(streamingWhenHeard).toEqual([false]);
		expect(await resumed).toBe("resumed");
		expect(transcriptTexts(agent)).toEqual(["P1"]);
	});

	it("keeps a promotion with its occurrence when a listener promotes a new occurrence during a dequeue", async () => {
		const { agent } = createAgent();
		const repeated = card("C");
		agent.steer(repeated);
		agent.steer(repeated);
		agent.steer(person("P"));
		agent.prioritizeSteering([repeated]);
		let dequeuing = false;
		let promotedAgain = false;
		agent.addBeforeQueuedMessageDequeueHook(() => {
			dequeuing = true;
		});
		agent.onQueueChange(() => {
			if (!dequeuing) return;
			dequeuing = false;
			if (promotedAgain) return;
			// The first occurrence was just taken; a third arrives and is promoted too.
			promotedAgain = true;
			agent.steer(repeated);
			agent.prioritizeSteering([repeated]);
		});

		await agent.continue();

		expect(promotedAgain).toBe(true);
		expect(transcriptTexts(agent)).toEqual(["C", "C", "C", "P"]);
	});

	it("drops the promotion of a removed occurrence instead of passing it to a later one", async () => {
		const { agent } = createAgent();
		const repeated = card("C");
		agent.steer(repeated);
		agent.steer(repeated);
		agent.prioritizeSteering([repeated]);
		agent.popLastSteer();
		await agent.continue();

		agent.steer(repeated);
		agent.steer(person("P"));
		await agent.continue();

		// The C queued last was never promoted, so the person's steer goes ahead of it.
		expect(transcriptTexts(agent)).toEqual(["C", "P", "C"]);
	});
});

/** Where the run is when its end is produced. */
type Held = "nothing" | "live-steered" | "claimed" | "continuation-claimed";
/** What ends the run, or tries to. */
type Ending =
	| "completes"
	| "abort"
	| "provider-throws"
	| "abort-then-throw"
	| "preparation-throws"
	| "preparation-aborts"
	| "foreign-end";

const ENDINGS: Record<Held, readonly Ending[]> = {
	nothing: ["completes", "abort", "provider-throws", "abort-then-throw", "foreign-end"],
	"live-steered": ["completes", "abort", "provider-throws", "abort-then-throw", "foreign-end"],
	claimed: ["completes", "abort", "preparation-throws", "preparation-aborts", "foreign-end"],
	"continuation-claimed": ["completes", "abort", "preparation-throws", "preparation-aborts", "foreign-end"],
};

interface EndSeen {
	source: string | undefined;
	streaming: boolean;
	undelivered: string[];
	misplaced: string[];
}

/**
 * Hold the run in `held`, then end it by `ending`. Every `agent_end` a subscriber sees is recorded with
 * the Agent's state at that moment, and the first own end starts the next run when input is queued.
 */
async function endRunWhileHolding(held: Held, ending: Ending) {
	const { agent, mock } = createAgent();
	const steered: AgentMessage[] = [];
	const steer = (message: AgentMessage): void => {
		steered.push(message);
		agent.steer(message);
	};
	const reached = Promise.withResolvers<void>();
	const decided = Promise.withResolvers<void>();
	let firstCall = true;
	agent.streamFn = async (model, context, options) => {
		if (!firstCall || held === "continuation-claimed") return mock.stream(model, context, options);
		firstCall = false;
		if (held === "claimed") {
			// The boundary after this response claims P1 for preparation.
			steer(person("P1"));
			return mock.stream(model, context, options);
		}
		if (held === "live-steered" && options?.liveSteering && options.signal) {
			steer(person("P1"));
			await options.liveSteering.claim(options.signal);
		}
		reached.resolve();
		await decided.promise;
		if (ending === "provider-throws") throw new Error("provider failed");
		if (ending === "abort-then-throw") {
			agent.abort();
			throw new Error("provider failed after the abort");
		}
		return mock.stream(model, context, options);
	};
	let preparations = 0;
	agent.prepareQueuedMessages = async () => {
		if (preparations++ > 0) return undefined;
		reached.resolve();
		await decided.promise;
		if (ending === "preparation-throws") throw new Error("preparation failed");
		if (ending === "preparation-aborts") {
			agent.abort();
			throw new Error("preparation cancelled");
		}
		return undefined;
	};

	const ends: EndSeen[] = [];
	let next: Promise<string> | undefined;
	agent.subscribe(event => {
		if (event.type !== "agent_end") return;
		ends.push({
			source: event.source,
			streaming: agent.state.isStreaming,
			undelivered: texts(agent.peekUndeliveredQueuedMessages()),
			misplaced: misplaced(agent, steered, []),
		});
		// A subscriber may start the next run from the end, so it must find the Agent idle.
		if (next || event.source !== undefined || agent.peekSteeringQueue().length === 0) return;
		next = agent.continue().then(
			() => "continued",
			(error: unknown) => String(error),
		);
	});

	if (held === "continuation-claimed") steer(person("P1"));
	const running = (held === "continuation-claimed" ? agent.continue() : agent.prompt("start")).catch(
		(error: unknown) => String(error),
	);
	await reached.promise;
	let foreign: string | undefined;
	if (ending === "foreign-end") {
		try {
			agent.emitExternalAgentEnd({ type: "agent_end", messages: [] }, "other-producer");
			foreign = "dispatched";
		} catch (error) {
			foreign = error instanceof Error ? error.message : String(error);
		}
	}
	const endsWhileRunning = ends.length;
	if (ending === "abort") agent.abort();
	decided.resolve();
	await running;
	const continued = await next;
	await agent.waitForIdle();
	// A continuation whose preparation failed reports no end; the queue still holds what it took.
	if (agent.peekSteeringQueue().length > 0) await agent.continue();
	return { ends, endsWhileRunning, foreign, continued, transcript: transcriptTexts(agent), steered };
}

describe("steering invariant 1: every agent_end finds the Agent settled, whatever produced it", () => {
	for (const held of Object.keys(ENDINGS) as Held[]) {
		for (const ending of ENDINGS[held]) {
			it(`holding ${held}, ended by ${ending}`, async () => {
				const outcome = await endRunWhileHolding(held, ending);

				if (ending === "foreign-end") {
					expect(outcome.foreign).toContain("Agent.emitExternalAgentEnd cannot report an end while this Agent");
					expect(outcome.endsWhileRunning).toBe(0);
				}
				expect(outcome.ends.length).toBeGreaterThan(0);
				for (const end of outcome.ends) {
					expect(end).toEqual({ source: undefined, streaming: false, undelivered: [], misplaced: [] });
				}
				expect(outcome.continued ?? "continued").toBe("continued");
				const opening = held === "continuation-claimed" ? [] : ["start"];
				expect(outcome.transcript).toEqual(held === "nothing" ? opening : [...opening, "P1"]);
			});
		}
	}

	it("dispatches a foreign agent_end, tagged with its source, while the Agent is idle", async () => {
		const { agent } = createAgent();
		await agent.prompt("start");
		const ends: EndSeen[] = [];
		agent.subscribe(event => {
			if (event.type !== "agent_end") return;
			ends.push({
				source: event.source,
				streaming: agent.state.isStreaming,
				undelivered: texts(agent.peekUndeliveredQueuedMessages()),
				misplaced: [],
			});
		});

		agent.emitExternalAgentEnd({ type: "agent_end", messages: [] }, "other-producer");

		expect(ends).toEqual([{ source: "other-producer", streaming: false, undelivered: [], misplaced: [] }]);
	});
});

/** How input the run took gets put back. */
type Restoration = "boundary-claim" | "continuation-claim" | "live-claim" | "live-steered-at-end";
type RestorationOutcome = "succeeds" | "throws" | "aborts";

interface QueueEntry {
	kind: "queue" | "end" | "take";
	streaming: boolean;
	queue: string[];
}

/** Records every queue notification, `agent_end` and dequeue with the Agent's state at that moment. */
class QueueObserver {
	readonly log: QueueEntry[] = [];
	readonly violations: string[] = [];
	triggeredAt = -1;

	constructor(
		readonly agent: Agent,
		readonly steered: AgentMessage[],
		readonly removed: AgentMessage[],
	) {
		agent.onQueueChange(() => this.#record("queue"));
		agent.subscribe(event => {
			if (event.type === "agent_end") this.#record("end");
		});
		agent.addBeforeQueuedMessageDequeueHook(() => this.#record("take"));
	}

	#record(kind: QueueEntry["kind"]): void {
		this.log.push({ kind, streaming: this.agent.state.isStreaming, queue: texts(this.agent.peekSteeringQueue()) });
		for (const place of misplaced(this.agent, this.steered, this.removed)) {
			this.violations.push(`${kind} #${this.log.length - 1}: ${place}`);
		}
	}

	/** The outcome that puts input back happens now. */
	trigger(): void {
		this.triggeredAt = this.log.length;
	}
}

/** Whether the outcome ends the run that took the input (otherwise the run goes on and reads it). */
function endsRun(path: Restoration, outcome: RestorationOutcome): boolean {
	if (path === "live-steered-at-end") return true;
	if (path === "live-claim") return outcome === "aborts";
	return outcome !== "succeeds";
}

async function restoreThrough(path: Restoration, outcome: RestorationOutcome) {
	const { agent, mock } = createAgent();
	const steered: AgentMessage[] = [];
	const observer = new QueueObserver(agent, steered, []);
	const p1 = person("P1");
	const steer = (): void => {
		steered.push(p1);
		agent.steer(p1);
	};
	let preparations = 0;
	agent.prepareQueuedMessages = () => {
		if (preparations++ > 0 || path === "live-steered-at-end" || outcome === "succeeds") return undefined;
		observer.trigger();
		if (outcome === "aborts") agent.abort();
		throw new Error(outcome === "aborts" ? "preparation cancelled" : "preparation failed");
	};
	let firstCall = true;
	agent.streamFn = async (model, context, options) => {
		if (!firstCall || path === "continuation-claim") return mock.stream(model, context, options);
		firstCall = false;
		steer();
		if (path === "boundary-claim" || !options?.liveSteering || !options.signal) {
			return mock.stream(model, context, options);
		}
		const claim = await options.liveSteering.claim(options.signal);
		if (path === "live-claim") {
			claim?.accept();
			return mock.stream(model, context, options);
		}
		// Live-steered and never accepted: the run's end puts it back however the run ends.
		observer.trigger();
		if (outcome === "throws") throw new Error("provider failed");
		if (outcome === "aborts") agent.abort();
		return mock.stream(model, context, options);
	};

	if (path === "continuation-claim") {
		steer();
		await agent.continue().catch(() => undefined);
	} else {
		await agent.prompt("start");
	}
	await agent.waitForIdle();
	const settled = { log: [...observer.log], queue: texts(agent.peekSteeringQueue()) };
	if (agent.peekSteeringQueue().length > 0) await agent.continue();
	return { observer, settled, transcript: transcriptTexts(agent) };
}

describe("steering invariant 2: queue listeners hear restored input only once its run settled", () => {
	for (const path of ["boundary-claim", "continuation-claim", "live-claim", "live-steered-at-end"] as const) {
		for (const outcome of ["succeeds", "throws", "aborts"] as const) {
			it(`${path} that ${outcome}`, async () => {
				const { observer, settled, transcript } = await restoreThrough(path, outcome);

				expect(observer.violations).toEqual([]);
				// Listeners are never left with a stale view: the last notification shows the settled queue.
				expect(settled.log.findLast(entry => entry.kind === "queue")?.queue).toEqual(settled.queue);
				if (path === "live-steered-at-end" || outcome !== "succeeds") {
					expect(observer.triggeredAt).toBeGreaterThanOrEqual(0);
					const after = settled.log.slice(observer.triggeredAt);
					if (endsRun(path, outcome)) {
						// Nothing reports the queue from inside the run's teardown: not while it streams, and
						// not before the end of the run that put the input back.
						const firstEnd = after.findIndex(entry => entry.kind === "end");
						after.forEach((entry, index) => {
							if (entry.kind !== "queue") return;
							expect({ index, streaming: entry.streaming }).toEqual({ index, streaming: false });
							if (firstEnd >= 0) expect(index).toBeGreaterThan(firstEnd);
						});
						// The last word listeners heard came once the run settled, so one can start the next run.
						expect(settled.log.findLast(entry => entry.kind === "queue")?.streaming).toBe(false);
					} else {
						// The run goes on: the put-back input is read at the next boundary, and the
						// restoration itself announced nothing before that read.
						const nextTake = after.findIndex(entry => entry.kind === "take");
						expect(nextTake).toBeGreaterThanOrEqual(0);
						expect(after.slice(0, nextTake).filter(entry => entry.kind === "queue")).toEqual([]);
					}
				}
				const opening = path === "continuation-claim" ? [] : ["start"];
				expect(transcript).toEqual([...opening, "P1"]);
			});
		}
	}

	it("announces an explicit removal that cancels a claim at once, while the run streams", async () => {
		const { agent } = createAgent();
		const steered: AgentMessage[] = [];
		const removed: AgentMessage[] = [];
		const observer = new QueueObserver(agent, steered, removed);
		const p1 = person("P1");
		steered.push(p1);
		agent.steer(p1);
		let popped: AgentMessage | undefined;
		agent.prepareQueuedMessages = () => {
			observer.trigger();
			// The pop's own notification must already count P1 as removed.
			removed.push(p1);
			popped = agent.popLastSteer();
			return undefined;
		};

		await agent.continue().catch(() => undefined);

		expect(popped).toBe(p1);
		expect(observer.violations).toEqual([]);
		expect(observer.log[observer.triggeredAt]).toEqual({ kind: "queue", streaming: true, queue: [] });
		expect(transcriptTexts(agent)).toEqual([]);
	});
});

/** One queued occurrence in the reference model. */
interface ModelOccurrence {
	name: string;
	promoted: boolean;
}

/**
 * Reference model of "one-at-a-time" steering with occurrence-owned promotion: a unit holding a promoted
 * occurrence goes first, then a person's, then the head. Sequences queue at most
 * MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING person occurrences, so the agent-steering allowance never decides.
 */
class OccurrenceModel {
	queue: ModelOccurrence[] = [];
	/** The unit taken for delivery (claimed, or live-steered) and not yet recorded or put back. */
	taken: ModelOccurrence[] | undefined;
	readonly transcript: string[] = [];

	/** What `peekSteeringQueue` shows: a claimed unit, then the queue. */
	view(): string[] {
		return [...(this.taken ?? []), ...this.queue].map(occurrence => occurrence.name);
	}

	enqueue(name: string): void {
		this.queue.push({ name, promoted: false });
	}

	promote(names: readonly string[]): void {
		const wanted = new Set(names);
		const front = this.queue.filter(occurrence => wanted.has(occurrence.name));
		for (const occurrence of front) occurrence.promoted = true;
		this.queue = [...front, ...this.queue.filter(occurrence => !wanted.has(occurrence.name))];
	}

	popLast(): string | undefined {
		return this.queue.pop()?.name;
	}

	/** Remove the occurrence at `index` of {@link view}; a claimed unit goes back to the queue. */
	removeAt(index: number): void {
		const occurrences = [...(this.taken ?? []), ...this.queue];
		occurrences.splice(index, 1);
		this.queue = occurrences;
		this.taken = undefined;
	}

	take(): void {
		let index = this.queue.findIndex(occurrence => occurrence.promoted);
		if (index < 0) index = this.queue.findIndex(occurrence => occurrence.name.startsWith("P"));
		if (index < 0) index = 0;
		this.taken = this.queue.splice(index, 1);
	}

	record(): void {
		for (const occurrence of this.taken ?? []) this.transcript.push(occurrence.name);
		this.taken = undefined;
	}

	putBack(): void {
		this.queue = [...(this.taken ?? []), ...this.queue];
		this.taken = undefined;
	}
}

const OCCURRENCE_NAMES = ["C", "D", "P1", "P2", "P3", "P4"] as const;

/**
 * Drive the Agent and the reference model through one random sequence of enqueue, promote, pop,
 * replacement that removes an occurrence, and re-enqueue of a message already used, between runs, while a
 * unit is being dequeued, and while it is claimed; each taken unit is then delivered, live-steered and
 * recorded, or put back by a failed or aborted preparation or an aborted response.
 */
async function runOccurrenceSequence(seed: number) {
	const random = seededRandom(seed);
	const objects = new Map(
		OCCURRENCE_NAMES.map(name => [name, name.startsWith("P") ? person(name) : card(name)] as const),
	);
	const { agent, mock } = createAgent();
	const model = new OccurrenceModel();
	const log: string[] = [];
	const violations: string[] = [];
	/** How often each operation and outcome ran, so the property can require that it explored them. */
	const coverage = new Map<string, number>();
	const cover = (what: string): void => {
		coverage.set(what, (coverage.get(what) ?? 0) + 1);
	};
	const steeredBefore = new Set<string>();
	let budget = 4 + Math.floor(random() * 11);
	let personBudget = 4;
	let interruptions = 3;
	let applying = false;
	let liveClaiming = false;

	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
	const apply = (phase: string): void => {
		if (budget <= 0) return;
		budget--;
		applying = true;
		try {
			const view = texts(agent.peekSteeringQueue());
			if (view.join() !== model.view().join()) {
				violations.push(`${phase}: the Agent shows [${view}] where the model holds [${model.view()}]`);
			}
			const roll = random();
			if (roll < 0.4) {
				const name = pick(OCCURRENCE_NAMES.filter(candidate => personBudget > 0 || !candidate.startsWith("P")));
				if (name.startsWith("P")) personBudget--;
				log.push(`${phase}: steer ${name}`);
				cover(steeredBefore.has(name) ? "re-enqueue" : "enqueue");
				steeredBefore.add(name);
				model.enqueue(name);
				agent.steer(objects.get(name)!);
			} else if (roll < 0.62) {
				const names = [...new Set([pick(OCCURRENCE_NAMES), pick(OCCURRENCE_NAMES)])];
				log.push(`${phase}: promote ${names}`);
				cover("promote");
				model.promote(names);
				agent.prioritizeSteering(names.map(name => objects.get(name)!));
			} else if (roll < 0.8) {
				if (model.queue.length === 0) return;
				const expected = model.popLast();
				const popped = agent.popLastSteer();
				log.push(`${phase}: pop ${expected}`);
				cover("pop");
				if (popped === undefined || messageText(popped) !== expected) {
					violations.push(`${phase}: popped ${popped ? messageText(popped) : "nothing"}, model ${expected}`);
				}
			} else {
				const shown = model.view();
				if (shown.length === 0) return;
				// A replacement names occurrences only by their order, so remove the last occurrence of a
				// message: the earlier ones keep their places, and with them their promotions.
				const index = shown.lastIndexOf(pick(shown));
				log.push(`${phase}: replace without #${index} (${shown[index]})`);
				cover(model.taken ? "replace dropping a claim" : "replace");
				const next = [...agent.peekSteeringQueue()];
				next.splice(index, 1);
				model.removeAt(index);
				agent.replaceQueue("steering", next);
				const kept = model.queue;
				if (kept.some(a => a.promoted && kept.some(b => b.name === a.name && !b.promoted))) {
					cover("replace keeping promoted and unpromoted occurrences of one message");
				}
			}
			cover(`operation while ${phase}`);
		} finally {
			applying = false;
		}
	};

	let expectingTake = false;
	agent.addBeforeQueuedMessageDequeueHook(() => {
		expectingTake = true;
	});
	agent.onQueueChange(() => {
		if (!expectingTake || applying) return;
		expectingTake = false;
		model.take();
		cover("take");
		if (random() < 0.35) apply("dequeue");
	});
	agent.prepareQueuedMessages = (messages, signal) => {
		// A replacement during the dequeue notification cancelled this claim.
		if (signal.aborted) return undefined;
		if (!model.taken) {
			violations.push(`a preparation of [${texts(messages)}] the model did not take`);
			return undefined;
		}
		const expected = model.taken.map(occurrence => occurrence.name);
		if (texts(messages).join() !== expected.join()) {
			violations.push(`took [${texts(messages)}] where the model takes [${expected}]`);
		}
		if (random() < 0.35) apply("claim");
		if (signal.aborted || !model.taken) return undefined;
		const roll = interruptions > 0 ? random() : 1;
		if (roll < 0.12) {
			interruptions--;
			log.push(`fail preparing ${expected}`);
			cover("failed preparation");
			model.putBack();
			throw new Error("preparation failed");
		}
		if (roll < 0.24) {
			interruptions--;
			log.push(`abort preparing ${expected}`);
			cover("aborted preparation");
			model.putBack();
			agent.abort();
			throw new Error("preparation cancelled");
		}
		// A live claim is recorded only after the response, if the provider accepts it.
		if (!liveClaiming) model.record();
		return undefined;
	};
	agent.streamFn = async (model_, context, options) => {
		if (options?.liveSteering && options.signal && agent.peekSteeringQueue().length > 0 && random() < 0.3) {
			liveClaiming = true;
			let claim: LiveSteerClaim | undefined;
			try {
				claim = await options.liveSteering.claim(options.signal);
			} finally {
				liveClaiming = false;
			}
			if (claim && model.taken) {
				if (interruptions > 0 && random() < 0.3) {
					interruptions--;
					log.push(`abort the response holding ${model.view().slice(0, 1)}`);
					cover("aborted response holding a live claim");
					model.putBack();
					agent.abort();
				} else {
					log.push("accept the live claim");
					cover("accepted live claim");
					claim.accept();
					model.record();
				}
			}
		}
		return mock.stream(model_, context, options);
	};

	let rounds = 0;
	while ((budget > 0 || agent.hasQueuedMessages()) && rounds++ < 80) {
		const idleOps = 1 + Math.floor(random() * 4);
		for (let op = 0; op < idleOps; op++) apply("idle");
		// Sometimes let the queue grow across idle phases before a run drains it.
		if (agent.hasQueuedMessages() && (budget <= 0 || random() < 0.5)) await agent.continue().catch(() => undefined);
	}
	if (rounds >= 80) violations.push("the queue never drained");
	return { violations, log, coverage, actual: transcriptTexts(agent), expected: model.transcript };
}

describe("steering invariant 3: a promotion belongs to its occurrence", () => {
	const SEQUENCES = 2000;

	it(`matches the reference model over ${SEQUENCES} random sequences of queue operations`, async () => {
		const failures: string[] = [];
		const explored = new Map<string, number>();
		for (let seed = 1; seed <= SEQUENCES; seed++) {
			const run = await runOccurrenceSequence(seed);
			for (const [what, count] of run.coverage) explored.set(what, (explored.get(what) ?? 0) + count);
			if (run.violations.length > 0 || run.actual.join() !== run.expected.join()) {
				failures.push(
					`seed ${seed}: transcript [${run.actual}] model [${run.expected}]; ${run.violations.join("; ")}\n  ${run.log.join("\n  ")}`,
				);
			}
		}
		expect(failures.slice(0, 3)).toEqual([]);
		// The sequences explored every operation and outcome, at every point an operation can happen.
		const required = [
			"enqueue",
			"re-enqueue",
			"promote",
			"pop",
			"replace",
			"replace dropping a claim",
			"replace keeping promoted and unpromoted occurrences of one message",
			"take",
			"failed preparation",
			"aborted preparation",
			"accepted live claim",
			"aborted response holding a live claim",
			"operation while idle",
			"operation while dequeue",
			"operation while claim",
		];
		// The rarest, a replacement keeping both a promoted and an unpromoted occurrence of one message, ran 9
		// times when this was written; the others ran hundreds to thousands of times.
		expect(required.filter(what => (explored.get(what) ?? 0) < 5)).toEqual([]);
	});
});
