import { expect, it } from "bun:test";
import { Agent, type AgentMessage, MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING } from "@oh-my-pi/pi-agent-core";
import type { LiveSteerClaim, LiveSteering, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

/**
 * The oracle owns occurrences, not messages. Object numbers deliberately repeat; occurrence ids never do.
 * Only public queue views, transcript events and provider requests are observed. Gate callbacks identify
 * candidate positions, not holders inside Agent. The model independently selects units and accounts for
 * each take's promotion, allowance place, preparation context and gate lease.
 *
 * A live hand-over can remain unrecorded when its response aborts or never accepts it. Such an occurrence
 * returns to the queue at the settled end. A rejected hand-over is removable again before the boundary.
 * Prepared context, prompt input and host records are separate occurrences even when they alias a steer.
 */
type Queue = "steering" | "followUp";
type Op = {
	type:
		| "before"
		| "enqueue"
		| "promote"
		| "group"
		| "prepare"
		| "watch"
		| "conversion"
		| "claim"
		| "remove"
		| "clear"
		| "withdraw"
		| "append"
		| "abort"
		| "run"
		| "gate"
		| "tick";
	object?: number;
	queue?: Queue;
	mode?: string;
	count?: number;
	body?: Op[];
};
type Occurrence = {
	id: number;
	object: number;
	kind: Queue | "context" | "prompt" | "host";
	state: "queued" | "held" | "recorded" | "removed";
	promoted: boolean;
	delivered: boolean;
	batch?: Batch;
};
type Place = { agent: boolean };
type Batch = {
	originals: Occurrence[];
	additional: Occurrence[];
	live: boolean;
	preparing: boolean;
	ready: boolean;
	claimNotifications: number;
	place?: Place;
};
type Violation = { rule: string; detail: string };
type Result = { violations: Violation[]; coverage: Set<string>; notifications: number; requests: number };

function text(message: AgentMessage | Message): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string"
		? message.content
		: message.content.map(p => ("text" in p ? p.text : "")).join("");
}
function randomFor(seed: number): () => number {
	let state = Math.imul(seed, 0x9e3779b1) >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}
function convert(messages: AgentMessage[]): Message[] {
	return messages.flatMap((message): Message[] => {
		if (message.role === "custom") return [{ role: "user", content: text(message), timestamp: 1 }];
		return message.role === "user" || message.role === "assistant" || message.role === "toolResult" ? [message] : [];
	});
}

async function execute(operations: readonly Op[]): Promise<Result> {
	const objects: AgentMessage[] = Array.from({ length: 12 }, (_, object) =>
		object === 3
			? { role: "custom", customType: "card", content: `O${object}`, display: true, timestamp: 1 }
			: { role: "user", content: `O${object}`, attribution: object % 2 ? "agent" : "user", timestamp: 1 },
	);
	const numberOf = (message: AgentMessage | Message): number =>
		objects.findIndex(object => text(object) === text(message));
	const occurrences: Occurrence[] = [];
	const queues: Record<Queue, Occurrence[]> = { steering: [], followUp: [] };
	const batches: Batch[] = [];
	const violations: Violation[] = [];
	const coverage = new Set<string>();
	const leases = new Set<Occurrence>();
	const recordedOrder: Occurrence[] = [];
	const listenerClaims: Promise<void>[] = [];
	let places: Place[] = [];
	let grouping = "none";
	let preparer = "none";
	let contextObject = 0;
	let vetoes: number[] = [];
	let watch: Op | undefined;
	let conversion: Op | undefined;
	let liveDepth = 0;
	let executing = false;
	let draining = false;
	let notifications = 0;
	let requests = 0;
	let expectedEvents: Occurrence[] = [];
	let boundary: Occurrence[] = [];
	let accepted: Occurrence[] = [];
	let deferred: Occurrence[] = [];
	let runInputs: Occurrence[] = [];
	let runBody: Op[] = [];
	let ranBody = false;
	const mock = createMockModel({
		handler: (_context, options) => ({ content: ["ack"], delayMs: options?.signal?.aborted ? 1 : 0 }),
	});
	const violation = (rule: string, detail: string): void => {
		if (!violations.some(v => v.rule === rule && v.detail === detail)) violations.push({ rule, detail });
	};
	const same = (rule: string, actual: unknown, expected: unknown, where: string): void => {
		try {
			expect(actual, where).toEqual(expected);
		} catch {
			violation(rule, `${where}: actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
		}
	};
	const make = (object: number, kind: Occurrence["kind"], state: Occurrence["state"]): Occurrence => {
		const occurrence: Occurrence = {
			id: occurrences.length + 1,
			object,
			kind,
			state,
			promoted: false,
			delivered: false,
		};
		occurrences.push(occurrence);
		return occurrence;
	};
	const nums = (items: readonly Occurrence[]): number[] => items.map(item => item.object);
	const observed = (items: readonly AgentMessage[]): number[] => items.map(numberOf).filter(n => n >= 0);
	const joins = (a: number, b: number): boolean =>
		grouping === "all" ||
		(grouping === "pairs" && a === b) ||
		(grouping === "bridge" && ((a === 1 && (b === 3 || b === 0)) || (a === 3 && b === 0)));
	const units = (queue: Queue): Occurrence[][] => {
		const result: Occurrence[][] = [];
		for (const occurrence of queues[queue]) {
			const last = result.at(-1);
			if (last && joins(last.at(-1)!.object, occurrence.object)) last.push(occurrence);
			else result.push([occurrence]);
		}
		return result;
	};
	const userUnit = (unit: readonly Occurrence[]): boolean => unit.some(o => o.object % 2 === 0);
	const agentPending = (): boolean =>
		units("steering").some(unit => !userUnit(unit)) ||
		batches.some(batch => batch.place?.agent && batch.originals.some(o => o.state === "held"));
	const settleWait = (): void => {
		if (!agentPending()) places = [];
	};
	const next = (queue: Queue): Occurrence[] => {
		const choices = units(queue);
		if (queue === "followUp") return choices[0] ?? [];
		const promoted = choices.find(unit => unit.some(o => o.promoted));
		let spent = 0;
		for (let i = places.length - 1; i >= 0 && !places[i].agent; i--) spent++;
		return (
			promoted ??
			(spent >= MAX_USER_UNITS_AHEAD_OF_AGENT_STEERING ? choices.find(unit => !userUnit(unit)) : undefined) ??
			choices.find(userUnit) ??
			choices[0] ??
			[]
		);
	};
	const giveBack = (batch: Batch): void => {
		if (batch.place) places = places.filter(place => place !== batch.place);
	};
	const retire = (o: Occurrence): void => {
		o.state = "removed";
		if (o.kind === "steering" || o.kind === "followUp") queues[o.kind] = queues[o.kind].filter(item => item !== o);
		if (o.batch && !o.batch.originals.some(item => item.state === "held" || item.state === "recorded")) {
			giveBack(o.batch);
			for (const extra of o.batch.additional) if (extra.state !== "recorded") extra.state = "removed";
		}
	};
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: mock.stream,
		convertToLlm: convert,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transformContext: async messages => {
			if (liveDepth > 0) {
				coverage.add("live conversion");
				const action = conversion;
				conversion = undefined;
				if (action) {
					coverage.add(`conversion ${action.mode}`);
					await applyAll(action.body ?? []);
					if (action.mode === "throw") throw new Error("model conversion failure");
					if (action.mode === "empty") return [];
				}
				return messages;
			}
			const inputs = [...accepted, ...deferred, ...boundary].filter(o => o.state !== "removed");
			accepted = [];
			deferred = [];
			boundary = [];
			for (const o of inputs) o.delivered = true;
			expectedEvents.push(...inputs);
			runInputs.push(...inputs);
			same("provider-input", observed(messages), nums(runInputs), "provider context");
			return messages;
		},
	});

	const check = (where: string): void => {
		// Agent updates state before it notifies a message_end subscriber. Account for that exact
		// prefix of scheduled records, without letting a context occurrence stand in for a steer.
		const actualRecorded = observed(agent.state.messages);
		const pending =
			expectedEvents.length > 0 ? expectedEvents : boundary.filter(o => o.kind === "prompt" && o.state === "held");
		const projected = [
			...recordedOrder,
			...pending.slice(0, Math.max(0, actualRecorded.length - recordedOrder.length)),
		];
		same("transcript-occurrences", actualRecorded, nums(projected), where);
		const expected = Array.from({ length: objects.length }, () => 0);
		for (const o of occurrences) {
			if (o.state !== "removed" && (o.kind === "steering" || o.kind === "followUp" || projected.includes(o)))
				expected[o.object]++;
		}
		const actual = Array.from({ length: objects.length }, () => 0);
		for (const message of [
			...agent.peekSteeringQueue(),
			...agent.peekFollowUpQueue(),
			...agent.peekUndeliveredQueuedMessages(),
			...agent.state.messages,
		]) {
			const object = numberOf(message);
			if (object >= 0) actual[object]++;
		}
		same("one-place", actual, expected, where);
		if (where === "run returned" || where === "sequence end")
			same("next-unit", observed(agent.peekNextSteering()), nums(next("steering")), where);
		for (const o of leases)
			if (o.state === "queued")
				violation("gate-displaced-release", `displaced lease id ${o.id} O${o.object} remains claimed at ${where}`);
	};

	agent.queuedMessageGate = {
		claim: (queue, messages) => {
			coverage.add("gate claim");
			const selected = next(queue);
			same("unit-order", observed(messages), nums(selected), `gate ${queue} (ids ${selected.map(o => o.id)})`);
			const veto = vetoes.length > 0 ? [vetoes.shift()!] : [];
			const removed = selected.filter(o => veto.includes(o.object)).slice(0, 1);
			for (const o of selected) if (!removed.includes(o)) leases.add(o);
			for (const o of removed) {
				retire(o);
				coverage.add("gate veto");
			}
			if (removed.length > 0) return removed.map(o => objects[o.object]);
			const batch: Batch = {
				originals: selected,
				additional: [],
				live: liveDepth > 0,
				preparing: preparer !== "none",
				ready: preparer === "none",
				claimNotifications: 0,
			};
			batches.push(batch);
			if (queue === "steering") {
				const isAgent = !userUnit(selected);
				if (isAgent || units("steering").some(unit => !userUnit(unit))) {
					batch.place = { agent: isAgent };
					places.push(batch.place);
				}
			}
			for (const o of selected) {
				o.state = "held";
				o.batch = batch;
			}
			queues[queue] = queues[queue].filter(o => !selected.includes(o));
			if (!batch.live) boundary.push(...selected);
			settleWait();
			return [];
		},
		release: messages => {
			coverage.add("gate release");
			for (const object of observed(messages)) {
				const candidates = [...leases].filter(o => o.object === object);
				const occurrence = candidates.find(o => o.state === "removed" || o.state === "queued") ?? candidates[0];
				if (!occurrence) violation("gate-release", `release without an occurrence lease: O${object}`);
				else leases.delete(occurrence);
			}
		},
	};

	const configurePreparer = (): void => {
		agent.prepareQueuedMessages =
			preparer === "none"
				? undefined
				: (messages, signal, queue) => {
						coverage.add(`prepare ${preparer}`);
						const batch = [...batches]
							.reverse()
							.find(batch => batch.preparing && batch.originals[0]?.kind === queue);
						if (batch) batch.preparing = false;
						if (signal.aborted) return undefined;
						const mode = preparer;
						if (mode === "throw" || mode === "abort" || mode === "cancel") {
							preparer = "none";
							configurePreparer();
							if (mode === "throw") throw new Error("model preparation failure");
							if (mode === "abort") {
								agent.abort();
								throw new Error("model preparation abort");
							}
							return { commit: () => undefined };
						}
						return {
							commit: () => {
								if (!batch) return [];
								batch.ready = true;
								if (mode === "plain") return [];
								if (mode === "context-once") {
									preparer = "none";
									configurePreparer();
								}
								const o = make(contextObject, "context", "held");
								o.batch = batch;
								batch.additional.push(o);
								if (!batch.live) boundary.push(o);
								return [objects[contextObject]];
							},
						};
					};
	};

	agent.onQueueChange(() => {
		notifications++;
		for (const batch of batches) {
			if (!executing && batch.preparing && batch.originals.every(o => o.state === "held")) {
				batch.claimNotifications++;
				if (batch.claimNotifications > 1)
					violation(
						"duplicate-claim-notification",
						`claim ids ${batch.originals.map(o => o.id)} announced ${batch.claimNotifications} times before preparation`,
					);
			}
		}
		check("notification");
		const trigger = watch;
		if (trigger && !executing) {
			const matches = (message: AgentMessage): boolean =>
				trigger.object === undefined || numberOf(message) === trigger.object;
			const held = agent.peekUndeliveredQueuedMessages().some(matches);
			const adopted = agent.peekLiveSteeredMessages().some(matches);
			const claimed = batches.some(batch => batch.preparing && batch.originals.some(o => o.state === "held"));
			if (
				(trigger.mode === "held" && held) ||
				(trigger.mode === "claim" && claimed) ||
				(trigger.mode === "adopt" && adopted)
			) {
				watch = undefined;
				coverage.add(`listener ${trigger.mode}`);
				for (const op of trigger.body ?? []) {
					if (op.type === "claim" && currentLive && currentSignal)
						listenerClaims.push(claims(op, currentLive, currentSignal));
					else applySync(op);
				}
				check("listener action");
			}
		}
	});
	agent.subscribe(event => {
		if (event.type === "message_end" && numberOf(event.message) >= 0) {
			// A preparation error can emit the prompt before any provider context is built.
			const expected = expectedEvents.shift() ?? boundary.find(o => o.kind === "prompt" && o.state === "held");
			if (!expected)
				violation("unexpected-record", `record O${numberOf(event.message)} without a provider input occurrence`);
			else {
				same("record-order", numberOf(event.message), expected.object, `record id ${expected.id}`);
				if (expected.state === "removed") violation("removed-recorded", `removed id ${expected.id} recorded`);
				expected.state = "recorded";
				recordedOrder.push(expected);
				leases.delete(expected);
				const batch = expected.batch;
				if (batch?.place && batch.originals.every(o => o.state === "recorded" || o.state === "removed")) {
					if (batch.place.agent) places = places.slice(places.indexOf(batch.place) + 1);
				}
			}
			settleWait();
		}
		if (event.type === "message_end") {
			check("message_end");
			if (watch?.mode === "record" && (watch.object === undefined || numberOf(event.message) === watch.object)) {
				const trigger = watch;
				watch = undefined;
				for (const child of trigger.body ?? []) applySync(child);
				check("record listener action");
			}
		}
		if (event.type === "agent_end") {
			for (const queue of ["steering", "followUp"] as const) {
				const restored = batches.flatMap(batch =>
					batch.originals.filter(o => o.batch === batch && o.kind === queue && o.state === "held"),
				);
				for (const o of restored) {
					o.state = "queued";
					o.delivered = false;
					if (o.batch) giveBack(o.batch);
				}
				queues[queue] = [...restored, ...queues[queue]];
				same(
					"settled-queue",
					observed(queue === "steering" ? agent.peekSteeringQueue() : agent.peekFollowUpQueue()),
					nums(queues[queue]),
					`agent_end ${queue}`,
				);
			}
			for (const o of occurrences) if (o.kind === "context" && o.state === "held") o.state = "removed";
			for (const o of [...leases])
				if (o.state !== "recorded")
					violation("gate-release", `lease id ${o.id} not released at agent_end (${o.state})`);
			same("settled-end", agent.state.isStreaming, false, "agent_end streaming");
			same("settled-end", observed(agent.peekUndeliveredQueuedMessages()), [], "agent_end held");
			check("agent_end");
			settleWait();
		}
	});

	function applySync(op: Op): void {
		coverage.add(op.type);
		executing = true;
		const object = op.object ?? 0;
		try {
			switch (op.type) {
				case "enqueue": {
					const queue = op.queue ?? "steering";
					coverage.add(object % 2 === 0 ? "user attribution" : "agent attribution");
					if ((op.count ?? 1) === 3) coverage.add("three aliased occurrences");
					for (let i = 0; i < (op.count ?? 1); i++) {
						if (occurrences.some(o => o.object === object)) coverage.add("reused object");
						const o = make(object, queue, "queued");
						queues[queue].push(o);
						settleWait();
						if (queue === "steering") agent.steer(objects[object]);
						else agent.followUp(objects[object]);
					}
					break;
				}
				case "promote": {
					const promoted = queues.steering.filter(o => o.object === object);
					for (const o of promoted) o.promoted = true;
					queues.steering = [...promoted, ...queues.steering.filter(o => o.object !== object)];
					agent.prioritizeSteering([objects[object]]);
					break;
				}
				case "group":
					grouping = op.mode ?? "none";
					agent.setQueuedMessageGrouping((a, b) => joins(numberOf(a), numberOf(b)));
					break;
				case "prepare":
					preparer = op.mode ?? "none";
					contextObject = object;
					configurePreparer();
					break;
				case "before":
					agent.setBeforeModelCall(() => {
						agent.setBeforeModelCall(undefined);
						for (const child of op.body ?? []) applySync(child);
						return { stop: true };
					});
					break;
				case "watch":
					watch = op;
					break;
				case "conversion":
					conversion = op;
					break;
				case "gate":
					vetoes = op.body?.map(child => child.object ?? 0) ?? [object];
					break;
				case "append":
					recordedOrder.push(make(object, "host", "recorded"));
					agent.appendMessage(objects[object]);
					break;
				case "abort":
					agent.abort();
					break;
				case "remove":
				case "clear":
				case "withdraw": {
					// A removal and a clear leave delivered input: the model read it, so the transcript records it or
					// the run's end puts it back. The Esc withdrawal is the abandon path: it takes back everything the
					// run holds and has not recorded, delivered or not, and the abort that follows discards the
					// response that read it.
					const abandon = op.type === "withdraw";
					const removable = occurrences.filter(
						o =>
							(o.kind === "steering" || o.kind === "followUp") &&
							(op.type === "withdraw"
								? o.state === "held" && o.batch?.ready === true
								: (o.state === "queued" || o.state === "held") &&
									!o.delivered &&
									(op.type === "clear" || o.object === object)),
					);
					for (const o of removable) retire(o);
					if (abandon) {
						const gone = new Set(removable);
						expectedEvents = expectedEvents.filter(o => !gone.has(o));
						for (const o of removable)
							for (const extra of o.batch?.additional ?? [])
								if (extra.state !== "recorded") extra.state = "removed";
					}
					settleWait();
					const result =
						op.type === "remove"
							? agent.removeQueuedMessages(message => message === objects[object])
							: op.type === "withdraw"
								? agent.withdrawUndeliveredQueuedMessages()
								: undefined;
					if (op.type === "clear") agent.clearAllQueues();
					if (abandon) agent.abort();
					if (result)
						for (const queue of ["steering", "followUp"] as const) {
							same(
								"removal-result",
								observed(result[queue]),
								nums(removable.filter(o => o.kind === queue)),
								`${op.type} ${queue}`,
							);
						}
					break;
				}
			}
		} finally {
			executing = false;
		}
	}

	async function claims(op: Op, live: LiveSteering, signal: AbortSignal): Promise<void> {
		coverage.add(op.count === 2 ? "overlapping claims" : `live ${op.mode}`);
		const start = batches.length;
		liveDepth++;
		let results: Array<LiveSteerClaim | undefined>;
		try {
			results =
				op.mode === "reverse"
					? [await live.claim(signal), await live.claim(signal)]
					: op.count === 2
						? await Promise.all([live.claim(signal), live.claim(signal)])
						: [await live.claim(signal)];
		} finally {
			liveDepth--;
		}
		const taken = batches.slice(start).filter(batch => batch.live);
		for (const i of op.mode === "reverse" ? [1, 0] : results.map((_, index) => index)) {
			const result = results[i];
			const batch = taken[i];
			if (!batch) {
				if (
					results.length === 1 &&
					next("steering").length > 0 &&
					!deferred.some(o => o.state !== "removed") &&
					!signal.aborted
				)
					violation("live-refused", "a removed deferred occurrence blocked a later live claim");
				continue;
			}
			const items = [...batch.originals, ...batch.additional].filter(o => o.state !== "removed");
			if (!result) {
				deferred.push(...items);
				continue;
			}
			same("live-handover", result.messages.map(numberOf), nums(items), `claim ${i}`);
			for (const o of items) o.delivered = true;
			const accept =
				op.mode === "reverse" ||
				op.mode === "accept" ||
				(op.mode === "first" && i === 0) ||
				(op.mode === "second" && i === 1);
			if (accept) {
				result.accept();
				accepted.push(...items);
			} else if (op.mode === "reject") {
				result.reject();
				deferred.push(...items);
				for (const o of items) o.delivered = false;
			}
		}
	}
	let currentLive: LiveSteering | undefined;
	let currentSignal: AbortSignal | undefined;
	async function applyAll(ops: readonly Op[]): Promise<void> {
		for (const op of ops) {
			if (op.type === "tick") {
				for (let i = 0; i < (op.count ?? 6); i++) await Promise.resolve();
			} else if (op.type === "claim") {
				if (currentLive && currentSignal) await claims(op, currentLive, currentSignal);
				else violation("missing-live-channel", "mock provider did not receive live steering");
			} else if (op.type === "run") {
				coverage.add(op.mode === "continue" ? "continue" : "prompt");
				runBody = op.body ?? [];
				ranBody = false;
				boundary = [];
				accepted = [];
				deferred = [];
				expectedEvents = [];
				runInputs = [...recordedOrder];
				if (op.mode !== "continue") {
					if (
						occurrences.some(
							o => o.object === (op.object ?? 10) && (o.kind === "steering" || o.kind === "followUp"),
						)
					)
						coverage.add("prompt aliases queue");
					if (op.mode === "prompt-first") boundary.push(make(op.object ?? 10, "prompt", "held"));
					if (op.mode === "prompt-first") boundary.push(make(8, "prompt", "held"));
					if (op.mode === "prompt-pair")
						for (let i = 1; i < (op.count ?? 2); i++) boundary.push(make(8, "prompt", "held"));
					if (op.mode !== "prompt-first") boundary.push(make(op.object ?? 10, "prompt", "held"));
				}
				try {
					if (op.mode === "continue") await agent.continue();
					else
						await agent.prompt(
							op.mode === "prompt-first"
								? [objects[op.object ?? 10], objects[8]]
								: op.mode === "prompt-pair"
									? [
											...Array.from({ length: (op.count ?? 2) - 1 }, () => objects[8]),
											objects[op.object ?? 10],
										]
									: objects[op.object ?? 10],
						);
				} catch (error) {
					if (
						!String(error).includes("preparation") &&
						!String(error).includes("No messages") &&
						!String(error).includes("Cannot continue")
					)
						violation("unexpected-error", String(error));
				}
				// continue() can fail during preparation, before it opens a loop and emits agent_end.
				for (const queue of ["steering", "followUp"] as const) {
					const restored = batches.flatMap(batch =>
						batch.originals.filter(o => o.batch === batch && o.kind === queue && o.state === "held"),
					);
					for (const o of restored) {
						o.state = "queued";
						o.delivered = false;
						if (o.batch) giveBack(o.batch);
					}
					queues[queue] = [...restored, ...queues[queue]];
				}
				for (const o of occurrences) if (o.kind === "context" && o.state === "held") o.state = "removed";
				check("run returned");
				if (listenerClaims.length > 0) await Promise.all(listenerClaims.splice(0));
			} else applySync(op);
		}
	}
	agent.streamFn = async (model, context, options) => {
		requests++;
		same(
			"provider-request",
			context.messages.filter(message => message.role === "user").map(numberOf),
			nums(runInputs),
			`request ${requests}`,
		);
		if (!ranBody && !draining) {
			ranBody = true;
			currentLive = options?.liveSteering;
			currentSignal = options?.signal;
			await applyAll(runBody);
			currentLive = undefined;
			currentSignal = undefined;
		}
		return mock.stream(model, context, options);
	};

	await applyAll(operations);
	// Finish with the real continuation path, not by changing an assertion or deleting pending input.
	draining = true;
	watch = undefined;
	conversion = undefined;
	vetoes = [];
	preparer = "none";
	configurePreparer();
	for (let i = 0; i < 3 && agent.hasQueuedMessages(); i++) await applyAll([{ type: "run", mode: "continue" }]);
	check("sequence end");
	for (const o of occurrences) {
		if (o.kind !== "steering" && o.kind !== "followUp") continue;
		if (o.state !== "recorded" && o.state !== "removed")
			violation("not-drained", `id ${o.id} O${o.object} remains ${o.state}`);
	}
	for (const o of leases) violation("gate-release", `unclosed lease id ${o.id} (${o.state})`);
	return { violations, coverage, notifications, requests };
}

const enqueue = (object: number, count = 1, queue: Queue = "steering"): Op => ({
	type: "enqueue",
	object,
	count,
	queue,
});
const run = (body: Op[] = [], mode = "prompt", object = 10): Op => ({ type: "run", mode, object, body });
const claim = (mode = "accept", count = 1): Op => ({ type: "claim", mode, count });

/** Small bias recipes create aliasing opportunities; all their values and additional operations are seeded. */
function generate(seed: number): Op[] {
	const random = randomFor(seed);
	const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
	const object = pick([0, 2, 4]);
	const agentObject = pick([1, 3, 5]);
	const prepare: Op = { type: "prepare", mode: pick(["none", "plain", "context"]), object };
	const action: Op = { type: pick(["remove", "clear", "withdraw"]), object };
	const ops: Op[] = [];
	switch (seed % 20) {
		case 0:
			ops.push(
				prepare,
				enqueue(object, pick([2, 3])),
				{ type: "promote", object },
				enqueue(agentObject),
				run([], pick(["prompt", "continue"]), object),
			);
			break;
		case 1:
			ops.push({ type: "prepare", mode: "plain" }, enqueue(object), run([], pick(["prompt", "continue"])));
			break;
		case 2:
			ops.push(
				run([
					enqueue(object),
					{ type: "promote", object },
					enqueue(object),
					claim(pick(["first", "second", "hold"]), 2),
					{ type: "append", object },
				]),
			);
			break;
		case 3:
			ops.push(
				run([
					enqueue(object),
					claim("hold"),
					{ type: "prepare", mode: "context", object },
					enqueue(agentObject),
					claim("accept"),
					enqueue(object),
					claim("reject"),
					{ type: "remove", object },
				]),
			);
			break;
		case 4:
			ops.push(run([enqueue(object), claim(pick(["accept", "hold"])), action, { type: "append", object }]));
			break;
		case 5:
			ops.push(
				run([
					enqueue(object),
					{ type: "conversion", mode: pick(["throw", "empty"]), body: [action] },
					claim("accept"),
					enqueue(6),
					claim("accept"),
				]),
			);
			break;
		case 6:
			ops.push(
				{ type: "prepare", mode: pick(["plain", "context", "throw", "cancel", "abort"]), object },
				enqueue(object, 2),
				{ type: "watch", mode: pick(["claim", "held"]), body: [action] },
				run([], pick(["prompt", "continue"])),
			);
			break;
		case 7:
			ops.push(
				{ type: "group", mode: "bridge" },
				enqueue(1),
				enqueue(3),
				enqueue(0),
				enqueue(1),
				enqueue(0),
				{
					type: "gate",
					body: [
						{ type: "remove", object: 3 },
						{ type: "remove", object: 0 },
					],
				},
				run(),
			);
			break;
		case 8:
			ops.push(
				run(
					[
						enqueue(object),
						{ type: "prepare", mode: "context", object },
						enqueue(object),
						claim(pick(["first", "second"]), 2),
						{ type: "abort" },
					],
					"prompt",
					object,
				),
			);
			break;
		case 9: {
			const body: Op[] = [enqueue(agentObject)];
			for (let i = 0; i < 7; i++)
				body.push(
					enqueue(object),
					claim(pick(["accept", "hold", "reject"])),
					...(random() < 0.5 ? [{ type: "remove", object } as Op] : []),
				);
			ops.push(run(body));
			break;
		}
		case 10:
			ops.push(
				{ type: "group", mode: pick(["none", "pairs", "all"]) },
				prepare,
				enqueue(object, 3, "followUp"),
				enqueue(object, 2),
				{ type: "gate", object },
				run([], pick(["prompt", "continue"]), object),
			);
			break;
		case 11:
			ops.push(
				run([enqueue(object), claim("hold"), { type: "append", object }, { type: "abort" }]),
				{ type: "promote", object },
				enqueue(6),
				run(),
			);
			break;
		case 12:
			ops.push(
				run([
					{ type: "prepare", mode: "context-once", object },
					enqueue(8),
					{ type: "promote", object: 8 },
					enqueue(object),
					{ type: "watch", mode: "held", object: 8, body: [claim("hold")] },
					claim("accept"),
				]),
			);
			break;
		case 13:
			ops.push({
				...run(
					[enqueue(object), { type: "promote", object }, claim("accept"), { type: "tick" }, { type: "abort" }],
					"prompt-pair",
					object,
				),
				count: pick([2, 3, 4, 5]),
			});
			break;
		case 14:
			ops.push(
				run([
					enqueue(object),
					{ type: "watch", mode: "adopt", body: [{ type: pick(["clear", "withdraw"]), object }] },
					claim("accept"),
				]),
			);
			break;
		case 15:
			ops.push(
				enqueue(1),
				enqueue(0, 4),
				{
					type: "watch",
					mode: "held",
					object: 1,
					body: [{ type: "clear" }, enqueue(3), enqueue(6), { type: "abort" }],
				},
				run(),
			);
			break;
		case 16:
			// An abandon or a removal after the request was built and before its records.
			ops.push(
				enqueue(object, pick([1, 2])),
				{ type: "before", body: [{ type: pick(["clear", "withdraw", "remove"]), object }] },
				run([], pick(["prompt", "prompt-first"]), object),
			);
			break;
		case 17:
			// Prompt input that is also a queued occurrence, first in the request.
			ops.push(prepare, enqueue(object, pick([1, 2])), run([], "prompt-first", object));
			break;
		case 18:
			// Prepared context that is a later batch's message, with a withdrawal or removal at one of its records.
			ops.push(
				run([
					{ type: "prepare", mode: "context", object },
					enqueue(agentObject),
					claim("accept"),
					{ type: "prepare", mode: "none" },
					enqueue(object),
					claim(pick(["accept", "reject"])),
					{
						type: "watch",
						mode: "record",
						object,
						body: [{ type: pick(["withdraw", "remove", "clear"]), object }],
					},
				]),
			);
			break;
		case 19:
			// Two claims accepted in reverse order, their prepared context one object.
			ops.push(
				run([
					{ type: "prepare", mode: "context", object },
					enqueue(agentObject),
					enqueue(pick([6, 7])),
					claim("reverse", 2),
					{
						type: "watch",
						mode: "record",
						object,
						body: [{ type: pick(["withdraw", "remove", "clear"]), object }],
					},
				]),
			);
			break;
	}
	// Mix fresh and reused objects before another real run. Never mutate message identities for tagging.
	for (let i = 0; i < 2 + Math.floor(random() * 4); i++) {
		const selected = pick([object, agentObject, 6, 7, 8]);
		ops.push(
			random() < 0.25
				? { type: "promote", object: selected }
				: enqueue(selected, pick([1, 2, 3]), pick(["steering", "followUp"])),
		);
	}
	ops.push(run([], pick(["prompt", "continue"]), object));
	return ops;
}

/** Delete operations (including callback operations) until no single deletion preserves this rule. */
async function shrink(operations: Op[], rule: string): Promise<Op[]> {
	let current = structuredClone(operations);
	const paths = (ops: Op[], prefix: number[] = []): number[][] =>
		ops.flatMap((op, index) => {
			const path = [...prefix, index];
			return [path, ...(op.body ? paths(op.body, path) : [])];
		});
	for (;;) {
		let changed = false;
		for (const path of paths(current)) {
			const candidate = structuredClone(current);
			let list = candidate;
			for (const index of path.slice(0, -1)) list = list[index].body!;
			list.splice(path.at(-1)!, 1);
			if ((await execute(candidate)).violations.some(v => v.rule === rule)) {
				current = candidate;
				changed = true;
				break;
			}
		}
		if (!changed)
			for (const path of paths(current)) {
				const candidate = structuredClone(current);
				let list = candidate;
				for (const index of path.slice(0, -1)) list = list[index].body!;
				const op = list[path.at(-1)!];
				const minimum = op.mode === "prompt-pair" ? 2 : op.type === "tick" ? 0 : 1;
				if (op.count === undefined || op.count <= minimum) continue;
				op.count--;
				if ((await execute(candidate)).violations.some(v => v.rule === rule)) {
					current = candidate;
					changed = true;
					break;
				}
			}
		if (!changed) return current;
	}
}

it("checks every message_end when the first prompt occurrence is also queued", async () => {
	const result = await execute([enqueue(0), run([], "prompt-first", 0)]);
	expect(result.violations).toEqual([]);
});
it("a withdrawal between the request and its records leaves a different prompt occurrence recorded", async () => {
	const result = await execute([
		enqueue(0),
		{ type: "before", body: [{ type: "withdraw" }] },
		run([], "prompt-first", 0),
	]);
	expect(result.violations).toEqual([]);
});

it("records each fresh occurrence and returns rejected live input through the real boundary", async () => {
	const result = await execute([
		enqueue(1),
		enqueue(0, 2),
		run([enqueue(4), claim("reject")]),
		enqueue(6, 2, "followUp"),
		run([], "continue"),
	]);
	expect(result.violations).toEqual([]);
});

it("keeps a held promotion on its own occurrence when overlapping takes accept only the second copy", async () => {
	const result = await execute([
		run([enqueue(1), { type: "promote", object: 1 }, enqueue(1), claim("second", 2)]),
		enqueue(6),
	]);
	expect(result.violations).toEqual([]);
});

it("records prepared context that is a later batch's message as context, not as that message", async () => {
	const result = await execute([
		run([
			{ type: "prepare", mode: "context", object: 2 },
			enqueue(0),
			claim("accept"),
			{ type: "prepare", mode: "none" },
			enqueue(2),
			claim("accept"),
			{ type: "watch", mode: "record", object: 2, body: [{ type: "withdraw" }] },
		]),
	]);
	expect(result.violations).toEqual([]);
});

it("gives shared prepared context to each batch when claims are accepted in reverse order", async () => {
	const result = await execute([
		run([
			{ type: "prepare", mode: "context", object: 4 },
			enqueue(0),
			enqueue(2),
			claim("reverse", 2),
			{ type: "watch", mode: "record", object: 4, body: [{ type: "withdraw" }] },
		]),
	]);
	expect(result.violations).toEqual([]);
});

it("keeps every aliased queued occurrence in one place, with its own delivery, promotion, allowance and gate lease", async () => {
	const started = performance.now();
	const sequences = 2000;
	const failures = new Map<string, { seed: number; rule: string; operations: Op[]; detail: string }>();
	const coverage = new Set<string>();
	let notifications = 0;
	let requests = 0;
	let failingSequences = 0;
	for (let seed = 1; seed <= sequences; seed++) {
		const operations = generate(seed);
		const result = await execute(operations);
		if (result.violations.length > 0) failingSequences++;
		notifications += result.notifications;
		requests += result.requests;
		for (const branch of result.coverage) coverage.add(branch);
		for (const v of result.violations) {
			const key = `${v.rule}/shape-${seed % 20}`;
			if (!failures.has(key)) failures.set(key, { seed, rule: v.rule, operations, detail: v.detail });
		}
	}
	for (const failure of failures.values()) {
		failure.operations = await shrink(failure.operations, failure.rule);
		failure.detail = (await execute(failure.operations)).violations.find(v => v.rule === failure.rule)!.detail;
	}
	console.log(
		"OCCURRENCE_MODEL",
		JSON.stringify({
			sequences,
			failingSequences,
			runtimeMs: Math.round(performance.now() - started),
			notifications,
			requests,
			coverage: [...coverage].sort(),
			failures: Object.fromEntries(failures),
		}),
	);
	for (const branch of [
		"prompt",
		"continue",
		"prompt aliases queue",
		"user attribution",
		"agent attribution",
		"three aliased occurrences",
		"reused object",
		"overlapping claims",
		"prepare context",
		"prepare context-once",
		"prepare throw",
		"prepare cancel",
		"prepare abort",
		"conversion throw",
		"conversion empty",
		"live accept",
		"live reject",
		"live hold",
		"listener claim",
		"listener held",
		"listener adopt",
		"gate veto",
		"gate release",
		"append",
		"abort",
		"clear",
		"withdraw",
		"remove",
		"group",
		"promote",
	])
		expect(coverage.has(branch), `generator never exercised ${branch}`).toBe(true);
	expect(
		Object.fromEntries(failures),
		"Each failure contains the first failing seed and a deletion-minimal operation list",
	).toEqual({});
}, 120_000);
