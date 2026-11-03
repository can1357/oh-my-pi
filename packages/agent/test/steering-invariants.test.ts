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
 * 4. Claimed run. A run `prompt()` or `continue()` accepts is the Agent's from the call: `abort()` cancels
 *    it and `waitForIdle()` waits for it, also while it waits for an `agent_end` to reach every subscriber.
 * 5. Removal by content. `removeQueuedMessages` drops an occurrence the Agent holds and has not delivered
 *    (queued, claimed, or taken by the run and not yet in a provider request), so the provider never gets it,
 *    no abort puts it back, and a later occurrence of the same message is unaffected. Delivered input stays.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	Agent,
	AgentBusyError,
	type AgentMessage,
	MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING,
} from "@oh-my-pi/pi-agent-core";
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

/** A taken unit's place in the agent-steering wait, as {@link MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING} describes it. */
interface ModelPlace {
	agent: boolean;
	wait: ModelPlace[] | undefined;
}

/**
 * Reference model of "one-at-a-time" steering with occurrence-owned promotion: a unit holding a promoted
 * occurrence goes first; then, once MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING person units were taken while an
 * agent unit was queued, the oldest agent unit; then a person's; then the head. A taken unit is claimed (still
 * in the pending view `peekSteeringQueue` shows), then in flight (handed to the run, out of the pending view)
 * until the transcript records it; whatever is not recorded goes back and gives its place in the wait back.
 */
class OccurrenceModel {
	queue: ModelOccurrence[] = [];
	/** The unit taken and claimed for preparation, still in the pending view. */
	claimed: ModelOccurrence[] | undefined;
	/** The unit handed to the run (delivered, or live-steered) and not yet recorded. */
	inFlight: ModelOccurrence[] | undefined;
	readonly transcript: string[] = [];
	/** The current agent-steering wait: the places of units taken while it lasts that still hold them. */
	wait: ModelPlace[] | undefined;
	/** Whether the last take went to an agent unit ahead of a queued person unit because the allowance was spent. */
	tookByAllowance = false;
	readonly #places = new Map<ModelOccurrence, ModelPlace>();

	/** What `peekSteeringQueue` shows: a claimed unit, then the queue. */
	view(): string[] {
		return [...(this.claimed ?? []), ...this.queue].map(occurrence => occurrence.name);
	}

	enqueue(name: string): void {
		this.queue.push({ name, promoted: false });
		this.#settle();
	}

	promote(names: readonly string[]): void {
		const wanted = new Set(names);
		const front = this.queue.filter(occurrence => wanted.has(occurrence.name));
		for (const occurrence of front) occurrence.promoted = true;
		this.queue = [...front, ...this.queue.filter(occurrence => !wanted.has(occurrence.name))];
	}

	popLast(): string | undefined {
		const popped = this.queue.pop()?.name;
		this.#settle();
		return popped;
	}

	/** Install the pending view without the occurrence at `index` (or as it is); a claimed unit goes back to the queue. */
	replace(index?: number): void {
		for (const occurrence of this.claimed ?? []) this.#giveBack(occurrence);
		const occurrences = [...(this.claimed ?? []), ...this.queue];
		if (index !== undefined) occurrences.splice(index, 1);
		this.queue = occurrences;
		this.claimed = undefined;
		this.#settle();
	}

	take(): void {
		const isAgent = (occurrence: ModelOccurrence): boolean => !occurrence.name.startsWith("P");
		let index = this.queue.findIndex(occurrence => occurrence.promoted);
		this.tookByAllowance = false;
		if (index < 0 && this.#spent() >= MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING) {
			index = this.queue.findIndex(isAgent);
			this.tookByAllowance = index >= 0 && this.queue.some(occurrence => !isAgent(occurrence));
		}
		if (index < 0) index = this.queue.findIndex(occurrence => !isAgent(occurrence));
		if (index < 0) index = 0;
		const agentQueued = this.queue.some(isAgent);
		const [occurrence] = this.queue.splice(index, 1);
		const agent = isAgent(occurrence);
		// A person unit taken while an agent unit is queued takes a place in that wait, starting it; an agent
		// unit takes one in the wait in progress, and person units count from zero after it.
		const wait = agent ? this.wait : agentQueued ? (this.wait ??= []) : undefined;
		const place: ModelPlace = { agent, wait };
		wait?.push(place);
		this.#places.set(occurrence, place);
		this.claimed = [occurrence];
		this.#settle();
	}

	deliver(): void {
		this.inFlight = this.claimed;
		this.claimed = undefined;
		this.#settle();
	}

	record(): void {
		for (const occurrence of this.inFlight ?? this.claimed ?? []) {
			this.transcript.push(occurrence.name);
			const place = this.#places.get(occurrence);
			this.#places.delete(occurrence);
			// A recorded agent unit keeps its place for good, so what was taken before it stops mattering.
			if (place?.agent && place.wait) place.wait.splice(0, place.wait.indexOf(place) + 1);
		}
		this.inFlight = undefined;
		this.claimed = undefined;
		this.#settle();
	}

	/** Everything taken and not recorded goes back to the front, oldest first, and gives its place back. */
	putBack(): void {
		for (const occurrence of [...(this.inFlight ?? []), ...(this.claimed ?? [])]) this.#giveBack(occurrence);
		this.queue = [...(this.inFlight ?? []), ...(this.claimed ?? []), ...this.queue];
		this.inFlight = undefined;
		this.claimed = undefined;
		this.#settle();
	}

	#giveBack(occurrence: ModelOccurrence): void {
		const place = this.#places.get(occurrence);
		this.#places.delete(occurrence);
		const at = place?.wait?.indexOf(place) ?? -1;
		if (at >= 0) place!.wait!.splice(at, 1);
	}

	/** Person units taken in the current wait since its last agent unit. */
	#spent(): number {
		let spent = 0;
		for (let i = (this.wait?.length ?? 0) - 1; i >= 0 && !this.wait![i].agent; i--) spent++;
		return spent;
	}

	/** The wait ends once no agent unit is pending: queued, claimed or in flight. */
	#settle(): void {
		const pending = [...this.queue, ...(this.claimed ?? []), ...(this.inFlight ?? [])];
		if (this.wait && !pending.some(occurrence => !occurrence.name.startsWith("P"))) this.wait = undefined;
	}
}

const OCCURRENCE_NAMES = ["C", "D", "P1", "P2", "P3", "P4"] as const;

/**
 * Drive the Agent and the reference model through one random sequence. Operations (enqueue, re-enqueue,
 * promote, pop, a replacement that removes one occurrence or keeps them all, continue()) run between runs,
 * from inside queue notifications (at a take, at a delivery, while idle), from inside an `agent_end` (the
 * run's own or a foreign one), and from an abort callback a restoration triggers. A taken unit is then
 * recorded, live-steered and recorded, or put back by a failed or aborted preparation, an aborted response,
 * or the end of a run whose live preparation is still pending. Every queue notification and every
 * `agent_end` is checked against the invariants, and the transcript against the model.
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
	// Every occurrence steered and every one removed, for the one-place check.
	const steered: AgentMessage[] = [];
	const removed: AgentMessage[] = [];
	// Runs started from inside a notification or an end, and held preparations to release once their run ended.
	const background: Promise<unknown>[] = [];
	const held: PromiseWithResolvers<void>[] = [];
	const withPreparer = random() < 0.75;
	let budget = 4 + Math.floor(random() * 11);
	// Above MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING, so the allowance decides some takes.
	let personBudget = 4 + Math.floor(random() * 6);
	let interruptions = 3;
	let applying = false;
	let liveClaiming = false;
	let abortingOurselves = false;
	let inRestoration = false;
	let probing = false;
	let holdNext: PromiseWithResolvers<void> | undefined;

	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
	const abort = (): void => {
		abortingOurselves = true;
		try {
			agent.abort();
		} finally {
			abortingOurselves = false;
		}
	};
	const startContinue = (phase: string, mustBeBusy: boolean): void => {
		background.push(
			agent.continue().then(
				() => {
					if (mustBeBusy) violations.push(`${phase}: a continue() started a run while one streamed`);
				},
				(error: unknown) => {
					if (mustBeBusy && !(error instanceof AgentBusyError)) {
						violations.push(`${phase}: continue() failed with ${String(error)}`);
					}
				},
			),
		);
	};
	const apply = (phase: string): void => {
		if (budget <= 0) return;
		budget--;
		applying = true;
		try {
			const view = texts(agent.peekSteeringQueue());
			if (view.join() !== model.view().join()) {
				violations.push(`${phase}: the Agent shows [${view}] where the model holds [${model.view()}]`);
			}
			// A message queued both promoted and unpromoted, which a removal elsewhere must leave that way.
			const mixedName = model.queue.find(
				a => a.promoted && model.queue.some(b => b.name === a.name && !b.promoted),
			)?.name;
			const promotedName = OCCURRENCE_NAMES.find(name =>
				model.queue.some(occurrence => occurrence.promoted && occurrence.name === name),
			);
			let roll = random();
			// Steer the rare interleavings: a replacement keeping everything while a unit is delivered, and a
			// removal that keeps a promoted and an unpromoted copy of one message.
			if (phase === "delivery" && model.inFlight && roll < 0.5) roll = 0.85;
			else if (mixedName && roll < 0.4) roll = 0.7;
			if (roll < 0.34) {
				const eligible = (candidate: string): boolean => personBudget > 0 || !candidate.startsWith("P");
				// Queue another copy of a promoted message now and then, so promoted and unpromoted copies meet.
				const name =
					promotedName && eligible(promotedName) && random() < 0.3
						? promotedName
						: pick(OCCURRENCE_NAMES.filter(eligible));
				if (name.startsWith("P")) personBudget--;
				log.push(`${phase}: steer ${name}`);
				cover(steeredBefore.has(name) ? "re-enqueue" : "enqueue");
				steeredBefore.add(name);
				model.enqueue(name);
				steered.push(objects.get(name)!);
				agent.steer(objects.get(name)!);
			} else if (roll < 0.52) {
				const names = [...new Set([pick(OCCURRENCE_NAMES), pick(OCCURRENCE_NAMES)])];
				log.push(`${phase}: promote ${names}`);
				cover("promote");
				model.promote(names);
				agent.prioritizeSteering(names.map(name => objects.get(name)!));
			} else if (roll < 0.66) {
				if (model.queue.length === 0) return;
				const last = agent.peekSteeringQueue().at(-1);
				if (last) removed.push(last);
				const expected = model.popLast();
				const popped = agent.popLastSteer();
				log.push(`${phase}: pop ${expected}`);
				cover("pop");
				if (popped === undefined || messageText(popped) !== expected) {
					violations.push(`${phase}: popped ${popped ? messageText(popped) : "nothing"}, model ${expected}`);
				}
			} else if (roll < 0.8) {
				const shown = model.view();
				if (shown.length === 0) return;
				// A replacement names occurrences only by their order, so remove the last occurrence of a
				// message: the earlier ones keep their places, and with them their promotions.
				const others = shown.filter(name => name !== mixedName);
				const index = shown.lastIndexOf(pick(mixedName && others.length > 0 ? others : shown));
				log.push(`${phase}: replace without #${index} (${shown[index]})`);
				cover(model.claimed ? "replace dropping a claim" : "replace");
				const next = [...agent.peekSteeringQueue()];
				removed.push(...next.splice(index, 1));
				model.replace(index);
				agent.replaceQueue("steering", next);
				const kept = model.queue;
				if (kept.some(a => a.promoted && kept.some(b => b.name === a.name && !b.promoted))) {
					cover("replace keeping promoted and unpromoted occurrences of one message");
				}
			} else if (roll < 0.9) {
				log.push(`${phase}: replace keeping every occurrence`);
				cover(model.inFlight ? "replace keeping every occurrence while one is delivered" : "replace keeping all");
				model.replace();
				agent.replaceQueue("steering", [...agent.peekSteeringQueue()]);
			} else {
				// The main loop starts the idle runs itself.
				if (phase === "idle") return;
				const busy = agent.state.isStreaming;
				log.push(`${phase}: continue()`);
				cover(busy ? "continue while a run streams" : `continue from ${phase}`);
				startContinue(phase, busy);
			}
			cover(`operation while ${phase}`);
		} finally {
			applying = false;
		}
	};

	let expectingTake = false;
	let expectingDelivery = false;
	agent.addBeforeQueuedMessageDequeueHook(() => {
		expectingTake = true;
	});
	agent.onQueueChange(() => {
		// No listener hears from inside a restoration, and each occurrence is in exactly one place.
		if (inRestoration) violations.push("a queue notification from inside a restoration");
		for (const place of misplaced(agent, steered, removed)) violations.push(`notification: ${place}`);
		if (applying) return;
		if (expectingTake) {
			expectingTake = false;
			model.take();
			cover("take");
			if (model.tookByAllowance) cover("the allowance put an agent unit ahead of a waiting person unit");
			if (withPreparer) {
				if (random() < 0.35) apply("dequeue");
				return;
			}
			// Without a preparer the take is the delivery: the run holds the unit at once.
			if (liveClaiming) model.deliver();
			else model.record();
			if (random() < 0.35) apply("delivery");
			return;
		}
		if (expectingDelivery) {
			expectingDelivery = false;
			if (random() < 0.35) apply("delivery");
			return;
		}
		if (!agent.state.isStreaming && budget > 0 && random() < 0.1) {
			budget--;
			cover("continue from a queue notification while idle");
			startContinue("queue notification while idle", false);
		}
	});
	if (withPreparer) {
		agent.prepareQueuedMessages = (messages, signal) => {
			// A replacement during the take notification cancelled this claim.
			if (signal.aborted) return undefined;
			if (!model.claimed) {
				violations.push(`a preparation of [${texts(messages)}] the model did not take`);
				return undefined;
			}
			const expected = model.claimed.map(occurrence => occurrence.name);
			if (texts(messages).join() !== expected.join()) {
				violations.push(`took [${texts(messages)}] where the model takes [${expected}]`);
			}
			if (holdNext) {
				// A live preparation still pending when its response is aborted.
				const ready = holdNext;
				holdNext = undefined;
				const release = Promise.withResolvers<void>();
				held.push(release);
				ready.resolve();
				return release.promise.then(() => undefined);
			}
			const live = liveClaiming;
			if (random() < 0.35) apply("claim");
			if (signal.aborted || !model.claimed) return undefined;
			if (random() < 0.3) {
				signal.addEventListener(
					"abort",
					() => {
						if (abortingOurselves || applying) return;
						inRestoration = true;
						try {
							apply("restoration");
						} finally {
							inRestoration = false;
						}
					},
					{ once: true },
				);
			}
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
				abort();
				throw new Error("preparation cancelled");
			}
			expectingDelivery = true;
			// A live claim is recorded only after the response, if the provider accepts it.
			if (live) model.deliver();
			else model.record();
			return undefined;
		};
	}
	agent.streamFn = async (model_, context, options) => {
		const live = options?.liveSteering;
		const signal = options?.signal;
		if (live && signal && agent.peekSteeringQueue().length > 0 && random() < 0.3) {
			if (withPreparer && interruptions > 0 && random() < 0.25) {
				interruptions--;
				const ready = Promise.withResolvers<void>();
				holdNext = ready;
				liveClaiming = true;
				const pending = live.claim(signal);
				background.push(pending);
				await Promise.race([ready.promise, pending]);
				liveClaiming = false;
				holdNext = undefined;
				log.push("abort the response while its live preparation is pending");
				cover("live preparation pending across an aborted response");
				abort();
				return mock.stream(model_, context, options);
			}
			liveClaiming = true;
			let claim: LiveSteerClaim | undefined;
			try {
				claim = await live.claim(signal);
			} finally {
				liveClaiming = false;
			}
			if (claim && model.inFlight) {
				if (interruptions > 0 && random() < 0.3) {
					interruptions--;
					log.push(`abort the response holding ${model.inFlight.map(occurrence => occurrence.name)}`);
					cover("aborted response holding a live claim");
					model.putBack();
					abort();
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
	agent.subscribe(event => {
		if (event.type !== "agent_end" || probing) return;
		// A run's end puts back whatever it took and did not record.
		if (event.source === undefined) model.putBack();
		else cover("foreign end");
		if (random() < 0.4) apply("end");
	});
	agent.subscribe(event => {
		// Registered after the subscriber above, which may have queued input or started a run.
		if (event.type !== "agent_end" || probing) return;
		const where = `${event.source ?? "own"} agent_end`;
		if (agent.state.isStreaming) violations.push(`${where}: a subscriber saw the Agent streaming`);
		const holding = texts(agent.peekUndeliveredQueuedMessages());
		if (holding.length > 0) violations.push(`${where}: the Agent still held [${holding}]`);
		for (const place of misplaced(agent, steered, removed)) violations.push(`${where}: ${place}`);
		probing = true;
		try {
			agent.emitExternalAgentEnd({ type: "agent_end", messages: [] }, "probe");
		} catch {
			violations.push(`${where}: the Agent called itself unsettled at its own end`);
		} finally {
			probing = false;
		}
	});

	const settle = async (): Promise<void> => {
		for (let round = 0; round < 40; round++) {
			await agent.waitForIdle();
			for (const release of held.splice(0)) release.resolve();
			const pending = background.splice(0);
			if (pending.length === 0 && !agent.state.isStreaming) return;
			await Promise.allSettled(pending);
		}
		violations.push("background work never settled");
	};
	let rounds = 0;
	while ((budget > 0 || agent.hasQueuedMessages()) && rounds++ < 80) {
		const idleOps = 1 + Math.floor(random() * 4);
		for (let op = 0; op < idleOps; op++) {
			// Idle operations stop once a run a notification started is in flight: its take comes first.
			if (agent.state.isStreaming) break;
			if (random() < 0.08) {
				log.push("idle: a foreign agent_end");
				try {
					agent.emitExternalAgentEnd({ type: "agent_end", messages: [] }, "foreign");
				} catch {
					violations.push("idle: a settled Agent refused a foreign agent_end");
				}
			} else {
				apply("idle");
			}
		}
		if (agent.hasQueuedMessages() && !agent.state.isStreaming && (budget <= 0 || random() < 0.5)) {
			await agent.continue().catch(() => undefined);
		}
		await settle();
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
		console.log(
			"MODEL",
			JSON.stringify({ sequences: SEQUENCES, failing: failures.length, explored: Object.fromEntries(explored) }),
		);
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
			"replace keeping all",
			"replace keeping every occurrence while one is delivered",
			"take",
			"failed preparation",
			"aborted preparation",
			"accepted live claim",
			"aborted response holding a live claim",
			"live preparation pending across an aborted response",
			"continue while a run streams",
			"continue from end",
			"continue from a queue notification while idle",
			"foreign end",
			"operation while idle",
			"operation while dequeue",
			"operation while claim",
			"operation while delivery",
			"operation while end",
			"operation while restoration",
			"the allowance put an agent unit ahead of a waiting person unit",
		];
		expect(required.filter(what => (explored.get(what) ?? 0) < 5)).toEqual([]);
		// 2,000 sequences took 2.7 s on a quiet slot and over 5 s at load 600; the default 5 s cut them off.
	}, 120_000);
});

describe("steering invariants: the round-eight reproductions", () => {
	for (const withPreparer of [false, true]) {
		it(`keeps live input a replacement of the pending queue leaves alone, and puts it back on abort (preparer: ${withPreparer})`, async () => {
			const { agent, mock } = createAgent();
			if (withPreparer) agent.prepareQueuedMessages = () => undefined;
			const p = person("P");
			let replaced = false;
			agent.onQueueChange(() => {
				if (replaced || !agent.peekUndeliveredQueuedMessages().includes(p)) return;
				replaced = true;
				agent.replaceQueue("steering", [...agent.peekSteeringQueue()]);
			});
			let first = true;
			let claimed: unknown;
			agent.streamFn = async (model, context, options) => {
				if (first && options?.liveSteering && options.signal) {
					first = false;
					agent.steer(p);
					agent.steer(person("Q"));
					claimed = (await options.liveSteering.claim(options.signal))?.messages;
					agent.abort();
				}
				return mock.stream(model, context, options);
			};

			await agent.prompt("start");

			expect(replaced).toBe(true);
			expect(claimed).toBeDefined();
			expect(transcriptTexts(agent)).toEqual(["start"]);
			expect(texts(agent.peekSteeringQueue())).toEqual(["P", "Q"]);
		});
	}

	it("starts a run an agent_end subscriber requests only after every subscriber received the settled end", async () => {
		const { agent } = createAgent();
		let next: Promise<void> | undefined;
		const streaming: boolean[] = [];
		agent.subscribe(event => {
			if (event.type !== "agent_end" || next) return;
			agent.steer(person("P"));
			next = agent.continue();
		});
		agent.subscribe(event => {
			if (event.type === "agent_end") streaming.push(agent.state.isStreaming);
		});

		await agent.prompt("start");
		await next;

		expect(streaming).toEqual([false, false]);
		expect(transcriptTexts(agent)).toEqual(["start", "P"]);
	});

	it("holds queue notifications through a foreign agent_end until every subscriber received it", async () => {
		const { agent } = createAgent();
		let next: Promise<void> | undefined;
		const streaming: boolean[] = [];
		agent.onQueueChange(() => {
			if (!next && !agent.state.isStreaming) next = agent.continue();
		});
		agent.subscribe(event => {
			if (event.type === "agent_end" && event.source) agent.steer(person("P"));
		});
		agent.subscribe(event => {
			if (event.type === "agent_end" && event.source) streaming.push(agent.state.isStreaming);
		});

		agent.emitExternalAgentEnd({ type: "agent_end", messages: [] }, "foreign");
		await next;

		expect(streaming).toEqual([false]);
		expect(transcriptTexts(agent)).toEqual(["P"]);
	});

	it("owes a queue change an abort callback makes during a restoration until the run settled", async () => {
		const { agent } = createAgent();
		agent.steer(person("P"));
		let restoring = false;
		const heard: Array<{ streaming: boolean; queue: string[] }> = [];
		agent.prepareQueuedMessages = (_messages, signal) => {
			signal.addEventListener(
				"abort",
				() => {
					restoring = true;
					agent.steer(person("Q"));
				},
				{ once: true },
			);
			throw new Error("preparation failed");
		};
		agent.onQueueChange(() => {
			if (restoring) heard.push({ streaming: agent.state.isStreaming, queue: texts(agent.peekSteeringQueue()) });
		});

		await expect(agent.continue()).rejects.toThrow("preparation failed");

		expect(heard).toEqual([{ streaming: false, queue: ["P", "Q"] }]);
	});

	it("puts back a live preparation still pending when its response is aborted, before the run's agent_end", async () => {
		const { agent, mock } = createAgent();
		const ready = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let pending: Promise<LiveSteerClaim | undefined> | undefined;
		agent.prepareQueuedMessages = async () => {
			ready.resolve();
			await release.promise;
			return undefined;
		};
		agent.streamFn = async (model, context, options) => {
			if (!pending && options?.liveSteering && options.signal) {
				agent.steer(person("P"));
				pending = options.liveSteering.claim(options.signal);
				await ready.promise;
				agent.abort();
			}
			return mock.stream(model, context, options);
		};
		const ends: unknown[] = [];
		agent.subscribe(event => {
			if (event.type !== "agent_end" || event.source) return;
			let accepted = true;
			try {
				agent.emitExternalAgentEnd({ type: "agent_end", messages: [] }, "probe");
			} catch {
				accepted = false;
			}
			ends.push({
				streaming: agent.state.isStreaming,
				queue: texts(agent.peekSteeringQueue()),
				held: texts(agent.peekUndeliveredQueuedMessages()),
				accepted,
			});
		});

		await agent.prompt("start");
		release.resolve();

		expect(await pending).toBeUndefined();
		expect(ends).toEqual([{ streaming: false, queue: ["P"], held: [], accepted: true }]);
		await agent.continue();
		expect(transcriptTexts(agent)).toEqual(["start", "P"]);
	});
});

describe("steering invariants: the round-nine reproductions", () => {
	/**
	 * A run requested from an `agent_end` subscriber, the run's own end or a foreign one, is the Agent's
	 * from the call. Its provider runs a real child process when it gets the request, so a cancellation that
	 * misses the run shows as the child's marker file, and an idle wait that misses it returns while the
	 * child still runs. Every subscriber still sees the Agent not streaming.
	 */
	for (const method of ["prompt", "continue"] as const) {
		for (const end of ["own", "foreign"] as const) {
			const request = (agent: Agent): Promise<void> => {
				if (method === "prompt") return agent.prompt("second");
				agent.steer(person("second"));
				return agent.continue();
			};
			const endFirst = (agent: Agent): Promise<void> => {
				if (end === "own") return agent.prompt("first");
				agent.emitExternalAgentEnd({ type: "agent_end", messages: [] }, "foreign");
				return Promise.resolve();
			};
			const asksForSecond = (context: { messages: readonly Message[] }) =>
				context.messages.some(
					message => message.role === "user" && JSON.stringify(message.content).includes("second"),
				);
			const endName = end === "own" ? "the run's own agent_end" : "a foreign agent_end";

			it(`abort() cancels a ${method}() requested at ${endName} before its provider starts work`, async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steering-deferred-abort-"));
				const marker = path.join(dir, "started");
				try {
					const { agent, mock } = createAgent();
					agent.streamFn = async (model, context, options) => {
						if (asksForSecond(context) && !options?.signal?.aborted) {
							await Bun.spawn(["sh", "-c", 'printf started > "$1"', "probe", marker]).exited;
						}
						return mock.stream(model, context, options);
					};
					let next: Promise<void> | undefined;
					let busy: unknown;
					const streaming: boolean[] = [];
					agent.subscribe(event => {
						if (event.type !== "agent_end" || next) return;
						next = request(agent);
						busy = agent.prompt("third").catch(error => error);
						agent.abort("cancel the requested run");
					});
					agent.subscribe(event => {
						if (event.type === "agent_end") streaming.push(agent.state.isStreaming);
					});

					await endFirst(agent);
					await next?.catch(() => undefined);

					expect(await busy).toBeInstanceOf(AgentBusyError);
					expect(fs.existsSync(marker)).toBe(false);
					expect(streaming.every(value => value === false)).toBe(true);
					// A cancelled continuation leaves the steer it never delivered queued.
					if (method === "continue") expect(texts(agent.peekSteeringQueue())).toEqual(["second"]);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			it(`waitForIdle() waits for a ${method}() requested at ${endName} while its provider's child runs`, async () => {
				const { agent, mock } = createAgent();
				const childStarted = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let childRunning = false;
				agent.streamFn = async (model, context, options) => {
					if (asksForSecond(context)) {
						const child = Bun.spawn(["cat"], { stdin: "pipe", stdout: "ignore" });
						childRunning = true;
						childStarted.resolve();
						await release.promise;
						child.stdin.end();
						await child.exited;
						childRunning = false;
					}
					return mock.stream(model, context, options);
				};
				let next: Promise<void> | undefined;
				let idleReturned = false;
				let idle: Promise<void> | undefined;
				const streaming: boolean[] = [];
				agent.subscribe(event => {
					if (event.type !== "agent_end" || next) return;
					next = request(agent);
					idle = agent.waitForIdle().then(() => {
						idleReturned = true;
					});
				});
				agent.subscribe(event => {
					if (event.type === "agent_end") streaming.push(agent.state.isStreaming);
				});

				const first = endFirst(agent);
				await childStarted.promise;
				await first;
				// Let a waiter that missed the run settle before reading it.
				for (let turn = 0; turn < 10; turn++) await Promise.resolve();
				const observed = { idleReturned, childRunning };
				release.resolve();
				await next;
				await idle;

				expect(observed).toEqual({ idleReturned: false, childRunning: true });
				expect(streaming.every(value => value === false)).toBe(true);
				expect(transcriptTexts(agent)).toEqual(end === "own" ? ["first", "second"] : ["second"]);
			});
		}
	}

	it("accepts a prompt() an abort callback requests while the run's end puts its live preparation back", async () => {
		const { agent, mock } = createAgent();
		const ready = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let pending: Promise<LiveSteerClaim | undefined> | undefined;
		let next: Promise<void> | undefined;
		agent.prepareQueuedMessages = async (_messages, signal) => {
			signal.addEventListener(
				"abort",
				() => {
					agent.prepareQueuedMessages = undefined;
					next = agent.prompt("second");
				},
				{ once: true },
			);
			ready.resolve();
			await release.promise;
			return undefined;
		};
		let first = true;
		agent.streamFn = async (model, context, options) => {
			if (first && options?.liveSteering && options.signal) {
				first = false;
				agent.steer(person("P"));
				pending = options.liveSteering.claim(options.signal);
				await ready.promise;
			}
			return mock.stream(model, context, options);
		};
		const ends: Array<{ streaming: boolean; held: string[] }> = [];
		agent.subscribe(event => {
			if (event.type === "agent_end") {
				ends.push({ streaming: agent.state.isStreaming, held: texts(agent.peekUndeliveredQueuedMessages()) });
			}
		});

		await agent.prompt("first");
		await next;
		release.resolve();
		await pending;

		for (const seen of ends) expect(seen).toEqual({ streaming: false, held: [] });
		expect(transcriptTexts(agent)).toEqual(["first", "second", "P"]);
	});

	/**
	 * Removal by content drops a message wherever the Agent holds it. A queue listener removes V the moment
	 * the run holds it (the session leaves a mode from such a notification), the response then aborts, and V
	 * must be nowhere: not handed to the provider, not recorded, not put back. P, queued beside it, stays.
	 */
	for (const withPreparer of [false, true]) {
		it(`removeQueuedMessages drops input the run holds, its context with it, and keeps the rest (preparer: ${withPreparer})`, async () => {
			const { agent, mock } = createAgent();
			const v = person("V");
			// The preparer commits context naming the batch it was prepared for.
			if (withPreparer) {
				agent.prepareQueuedMessages = messages => ({ commit: () => [card(`${texts(messages).join()} context`)] });
			}
			let removed: { steering: AgentMessage[]; followUp: AgentMessage[] } | undefined;
			agent.onQueueChange(() => {
				if (removed || !agent.peekUndeliveredQueuedMessages().includes(v)) return;
				removed = agent.removeQueuedMessages(message => message === v);
			});
			let first = true;
			let claimed: unknown = "not claimed";
			agent.streamFn = async (model, streamContext, options) => {
				if (first && options?.liveSteering && options.signal) {
					first = false;
					agent.steer(v);
					agent.steer(person("P"));
					claimed = await options.liveSteering.claim(options.signal);
					agent.abort();
				}
				return mock.stream(model, streamContext, options);
			};

			await agent.prompt("start");

			expect(removed).toEqual({ steering: [v], followUp: [] });
			expect(claimed).toBeUndefined();
			expect(transcriptTexts(agent)).not.toContain("V context");
			expect(transcriptTexts(agent)).toEqual(["start"]);
			expect(texts(agent.peekSteeringQueue())).toEqual(["P"]);
			await agent.continue();
			expect(transcriptTexts(agent)).toEqual(withPreparer ? ["start", "P", "P context"] : ["start", "P"]);
		});
	}

	it("removeQueuedMessages leaves live steering the provider was handed: it is delivered, and an abort puts it back as before", async () => {
		const { agent, mock } = createAgent();
		const v = person("V");
		let first = true;
		let claimed: string[] | undefined;
		let removed: unknown;
		agent.streamFn = async (model, context, options) => {
			if (first && options?.liveSteering && options.signal) {
				first = false;
				agent.steer(v);
				const claim = await options.liveSteering.claim(options.signal);
				claimed = claim?.messages.map(message => messageText(message));
				claim?.accept();
				agent.steer(person("W"));
				removed = agent.removeQueuedMessages(message => message === v);
				agent.abort();
			}
			return mock.stream(model, context, options);
		};

		await agent.prompt("start");

		expect(claimed).toEqual(["V"]);
		expect(removed).toEqual({ steering: [], followUp: [] });
		expect(transcriptTexts(agent)).toEqual(["start"]);
		expect(texts(agent.peekSteeringQueue())).toEqual(["V", "W"]);
	});

	it("removeQueuedMessages cancels a claim holding a removed message and puts the rest of its batch back", async () => {
		const { agent } = createAgent();
		agent.setSteeringMode("all");
		const v = card("V");
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		agent.prepareQueuedMessages = async (_messages, signal) => {
			started.resolve(signal);
			await release.promise;
			return undefined;
		};
		agent.steer(v);
		agent.steer(person("P"));
		const running = agent.continue().catch(error => error);
		const signal = await started.promise;

		expect(agent.removeQueuedMessages(message => message === v)).toEqual({ steering: [v], followUp: [] });
		expect(signal.aborted).toBe(true);
		expect(texts(agent.peekSteeringQueue())).toEqual(["P"]);
		release.resolve();
		await running;
		agent.prepareQueuedMessages = undefined;
		await agent.continue();
		expect(transcriptTexts(agent)).toEqual(["P"]);
	});
});

/**
 * Removal by content (invariant 5) against the point where input is delivered. Input is delivered once the
 * loop puts it into a provider request, or live steering hands it to the provider; from then the model
 * reads it, so the transcript records it and removal leaves it. Before then, removal takes it back once per
 * occurrence: the provider never gets it and the transcript never records it.
 */
describe("steering invariants: the round-ten reproductions", () => {
	/** Record every provider request's user texts, in order, then answer from `stream`. */
	function recordRequests(agent: Agent, stream: Agent["streamFn"], requests: string[][]): void {
		agent.streamFn = async (model, context, options) => {
			requests.push(
				context.messages.filter(message => message.role === "user").map(message => messageText(message)),
			);
			return stream(model, context, options);
		};
	}

	for (const method of ["prompt", "continue"] as const) {
		for (const end of ["own", "foreign"] as const) {
			it(`refuses a third run in every microtask before a ${method}() requested at ${end === "own" ? "the run's own" : "a foreign"} agent_end starts`, async () => {
				for (let depth = 0; depth <= 8; depth++) {
					const { agent, mock } = createAgent();
					const release = Promise.withResolvers<void>();
					agent.streamFn = async (model, context, options) => {
						if (texts(context.messages as AgentMessage[]).includes("second")) await release.promise;
						return mock.stream(model, context, options);
					};
					let next: Promise<void> | undefined;
					let third: Promise<unknown> | undefined;
					agent.subscribe(event => {
						if (event.type !== "agent_end" || next) return;
						if (method === "prompt") {
							next = agent.prompt("second");
						} else {
							agent.steer(person("second"));
							next = agent.continue();
						}
						let schedule = (): void => {
							third = agent.prompt("third").then(
								() => "accepted",
								error => (error instanceof AgentBusyError ? "busy" : String(error)),
							);
						};
						for (let turn = 0; turn < depth; turn++) {
							const inner = schedule;
							schedule = () => queueMicrotask(inner);
						}
						schedule();
					});

					if (end === "own") await agent.prompt("first");
					else agent.emitExternalAgentEnd({ type: "agent_end", messages: [] }, "foreign");
					for (let turn = 0; turn < depth + 4; turn++) await Promise.resolve();
					const outcome = await third;
					release.resolve();
					await next;

					expect({ depth, outcome }).toEqual({ depth, outcome: "busy" });
					expect(transcriptTexts(agent)).not.toContain("third");
				}
			});
		}
	}

	for (const withPreparer of [false, true]) {
		it(`a removal made when live steering takes the input keeps it from the provider (preparer: ${withPreparer})`, async () => {
			const { agent, mock } = createAgent();
			const v = person("V");
			if (withPreparer) {
				agent.prepareQueuedMessages = messages => ({ commit: () => [card(`${texts(messages).join()} context`)] });
			}
			let removed: unknown;
			agent.onQueueChange(() => {
				if (removed || !agent.peekLiveSteeredMessages().includes(v)) return;
				removed = agent.removeQueuedMessages(message => message === v);
			});
			let first = true;
			let claim: LiveSteerClaim | undefined | "not claimed" = "not claimed";
			agent.streamFn = async (model, context, options) => {
				if (first && options?.liveSteering && options.signal) {
					first = false;
					agent.steer(v);
					claim = await options.liveSteering.claim(options.signal);
				}
				return mock.stream(model, context, options);
			};

			await agent.prompt("start");

			expect(removed).toEqual({ steering: [v], followUp: [] });
			expect(claim).toBeUndefined();
			expect(transcriptTexts(agent)).toEqual(["start"]);
			expect(agent.peekSteeringQueue()).toEqual([]);
		});
	}

	it("a removal between dequeue and the request keeps the input from the provider, its context with it", async () => {
		const { agent, mock } = createAgent();
		const requests: string[][] = [];
		recordRequests(agent, mock.stream, requests);
		const v = person("V");
		agent.prepareQueuedMessages = messages => ({ commit: () => [person(`${texts(messages).join()} context`)] });
		agent.setOnBeforeYield(() => {
			agent.setOnBeforeYield(undefined);
			agent.steer(v);
		});
		let removed: unknown;
		agent.setAsideMessageProvider(boundary => {
			if (boundary === "stop" && removed === undefined)
				removed = agent.removeQueuedMessages(message => message === v);
			return [];
		});

		await agent.prompt("start");

		expect(removed).toEqual({ steering: [v], followUp: [] });
		expect(requests).toEqual([["start"]]);
		expect(transcriptTexts(agent)).toEqual(["start"]);
		expect(agent.peekSteeringQueue()).toEqual([]);
	});

	it("a removal of part of a batch keeps the batch's context with what is left", async () => {
		const { agent, mock } = createAgent();
		agent.setSteeringMode("all");
		const requests: string[][] = [];
		recordRequests(agent, mock.stream, requests);
		const [a, b] = [person("A"), person("B")];
		agent.prepareQueuedMessages = () => ({ commit: () => [person("batch context")] });
		agent.setOnBeforeYield(() => {
			agent.setOnBeforeYield(undefined);
			agent.steer(a);
			agent.steer(b);
		});
		agent.setAsideMessageProvider(boundary => {
			if (boundary === "stop") agent.removeQueuedMessages(message => message === b);
			return [];
		});

		await agent.prompt("start");

		expect(requests.at(-1)).toEqual(["start", "A", "batch context"]);
		expect(transcriptTexts(agent)).toEqual(["start", "A", "batch context"]);
	});

	it("a removed occurrence is dropped once: the same object queued again is delivered and recorded once", async () => {
		const { agent, mock } = createAgent();
		const requests: string[][] = [];
		recordRequests(agent, mock.stream, requests);
		const v = person("V");
		agent.setOnBeforeYield(() => {
			agent.setOnBeforeYield(undefined);
			agent.steer(v);
		});
		let requeued = false;
		agent.setAsideMessageProvider(boundary => {
			if (boundary !== "stop" || requeued) return [];
			requeued = true;
			agent.removeQueuedMessages(message => message === v);
			agent.steer(v);
			return [];
		});

		await agent.prompt("start");

		expect(transcriptTexts(agent)).toEqual(["start", "V"]);
		expect(requests.at(-1)).toEqual(["start", "V"]);
		expect(agent.peekSteeringQueue()).toEqual([]);
	});

	/*
	 * The three cases below remove input after it was delivered. The model has read it, so a transcript
	 * without it would not match what the model saw; removal leaves it and the transcript records it.
	 */
	it("a removal from a message_start listener leaves the delivered input in the request and the transcript", async () => {
		const { agent, mock } = createAgent();
		const requests: string[][] = [];
		recordRequests(agent, mock.stream, requests);
		const v = person("V");
		let removed: unknown;
		agent.subscribe(event => {
			if (event.type === "message_start" && event.message === v) removed = agent.removeQueuedMessages(m => m === v);
		});
		agent.steer(v);

		await agent.continue();

		expect(removed).toEqual({ steering: [], followUp: [] });
		expect(requests).toEqual([["V"]]);
		expect(transcriptTexts(agent)).toEqual(["V"]);
	});

	it("a removal after live steering handed two batches leaves both batches and their own context", async () => {
		const { agent, mock } = createAgent();
		const [a, b] = [person("A"), person("B")];
		agent.prepareQueuedMessages = messages => ({ commit: () => [person(`ctx:${texts(messages).join()}`)] });
		let first = true;
		let removed: unknown;
		agent.streamFn = async (model, context, options) => {
			if (first && options?.liveSteering && options.signal) {
				first = false;
				for (const message of [a, b]) {
					agent.steer(message);
					(await options.liveSteering.claim(options.signal))?.accept();
				}
				removed = agent.removeQueuedMessages(message => message === b);
			}
			return mock.stream(model, context, options);
		};

		await agent.prompt("start");

		expect(removed).toEqual({ steering: [], followUp: [] });
		expect(transcriptTexts(agent)).toEqual(["start", "A", "ctx:A", "B", "ctx:B"]);
	});

	it("a removal after live steering handed an occurrence leaves it, and the same object queued again is a second delivery", async () => {
		const { agent, mock } = createAgent();
		const v = person("V");
		let first = true;
		agent.streamFn = async (model, context, options) => {
			if (first && options?.liveSteering && options.signal) {
				first = false;
				agent.steer(v);
				(await options.liveSteering.claim(options.signal))?.accept();
				agent.removeQueuedMessages(message => message === v);
				agent.steer(v);
			}
			return mock.stream(model, context, options);
		};

		await agent.prompt("start");

		expect(transcriptTexts(agent)).toEqual(["start", "V", "V"]);
		expect(agent.peekSteeringQueue()).toEqual([]);
	});
});

/** Removal and delivery act on one occurrence; the same message object held twice is two occurrences. */
describe("steering invariants: the round-eleven reproductions", () => {
	for (const withPreparer of [false, true]) {
		it(`a declined live steer of a message makes only that occurrence removable, not an accepted one (preparer: ${withPreparer})`, async () => {
			const { agent, mock } = createAgent();
			const v = person("V");
			let batch = 0;
			if (withPreparer) agent.prepareQueuedMessages = () => ({ commit: () => [person(`ctx:${++batch}`)] });
			let first = true;
			let removed: unknown;
			agent.streamFn = async (model, context, options) => {
				if (first && options?.liveSteering && options.signal) {
					first = false;
					agent.steer(v);
					(await options.liveSteering.claim(options.signal))?.accept();
					agent.steer(v);
					(await options.liveSteering.claim(options.signal))?.reject();
					removed = agent.removeQueuedMessages(message => message === v);
				}
				return mock.stream(model, context, options);
			};

			await agent.prompt("start");

			expect(removed).toEqual({ steering: [v], followUp: [] });
			expect(transcriptTexts(agent)).toEqual(withPreparer ? ["start", "V", "ctx:1"] : ["start", "V"]);
			expect(agent.peekSteeringQueue()).toEqual([]);
		});
	}

	it("removing an undelivered copy of a message keeps the delivered occurrence's place in the agent-steering wait", async () => {
		const { agent, mock } = createAgent();
		const claimed: string[] = [];
		let first = true;
		agent.streamFn = async (model, context, options) => {
			if (first && options?.liveSteering && options.signal) {
				first = false;
				agent.steer(card("CARD"));
				for (let index = 1; index <= 8 && !claimed.includes("CARD"); index++) {
					const p = person(`P${index}`);
					agent.steer(p);
					const claim = await options.liveSteering.claim(options.signal);
					claimed.push(...(claim?.messages.map(message => messageText(message)) ?? []));
					claim?.accept();
					if (claimed.includes("CARD")) break;
					// An undelivered copy of the person's message, taken and then removed before it is handed over.
					agent.steer(p);
					let removing = true;
					const stop = agent.onQueueChange(() => {
						if (!removing || agent.peekLiveSteeredMessages().filter(message => message === p).length < 2) return;
						removing = false;
						agent.removeQueuedMessages(message => message === p);
					});
					// The copy is removed while this claim takes it; if the card is due instead, the claim takes the card.
					const copyClaim = await options.liveSteering.claim(options.signal);
					stop();
					claimed.push(...(copyClaim?.messages.map(message => messageText(message)) ?? []));
					copyClaim?.accept();
				}
			}
			return mock.stream(model, context, options);
		};

		await agent.prompt("start");

		expect(claimed.indexOf("CARD")).toBeGreaterThanOrEqual(0);
		expect(claimed.indexOf("CARD")).toBeLessThanOrEqual(MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING);
	});

	it("removing a declined batch takes back its own context occurrence, not an accepted batch's copy of the same object", async () => {
		const { agent, mock } = createAgent();
		const requests: string[][] = [];
		const [a, b, d, c, e] = ["A", "B", "D", "C", "E"].map(person);
		// Batches A and B are given the same context object C; batch D gets E.
		agent.prepareQueuedMessages = messages => ({ commit: () => [messages[0] === d ? e : c] });
		let first = true;
		agent.streamFn = async (model, context, options) => {
			requests.push(
				context.messages.filter(message => message.role === "user").map(message => messageText(message)),
			);
			if (first && options?.liveSteering && options.signal) {
				first = false;
				for (const message of [a, d]) {
					agent.steer(message);
					(await options.liveSteering.claim(options.signal))?.accept();
				}
				agent.steer(b);
				(await options.liveSteering.claim(options.signal))?.reject();
				agent.removeQueuedMessages(message => message === b);
			}
			return mock.stream(model, context, options);
		};

		await agent.prompt("start");

		expect(requests.at(-1)).toEqual(["start", "A", "C", "D", "E"]);
		expect(transcriptTexts(agent)).toEqual(["start", "A", "C", "D", "E"]);
	});

	it("a request passes over only live steering the provider accepted, so a dequeued copy it carries is delivered", async () => {
		const { agent, mock } = createAgent();
		const p = person("P");
		let first = true;
		agent.streamFn = async (model, context, options) => {
			if (first && options?.liveSteering && options.signal) {
				first = false;
				agent.steer(p);
				// Handed to the provider, never accepted nor declined.
				await options.liveSteering.claim(options.signal);
				agent.steer(p);
			}
			return mock.stream(model, context, options);
		};
		let removed: unknown;
		agent.addBeforeModelCallHook((_signal, context) => {
			if (removed === undefined && context.messages.includes(p)) {
				removed = agent.removeQueuedMessages(message => message === p);
			}
		});

		await agent.prompt("start");

		// The copy the stop boundary put into the request is delivered, so the removal leaves it.
		expect(removed).toEqual({ steering: [], followUp: [] });
		expect(transcriptTexts(agent)).toEqual(["start", "P"]);
	});

	it("the transcript records the accepted occurrence, so an unsettled copy of the same object keeps its promotion", async () => {
		const { agent, mock } = createAgent();
		const v = card("V");
		let first = true;
		agent.streamFn = async (model, context, options) => {
			if (first && options?.liveSteering && options.signal) {
				first = false;
				agent.steer(v);
				agent.prioritizeSteering([v]);
				// The promoted occurrence is handed to the provider and never settled.
				await options.liveSteering.claim(options.signal);
				agent.steer(v);
				(await options.liveSteering.claim(options.signal))?.accept();
			}
			return mock.stream(model, context, options);
		};

		await agent.prompt("start");
		agent.steer(person("W"));

		expect(transcriptTexts(agent)).toEqual(["start", "V"]);
		// The run's end put the unsettled, promoted occurrence back; it still goes ahead of a person's steer.
		expect(texts(agent.peekNextSteering())).toEqual(["V"]);
	});

	it("the transcript records the occurrence a request carried, not an unsettled live copy of the same object", async () => {
		const { agent, mock } = createAgent();
		const v = card("V");
		const requests: string[][] = [];
		let first = true;
		agent.streamFn = async (model, context, options) => {
			requests.push(context.messages.map(message => messageText(message as AgentMessage)));
			if (first && options?.liveSteering && options.signal) {
				first = false;
				agent.steer(v);
				agent.prioritizeSteering([v]);
				// The promoted occurrence is handed to the provider and never settled.
				await options.liveSteering.claim(options.signal);
				// The second occurrence is put into the next request at the stop boundary.
				agent.steer(v);
			}
			return mock.stream(model, context, options);
		};

		await agent.prompt("start");
		agent.steer(person("W"));

		expect(requests.at(-1)).toEqual(["start", "ack", "V"]);
		expect(transcriptTexts(agent)).toEqual(["start", "V"]);
		// The run's end put the unsettled, promoted occurrence back; it still goes ahead of a person's steer.
		expect(texts(agent.peekNextSteering())).toEqual(["V"]);
	});
});

/**
 * A request writes down which holder each occurrence it carries is, so recording one message object held
 * twice (as prepared context and as a promoted original, or by two overlapping live claims, or as a
 * follow-up and a steer) touches exactly the occurrence delivered. The other keeps its promotion and its
 * place in the agent-steering wait. Each case also runs with distinct objects as the control.
 */
describe("steering invariants: the round-fifteen and round-sixteen reproductions", () => {
	/** An Agent whose context transform can park the conversion of one live claim. */
	function createParkingAgent(park?: (messages: AgentMessage[]) => Promise<void> | undefined) {
		const mock = createMockModel({
			handler: (_context, options) => ({ content: ["ack"], delayMs: options?.signal?.aborted ? 1 : 0 }),
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			convertToLlm,
			steeringMode: "one-at-a-time",
			transformContext: async messages => {
				await park?.(messages);
				return messages;
			},
		});
		return { agent, mock };
	}

	for (const alias of [false, true]) {
		for (const held of ["unsettled", "converting"] as const) {
			for (const delivered of ["live-original", "live-context", "request-original", "request-context"] as const) {
				it(`a promoted ${held} live V keeps its promotion when ${delivered} delivers ${alias ? "the same object" : "another V"}`, async () => {
					const v = person("V");
					const copy = alias ? v : person("V");
					const a = person("A");
					const parked = Promise.withResolvers<void>();
					const release = Promise.withResolvers<void>();
					let parking = held === "converting";
					const { agent, mock } = createParkingAgent(messages => {
						if (!parking || messages.length !== 1 || messages[0] !== v) return undefined;
						parking = false;
						parked.resolve();
						return release.promise;
					});
					let first = true;
					let pending: Promise<unknown> | undefined;
					agent.streamFn = async (model, context, options) => {
						if (first && options?.liveSteering && options.signal) {
							first = false;
							agent.steer(v);
							agent.prioritizeSteering([v]);
							if (held === "unsettled") await options.liveSteering.claim(options.signal);
							else {
								pending = options.liveSteering.claim(options.signal);
								await parked.promise;
							}
							const withContext = delivered.endsWith("context");
							if (withContext) agent.prepareQueuedMessages = () => ({ commit: () => [copy] });
							agent.steer(withContext ? a : copy);
							if (delivered.startsWith("live")) (await options.liveSteering.claim(options.signal))?.accept();
						}
						return mock.stream(model, context, options);
					};

					try {
						await agent.prompt("start");
					} finally {
						release.resolve();
					}
					await pending;
					agent.prepareQueuedMessages = undefined;
					// W is a prioritized steer, so only a V that kept its promotion still goes first.
					const w = person("W");
					agent.steer(w);
					agent.setSteeringPriority(message => message === w);

					expect(transcriptTexts(agent)).toEqual(
						delivered.endsWith("context") ? ["start", "A", "V"] : ["start", "V"],
					);
					expect(texts(agent.peekSteeringQueue())).toEqual(["V", "W"]);
					expect(texts(agent.peekNextSteering())).toEqual(["V"]);
				});
			}
		}
	}

	for (const alias of [false, true]) {
		for (const held of ["unsettled", "converting"] as const) {
			it(`accepted context of ${alias ? "the same object" : "another V"} recorded before a promoted ${held} live V leaves its promotion`, async () => {
				const a = person("A");
				const v = person("V");
				const context = alias ? v : person("V");
				const parked = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let parking = held === "converting";
				const { agent, mock } = createParkingAgent(messages => {
					if (!parking || messages.length !== 1 || messages[0] !== v) return undefined;
					parking = false;
					parked.resolve();
					return release.promise;
				});
				let first = true;
				let pending: Promise<unknown> | undefined;
				agent.streamFn = async (model, streamContext, options) => {
					if (first && options?.liveSteering && options.signal) {
						first = false;
						agent.prepareQueuedMessages = () => ({ commit: () => [context] });
						agent.steer(a);
						(await options.liveSteering.claim(options.signal))?.accept();
						agent.prepareQueuedMessages = undefined;
						agent.steer(v);
						agent.prioritizeSteering([v]);
						if (held === "unsettled") await options.liveSteering.claim(options.signal);
						else {
							pending = options.liveSteering.claim(options.signal);
							await parked.promise;
						}
					}
					return mock.stream(model, streamContext, options);
				};

				try {
					await agent.prompt("start");
				} finally {
					release.resolve();
				}
				await pending;
				const w = person("W");
				agent.steer(w);
				agent.setSteeringPriority(message => message === w);

				expect(transcriptTexts(agent)).toEqual(["start", "A", "V"]);
				expect(texts(agent.peekSteeringQueue())).toEqual(["V", "W"]);
				expect(texts(agent.peekNextSteering())).toEqual(["V"]);
			});
		}
	}

	for (const alias of [false, true]) {
		it(`recording a follow-up of ${alias ? "a held steer's object" : "another V"} charges no steering place`, async () => {
			const { agent, mock } = createAgent();
			const v = person("V");
			const copy = alias ? v : person("V");
			const agentCard: AgentMessage = { ...person("CARD"), attribution: "agent" } as AgentMessage;
			let calls = 0;
			agent.streamFn = async (model, context, options) => {
				calls++;
				if (calls === 1 && options?.liveSteering && options.signal) {
					agent.steer(agentCard);
					agent.steer(v);
					agent.prioritizeSteering([v]);
					// Both are handed to the provider and never settled.
					for (let i = 0; i < 2; i++) await options.liveSteering.claim(options.signal);
					agent.followUp(copy);
				} else if (calls === 2) {
					agent.abort();
				}
				return mock.stream(model, context, options);
			};

			await agent.prompt("start");
			expect(texts(agent.peekSteeringQueue())).toEqual(["V", "CARD"]);
			expect(transcriptTexts(agent)).toEqual(["start", "V"]);
			expect(texts(agent.removeQueuedMessages(message => message === v).steering)).toEqual(["V"]);
			for (let i = 0; i < 5; i++) agent.steer(person(`P${i}`));
			await agent.continue();

			expect(transcriptTexts(agent).slice(2)).toEqual(["P0", "P1", "P2", "P3", "CARD", "P4"]);
		});
	}

	it("reset() discards a run requested at an agent_end before it starts", async () => {
		const { agent, mock } = createAgent();
		const requests: string[][] = [];
		agent.streamFn = async (model, context, options) => {
			requests.push(texts(context.messages as AgentMessage[]));
			return mock.stream(model, context, options);
		};
		let next: Promise<void> | undefined;
		agent.subscribe(event => {
			if (event.type !== "agent_end" || next) return;
			next = agent.prompt("stale");
			agent.reset();
		});

		await agent.prompt("first");
		await next;
		await agent.waitForIdle();

		expect(requests).toEqual([["first"]]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
	});

	// Round sixteen: live input that never reached the provider, host records, and record order.
	for (const conversion of ["image", "throws", "empty", "reject"] as const) {
		it(`the next request owns promoted live input that ${conversion === "reject" ? "the provider declined" : `failed to convert (${conversion})`}`, async () => {
			const v = person("V");
			if (conversion === "image") {
				v.content = [
					{ type: "text", text: "V" },
					{
						type: "image",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=",
						mimeType: "image/png",
					},
				];
			}
			const mock = createMockModel({ handler: () => ({ content: ["ack"] }) });
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
				convertToLlm,
				steeringMode: "one-at-a-time",
				// Only live steering converts V alone.
				transformContext: async messages => {
					if (messages.length !== 1 || messages[0] !== v) return messages;
					if (conversion === "throws") throw new Error("live conversion unavailable");
					return conversion === "empty" ? [] : messages;
				},
			});
			const requests: string[][] = [];
			let first = true;
			agent.streamFn = async (model, context, options) => {
				requests.push(
					context.messages
						.filter(message => message.role === "user")
						.map(message => messageText(message as AgentMessage)),
				);
				if (first && options?.liveSteering && options.signal) {
					first = false;
					agent.steer(v);
					agent.prioritizeSteering([v]);
					(await options.liveSteering.claim(options.signal))?.reject();
				}
				return mock.stream(model, context, options);
			};

			await agent.prompt("start");

			expect(requests).toEqual([["start"], ["start", "V"]]);
			expect(transcriptTexts(agent)).toEqual(["start", "V"]);
			expect(agent.peekSteeringQueue()).toEqual([]);
			expect(agent.peekUndeliveredQueuedMessages()).toEqual([]);
		});
	}

	for (const alias of [false, true]) {
		it(`a host record of ${alias ? "a request's object" : "another V"} leaves an unsettled promoted V its promotion`, async () => {
			const { agent, mock } = createAgent();
			const v = person("V");
			const host = alias ? v : person("host V");
			let first = true;
			let hostDone = false;
			agent.streamFn = async (model, context, options) => {
				if (first && options?.liveSteering && options.signal) {
					first = false;
					agent.steer(v);
					agent.prioritizeSteering([v]);
					// Handed to the provider and never settled; a second occurrence goes into the next request.
					await options.liveSteering.claim(options.signal);
					agent.steer(v);
				}
				return mock.stream(model, context, options);
			};
			agent.addBeforeModelCallHook((_signal, context) => {
				if (hostDone || !context.messages.includes(v)) return;
				hostDone = true;
				agent.appendMessage(host);
			});

			await agent.prompt("start");
			const w = person("W");
			agent.steer(w);
			agent.setSteeringPriority(message => message === w);

			expect(hostDone).toBe(true);
			expect(texts(agent.peekSteeringQueue())).toEqual(["V", "W"]);
			expect(texts(agent.peekNextSteering())).toEqual(["V"]);
		});
	}

	for (const reverse of [false, true]) {
		it(`a grouped request's records ${reverse ? "in reverse order" : "in order"} leave nothing held`, async () => {
			const a = person("A");
			const b = person("B");
			const requests: string[][] = [];
			// A host that records the run's own input events once both arrive, in either order.
			class RecordingAgent extends Agent {
				#buffered: AgentMessage[] = [];
				override appendMessage(message: AgentMessage): void {
					if (this.#buffered.length < 2 && (message === a || message === b)) {
						this.#buffered.push(message);
						if (this.#buffered.length === 2) {
							for (const item of reverse ? [...this.#buffered].reverse() : this.#buffered)
								super.appendMessage(item);
						}
						return;
					}
					super.appendMessage(message);
				}
			}
			const mock = createMockModel({ handler: () => ({ content: ["ack"] }) });
			const agent = new RecordingAgent({
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				steeringMode: "one-at-a-time",
				streamFn: async (model, context, options) => {
					requests.push(
						context.messages
							.filter(message => message.role === "user")
							.map(message => messageText(message as AgentMessage)),
					);
					return mock.stream(model, context, options);
				},
			});
			agent.setQueuedMessageGrouping((previous, next) => previous === a && next === b);
			agent.steer(a);
			agent.steer(b);

			await agent.prompt("start");

			expect(transcriptTexts(agent)).toEqual(reverse ? ["start", "B", "A"] : ["start", "A", "B"]);
			expect(agent.peekUndeliveredQueuedMessages()).toEqual([]);
			expect(agent.peekSteeringQueue()).toEqual([]);
			expect(requests).toHaveLength(1);
		});
	}
});
